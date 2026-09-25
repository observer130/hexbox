/**
 * 合规闸门 (Compliance Gate) — v2
 *
 * v1 的错误：把「是否包含胜率」当成边界。那是对 Riot 开发者政策的误用 ——
 * 该政策约束的是 Riot 开发生态（developer.riotgames.com 的审批标准），
 * 而本项目面向国服；国服由腾讯运营，101.qq.com 是腾讯官方数据站，
 * 其公开发布的胜率属于运营方一方公开数据，性质与 Riot 官方静态数据相同。
 *
 * v2 的判定维度：**看数据来源，不看数据内容。**
 *   - 运营方/官方一方公开的数据（静态或聚合统计）→ 允许，须标注来源与日期。
 *   - 第三方爬取/二次加工的数据 → 禁止。
 *   - 手段红线永不妥协：不读内存、不注入、不解析封包、不打开游戏进程句柄。
 *
 * 之所以把规则写进代码而不是只写文档：
 *   1. 让规则与执行共存于同一处，不会失同步；
 *   2. 让「新来源能否接入」在注册期就经过闸门，而不是靠自觉。
 *
 * 本文件即合规边界的完整权威说明（原独立文档已并入此处）。
 */

/**
 * 数据来源类别 —— 用于声明「这个 provider 的数据从哪来、能不能用」。
 *
 * 命名刻意以来源为主体（official-* / third-party-*），
 * 而非数据内容（v1 的 *-performance 命名方式是 v2 修正的根源）。
 */
export type DataClass =
  /** 官方静态定义：名称、图标、描述、稀有度、模式池、价格。 */
  | 'official-static'
  /** 官方聚合统计：胜率、选取率、排名（运营方官方站点公开发布）。 */
  | 'official-aggregated'
  /** 第三方爬取/二次加工数据：来源与口径不明，禁止。 */
  | 'third-party-scraped'
  /**
   * 局内实时信息：当前对局中玩家被提供的 3 个海克斯。
   * 官方 API 不提供；只能靠读内存/OCR 获取，而手段红线已排除。
   */
  | 'live-session'
  /** 手段红线：读内存、注入、进程句柄、封包解析。永不允许。 */
  | 'process-invasive';

/** 某个数据类别的处置策略。 */
export type PolicyVerdict =
  /** 允许使用。 */
  | { readonly allowed: true }
  /** 禁止使用。 */
  | { readonly allowed: false; readonly reason: string };

/**
 * 数据类别策略表。
 *
 * 修改任何条目前，请先阅读本文件顶部的说明 —— 策略与理由集中在此处，
 * compliance.test.ts 会校验策略行为的一致性。
 */
export const DATA_POLICY: Readonly<Record<DataClass, PolicyVerdict>> = Object.freeze({
  'official-static': { allowed: true },
  'official-aggregated': { allowed: true },

  'third-party-scraped': {
    allowed: false,
    reason:
      '第三方站点爬取/二次加工的数据来源与统计口径不明，可能违反上游服务条款，' +
      '且无法验证真实性。只接运营方/官方一方公开数据。',
  },

  'live-session': {
    allowed: false,
    reason:
      '官方 Live Client Data API 不提供「当前被提供的 3 个海克斯」' +
      '（swagger 24 端点/24 schema 中 augment/cherry/kiwi/hextech/brawl 零命中）。' +
      '合法途径无法获取；读内存/OCR 方案已被手段红线排除。',
  },

  'process-invasive': {
    allowed: false,
    reason:
      '手段红线，永不妥协：不读内存、不注入、不打开游戏进程句柄、不解析网络封包。' +
      '无论数据内容多「官方」，获取手段越界即整体越界。',
  },
});

/**
 * 违规访问数据类别时抛出的错误。
 *
 * 注意：刻意不使用 TS 参数属性（`constructor(readonly x)`），
 * 因为 Node 的 strip-only 模式不支持该语法。
 */
export class ComplianceError extends Error {
  readonly dataClass: DataClass;
  readonly reason: string;

  constructor(dataClass: DataClass, reason: string) {
    super(`[合规拦截] 数据类别 "${dataClass}" 未被允许：${reason}\n详见 packages/core/src/compliance.ts 中 DATA_POLICY 的说明。`);
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

/** 别名：来源准入断言（provider 注册表使用，语义更贴近 v2 的来源维度）。 */
export function assertDataSourceAllowed(dataClass: DataClass): void {
  assertDataClassAllowed(dataClass);
}

/** 列出所有被禁止的数据类别（供 UI 展示「我们刻意不做的事」）。 */
export function listForbiddenDataClasses(): readonly DataClass[] {
  return (Object.keys(DATA_POLICY) as DataClass[]).filter((k) => !DATA_POLICY[k].allowed);
}
