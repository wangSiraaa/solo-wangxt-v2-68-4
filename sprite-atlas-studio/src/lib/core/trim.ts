import type { Pixels, TrimRect } from "./types";

/**
 * 计算 alpha 通道的包围盒（用于裁切透明边缘）。
 * 纯函数，只依赖像素数据，可在浏览器与 Node 中运行。
 *
 * @param pixels RGBA 像素
 * @param threshold alpha 大于该值视为不透明（0-255）
 * @returns 内容包围盒；完全透明时返回 null
 */
export function computeAlphaBBox(pixels: Pixels, threshold = 0): TrimRect | null {
  const { data, width, height } = pixels;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const a = data[(row + x) * 4 + 3];
      if (a !== undefined && a > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null; // 完全透明
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 2 的幂向上取整（至少为 1） */
export function nextPow2(n: number): number {
  if (n <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(n));
}
