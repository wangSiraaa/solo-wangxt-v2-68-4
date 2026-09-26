import { describe, expect, it } from "vitest";
import {
  buildFullReport,
  packIncremental,
  type BaselineFrame,
  type IncrementalInput,
  type LayoutBaseline
} from "../../src/lib/core/incremental";
import { packFrames, type PackInput } from "../../src/lib/core/pack";

/** 构造一帧输入：hash 与 id 同名（测试里用名字+尺寸模拟内容摘要） */
function frame(
  name: string,
  w: number,
  h: number,
  hash?: string,
  extra?: Partial<IncrementalInput>
): IncrementalInput {
  return {
    id: name,
    name,
    w,
    h,
    trim: { x: 0, y: 0, w, h },
    srcW: w,
    srcH: h,
    duration: 100,
    hash: hash ?? `h:${name}:${w}x${h}`,
    ...extra
  };
}

function baselineOf(
  inputs: PackInput[],
  padding: number,
  maxSize: number,
  pot = true
): LayoutBaseline {
  const hashed = inputs as IncrementalInput[];
  const layout = packFrames(inputs, padding, maxSize, pot);
  const frames: BaselineFrame[] = layout.frames.map((f) => {
    const src = hashed.find((x) => x.id === f.id)!;
    return {
      name: f.name,
      w: f.w,
      h: f.h,
      trim: { ...f.trim },
      srcW: f.srcW,
      srcH: f.srcH,
      hash: src.hash ?? `h:${f.name}:${f.w}x${f.h}`,
      x: f.x,
      y: f.y
    };
  });
  return { atlasWidth: layout.atlasWidth, atlasHeight: layout.atlasHeight, frames };
}

function coords(b: LayoutBaseline): Record<string, [number, number]> {
  return Object.fromEntries(b.frames.map((f) => [f.name, [f.x, f.y]] as const));
}

/** 校验输出布局：含留白互不重叠、不越界 */
function expectValid(
  result: { layout: { atlasWidth: number; atlasHeight: number; frames: Array<{ name: string; x: number; y: number; w: number; h: number }> } },
  padding: number
): void {
  const boxes = result.layout.frames.map((f) => ({
    name: f.name,
    x: f.x - padding,
    y: f.y - padding,
    r: f.x + f.w + padding,
    b: f.y + f.h + padding
  }));
  for (const a of boxes) {
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.r).toBeLessThanOrEqual(result.layout.atlasWidth);
    expect(a.b).toBeLessThanOrEqual(result.layout.atlasHeight);
    for (const b of boxes) {
      if (a.name < b.name) {
        const overlap = a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
        expect(overlap, `${a.name} 与 ${b.name} 重叠`).toBe(false);
      }
    }
  }
}

describe("packIncremental：稳定布局增量重打包", () => {
  it("新增帧能塞进空洞时，旧帧零移动", () => {
    // 基线：4 帧小方块打包在一张图里，留出空洞
    const base = [frame("a", 40, 40), frame("b", 40, 40), frame("c", 40, 40), frame("d", 20, 20)];
    const padding = 2;
    const bl = baselineOf(base, padding, 128, false);
    const before = coords(bl);

    // 新增一个小于空洞的帧
    const next = [...base, frame("n", 12, 12)];
    const res = packIncremental(next, bl, { padding, maxSize: 128, pot: false, strategy: "stable" });
    expect(res).not.toBeNull();
    expectValid(res!, padding);

    // 所有旧帧坐标完全不变
    for (const f of next.slice(0, 4)) {
      const p = res!.layout.frames.find((x) => x.name === f.name)!;
      expect([p.x, p.y], f.name).toEqual(before[f.name]);
    }
    expect(res!.report.incremental).toBe(true);
    expect(res!.report.kept).toBe(4);
    expect(res!.report.moved).toBe(0);
    expect(res!.report.added).toBe(1);
    expect(res!.report.removed).toBe(0);
    expect(res!.report.replaced).toBe(0);
  });

  it("删除帧不主动压缩：其余帧不动，图集尺寸不缩小", () => {
    const base = [frame("a", 30, 30), frame("b", 30, 30), frame("c", 30, 30)];
    const padding = 2;
    const bl = baselineOf(base, padding, 128, false);
    const before = coords(bl);

    const next = [base[0]!, base[2]!]; // 删除 b
    const res = packIncremental(next, bl, { padding, maxSize: 128, pot: false, strategy: "stable" });
    expect(res).not.toBeNull();

    expect([res!.layout.frames.find((f) => f.name === "a")!.x, res!.layout.frames.find((f) => f.name === "a")!.y]).toEqual(before["a"]);
    expect([res!.layout.frames.find((f) => f.name === "c")!.x, res!.layout.frames.find((f) => f.name === "c")!.y]).toEqual(before["c"]);
    // 图集尺寸不主动收缩
    expect(res!.layout.atlasWidth).toBe(bl.atlasWidth);
    expect(res!.layout.atlasHeight).toBe(bl.atlasHeight);
    expect(res!.report.removed).toBe(1);
    expect(res!.report.moved).toBe(0);
    expect(res!.report.kept).toBe(2);
    const removedDelta = res!.report.deltas.find((d) => d.name === "b");
    expect(removedDelta?.kind).toBe("removed");
    expect(removedDelta?.to).toBeUndefined();
    expect(removedDelta?.from).toBeDefined();
  });

  it("替换为更大图像时只移动必要帧（原地放得下则零移动）", () => {
    const base = [frame("a", 20, 20), frame("b", 20, 20), frame("c", 20, 20), frame("d", 20, 20)];
    const padding = 1;
    const bl = baselineOf(base, padding, 128, false);
    const before = coords(bl);

    // 同名单帧放大，且新尺寸在原位置不与邻居冲突 → 零移动
    const grown = frame("a", 24, 24, "h:a:changed");
    const next0 = [grown, base[1]!, base[2]!, base[3]!];
    const res0 = packIncremental(next0, bl, { padding, maxSize: 128, pot: false, strategy: "stable" });
    expect(res0).not.toBeNull();
    expectValid(res0!, padding);
    expect(res0!.report.replaced).toBe(1);
    expect(res0!.report.moved).toBe(0);
    // 其余帧坐标不变
    for (const name of ["b", "c", "d"]) {
      const p = res0!.layout.frames.find((f) => f.name === name)!;
      expect([p.x, p.y], name).toEqual(before[name]);
    }
    const rep = res0!.report.deltas.find((d) => d.name === "a")!;
    expect(rep.kind).toBe("replaced");
    expect(rep.to!.w).toBe(24);
    expect(rep.to!.h).toBe(24);
  });

  it("替换为更大图像：原地/基线尺寸内能解决时只动替换帧，保留帧零移动", () => {
    // 基线：3 个横条堆叠在 64 宽内（每个 62×18，留白 1）
    const base = [frame("a", 62, 18), frame("b", 62, 18), frame("c", 62, 18)];
    const padding = 1;
    const bl = baselineOf(base, padding, 128, false);

    // 中间的 b 变高到 40：需要 42 的连续高度，放在底部即可，a、c 都不用动
    const grown = frame("b", 62, 40, "h:b:big");
    const next = [base[0]!, grown, base[2]!];
    const res = packIncremental(next, bl, { padding, maxSize: 128, pot: false, strategy: "stable" });
    expect(res, "放得下时应有方案").not.toBeNull();
    expectValid(res!, padding);

    const rep = res!.report.deltas.find((d) => d.name === "b")!;
    expect(rep.kind).toBe("replaced");
    expect(rep.dx === 0 && rep.dy !== 0).toBe(true); // 替换帧被下移
    expect(res!.report.moved).toBe(0); // 没有任何保留帧被移动
    expect(res!.report.kept).toBe(2);
    for (const name of ["a", "c"]) {
      const p = res!.layout.frames.find((f) => f.name === name)!;
      const o = bl.frames.find((f) => f.name === name)!;
      expect([p.x, p.y], name).toEqual([o.x, o.y]);
    }
  });

  it("替换为更大图像、必须挪动保留帧时只移动最少数量", () => {
    // 基线：2×2 排列的 4 个小方块；把 a 横向加宽到横贯整行，
    // 至多需要让同排的 1 个保留帧挪到下方空洞。
    const base = [frame("a", 30, 30), frame("b", 30, 30), frame("c", 30, 30), frame("d", 30, 30)];
    const padding = 1;
    const bl = baselineOf(base, padding, 128, false);

    const grown = frame("a", 62, 30, "h:a:wide");
    const next = [grown, ...base.filter((f) => f.name !== "a")];
    const res = packIncremental(next, bl, { padding, maxSize: 128, pot: false, strategy: "stable" });
    expect(res, "应能通过让出至多一帧解决").not.toBeNull();
    expectValid(res!, padding);

    expect(res!.report.deltas.find((d) => d.name === "a")!.kind).toBe("replaced");
    // 保留帧中最多 1 帧移动（最少必要移动）
    expect(res!.report.moved).toBeLessThanOrEqual(1);
    expect(res!.report.kept + res!.report.moved).toBe(3);
  });

  it("增量无法满足尺寸时返回 null（不产出布局，由调用方提示全量重排）", () => {
    const base = [frame("a", 100, 100), frame("b", 100, 100)];
    const padding = 0;
    // 基线本身需要 200×100
    const bl = baselineOf(base, padding, 256, false);
    expect(bl.atlasWidth).toBe(200);

    // 上限降到 128：两帧 100×100 无法同时放进 128×128（只能放下一个），任何让出都无解
    const res = packIncremental(base, bl, { padding, maxSize: 128, pot: false, strategy: "stable" });
    expect(res).toBeNull();
  });

  it("失败后取消不改变旧布局（store 语义由集成保证；此处基线对象未被修改）", () => {
    const base = [frame("a", 40, 40), frame("b", 40, 40)];
    const padding = 0;
    const bl = baselineOf(base, padding, 128, false);
    const snapshot = JSON.parse(JSON.stringify(bl));
    const next = [frame("a", 100, 100, "h:a:big"), frame("b", 100, 100, "h:b:big")];
    const res = packIncremental(next, bl, { padding, maxSize: 128, pot: false, strategy: "stable" });
    expect(res).toBeNull();
    // 基线未被污染
    expect(bl).toEqual(snapshot);
  });

  it("完全相同输入重复执行不产生漂移（坐标逐帧一致）", () => {
    const base = [
      frame("a", 42, 48),
      frame("b", 70, 40),
      frame("c", 68, 68),
      frame("d", 200, 150),
      frame("e", 12, 12)
    ];
    const padding = 2;
    const bl = baselineOf(base, padding, 512, true);

    const res1 = packIncremental(base, bl, { padding, maxSize: 512, pot: true, strategy: "stable" });
    const res2 = packIncremental(base, bl, { padding, maxSize: 512, pot: true, strategy: "stable" });
    expect(res1).not.toBeNull();
    expect(res2).not.toBeNull();
    const c1 = Object.fromEntries(res1!.layout.frames.map((f) => [f.name, [f.x, f.y]]));
    const c2 = Object.fromEntries(res2!.layout.frames.map((f) => [f.name, [f.x, f.y]]));
    expect(c2).toEqual(c1);
    // 与基线也完全一致
    expect(c1).toEqual(coords(bl));
    expect(res1!.report.kept).toBe(base.length);
    expect(res1!.report.moved + res1!.report.added + res1!.report.removed + res1!.report.replaced).toBe(0);
    expect(res1!.layout.atlasWidth).toBe(bl.atlasWidth);
    expect(res1!.layout.atlasHeight).toBe(bl.atlasHeight);
  });

  it("同名但哈希不变即保持；仅哈希变化（尺寸不变）也判为替换并原地保留", () => {
    const base = [frame("a", 30, 30), frame("b", 30, 30)];
    const padding = 0;
    const bl = baselineOf(base, padding, 64, false);
    // 尺寸不变、仅像素内容变化
    const next = [frame("a", 30, 30, "h:a:newpixels"), base[1]!];
    const res = packIncremental(next, bl, { padding, maxSize: 64, pot: false, strategy: "stable" });
    expect(res).not.toBeNull();
    expect(res!.report.replaced).toBe(1);
    expect(res!.report.moved).toBe(0);
    const a = res!.layout.frames.find((f) => f.name === "a")!;
    expect([a.x, a.y]).toEqual([bl.frames.find((f) => f.name === "a")!.x, bl.frames.find((f) => f.name === "a")!.y]);
  });

  it("删除后再新增：新帧使用空洞，幸存者零移动", () => {
    const base = [frame("a", 24, 24), frame("b", 24, 24), frame("c", 24, 24), frame("d", 24, 24)];
    const padding = 0;
    const bl = baselineOf(base, padding, 64, false);
    const before = coords(bl);

    const next = [base[0]!, base[1]!, base[2]!, frame("z", 24, 24)]; // d 删除，z 新增
    const res = packIncremental(next, bl, { padding, maxSize: 64, pot: false, strategy: "stable" });
    expect(res).not.toBeNull();
    expectValid(res!, padding);
    expect(res!.report.removed).toBe(1);
    expect(res!.report.added).toBe(1);
    expect(res!.report.moved).toBe(0);
    for (const name of ["a", "b", "c"]) {
      const p = res!.layout.frames.find((f) => f.name === name)!;
      expect([p.x, p.y], name).toEqual(before[name]);
    }
  });

  it("POT 模式：删除不压缩，新增在必要时才升到下一个 2 的幂", () => {
    const base = [frame("a", 20, 20), frame("b", 20, 20)];
    const padding = 0;
    const bl = baselineOf(base, padding, 256, true);
    const startW = bl.atlasWidth;
    const startH = bl.atlasHeight;
    // POT 下基线必为 2 的幂
    expect(Math.log2(startW) % 1).toBe(0);
    expect(Math.log2(startH) % 1).toBe(0);

    // 删除后不压缩：仍是同一 POT 尺寸
    const del = packIncremental([base[0]!], bl, { padding, maxSize: 256, pot: true, strategy: "stable" });
    expect(del).not.toBeNull();
    expect(del!.layout.atlasWidth).toBe(startW);
    expect(del!.layout.atlasHeight).toBe(startH);

    // 不断新增 20×20，直到起始 POT 放不下；每次旧帧都必须零移动，
    // 放不下时升到下一个 2 的幂（恰好 ×2）
    let cur = [...base];
    let prev = bl;
    let leveled = false;
    for (let i = 0; i < 12; i++) {
      cur = [...cur, frame(`n${i}`, 20, 20)];
      const r = packIncremental(cur, prev, { padding, maxSize: 256, pot: true, strategy: "stable" });
      expect(r, `第 ${i + 1} 次新增应能放下`).not.toBeNull();
      expectValid(r!, padding);
      expect(r!.report.moved, `第 ${i + 1} 次新增旧帧零移动`).toBe(0);
      const grown =
        r!.layout.atlasWidth > prev.atlasWidth || r!.layout.atlasHeight > prev.atlasHeight;
      if (grown) {
        leveled = true;
        expect(r!.layout.atlasWidth).toBeLessThanOrEqual(prev.atlasWidth * 2);
        expect(r!.layout.atlasHeight).toBeLessThanOrEqual(prev.atlasHeight * 2);
        break;
      }
      prev = {
        atlasWidth: r!.layout.atlasWidth,
        atlasHeight: r!.layout.atlasHeight,
        frames: r!.layout.frames.map((f) => ({
          name: f.name,
          w: f.w,
          h: f.h,
          trim: f.trim,
          srcW: f.srcW,
          srcH: f.srcH,
          hash: f.hash ?? `h:${f.name}`,
          x: f.x,
          y: f.y
        }))
      };
    }
    expect(leveled, "新增足够多帧后应升级到下一个 POT").toBe(true);
  });

  it("buildFullReport：紧凑优先全量重排时正确统计差异", () => {
    const base = [frame("a", 20, 20), frame("b", 20, 20), frame("c", 20, 20)];
    const bl = baselineOf(base, 0, 64, false);

    const next = [frame("a", 20, 20), frame("c", 20, 20), frame("n", 30, 30)]; // 删 b，新增 n
    const layout = packFrames(next, 0, 64, false);
    const report = buildFullReport(next, layout, bl, "compact");
    expect(report.incremental).toBe(false);
    expect(report.strategy).toBe("compact");
    expect(report.added).toBe(1);
    expect(report.removed).toBe(1);
    // 坐标变化的帧按 moved/kept 归类，总数守恒
    expect(report.kept + report.moved + report.replaced + report.added).toBe(3);
  });

  // ---------- 随机属性：与「暴力最少移动」参考实现对比 ----------

  // 独立的自由矩形表（与实现同思路但独立编写），带回溯放置
  interface BR { x: number; y: number; w: number; h: number }
  function freeAfterOne(f: BR, r: BR): BR[] {
    const out: BR[] = [];
    if (!(r.x < f.x + f.w && f.x < r.x + r.w && r.y < f.y + f.h && f.y < r.y + r.h)) return [f];
    if (r.x > f.x) out.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
    if (r.x + r.w < f.x + f.w) out.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - r.x - r.w, h: f.h });
    if (r.y > f.y) out.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
    if (r.y + r.h < f.y + f.h) out.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - r.y - r.h });
    return out;
  }
  function occupies(free: BR[], r: BR): BR[] {
    let next: BR[] = [];
    for (const f of free) next = next.concat(freeAfterOne(f, r));
    return next.filter((a, i) =>
      !next.some((b, j) =>
        j !== i &&
        b.x <= a.x && b.y <= a.y &&
        b.x + b.w >= a.x + a.w && b.y + b.h >= a.y + a.h &&
        (b.w * b.h > a.w * a.h || (b.w * b.h === a.w * a.h && j < i))
      )
    );
  }
  /** 回溯放置：在 free 中放置 rects（大的先放），找到一个可行解 */
  function canPack(free: BR[], rects: BR[]): boolean {
    if (rects.length === 0) return true;
    const [r0, ...rest] = [...rects].sort((a, b) => b.w * b.h - a.w * a.h);
    const r = r0!;
    const candidates = new Set<string>();
    for (const f of free) {
      if (f.w >= r.w && f.h >= r.h) {
        candidates.add(`${f.x},${f.y}`); // 自由矩形左上角
        candidates.add(`${f.x + f.w - r.w},${f.y}`);
        candidates.add(`${f.x},${f.y + f.h - r.h}`);
        candidates.add(`${f.x + f.w - r.w},${f.y + f.h - r.h}`);
      }
    }
    for (const c of candidates) {
      const [cx, cy] = c.split(",").map(Number);
      const box = { x: cx!, y: cy!, w: r.w, h: r.h };
      if (canPack(occupies(free, box), rest)) return true;
    }
    return false;
  }

  /** 暴力：枚举保留帧固定子集（2^k），返回能让全部帧落位时「被移动保留帧数」的最小值 */
  function bruteMinMoves(
    next: IncrementalInput[],
    bl: LayoutBaseline,
    padding: number,
    boundW: number,
    boundH: number
  ): number | null {
    const old = new Map(bl.frames.map((f) => [f.name, f]));
    const kept = next.filter((f) => {
      const o = old.get(f.name);
      return o && o.hash === f.hash && o.w === f.w && o.h === f.h;
    });
    const pad2 = padding * 2;
    const boxAt = (name: string, w: number, h: number): BR => {
      const o = old.get(name)!;
      return { x: o.x - padding, y: o.y - padding, w: w + pad2, h: h + pad2 };
    };

    let best: number | null = null;
    const k = kept.length;
    for (let mask = 0; mask < 1 << k; mask++) {
      const movedCount = k - countBits(mask);
      if (best !== null && movedCount >= best) continue;
      let free: BR[] = [{ x: 0, y: 0, w: boundW, h: boundH }];
      let ok = true;
      // 固定该子集中的保留帧
      kept.forEach((f, i) => {
        if (!ok) return;
        if (mask & (1 << i)) {
          const b = boxAt(f.name, f.w, f.h);
          if (!free.some((fr) => fr.x <= b.x && fr.y <= b.y && fr.x + fr.w >= b.x + b.w && fr.y + fr.h >= b.y + b.h)) {
            ok = false;
            return;
          }
          free = occupies(free, b);
        }
      });
      if (!ok) continue;
      // 其余帧（移动的保留帧 + 替换帧 + 新增帧）作为自由矩形
      const loose: BR[] = [];
      for (const f of next) {
        const isFixedKept = (() => {
          const idx = kept.findIndex((x) => x.name === f.name);
          return idx >= 0 && (mask & (1 << idx)) !== 0;
        })();
        if (isFixedKept) continue;
        loose.push({ x: 0, y: 0, w: f.w + pad2, h: f.h + pad2 });
      }
      if (canPack(free, loose)) best = movedCount;
    }
    return best;
  }

  function countBits(n: number): number {
    let c = 0;
    while (n) { c += n & 1; n >>= 1; }
    return c;
  }

  it("随机场景：启发式移动的保留帧数等于暴力最小值（含可行性一致）", () => {
    let seed = 0x12345678;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0x100000000;
    };
    const names = ["a", "b", "c", "d", "e", "f"];
    let checked = 0;
    for (let trial = 0; trial < 150; trial++) {
      const padding = Math.floor(rnd() * 3);
      const maxSize = [64, 96, 128][Math.floor(rnd() * 3)]!;
      // 基线：3~5 帧
      const n0 = 3 + Math.floor(rnd() * 3);
      const baseInputs: IncrementalInput[] = names.slice(0, n0).map((name) =>
        frame(name, 10 + Math.floor(rnd() * 34), 10 + Math.floor(rnd() * 34))
      );
      let bl: LayoutBaseline;
      try {
        bl = baselineOf(baseInputs, padding, maxSize, false);
      } catch {
        continue; // 基线本身放不下
      }

      // 随机变更：增/删/替换
      let next = baseInputs.map((f) => ({ ...f }));
      if (rnd() < 0.5 && next.length > 2) {
        const i = Math.floor(rnd() * next.length);
        next = next.filter((_, j) => j !== i); // 删除
      }
      if (rnd() < 0.6 && next.length > 0) {
        const i = Math.floor(rnd() * next.length);
        const f = next[i]!;
        next[i] = frame(f.name, 10 + Math.floor(rnd() * 40), 10 + Math.floor(rnd() * 40), `h:${f.name}:new${trial}`);
      }
      if (rnd() < 0.6) {
        next.push(frame(`z${trial}`, 8 + Math.floor(rnd() * 30), 8 + Math.floor(rnd() * 30)));
      }

      const res = packIncremental(next, bl, { padding, maxSize, pot: false, strategy: "stable" });
      // 暴力参考：在 maxSize 边界内的最小移动数
      const brute = bruteMinMoves(next, bl, padding, maxSize, maxSize);

      if (brute === null) {
        expect(res, `trial ${trial}: 暴力无解时启发式也必须返回 null`).toBeNull();
      } else {
        expect(res, `trial ${trial}: 暴力有解时启发式应有解`).not.toBeNull();
        // 启发式报告的 moved（保留帧移动数）不得超过暴力最小值
        expect(res!.report.moved, `trial ${trial} 移动数应最少`).toBeLessThanOrEqual(brute);
        // 且不能低于（不可能比最优更好）
        expect(res!.report.moved).toBeGreaterThanOrEqual(brute);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(80);
  });
});
