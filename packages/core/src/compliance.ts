/**
 * 合规闸门 (Compliance Gate)
 *
 * 本项目刻意不使用某些**技术上可得**的数据（例如海克斯胜率）。
 * 这不是能力缺陷，而是主动的政策选择。
 *
 * 之所以把这套规则**写进代码**而不是只写在文档里，是因为：
 *   1. 文档会过时，代码会强制执行；
 *   2. 后来者（包括未来的我）很容易"顺手"把可得的数据接进来；
 *   3. 让合规边界在类型层面可见，而非依赖记忆。
 *
 * Riot 政策原文（https://developer.riotgames.com/docs/lol）：
 *   "Products cannot display win rates for Augments or Arena Mode items.
 *    This applies to all websites, applications and overlays."
 *
 * 该条款位于 "Game Policy → Use Cases for Production Keys" 之下，
 * 属于**应用审批标准**（不批准），而非法律禁止。违反的后果是拿不到
 * Riot 认可 / 可能被要求下架，而非承担法律责任。
 */

/** 数据类别 —— 用于声明"这类数据能不能用"。 */
export type DataClass =
  /** 静态定义：名称、图标、描述、稀有度、模式池。官方公开，明确允许。 */
  | 'static-definition'
  /** 静态数值：价格、合成树、基础属性。 */
  | 'static-numeric'
  /** 赛前可见信息：选人阶段阵容、玩家自己选择的英雄。 */
  | 'pregame-visible'
  /**
   * 局内实时信息：当前对局中、玩家被提供了哪 3 个海克斯。
   * ❌ 官方 API 不提供；只能靠读内存/OCR 获取。**不实现**。
   */
  | 'live-session'
  /**
   * 海克斯/竞技场物品的胜率、选取率、梯度。
   * ❌ Riot 明列为不予批准的用例。**不实现**。
   */
  | 'augment-performance'
  /**
   * 对局结果统计（非海克斯维度），例如"某模式下某英雄的胜率"。
   * ⚠️ 属于**解释空间**：禁令措辞只提 Augments / Arena Mode items。
   * 默认关闭，需人工确认后才可启用。
   */
  | 'mode-performance';

/** 某个数据类别的处置策略。 */
export type PolicyVerdict =
  /** 允许使用。 */
  | { readonly allowed: true }
  /** 禁止使用。 */
  | { readonly allowed: false; readonly reason: string };

/**
 * 数据类别策略表。
 *
 * 修改 `augment-performance` 或 `live-session` 为 allowed 之前，
 * 请先阅读 COMPLIANCE.md 并取得 Riot 明确答复。
 */
export const DATA_POLICY: Readonly<Record<DataClass, PolicyVerdict>> = Object.freeze({
  'static-definition': { allowed: true },
  'static-numeric': { allowed: true },
  'pregame-visible': { allowed: true },

  'live-session': {
    allowed: false,
    reason:
      '官方 Live Client Data API 不提供"当前被提供的 3 个海克斯"。' +
      '合法途径无法获取；读内存/OCR 方案已被排除。',
  },

  'augment-performance': {
    allowed: false,
    reason:
      'Riot 政策明文列为不予批准的用例：' +
      '"Products cannot display win rates for Augments or Arena Mode items. ' +
      'This applies to all websites, applications and overlays." ' +
      '注意：即使不直接显示数字，仅用其排序/推荐亦属该禁令的实质。',
  },

  'mode-performance': {
    allowed: false,
    reason:
      '属解释空间：禁令措辞只涵盖 Augments / Arena Mode items，' +
      '未明确覆盖"某模式下的英雄胜率"。' +
      '为保守起见默认关闭；如需启用，请先向 Riot 开发者门户确认。',
  },
});

/**
 * 违规访问数据类别时抛出的错误。
 *
 * 注意：此处刻意不使用 TS 参数属性（`constructor(readonly x)`），
 * 因为 Node 的 strip-only 模式不支持该语法。详见 tsconfig 说明。
 */
export class ComplianceError extends Error {
  readonly dataClass: DataClass;
  readonly reason: string;

  constructor(dataClass: DataClass, reason: string) {
    super(
      `[合规拦截] 数据类别 "${dataClass}" 未被允许：${reason}\n` +
        `详见 COMPLIANCE.md。`,
    );
    this.name = 'ComplianceError';
    this.dataClass = dataClass;
    this.reason = reason;
  }
}

/** 查询某数据类别是否被允许（不抛错）。 */
export function isDataClassAllowed(dataClass: DataClass): boolean {
  return DATA_POLICY[dataClass].allowed;
}

/**
 * 断言某数据类别被允许；否则抛 ComplianceError。
 *
 * 数据源在返回数据前应调用此函数，使越界在**开发期**就暴露，
 * 而不是等到审查或上线后。
 */
export function assertDataClassAllowed(dataClass: DataClass): void {
  const verdict = DATA_POLICY[dataClass];
  if (!verdict.allowed) throw new ComplianceError(dataClass, verdict.reason);
}

/** 列出所有被禁止的数据类别（供 UI 展示"我们刻意不做的事"）。 */
export function listForbiddenDataClasses(): readonly DataClass[] {
  return (Object.keys(DATA_POLICY) as DataClass[]).filter((k) => !DATA_POLICY[k].allowed);
}
