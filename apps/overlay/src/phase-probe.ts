/**
 * 阶段探针（给 debug/watch-capture.ps1 用）
 *
 * 为什么要独立入口：守望脚本原先用 `node -e "<内联脚本>"` 查询阶段，
 * 而内联脚本里要插值 Windows 路径（`D:\Projects\hexbox`）—— 反斜杠在
 * JS 字符串里会被当转义，且任何语法/模块解析失败都表现为「阶段为空」，
 * 守望脚本于是静默地一直等待。改成打包后的独立入口，失败可见。
 *
 * 用法：
 *   node run-electron.mjs dist/phase-probe.cjs
 * 输出（**整行、易于解析**）：
 *   PHASE=<phase|NONE>
 *   ERROR=<原因>            （探针失败时）
 */
import { detectCredentialsDetailed, LcuClient } from '@hexbox/lcu';

async function main(): Promise<void> {
  const r = await detectCredentialsDetailed();
  if (!r.credentials) {
    console.log('PHASE=NONE');
    console.log(`ERROR=${r.detail}`);
    process.exitCode = 2;
    return;
  }
  const client = new LcuClient(r.credentials);
  const phase = await client.getOrNull<string>('/lol-gameflow/v1/gameflow-phase');
  console.log(`PHASE=${phase ?? 'None'}`);
}

main().catch((e: unknown) => {
  console.log('PHASE=NONE');
  console.log(`ERROR=${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 3;
});
