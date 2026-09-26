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
  /** 本次打包的增量摘要（保持/移动/新增/删除） */
  summary?: PackSummary;
}

/** 布局策略：稳定优先（增量复用原位置）或紧凑优先（全量重排） */
export type PackStrategy = "stable" | "compact";

/** 布局基线中的单帧：逻辑名称 + 内容摘要 + 原位置（内容区，不含留白） */
export interface BaselineFrame {
  name: string;
  /** 内容摘要（解码后 RGBA + 尺寸的散列），与名称共同决定帧身份 */
  digest: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 布局基线：上一次成功打包的稳定布局，增量重打包以其为基准 */
export interface LayoutBaseline {
  atlasWidth: number;
  atlasHeight: number;
  padding: number;
  trim: boolean;
  pot: boolean;
  frames: BaselineFrame[];
}

/** 单帧的坐标差异 */
export interface FrameChange {
  name: string;
  kind: "kept" | "moved" | "added" | "replaced" | "deleted";
  /** 基线中的位置（新增帧无） */
  from?: { x: number; y: number };
  /** 本次布局中的位置（删除帧无） */
  to?: { x: number; y: number };
}

/** 一次打包的结果摘要 */
export interface PackSummary {
  strategy: PackStrategy;
  /** 是否进行了全量重排（首次打包、设置变化、紧凑优先或增量失败后的回退） */
  fullRepack: boolean;
  /** 全量重排的原因（如有） */
  reason?: string;
  kept: number;
  moved: number;
  added: number;
  replaced: number;
  deleted: number;
  /** 逐帧坐标差异 */
  changes: FrameChange[];
  at: number;
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
  /** 布局策略：稳定优先（增量）或紧凑优先（全量） */
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
