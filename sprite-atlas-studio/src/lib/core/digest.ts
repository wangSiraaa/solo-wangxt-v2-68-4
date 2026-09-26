import type { Pixels } from "./types";

/**
 * 帧内容摘要：对解码后的 RGBA 像素（含尺寸）计算 cyrb53 散列。
 * - 纯函数、同步，浏览器与 Node 行为一致；
 * - 作用于解码像素而非 PNG 字节，因此重新编码（导出→导入恢复）
 *   只要像素一致，摘要就不变，帧身份得以保持。
 */
export function digestPixels(pixels: Pixels): string {
  const { data, width, height } = pixels;
  // cyrb53，种子混入尺寸，使同像素不同尺寸也有不同摘要
  let h1 = 0xdeadbeef ^ (width * 0x9e3779b1) ^ data.length;
  let h2 = 0x41c6ce57 ^ (height * 0x85ebca6b) ^ data.length;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!;
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  // 53 位散列，输出定长十六进制字符串
  const h = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${width}x${height}:${h.toString(16)}`;
}
