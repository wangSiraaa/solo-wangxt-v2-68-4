import { describe, expect, it } from "vitest";
import { computeAlphaBBox, nextPow2 } from "../../src/lib/core/trim";
import type { Pixels } from "../../src/lib/core/types";

function makePixels(w: number, h: number, opaque: Array<[number, number]>): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const [x, y] of opaque) {
    const i = (y * w + x) * 4;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

describe("computeAlphaBBox", () => {
  it("计算含透明边缘图的包围盒", () => {
    // 10x6，内容在 (2..6, 1..4)
    const opaque: Array<[number, number]> = [];
    for (let y = 1; y <= 4; y++) for (let x = 2; x <= 6; x++) opaque.push([x, y]);
    const bbox = computeAlphaBBox(makePixels(10, 6, opaque));
    expect(bbox).toEqual({ x: 2, y: 1, w: 5, h: 4 });
  });

  it("完全透明时返回 null", () => {
    expect(computeAlphaBBox(makePixels(8, 8, []))).toBeNull();
  });

  it("完全不透明时返回整图", () => {
    const opaque: Array<[number, number]> = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) opaque.push([x, y]);
    expect(computeAlphaBBox(makePixels(4, 4, opaque))).toEqual({ x: 0, y: 0, w: 4, h: 4 });
  });

  it("单个像素", () => {
    expect(computeAlphaBBox(makePixels(5, 5, [[3, 2]]))).toEqual({ x: 3, y: 2, w: 1, h: 1 });
  });

  it("alpha 阈值：半透明像素低于阈值视为透明", () => {
    const p = makePixels(4, 4, [[1, 1]]);
    p.data[(1 * 4 + 1) * 4 + 3] = 100;
    expect(computeAlphaBBox(p, 0)).not.toBeNull();
    expect(computeAlphaBBox(p, 100)).toBeNull();
  });
});

describe("nextPow2", () => {
  it("向上取 2 的幂", () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(2)).toBe(2);
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(300)).toBe(512);
    expect(nextPow2(1024)).toBe(1024);
    expect(nextPow2(1025)).toBe(2048);
  });
});
