/**
 * 离线预览用的 **CJK 最小点阵**（只有「选取率」三个字）
 *
 * 局内标签那一行「选取率 12.1%」是 Chromium 用系统字体（微软雅黑）画的，
 * 而离线预览（`scripts/preview-augment-labels.mts`）跑在纯 Node 里、没有字体引擎。
 * 为了让预览与局内的**版面**一致（同样的字号、同样的居中、同样的墨迹高），
 * 这里只内嵌那**三个汉字**的点阵（ASCII 部分仍用 `label-glyph.ts` 的 5×7 点阵）。
 *
 * ⚠️ 与局内的差异只剩"字形是位图、不是矢量字体"这一条（和档位字母用单线字形同理）。
 * 生成方式（可重跑，字体换了就重新生成）：
 *
 *   pwsh -NoProfile -File scripts/render-cjk-rate-glyphs.ps1   # 微软雅黑 Regular 96px
 *     → 裁墨迹包围盒 → 盒式降采样到高 32 → 量化成 4bit alpha → 每行一个十六进制字符
 *
 * 数据是**十六进制点阵**而不是 base64：这样在源码里能直接看出字形（可复核）。
 * 实测墨迹高 ≈ 0.92~0.98 字号 —— `label-draw.ts` 的 `TIER_RATE_INK` 按这个上界取值。
 */

/** 一个汉字点阵：w×h，每行 w 个十六进制字符（0 = 透明，f = 不透明）。 */
export interface CjkRateGlyph {
  readonly w: number
  readonly h: number
  readonly rows: readonly string[]
}

/** 「选取率」三个字的点阵（键 = 汉字本身；查不到返回 null，调用方回退到方框提示）。 */
export const CJK_RATE_GLYPHS: Readonly<Record<string, CjkRateGlyph>> = {
  '选': { w: 33, h: 32, rows: [
    '00000000000000000000bc70000000000',
    '00087000000000400000ef80000000000',
    '008fe600000006fc3000ef80000000000',
    '000dfe50000009fc0000ef80000000000',
    '0006ffc000000cf80000ef80000000000',
    '00009ff900004ff60004ef90000000000',
    '00003dfe50008ffdcccdffecccccccc40',
    '000006ef6000bffffffffffffffffff50',
    '000000760006ffb9999affc9999999930',
    '00000000000dfc000000ef80000000000',
    '00000000005ff7000000ef80000000000',
    '00000000008fc0000000ef80000000000',
    '8ccccca0000660000000ef80000000000',
    'afffffd0000000000004ef90000000000',
    '6999dfd00cddddddddddffedddddddddb',
    '0000afd00effffffffffffffffffffffd',
    '0000afd00555555bfe7555bfe65555555',
    '0000afd000000009fe00008fd00000000',
    '0000afd00000000afd00008fd00000000',
    '0000afd00000000bfc00008fd00000740',
    '0000afd00000000dfb00008fd00000be8',
    '0000afd00000007ff800008fd00000cf9',
    '0000afd0000004dfe300008fd00000df6',
    '0000afd000005dfe6000008fe00004fe4',
    '0000afd0004aefe70000006ffa556cfc0',
    '0000cfd007efff800000000cfffffff70',
    '0009ffe403cfd60000000004addddc800',
    '00affdfd4036000000000000000000000',
    '0aff83cfe950000000000000000000000',
    'aff9003bfffdbaaa9999999aaaaabbbbb',
    '6ea000007cffffffffffffffffffffffa',
    '090000000058abbbbbcccccccbbbbbbb4',
  ] },
  '取': { w: 34, h: 32, rows: [
    '5cccccccccccccccc30000000000000000',
    '6ffffffffffffffffa9999999999999800',
    '056dfc555555cfd66ffffffffffffffe00',
    '000cfa000000afc007cfb77777777bfd00',
    '000cfa000000afc0009f900000000afb00',
    '000cfa000000afc0008fa00000000cfa00',
    '000cfa000000afc0006fb00000003ef800',
    '000cfb000000bfc0005fc00000005ff600',
    '000cffffffffffc0003fe40000007ff400',
    '000cfeddddddefc0000df6000000afd000',
    '000cfb000000bfc0000bf9000000cfa000',
    '000cfa000000afc00009fc000003ef8000',
    '000cfa000000afc00006ff400006ff5000',
    '000cfa000000afc00004ff700009fd0000',
    '000cfb000000bfc00000cfa0000df80000',
    '000cfeccccccefc000009fd0005fe40000',
    '000cffffffffffc000006ff6009fa00000',
    '000cfc555555cfc000000dfa00df600000',
    '000cfa000000afc0000007fe59fd000000',
    '000cfa000000afc0000000cfcef9000000',
    '000cfa000000afc00000007fffe3000000',
    '000cfa000000afd56860000dff90000000',
    '000cfa003579dfffff90005effb0000000',
    '000dfdaceffffffffd7000cffff7000000',
    'bfffffffffebdfd300003dfe6cfe500000',
    'bfffdca86530afc00000cff803cfd50000',
    '575400000000afc0003cff90004dfe8000',
    '000000000000afc004cffa000007fff900',
    '000000000000afc08fff800000008fffc5',
    '000000000000afdbfff80000000007efe7',
    '000000000000afc8fd6000000000004d80',
    '0000000000008ca0830000000000000300',
  ] },
  '率': { w: 31, h: 32, rows: [
    '00000000000003ac000000000000000',
    '00000000000007ff700000000000000',
    '00000000000000cfd00000000000000',
    '055555555555559ffa5555555555553',
    '7fffffffffffffffffffffffffffff8',
    '6dddddddddddddfddddddddddddddd7',
    '00000000000009fb300000000000000',
    '0053000000006ee8000000000005000',
    '04ed40000005ee70006a4000007ec00',
    '04dfd400006ed50005efb00009ffb00',
    '003cfd5008ef96668efb0004bffa000',
    '0003cfd06fffffffffa0000bfe70000',
    '00003c700deccbcff9000003a400000',
    '00000000030003ce700000000000000',
    '0000006d80005dd500bc000bc600000',
    '00000affc006ee5000cf904eff90000',
    '0008effa00afb000004ef700bffd500',
    '05bffd706cffb99aaaaefd3008efe80',
    '7ffe90009ffffffffffeefb0004cff9',
    '0bb400005b98877764306ed300009c0',
    '000000000000006db00005000000000',
    '000000000000008fd00000000000000',
    '89999999999999cfea9999999999999',
    'dffffffffffffffffffffffffffffff',
    '89999999999999cfea9999999999999',
    '000000000000008fd00000000000000',
    '000000000000008fd00000000000000',
    '000000000000008fd00000000000000',
    '000000000000008fd00000000000000',
    '000000000000008fd00000000000000',
    '000000000000008fd00000000000000',
    '000000000000006ca00000000000000',
  ] },
}

/** 取一个汉字的点阵；没有内置字形时返回 null。 */
export function cjkRateGlyph(ch: string): CjkRateGlyph | null {
  return CJK_RATE_GLYPHS[ch] ?? null
}

