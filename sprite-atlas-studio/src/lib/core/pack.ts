import { MaxRectsPacker } from "maxrects-packer";
import type { PackedFrame, TrimRect } from "./types";
import { nextPow2 } from "./trim";

/** 参与打包的单帧输入（尺寸为裁切后的内容尺寸） */
export interface PackInput {
  id: string;
  name: string;
  /** 内容宽（裁切后） */
  w: number;
  /** 内容高（裁切后） */
  h: number;
  trim: TrimRect;
  srcW: number;
  srcH: number;
  duration: number;
}

export interface PackLayout {
  atlasWidth: number;
  atlasHeight: number;
  /** 与输入同顺序 */
  frames: PackedFrame[];
}

interface PlacedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  oversized: boolean;
  data: { id: string };
}

/**
 * 用 maxrects-packer 打包矩形。
 * - 固定方向：allowRotation = false，绝不旋转。
 * - 统一留白：把每个矩形放大 padding*2 后再打包，
 *   内容实际绘制在 (x + padding, y + padding)，保证四周留白一致。
 * - 图集尺寸 = 实际占用范围（可选向上取 2 的幂），不超过 maxSize。
 *
 * @throws 当任何帧超出 maxSize 或整体放不进单张图集时抛错
 */
export function packFrames(
  inputs: PackInput[],
  padding: number,
  maxSize: number,
  pot: boolean
): PackLayout {
  if (inputs.length === 0) throw new Error("没有可打包的帧");
  if (padding < 0) throw new Error("留白不能为负数");

  const packer = new MaxRectsPacker(maxSize, maxSize, 0, {
    smart: true,
    pot: false, // 图集最终尺寸由我们按占用范围计算，packer 只负责布局
    square: false,
    allowRotation: false, // 固定方向，不旋转
    border: 0
  });

  for (const f of inputs) {
    packer.add(f.w + padding * 2, f.h + padding * 2, { id: f.id });
  }

  const placed = packer.rects as unknown as PlacedRect[];

  const oversized = placed.filter((r) => r.oversized);
  if (oversized.length > 0) {
    const names = oversized
      .map((r) => inputs.find((f) => f.id === r.data?.id)?.name ?? r.data?.id)
      .join("、");
    throw new Error(`帧 ${names} 加上留白后超过图集上限 ${maxSize}×${maxSize}`);
  }
  // 每个矩形都一定能放进某个 bin；出现多个 bin 说明一张图集放不下
  if (packer.bins.length > 1) {
    throw new Error(
      `图集尺寸不足：${inputs.length} 帧无法全部放入 ${maxSize}×${maxSize}，请调大图集最大边长或减少留白`
    );
  }

  const byId = new Map(placed.map((r) => [r.data.id, r]));

  // 实际占用范围（含留白）
  let usedW = 0;
  let usedH = 0;
  for (const r of placed) {
    usedW = Math.max(usedW, r.x + r.width);
    usedH = Math.max(usedH, r.y + r.height);
  }
  const atlasWidth = pot ? nextPow2(usedW) : usedW;
  const atlasHeight = pot ? nextPow2(usedH) : usedH;
  if (atlasWidth > maxSize || atlasHeight > maxSize) {
    throw new Error(`图集尺寸不足：需要 ${atlasWidth}×${atlasHeight}，超过上限 ${maxSize}`);
  }

  // 按输入顺序输出，内容坐标 = 矩形坐标 + padding
  const frames: PackedFrame[] = inputs.map((f) => {
    const r = byId.get(f.id);
    if (!r) throw new Error(`帧 ${f.name} 未能放入图集`);
    return {
      id: f.id,
      name: f.name,
      x: r.x + padding,
      y: r.y + padding,
      w: f.w,
      h: f.h,
      trim: f.trim,
      srcW: f.srcW,
      srcH: f.srcH,
      duration: f.duration
    };
  });

  return { atlasWidth, atlasHeight, frames };
}
