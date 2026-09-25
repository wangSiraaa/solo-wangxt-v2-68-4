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
}

export const DEFAULT_SETTINGS: Settings = {
  trim: true,
  padding: 2,
  maxSize: 2048,
  pot: true,
  embedAtlas: true
};

/** 类 ImageData 的最小结构，便于在 Node 中测试 */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
