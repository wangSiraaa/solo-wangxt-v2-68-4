import { describe, expect, it } from "vitest";
import { Animator, frameIndexAt, totalDuration } from "../../src/lib/core/animator";

describe("frameIndexAt", () => {
  const d = [100, 200, 50]; // 总时长 350

  it("按每帧时长定位", () => {
    expect(frameIndexAt(d, 0)).toBe(0);
    expect(frameIndexAt(d, 99)).toBe(0);
    expect(frameIndexAt(d, 100)).toBe(1);
    expect(frameIndexAt(d, 299)).toBe(1);
    expect(frameIndexAt(d, 300)).toBe(2);
    expect(frameIndexAt(d, 349)).toBe(2);
  });

  it("超过一轮自动循环", () => {
    expect(frameIndexAt(d, 350)).toBe(0);
    expect(frameIndexAt(d, 450)).toBe(1);
    expect(frameIndexAt(d, 700)).toBe(0);
  });

  it("totalDuration 正确", () => {
    expect(totalDuration(d)).toBe(350);
    expect(totalDuration([])).toBe(0);
  });
});

describe("Animator", () => {
  it("按 deltaMs 逐帧推进", () => {
    const a = new Animator([100, 200, 50]);
    expect(a.tick(16)).toBe(0);
    expect(a.tick(90)).toBe(1); // 累计 106 → 帧1
    expect(a.tick(199)).toBe(2); // 累计 305 → 帧2（起点 300）
    expect(a.tick(50)).toBe(0); // 累计 355 → 循环回 0
  });

  it("大跨度 delta 直接跳到正确帧", () => {
    const a = new Animator([100, 100, 100]);
    expect(a.tick(250)).toBe(2);
    expect(a.tick(300)).toBe(2); // 550 % 300 = 250 → 帧2
    expect(a.tick(60)).toBe(0); // 610 % 300 = 10 → 帧0
  });

  it("暂停时不推进", () => {
    const a = new Animator([100, 100]);
    a.playing = false;
    expect(a.tick(500)).toBe(0);
  });

  it("时长更新后下标收敛", () => {
    const a = new Animator([100, 100, 100, 100]);
    a.tick(350);
    expect(a.index).toBe(3);
    a.setDurations([100, 100]);
    expect(a.index).toBeLessThan(2);
  });
});
