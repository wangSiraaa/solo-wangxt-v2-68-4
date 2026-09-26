import { describe, expect, it } from "vitest";
import {
  IncrementalInfeasibleError,
  baselineFromLayout,
  packFull,
  packIncremental,
  type IncFrameInput,
  type IncrementalOptions
} from "../../src/lib/core/incremental";
import { digestPixels } from "../../src/lib/core/digest";
import type { LayoutBaseline, Pixels } from "../../src/lib/core/types";

function input(id: string, w: number, h: number, digest = `dg-${id}`): IncFrameInput {
  return {
    id,
    name: `${id}.png`,
    w,
    h,
    trim: { x: 0, y: 0, w, h },
    srcW: w,
    srcH: h,
    duration: 100,
    digest
  };
}

function opts(over: Partial<IncrementalOptions> = {}): IncrementalOptions {
  return { padding: 2, maxSize: 1024, pot: true, trim: true, strategy: "stable", ...over };
}

/** 手工构造基线（内容坐标） */
function baseline(
  atlasWidth: number,
  atlasHeight: number,
  frames: Array<{ id: string; x: number; y: number; w: number; h: number; digest?: string }>,
  over: Partial<LayoutBaseline> = {}
): LayoutBaseline {
  return {
    atlasWidth,
    atlasHeight,
    padding: 0,
    trim: true,
    pot: false,
    frames: frames.map((f) => ({
      name: `${f.id}.png`,
      digest: f.digest ?? `dg-${f.id}`,
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h
    })),
    ...over
  };
}

function posOf(result: { layout: { frames: Array<{ name: string; x: number; y: number }> } }, id: string) {
  const f = result.layout.frames.find((x) => x.name === `${id}.png`);
  if (!f) throw new Error(`帧 ${id} 不在结果中`);
  return { x: f.x, y: f.y };
}

/** 校验结果中任意两帧（含留白）不重叠 */
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
      expect(a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b, `矩形 ${i} 与 ${j} 重叠`).toBe(false);
    }
  }
}

describe("digestPixels", () => {
  function px(w: number, h: number, fill: (i: number) => number): Pixels {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = fill(i);
    return { data, width: w, height: h };
  }

  it("相同像素与尺寸 → 相同摘要", () => {
    const a = px(4, 4, (i) => i % 251);
    const b = px(4, 4, (i) => i % 251);
    expect(digestPixels(a)).toBe(digestPixels(b));
  });

  it("像素不同 → 摘要不同", () => {
    const a = px(4, 4, () => 0);
    const b = px(4, 4, (i) => (i === 10 ? 255 : 0));
    expect(digestPixels(a)).not.toBe(digestPixels(b));
  });

  it("尺寸不同 → 摘要不同", () => {
    const a = px(4, 4, () => 7);
    const b = px(8, 2, () => 7);
    expect(digestPixels(a)).not.toBe(digestPixels(b));
  });
});

describe("packIncremental：新增塞入空洞", () => {
  it("新增帧能塞入删除留下的空洞时，旧帧零移动", () => {
    const base = packFull(
      [input("a", 40, 40), input("b", 40, 40), input("c", 20, 20), input("d", 30, 50)],
      null,
      opts(),
      "首次打包"
    );
    // 删除 c，新增一个比 c 的矩形更小的帧
    const next = [
      input("a", 40, 40),
      input("b", 40, 40),
      input("d", 30, 50),
      input("e", 12, 12) // 新增
    ];
    const r = packIncremental(next, base.baseline, opts());

    expect(r.summary.added).toBe(1);
    expect(r.summary.deleted).toBe(1);
    expect(r.summary.moved).toBe(0);
    expect(r.summary.kept).toBe(3);
    // 旧帧坐标与基线完全一致
    for (const id of ["a", "b", "d"]) {
      const before = base.layout.frames.find((f) => f.name === `${id}.png`)!;
      expect(posOf(r, id)).toEqual({ x: before.x, y: before.y });
    }
    // 图集尺寸不变
    expect(r.layout.atlasWidth).toBe(base.layout.atlasWidth);
    expect(r.layout.atlasHeight).toBe(base.layout.atlasHeight);
    expectNoOverlap(r.layout.frames, 2);
  });
});

describe("packIncremental：删除不压缩", () => {
  it("删除帧后其余帧保持原位，图集尺寸不变", () => {
    const base = packFull(
      [input("a", 100, 60), input("b", 30, 30), input("c", 50, 80), input("d", 20, 20)],
      null,
      opts(),
      "首次打包"
    );
    const r = packIncremental([input("a", 100, 60), input("c", 50, 80), input("d", 20, 20)], base.baseline, opts());

    expect(r.summary.deleted).toBe(1);
    expect(r.summary.moved).toBe(0);
    expect(r.summary.kept).toBe(3);
    expect(r.layout.atlasWidth).toBe(base.layout.atlasWidth);
    expect(r.layout.atlasHeight).toBe(base.layout.atlasHeight);
    for (const id of ["a", "c", "d"]) {
      const before = base.layout.frames.find((f) => f.name === `${id}.png`)!;
      expect(posOf(r, id)).toEqual({ x: before.x, y: before.y });
    }
  });
});

describe("packIncremental：替换为更大图像", () => {
  // 128×64 图集，四个 32×32 占据左侧两列四角；中间十字空洞放不下 40×40，
  // 但右侧 x≥96 有空列可容纳被挤走的帧
  const cornerBaseline = baseline(128, 64, [
    { id: "a", x: 0, y: 0, w: 32, h: 32 },
    { id: "b", x: 64, y: 0, w: 32, h: 32 },
    { id: "c", x: 0, y: 32, w: 32, h: 32 },
    { id: "d", x: 64, y: 32, w: 32, h: 32 }
  ]);
  const cornerOpts = opts({ padding: 0, pot: false, maxSize: 128 });

  it("只移动必要帧：被挤占的 1 帧迁移，其余保持原位", () => {
    const r = packIncremental(
      [
        input("a", 40, 40, "dg-a2"), // 同名内容变大 → 替换
        input("b", 32, 32),
        input("c", 32, 32),
        input("d", 32, 32)
      ],
      cornerBaseline,
      cornerOpts
    );

    expect(r.summary.replaced).toBe(1);
    expect(r.summary.moved).toBe(1); // 只有 c 被挤走
    expect(r.summary.kept).toBe(2);
    expect(posOf(r, "a")).toEqual({ x: 0, y: 0 }); // 替换帧回到原角落
    expect(posOf(r, "b")).toEqual({ x: 64, y: 0 }); // 未受影响的帧不动
    expect(posOf(r, "d")).toEqual({ x: 64, y: 32 });
    expect(posOf(r, "c")).not.toEqual({ x: 0, y: 32 }); // c 被迫迁移
    // 图集尺寸不变、无重叠
    expect(r.layout.atlasWidth).toBe(128);
    expect(r.layout.atlasHeight).toBe(64);
    expectNoOverlap(r.layout.frames, 0);
    // 坐标差异明细
    const movedC = r.summary.changes.find((c) => c.name === "c.png");
    expect(movedC).toMatchObject({ kind: "moved", from: { x: 0, y: 32 } });
    const replA = r.summary.changes.find((c) => c.name === "a.png");
    expect(replA).toMatchObject({ kind: "replaced", from: { x: 0, y: 0 }, to: { x: 0, y: 0 } });
  });

  it("替换为更小图像：旧帧零移动", () => {
    const r = packIncremental(
      [input("a", 20, 20, "dg-a3"), input("b", 32, 32), input("c", 32, 32), input("d", 32, 32)],
      cornerBaseline,
      cornerOpts
    );
    expect(r.summary.replaced).toBe(1);
    expect(r.summary.moved).toBe(0);
    expect(r.summary.kept).toBe(3);
    expect(posOf(r, "b")).toEqual({ x: 64, y: 0 });
    expect(posOf(r, "c")).toEqual({ x: 0, y: 32 });
    expect(posOf(r, "d")).toEqual({ x: 64, y: 32 });
  });
});

describe("packIncremental：增量不可行", () => {
  it("无法容纳时抛出 IncrementalInfeasibleError，且基线不被污染", () => {
    // 64×64 被四个 32×32 占满，maxSize=64 无法增长
    const full = baseline(64, 64, [
      { id: "a", x: 0, y: 0, w: 32, h: 32 },
      { id: "b", x: 32, y: 0, w: 32, h: 32 },
      { id: "c", x: 0, y: 32, w: 32, h: 32 },
      { id: "d", x: 32, y: 32, w: 32, h: 32 }
    ]);
    const snapshot = JSON.parse(JSON.stringify(full)) as unknown;
    const inputs = [
      input("a", 64, 64, "dg-a-big"), // 替换为占满整张图集的大图
      input("b", 32, 32),
      input("c", 32, 32),
      input("d", 32, 32)
    ];
    expect(() => packIncremental(inputs, full, opts({ padding: 0, pot: false, maxSize: 64 }))).toThrow(
      IncrementalInfeasibleError
    );
    // 基线对象未被修改
    expect(JSON.parse(JSON.stringify(full))).toEqual(snapshot);
  });
});

describe("packIncremental：图集增长", () => {
  it("空洞与驱逐都放不下时在 maxSize 内增长图集，旧帧零移动", () => {
    // 64×64 占满（POT），新帧太宽无法通过驱逐容纳，但增长后可以
    const full = baseline(
      64,
      64,
      [
        { id: "a", x: 0, y: 0, w: 32, h: 32 },
        { id: "b", x: 32, y: 0, w: 32, h: 32 },
        { id: "c", x: 0, y: 32, w: 32, h: 32 },
        { id: "d", x: 32, y: 32, w: 32, h: 32 }
      ],
      { pot: true }
    );
    const r = packIncremental(
      [input("a", 32, 32), input("b", 32, 32), input("c", 32, 32), input("d", 32, 32), input("e", 100, 60)],
      full,
      opts({ padding: 0, pot: true, maxSize: 256 })
    );
    expect(r.summary.added).toBe(1);
    expect(r.summary.moved).toBe(0);
    expect(r.summary.kept).toBe(4);
    // 旧帧坐标不变，图集按 POT 增长
    for (const [id, x, y] of [
      ["a", 0, 0],
      ["b", 32, 0],
      ["c", 0, 32],
      ["d", 32, 32]
    ] as const) {
      expect(posOf(r, id)).toEqual({ x, y });
    }
    expect(r.layout.atlasWidth).toBe(128);
    expect(r.layout.atlasHeight).toBe(128);
    expect(Math.log2(r.layout.atlasWidth) % 1).toBe(0);
    expectNoOverlap(r.layout.frames, 0);
  });
});

describe("packIncremental：重复执行不漂移", () => {
  it("完全相同输入重复打包，坐标与基线逐位一致", () => {
    const inputs = () => [input("a", 42, 48), input("b", 70, 40), input("c", 68, 68), input("d", 12, 12)];
    const first = packFull(inputs(), null, opts(), "首次打包");

    const second = packIncremental(inputs(), first.baseline, opts());
    expect(second.summary.kept).toBe(4);
    expect(second.summary.moved).toBe(0);
    expect(second.summary.added).toBe(0);
    expect(second.summary.deleted).toBe(0);
    expect(second.layout).toEqual(first.layout);
    expect(second.baseline).toEqual(first.baseline);

    // 再来一轮：仍然完全一致（无漂移）
    const third = packIncremental(inputs(), second.baseline, opts());
    expect(third.layout).toEqual(first.layout);
    expect(third.baseline).toEqual(first.baseline);
  });

  it("基线来自上一轮增量结果时也不漂移", () => {
    const first = packFull([input("a", 30, 30), input("b", 20, 20)], null, opts(), "首次打包");
    // 加一帧再打包（增量），然后原样重复
    const withC = [...[input("a", 30, 30), input("b", 20, 20)], input("c", 16, 16)];
    const second = packIncremental(withC, first.baseline, opts());
    const third = packIncremental(withC, second.baseline, opts());
    expect(third.layout).toEqual(second.layout);
    expect(third.summary.kept).toBe(3);
    expect(third.summary.moved).toBe(0);
  });
});

describe("packIncremental：设置变化回退全量", () => {
  it("留白变化 → 全量重排并给出原因", () => {
    const first = packFull([input("a", 30, 30), input("b", 20, 20)], null, opts(), "首次打包");
    const r = packIncremental([input("a", 30, 30), input("b", 20, 20)], first.baseline, opts({ padding: 5 }));
    expect(r.summary.fullRepack).toBe(true);
    expect(r.summary.reason).toContain("设置变化");
    expectNoOverlap(r.layout.frames, 5);
  });
});

describe("packFull：紧凑优先摘要", () => {
  it("与旧基线对比给出保持/移动统计", () => {
    const first = packFull([input("a", 30, 30), input("b", 20, 20)], null, opts(), "首次打包");
    // 加一帧后全量重排
    const r = packFull(
      [input("a", 30, 30), input("b", 20, 20), input("c", 200, 200)],
      first.baseline,
      opts({ strategy: "compact" }),
      "紧凑优先：全量重排"
    );
    expect(r.summary.fullRepack).toBe(true);
    expect(r.summary.strategy).toBe("compact");
    expect(r.summary.added).toBe(1);
    expect(r.summary.kept + r.summary.moved).toBe(2);
    expectNoOverlap(r.layout.frames, 2);
  });
});

describe("baselineFromLayout", () => {
  it("基线记录名称、摘要与内容坐标", () => {
    const r = packFull([input("a", 10, 10), input("b", 8, 12)], null, opts(), "首次打包");
    expect(r.baseline.frames).toHaveLength(2);
    for (const f of r.baseline.frames) {
      const packed = r.layout.frames.find((p) => p.name === f.name)!;
      expect([f.x, f.y, f.w, f.h]).toEqual([packed.x, packed.y, packed.w, packed.h]);
      expect(f.digest).toBe(`dg-${f.name.replace(".png", "")}`);
    }
    expect(r.baseline.padding).toBe(2);
  });
});
