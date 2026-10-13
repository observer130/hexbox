/**
 * **故障症状 → 原因 → 该怎么查**（纯函数 + 单测）
 *
 * ── 这份表是从哪来的（来源与用途）────────────────────────────────────────────
 *
 * 同类产品**已发货**的安装包里带着一张反馈分类表（用户可见的"反馈类型"下拉），
 * 那五条症状是他们线上真实收到过的用户反馈 —— 也就是说，**这是被市场验证过的
 * 失败清单**，不是我们凭空想的边界情况。我们把它抄成自己的"排查手册"：
 *
 *   `选人阶段不显示` / `海克斯阶段不显示` / `两个阶段都不显示` /
 *   `玩了几局后不显示` / `显示信息偏移`
 *
 * 每一类都给出：**hexbox 里可能的原因** + **去哪一行日志/哪个产物找证据** + **动作**。
 *
 * ── 为什么这值得是一个纯函数模块 ───────────────────────────────────────────
 *
 * 排查时最贵的是"猜方向"：同一个症状（屏幕上什么都没有）在选人/局内/长会话三种
 * 场景下的原因完全不同，而每条原因对应的**证据行**是确定的（本仓库的日志格式是
 * 契约，见 `augment-clear.ts` 的说明）。把映射写死在代码里并被单测锁住，好处是：
 *   · 自测脚本可以直接把它打印出来（用户照着 grep 就能定位，不用问我们）；
 *   · 文档与代码同源 —— 改代码不改文档会当场被单测发现（见 `failure-taxonomy.test.ts`）。
 *
 * ⚠️ 这张表**只描述"怎么查"**，不参与任何运行时判定（不改变画/不画的行为）：
 * 判定逻辑在各自的纯函数里（`visibility.ts` / `augment-clear.ts` / `reconnect-recovery.ts`）。
 */

/** 症状词表（**唯一来源**：自测输出、文档、issue 模板都用这里的字面量）。 */
export const LABEL_SYMPTOMS = [
  '选人阶段不显示',
  '海克斯阶段不显示',
  '两个阶段都不显示',
  '玩了几局后不显示',
  '显示信息偏移',
] as const;

export type LabelSymptom = (typeof LABEL_SYMPTOMS)[number];

/** 一条可能原因。 */
export interface SymptomCause {
  /** 一句话说明（人话，不要术语堆砌）。 */
  readonly cause: string;
  /**
   * 去日志里搜什么（**必须是真实存在的日志片段**）。
   *
   * ⚠️ 这些字符串是排查的入口：写错了用户就搜不到。单测会检查它们**互不重复**
   * 且非空 —— 复制粘贴改一半是最常见的坏法。
   */
  readonly grep: string;
  /** 找到之后做什么（可执行的一步，不是"检查一下"这种废话）。 */
  readonly action: string;
}

export interface SymptomEntry {
  /** 用户看到的现象。 */
  readonly symptom: LabelSymptom;
  /** 一句话解释"为什么这个现象会出现在这里"。 */
  readonly why: string;
  readonly causes: readonly SymptomCause[];
}

/**
 * 五个症状的排查表。
 *
 * 顺序刻意从"最常见的环境问题"排到"链路/几何问题" —— 用户从上往下查，
 * 大多数情况在前两条就能定位。
 */
export const LABEL_SYMPTOM_TAXONOMY: readonly SymptomEntry[] = [
  {
    symptom: '选人阶段不显示',
    why: '选人标签来自**截屏识别**（卡片/顶栏），所以先分"没识别出英雄"和"识别出了但没画出来"。',
    causes: [
      {
        cause: '卡片/顶栏没被识别出英雄（宁漏勿错是刻意行为：认不出就不画）',
        grep: '[overlay-canvas] draw labels=0',
        action:
          '跑 `node --experimental-strip-types scripts/diag-champ-select-cards.mts --ocr`：正样本必须检出、几何差几像素要能量出来。',
      },
      {
        cause: '截屏形态判错（窗口快照 vs 显示器快照）→ 搜索区整体错位',
        grep: 'captureForm',
        action:
          '看该帧的形态判定与两个候选的命中；`HEXBOX_CHAMP_SELECT_CARDS=legacy` 可临时对比旧路径（见 docs/SCREENSHOT-DEV.md §9.7）。',
      },
      {
        cause: '画布没跟着窗口设尺寸（停在 HTML 默认 300x150）→ 坐标全在画布外',
        grep: 'canvas=300x150',
        action: '这是硬缺陷：`dist/renderer/*.js` 缺失或脚本没跑到，重新 `pnpm build` 并看构建期报错。',
      },
      {
        cause: '窗口被游戏独占全屏盖住（窗口本身可见、像素也在）',
        grep: '窗口：visible=',
        action: '把游戏改成"无边框窗口"模式；独占全屏下任何置顶透明窗都可能被覆盖。',
      },
    ],
  },
  {
    symptom: '海克斯阶段不显示',
    why: '局内标签依赖"认出面板 + 认出我的英雄 + 该英雄的强度表里有这张卡"，三者缺一都不画。',
    causes: [
      {
        cause: '本局英雄没认出来（选人会话已消失 + 2999 还没就绪）',
        grep: '未能确定本局英雄',
        action: '看同一行括号里的 reason；重连场景现在会自动重试 3 次×2 秒（见 `reconnect-recovery.ts`）。',
      },
      {
        cause: '面板开边沿没被门控认定（常驻流没起来 / 渲染端没报"门控已就绪"）',
        grep: '8 秒内未报告',
        action:
          '看它上一行的流启动异常；`HEXBOX_AUGMENT_FORENSICS=1` 会留取证帧（见 docs/AUGMENT-PANEL.md）。',
      },
      {
        cause: '认出来了但官方强度表里查不到这张卡（约 37 颗海克斯上游就是没有）',
        grep: '查不到强度',
        action: '这是数据覆盖问题，不是缺陷：官方每个英雄只有 95~162 条；**绝不**为此猜一个档位。',
      },
      {
        cause: '本局链路被判 failed（本局不再重试）',
        grep: '链路曾判 failed',
        action: '重连会自动重置这个熔断；若同一局内反复出现，看它上面一行的启动异常原因。',
      },
    ],
  },
  {
    symptom: '两个阶段都不显示',
    why: '两个阶段共用一块画布与一个窗口 —— 都看不到，问题几乎一定在**更下面一层**（窗口/画布/LCU）。',
    causes: [
      {
        cause: '读不到 LCU 凭证（客户端没起 / WeGame 版 lockfile 是 0 字节且非管理员）',
        grep: '读不到 LCU 凭证',
        action: '以管理员运行，或显式给 `HEXBOX_LCU_CREDENTIALS`（见 apps/overlay/README.md）。',
      },
      {
        cause: '覆盖窗根本没建（第二个实例抢锁失败 / 被托盘"隐藏"了）',
        grep: 'singleInstanceLock',
        action: '确认只有一个 hexbox 进程；从托盘菜单重新显示。',
      },
      {
        cause: '画布脚本没加载（HTML 指向的 dist/renderer 文件不存在）',
        grep: 'canvas=300x150',
        action: '`pnpm build`（构建期会直接失败）；**不要**手工复制 dist。',
      },
      {
        cause: '窗口可见但不在游戏那块显示器上（多屏）',
        grep: '画在**主显示器**',
        action: '自测画的是主显示器；局内会跟随游戏窗口所在显示器（`findGameWindowRect`）。',
      },
    ],
  },
  {
    symptom: '玩了几局后不显示',
    why: '只在"跑过几局之后"出现 → 几乎都是**跨局残留状态**（僵尸抓帧会话 / 本局熔断 / 上一局的标签没清）。',
    causes: [
      {
        cause: '链路状态机以为在跑、但抓帧早已失效（僵尸会话，流目标随客户端重启一起废了）',
        grep: '僵尸会话',
        action: '重连恢复会停掉这一代并重建；若没有重连相位可等，重启客户端即可复位。',
      },
      {
        cause: '上一局的标签没被清空（错误的"链路停止不清标签"组合）',
        grep: '链路停止但不清标签',
        action: '确认随后出现了"确认离开对局"或"面板关闭边沿"；这两条才是标签的终结者。',
      },
      {
        cause: '本局熔断（failed）在下一局没有被重置',
        grep: '重置熔断',
        action: '换局本身会走"确认离开对局 → idle"；若没看到该行，把日志发回。',
      },
      {
        cause: '进程内计数/句柄累积（长会话）',
        grep: '退出清理',
        action: '跑一次自测的长会话场景（`HEXBOX_LABEL_OVERLAY_TEST=1`，见 label-selftest.ts）。',
      },
    ],
  },
  {
    symptom: '显示信息偏移',
    why: '标签位置 = 识别坐标 × 截屏形态 → 屏幕 → 窗口三次换算，任一处口径不一致就整体偏移。',
    causes: [
      {
        cause: '截屏形态判错（显示器快照当成窗口快照，或反之）',
        grep: '形态',
        action: '对比两个候选的几何（docs/SCREENSHOT-DEV.md §9.7）；两个形态必须成对使用 region + geo。',
      },
      {
        cause: '显示器缩放/分辨率变化后画布没重设（DPR 变了）',
        grep: 'dpr',
        action: '自测里的"改窗口尺寸"场景就是在盯这一条：画布尺寸必须等于窗口内尺寸 × DPR。',
      },
      {
        cause: '游戏窗口矩形探错（无边框/被移动/被缩放）',
        grep: '游戏窗口',
        action: '看探到的矩形与目视窗口是否一致；geometry 探针失败会退回 altRegion。',
      },
      {
        cause: '窗口内坐标换算少减了工作区原点（只在副屏显形）',
        grep: 'workArea',
        action: '换算**只有** `toWindowRelativeLabels()` 一处；出现第二处就要立刻删掉。',
      },
    ],
  },
];

/** 按症状取排查表（找不到返回 null，不抛）。 */
export function symptomEntry(symptom: string): SymptomEntry | null {
  return LABEL_SYMPTOM_TAXONOMY.find((e) => e.symptom === symptom) ?? null;
}

/**
 * 自测/文档用的一整段文本（**与表同源**，不会出现"文档写了、代码没这行"）。
 *
 * 打印在自测开头：用户把这段日志发回来，就等于把排查手册一起发回来了。
 */
export function failureTaxonomyText(): string {
  const lines: string[] = [];
  for (const entry of LABEL_SYMPTOM_TAXONOMY) {
    lines.push(`【${entry.symptom}】${entry.why}`);
    for (const c of entry.causes) {
      lines.push(`   · ${c.cause}`);
      lines.push(`     搜日志：${c.grep}`);
      lines.push(`     动作：${c.action}`);
    }
  }
  return lines.join('\n');
}
