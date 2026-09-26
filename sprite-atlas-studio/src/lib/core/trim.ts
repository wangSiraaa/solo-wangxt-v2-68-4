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

/**
 * 计算裁切后内容的摘要哈希。
 * 优先使用浏览器/Node 的 SubtleCrypto（SHA-256），不可用时退化为
 * FNV-1a 32 位（同样确定性，纯同步）。哈希只依赖 RGBA 字节与尺寸，
 * 因此同内容（含相同空白）必得同摘要；返回 hex 字符串。
 */
export async function hashPixels(pixels: Pixels): Promise<string> {
  const header = new Uint8Array(8);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, pixels.width >>> 0);
  dv.setUint32(4, pixels.height >>> 0);
  const bytes = concatBytes(header, pixels.data);

  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      // fall through to FNV-1a
    }
  }
  return "fnv1a:" + fnv1a(bytes);
}

function concatBytes(head: Uint8Array, body: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] ?? 0;
    // 32 位 FNV prime，用无符号乘并取模 2^32
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
