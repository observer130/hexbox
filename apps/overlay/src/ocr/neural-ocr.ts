/**
 * 神经网络 OCR 运行时（主进程 / 回放共用）
 *
 * 纯算法在 `@hexbox/vision/augment-ocr-neural.ts`（预处理 / 闭集 CTC / 阈值）；
 * 本文件只做"加载 ONNX Runtime + 模型 + 字典，并把几张名字带变成名字"。
 *
 * ⚠️ 两个运行时约束（真机/打包相关）：
 *   · `onnxruntime-node` 是原生模块，**不能**打包进 esbuild bundle，也不适合放进
 *     asar —— 构建脚本把它按平台复制到 `dist/native/onnxruntime-node`，这里用
 *     `createRequire` 从**绝对目录**加载；开发版与打包版路径都由调用方给。
 *   · Windows 预编译的 ORT **不支持 CUDA**（CUDA EP 只有 Linux）；Windows 可用
 *     CPU / DirectML。本任务 3 条小文本行用 CPU 已足够（实测 ~5.5ms/行），
 *     所以默认 CPU；`executionProviders` 允许显式传 `dml` 做可选加速。
 *
 * 模型输出是**已 softmax 的逐帧概率**（不是 logits）；`resolveNeuralName` 按这个
 * 前提计算 CTC 对数似然 —— 不要把这里改成 softmax 两次。
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  buildNameLexicon,
  parsePpOcrDict,
  prepareNeuralName,
  resolveNeuralName,
  type AugmentNameMatch,
  type GrayNameBand,
  type NameLexicon,
} from '@hexbox/vision';

/** 只用于类型的 ORT 引用；运行时通过绝对路径 require，避免打进 bundle。 */
type OrtModule = typeof import('onnxruntime-node');
type OrtSession = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;

export interface NeuralOcrOptions {
  /** `ppocrv5-ch-mobile-rec.onnx` 的绝对路径。 */
  readonly modelPath: string;
  /** 模型配套字典的绝对路径。 */
  readonly dictionaryPath: string;
  /**
   * `onnxruntime-node` 包所在的**父目录**（即 `dist/native/`）。
   *
   * 目录布局：`<nativeModuleDir>/onnxruntime-node/` 与
   * `<nativeModuleDir>/node_modules/onnxruntime-common/`。
   */
  readonly nativeModuleDir: string;
  /** 已知名字（来自 `dataset.hextechs`，闭集解码用）。 */
  readonly names: readonly { readonly augmentId: number; readonly name: string }[];
  /** ORT execution providers，默认 `['cpu']`；可传 `['dml','cpu']`。 */
  readonly executionProviders?: readonly string[];
  readonly log?: (message: string) => void;
}

export interface NeuralAugmentOcr {
  /** 懒加载模型并返回是否可用（失败返回 false，不抛）。 */
  warmUp(): Promise<boolean>;
  /** 逐张识别名字带；模型初始化失败会 reject（调用方回退模板匹配）。 */
  recognize(bands: readonly GrayNameBand[]): Promise<readonly (AugmentNameMatch | null)[]>;
  close(): Promise<void>;
}

/** 从 `<nativeModuleDir>/onnxruntime-node` 加载原生模块。 */
function loadOrt(nativeModuleDir: string): OrtModule {
  const packageDir = join(nativeModuleDir, 'onnxruntime-node');
  // createRequire 只要求 anchor 是绝对路径（文件不必存在）
  const req = createRequire(join(packageDir, 'package.json'));
  return req(packageDir) as OrtModule;
}

/**
 * 创建懒加载的神经网络 OCR。
 *
 * 第一次 `recognize()`/`warmUp()` 才读 16MB 模型并建 session（CPU 约 100~200ms）；
 * 不在应用启动路径上阻塞。
 */
export function createNeuralAugmentOcr(options: NeuralOcrOptions): NeuralAugmentOcr {
  const log = options.log ?? ((m: string) => console.log(m));
  let initPromise: Promise<{ ort: OrtModule; session: OrtSession; lexicon: NameLexicon; inputName: string; outputName: string }> | null = null;
  let initFailure: Error | null = null;
  let closed = false;

  const init = async (): Promise<{ ort: OrtModule; session: OrtSession; lexicon: NameLexicon; inputName: string; outputName: string }> => {
    if (closed) throw new Error('神经网络 OCR 已关闭');
    if (initFailure) throw initFailure;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const t0 = Date.now();
      const dictText = readFileSync(options.dictionaryPath, 'utf8');
      const dict = parsePpOcrDict(dictText);
      const lexicon = buildNameLexicon(options.names, dict);
      if (lexicon.entries.length === 0) {
        throw new Error('闭集词表为空（dataset.hextechs 未加载或字典不匹配）');
      }
      const ort = loadOrt(options.nativeModuleDir);
      const model = readFileSync(options.modelPath);
      const wantedProviders = options.executionProviders ?? ['cpu'];
      let session: OrtSession;
      try {
        session = await ort.InferenceSession.create(model, { executionProviders: wantedProviders });
      } catch (err) {
        if (wantedProviders.length === 1) throw err;
        log(
          `[ocr] ⚠ ${wantedProviders.join('/')} 初始化失败（${err instanceof Error ? err.message : String(err)}）→ 回退 CPU`,
        );
        session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'] });
      }
      const inputName = session.inputNames[0];
      const outputName = session.outputNames[0];
      if (!inputName || !outputName) throw new Error('ONNX 模型缺少输入/输出名');
      log(
        `[ocr] 🧠 神经网络 OCR 就绪：${options.modelPath.split(/[\\/]/).pop()} ` +
          `${(model.byteLength / 1024 / 1024).toFixed(1)}MB · 词表 ${lexicon.entries.length} 条` +
          (lexicon.skipped.length > 0 ? `（跳过 ${lexicon.skipped.length} 条）` : '') +
          ` · EP=${wantedProviders.join('/')} · 加载 ${Date.now() - t0}ms`,
      );
      return { ort, session, lexicon, inputName, outputName };
    })().catch((err: unknown) => {
      initFailure = err instanceof Error ? err : new Error(String(err));
      initPromise = null;
      throw initFailure;
    });
    return initPromise;
  };

  return {
    async warmUp(): Promise<boolean> {
      try {
        await init();
        return true;
      } catch (err) {
        log(`[ocr] ⚠ 神经网络 OCR 不可用：${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    },

    async recognize(bands: readonly GrayNameBand[]): Promise<readonly (AugmentNameMatch | null)[]> {
      const { ort, session, lexicon, inputName, outputName } = await init();
      const out: (AugmentNameMatch | null)[] = [];
      for (const band of bands) {
        const prepared = prepareNeuralName(band);
        if (!prepared) {
          out.push(null);
          continue;
        }
        const tensor = new ort.Tensor('float32', prepared.data, [1, 3, prepared.height, prepared.width]);
        const result = await session.run({ [inputName]: tensor });
        const pred = result[outputName] as { readonly dims: readonly number[]; readonly data: Float32Array | number[] } | undefined;
        if (!pred || pred.dims.length !== 3) {
          out.push(null);
          continue;
        }
        const [batch, steps, classes] = pred.dims as [number, number, number];
        if (batch !== 1) {
          out.push(null);
          continue;
        }
        const probs = pred.data instanceof Float32Array ? pred.data : Float32Array.from(pred.data);
        out.push(resolveNeuralName(probs, steps, classes, lexicon.entries));
      }
      return out;
    },

    async close(): Promise<void> {
      closed = true;
      if (!initPromise) return;
      try {
        const { session } = await initPromise;
        await session.release();
      } catch {
        /* 初始化失败/已释放：忽略 */
      }
    },
  };
}
