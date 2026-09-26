/** 帧条目：导入的一张 PNG 及其播放参数 */
export interface FrameItem {
  id: string;
  name: string;
  /** 帧时长（毫秒） */
  duration: number;
  /** 原始宽度 */
  width: number;
  /** 原始高度 */
  height: number;
  /** 原始 PNG 数据（不离开浏览器） */
  blob: Blob;
  /** 预览用 object URL */
  url: string;
}

/** 透明边缘裁切结果（相对原始图的偏移与内容尺寸） */
export interface TrimRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 打包后单帧在图集中的信息 */
export interface PackedFrame {
  id: string;
  name: string;
  /** 图集中内容区左上角 x（不含留白） */
  x: number;
  /** 图集中内容区左上角 y（不含留白） */
  y: number;
  /** 图集中内容区宽度（裁切后） */
  w: number;
  /** 图集中内容区高度（裁切后） */
  h: number;
  /** 裁切偏移与内容尺寸（spriteSourceSize） */
  trim: TrimRect;
  /** 原始尺寸（sourceSize） */
  srcW: number;
  srcH: number;
  duration: number;
  /** 内容摘要（裁切后像素哈希）；帧身份 = 名称 + 摘要 */
  hash?: string;
}

/** 一次打包的结果 */
export interface PackResult {
  atlasWidth: number;
  atlasHeight: number;
  /** 按原始帧顺序排列 */
  frames: PackedFrame[];
  atlasBlob: Blob;
  atlasUrl: string;
  padding: number;
  trimmed: boolean;
  /** 最近一次打包（全量或增量）产生的变更摘要 */
  report?: PackReport;
}

/** 重排策略：稳定优先（尽量复用旧坐标）或紧凑优先（全量重排） */
export type PackStrategy = "stable" | "compact";

/** 帧在一次增量打包中的变更类型 */
export type FrameChangeKind = "kept" | "moved" | "replaced" | "added" | "removed";

/** 单帧相对上一版布局的变更 */
export interface FrameDelta {
  name: string;
  kind: FrameChangeKind;
  /** 变更前内容坐标（删除/移动/替换前存在） */
  from?: { x: number; y: number; w: number; h: number };
  /** 变更后内容坐标（删除时不存在） */
  to?: { x: number; y: number; w: number; h: number };
  /** 内容位移（仅 moved / 发生位移的 replaced 有意义） */
  dx: number;
  dy: number;
}

/** 一次打包相对布局基线的结果摘要 */
export interface PackReport {
  /** 本次是否基于旧基线做的增量打包（false = 全量重排/首次打包） */
  incremental: boolean;
  strategy: PackStrategy;
  kept: number;
  moved: number;
  replaced: number;
  added: number;
  removed: number;
  deltas: FrameDelta[];
  timestamp: number;
}

/** 打包/导出设置 */
export interface Settings {
  /** 裁切透明边缘 */
  trim: boolean;
  /** 统一留白（每帧四周的透明像素） */
  padding: number;
  /** 图集最大边长 */
  maxSize: number;
  /** 图集尺寸取 2 的幂 */
  pot: boolean;
  /** 导出 JSON 时内嵌图集 dataURL（可独立恢复） */
  embedAtlas: boolean;
  /** 有旧布局基线时：稳定优先做增量打包，紧凑优先则全量重排 */
  strategy: PackStrategy;
}

export const DEFAULT_SETTINGS: Settings = {
  trim: true,
  padding: 2,
  maxSize: 2048,
  pot: true,
  embedAtlas: true,
  strategy: "stable"
};

/** 类 ImageData 的最小结构，便于在 Node 中测试 */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
