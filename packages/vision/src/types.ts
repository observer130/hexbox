/**
 * 截屏识别的公共类型
 *
 * 设计原则：
 *   - 坐标一律用**归一化**（0..1）表示，与分辨率解耦。
 *     实测截屏尺寸 = 显示器逻辑尺寸 × 2，硬编码像素必然失效。
 *   - 纯数据 + 纯函数，便于单测（截屏与 Electron 都不在此包内）。
 */

/** 矩形。以归一化坐标表示时，x/y/w/h 均在 0..1。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 一张位图（RGBA，与 Electron NativeImage.toBitmap() 一致）。 */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** RGBA 顺序，长度 = width * height * 4。 */
  readonly data: Uint8ClampedArray;
}

/**
 * 截屏与屏幕之间的换算参数。
 *
 * 为什么需要这个：截屏分辨率与屏幕逻辑坐标**不是** 1:1。
 * 实测：显示器 2294×960 @1.5 DPI，截屏 4587×1920 → 倍率 2.0。
 * 且游戏窗口可能小于显示器，故还有一层窗口偏移。
 */
export interface CaptureGeometry {
  /** 截屏图像尺寸（像素）。 */
  readonly captureWidth: number;
  readonly captureHeight: number;
  /** 被截取窗口在**屏幕逻辑坐标**下的位置与尺寸。 */
  readonly windowX: number;
  readonly windowY: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
}

/** 一个候选 UI 元素（如英雄卡片）。 */
export interface CardSlot {
  /** 归一化矩形（相对截屏图像）。 */
  readonly rect: Rect;
  /** 匹配到的英雄 ID（未识别为 null）。 */
  readonly championId: number | null;
  /** 匹配得分（越大越像）；未识别为 0。 */
  readonly score: number;
}

/** 一次识别的完整结果。 */
export interface VisionResult {
  /** 检测到的卡片（按从左到右排序）。 */
  readonly cards: readonly CardSlot[];
  /** 检测是否可信（不可信时调用方**不应**绘制任何东西）。 */
  readonly confident: boolean;
  /** 失败/降级原因，便于调试与日志。 */
  readonly reason?: string;
}
