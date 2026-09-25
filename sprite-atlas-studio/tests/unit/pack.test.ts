import { describe, expect, it } from "vitest";
import { packFrames, type PackInput } from "../../src/lib/core/pack";

function input(id: string, w: number, h: number, duration = 100): PackInput {
  return {
    id,
    name: `${id}.png`,
    w,
    h,
    trim: { x: 0, y: 0, w, h },
    srcW: w,
    srcH: h,
    duration
  };
}

/** 检查任意两个「含留白」的矩形不重叠 */
function expectNoOverlap(
  frames: Array<{ x: number; y: number; w: number; h: number }>,
  padding: number
): void {
  const boxes = frames.map((f) => ({
    l: f.x - padding,
    t: f.y - padding,
    r: f.x + f.w + padding,
    b: f.y + f.h + padding
  }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlap = a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
      expect(overlap, `矩形 ${i} 与 ${j} 重叠（留白被侵犯）`).toBe(false);
    }
  }
}

describe("packFrames", () => {
  it("不同尺寸混合打包：位置含留白、互不重叠、保持原顺序", () => {
    const inputs = [
      input("a", 42, 48, 50),
      input("b", 70, 40, 80),
      input("c", 68, 68, 120),
      input("d", 200, 150, 100),
      input("e", 12, 12, 60)
    ];
    const padding = 2;
    const layout = packFrames(inputs, padding, 1024, true);

    // 顺序保持
    expect(layout.frames.map((f) => f.id)).toEqual(["a", "b", "c", "d", "e"]);
    // 内容尺寸与输入一致（未被旋转）
    for (const [i, f] of layout.frames.entries()) {
      expect(f.w).toBe(inputs[i]!.w);
      expect(f.h).toBe(inputs[i]!.h);
      // 位置至少留出 padding
      expect(f.x).toBeGreaterThanOrEqual(padding);
      expect(f.y).toBeGreaterThanOrEqual(padding);
      // 在图集范围内
      expect(f.x + f.w + padding).toBeLessThanOrEqual(layout.atlasWidth);
      expect(f.y + f.h + padding).toBeLessThanOrEqual(layout.atlasHeight);
    }
    expectNoOverlap(layout.frames, padding);
  });

  it("POT：图集尺寸为 2 的幂", () => {
    const layout = packFrames([input("a", 100, 100), input("b", 50, 70)], 2, 1024, true);
    expect(Math.log2(layout.atlasWidth) % 1).toBe(0);
    expect(Math.log2(layout.atlasHeight) % 1).toBe(0);
  });

  it("非 POT：图集尺寸等于实际占用范围", () => {
    const layout = packFrames([input("a", 10, 10)], 0, 1024, false);
    expect(layout.atlasWidth).toBe(10);
    expect(layout.atlasHeight).toBe(10);
  });

  it("留白为 0 时内容坐标即矩形坐标", () => {
    const layout = packFrames([input("a", 10, 10), input("b", 20, 5)], 0, 1024, false);
    expectNoOverlap(layout.frames, 0);
    for (const f of layout.frames) {
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("单帧超过图集上限时报错", () => {
    expect(() => packFrames([input("big", 300, 300)], 0, 256, true)).toThrow(/超过图集上限/);
  });

  it("整体放不进单张图集时报错", () => {
    const many = Array.from({ length: 20 }, (_, i) => input(`f${i}`, 200, 200));
    expect(() => packFrames(many, 0, 512, true)).toThrow(/图集尺寸不足/);
  });

  it("时长随帧保留", () => {
    const layout = packFrames([input("a", 10, 10, 33), input("b", 10, 10, 77)], 1, 256, true);
    expect(layout.frames[0]!.duration).toBe(33);
    expect(layout.frames[1]!.duration).toBe(77);
  });
});
