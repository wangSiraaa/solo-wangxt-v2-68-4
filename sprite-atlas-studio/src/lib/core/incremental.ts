import { packFrames, type PackInput, type PackLayout } from "./pack";
import { nextPow2 } from "./trim";
import type {
  BaselineFrame,
  FrameChange,
  LayoutBaseline,
  PackStrategy,
  PackSummary,
  PackedFrame
} from "./types";

/**
 * 稳定布局的增量重打包。
 *
 * 帧身份 = 逻辑名称 + 内容摘要（digest）：
 * - 名称与摘要都不变 → 保持（kept），复用基线坐标；
 * - 名称相同但摘要变化 → 替换（replaced），旧矩形释放为空洞，新内容重新放置；
 * - 名称不在基线 → 新增（added）；基线中消失的名称 → 删除（deleted）。
 *
 * 放置顺序（稳定优先）：
 * 1. 未变化帧固定在基线坐标，新增/替换帧优先塞进既有空洞（零移动）；
 * 2. 塞不下时做「最小驱逐」：选择重叠帧数最少的位置，只移动必要帧
 *    （每个基线帧最多被驱逐一次，保证终止且无环）；
 * 3. 仍放不下时在 maxSize 内增长图集（旧帧坐标不变）；
 * 4. 以上都失败 → 抛出 IncrementalInfeasibleError，由调用方提示全量重排或取消。
 *
 * 本模块全部为纯函数，不修改传入的 baseline，失败/取消不会污染旧布局。
 */

export interface IncFrameInput extends PackInput {
  /** 内容摘要（digestPixels） */
  digest: string;
}

export interface IncrementalOptions {
  padding: number;
  maxSize: number;
  pot: boolean;
  trim: boolean;
  strategy: PackStrategy;
  /** 单次放置允许驱逐的最大帧数，超出判定增量不可行（默认 4） */
  maxEvictPerFrame?: number;
}

export interface IncrementalResult {
  layout: PackLayout;
  baseline: LayoutBaseline;
  summary: PackSummary;
}

/** 增量布局无法满足尺寸时抛出（调用方应提示全量重排或取消保留旧布局） */
export class IncrementalInfeasibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncrementalInfeasibleError";
  }
}

// ---------- 空闲矩形（maximal free rects） ----------

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** 从空闲矩形列表中减去已放置矩形，返回新的最大空闲矩形列表 */
function subtractRect(free: Rect[], p: Rect): Rect[] {
  const out: Rect[] = [];
  for (const f of free) {
    if (!intersects(f, p)) {
      out.push(f);
      continue;
    }
    if (p.x > f.x) out.push({ x: f.x, y: f.y, w: p.x - f.x, h: f.h });
    if (p.x + p.w < f.x + f.w) out.push({ x: p.x + p.w, y: f.y, w: f.x + f.w - (p.x + p.w), h: f.h });
    if (p.y > f.y) out.push({ x: f.x, y: f.y, w: f.w, h: p.y - f.y });
    if (p.y + p.h < f.y + f.h) out.push({ x: f.x, y: p.y + p.h, w: f.w, h: f.y + f.h - (p.y + p.h) });
  }
  // 剔除被包含的矩形（完全相同的保留索引较小者），保持「最大」性质
  const pruned: Rect[] = [];
  for (let i = 0; i < out.length; i++) {
    const r = out[i]!;
    if (r.w <= 0 || r.h <= 0) continue;
    let contained = false;
    for (let j = 0; j < out.length; j++) {
      if (i === j) continue;
      const o = out[j]!;
      if (o.w <= 0 || o.h <= 0) continue;
      if (!containsRect(o, r)) continue;
      const same = o.x === r.x && o.y === r.y && o.w === r.w && o.h === r.h;
      if (!same || j < i) {
        contained = true;
        break;
      }
    }
    if (!contained) pruned.push(r);
  }
  return pruned;
}

/** 在空闲矩形中找最佳位置（短边剩余最小；平局依次比较长边剩余、y、x，保证确定性） */
function findFreeRect(free: Rect[], rw: number, rh: number): number {
  let best = -1;
  let bestShort = Infinity;
  let bestLong = Infinity;
  let bestY = Infinity;
  let bestX = Infinity;
  for (let i = 0; i < free.length; i++) {
    const f = free[i]!;
    if (rw > f.w || rh > f.h) continue;
    const short = Math.min(f.w - rw, f.h - rh);
    const long = Math.max(f.w - rw, f.h - rh);
    if (
      short < bestShort ||
      (short === bestShort && long < bestLong) ||
      (short === bestShort && long === bestLong && (f.y < bestY || (f.y === bestY && f.x < bestX)))
    ) {
      best = i;
      bestShort = short;
      bestLong = long;
      bestY = f.y;
      bestX = f.x;
    }
  }
  return best;
}

// ---------- 基线与摘要 ----------

/** 由布局结果生成新的基线 */
export function baselineFromLayout(
  layout: PackLayout,
  inputs: IncFrameInput[],
  opts: { padding: number; trim: boolean; pot: boolean }
): LayoutBaseline {
  const digestById = new Map(inputs.map((i) => [i.id, i.digest]));
  return {
    atlasWidth: layout.atlasWidth,
    atlasHeight: layout.atlasHeight,
    padding: opts.padding,
    trim: opts.trim,
    pot: opts.pot,
    frames: layout.frames.map((f) => ({
      name: f.name,
      digest: digestById.get(f.id) ?? "",
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h
    }))
  };
}

/** 对比布局结果与旧基线，生成逐帧坐标差异摘要 */
export function diffSummary(
  layout: PackLayout,
  inputs: IncFrameInput[],
  old: LayoutBaseline | null,
  strategy: PackStrategy,
  fullRepack: boolean,
  reason?: string
): PackSummary {
  const baseByName = new Map<string, BaselineFrame>((old?.frames ?? []).map((f) => [f.name, f]));
  const digestById = new Map(inputs.map((i) => [i.id, i.digest]));
  const changes: FrameChange[] = [];
  let kept = 0;
  let moved = 0;
  let added = 0;
  let replaced = 0;

  for (const f of layout.frames) {
    const base = baseByName.get(f.name);
    const digest = digestById.get(f.id) ?? "";
    const to = { x: f.x, y: f.y };
    if (!base) {
      added++;
      changes.push({ name: f.name, kind: "added", to });
    } else if (base.digest !== digest || base.w !== f.w || base.h !== f.h) {
      replaced++;
      changes.push({ name: f.name, kind: "replaced", from: { x: base.x, y: base.y }, to });
    } else if (base.x !== f.x || base.y !== f.y) {
      moved++;
      changes.push({ name: f.name, kind: "moved", from: { x: base.x, y: base.y }, to });
    } else {
      kept++;
      changes.push({ name: f.name, kind: "kept", from: { x: base.x, y: base.y }, to });
    }
  }

  let deleted = 0;
  const currentNames = new Set(layout.frames.map((f) => f.name));
  for (const b of old?.frames ?? []) {
    if (!currentNames.has(b.name)) {
      deleted++;
      changes.push({ name: b.name, kind: "deleted", from: { x: b.x, y: b.y } });
    }
  }

  return {
    strategy,
    fullRepack,
    ...(reason ? { reason } : {}),
    kept,
    moved,
    added,
    replaced,
    deleted,
    changes,
    at: Date.now()
  };
}

/** 全量重排（紧凑优先 / 设置变化 / 增量失败后的回退） */
export function packFull(
  inputs: IncFrameInput[],
  oldBaseline: LayoutBaseline | null,
  opts: IncrementalOptions,
  reason: string
): IncrementalResult {
  const layout = packFrames(inputs, opts.padding, opts.maxSize, opts.pot);
  const baseline = baselineFromLayout(layout, inputs, opts);
  const summary = diffSummary(layout, inputs, oldBaseline, opts.strategy, true, reason);
  return { layout, baseline, summary };
}

// ---------- 增量重打包 ----------

interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function packIncremental(
  inputs: IncFrameInput[],
  baseline: LayoutBaseline,
  opts: IncrementalOptions
): IncrementalResult {
  if (inputs.length === 0) throw new Error("没有可打包的帧");
  const { padding, maxSize, pot } = opts;
  const maxEvict = opts.maxEvictPerFrame ?? 4;

  // 基线兼容性：留白/裁切/POT 变化或基线超出当前上限时，坐标无法复用 → 全量重排
  const compatible =
    baseline.frames.length > 0 &&
    baseline.padding === padding &&
    baseline.trim === opts.trim &&
    baseline.pot === pot &&
    baseline.atlasWidth <= maxSize &&
    baseline.atlasHeight <= maxSize;
  if (!compatible) {
    return packFull(inputs, baseline, opts, "打包设置变化，无法复用原布局，已全量重排");
  }

  // 分类：保持 / 替换 / 新增 / 删除
  const baseByName = new Map<string, BaselineFrame>(baseline.frames.map((f) => [f.name, f]));
  const currentNames = new Set(inputs.map((i) => i.name));
  interface ToPlace {
    input: IncFrameInput;
    replacedFrom?: BaselineFrame;
  }
  const keptInputs: Array<{ input: IncFrameInput; base: BaselineFrame }> = [];
  const toPlace: ToPlace[] = [];
  for (const input of inputs) {
    const b = baseByName.get(input.name);
    if (b && b.digest === input.digest && b.w === input.w && b.h === input.h) {
      keptInputs.push({ input, base: b });
    } else if (b) {
      toPlace.push({ input, replacedFrom: b });
    } else {
      toPlace.push({ input });
    }
  }
  const deletedFrames = baseline.frames.filter((b) => !currentNames.has(b.name));

  let W = baseline.atlasWidth;
  let H = baseline.atlasHeight;

  // 放置状态：evictable = 未动过的基线帧（可被驱逐一次）；fixed = 新放置或已迁移的帧（不可驱逐）
  const evictable = new Map<string, Placed>();
  const fixed = new Map<string, Placed>();
  for (const { input, base } of keptInputs) {
    evictable.set(input.name, { x: base.x, y: base.y, w: base.w, h: base.h });
  }

  const toRect = (p: Placed): Rect => ({
    x: p.x - padding,
    y: p.y - padding,
    w: p.w + padding * 2,
    h: p.h + padding * 2
  });

  const computeFree = (): Rect[] => {
    let free: Rect[] = [{ x: 0, y: 0, w: W, h: H }];
    for (const p of evictable.values()) free = subtractRect(free, toRect(p));
    for (const p of fixed.values()) free = subtractRect(free, toRect(p));
    return free;
  };

  const movedNames = new Set<string>();

  /** 最小驱逐：在图集内找一个位置，使重叠的「可驱逐帧」数量最少（平局比面积、y、x） */
  function findEviction(rw: number, rh: number): { x: number; y: number; evict: string[] } | null {
    if (rw > W || rh > H) return null;
    const xs = new Set<number>([0, W - rw]);
    const ys = new Set<number>([0, H - rh]);
    const all: Rect[] = [];
    for (const p of evictable.values()) all.push(toRect(p));
    for (const p of fixed.values()) all.push(toRect(p));
    for (const r of all) {
      xs.add(r.x + r.w);
      xs.add(r.x - rw);
      ys.add(r.y + r.h);
      ys.add(r.y - rh);
    }
    const blocking = [...fixed.values()].map(toRect);

    let best: { x: number; y: number; evict: string[] } | null = null;
    let bestCount = Infinity;
    let bestArea = Infinity;
    for (const x of xs) {
      if (x < 0 || x + rw > W) continue;
      for (const y of ys) {
        if (y < 0 || y + rh > H) continue;
        const cand: Rect = { x, y, w: rw, h: rh };
        if (blocking.some((b) => intersects(b, cand))) continue;
        const evict: string[] = [];
        let area = 0;
        for (const [name, p] of evictable) {
          const r = toRect(p);
          if (intersects(r, cand)) {
            evict.push(name);
            area += r.w * r.h;
          }
        }
        if (evict.length === 0 || evict.length > maxEvict) continue;
        if (
          evict.length < bestCount ||
          (evict.length === bestCount && area < bestArea) ||
          (evict.length === bestCount &&
            area === bestArea &&
            best !== null &&
            (y < best.y || (y === best.y && x < best.x)))
        ) {
          best = { x, y, evict };
          bestCount = evict.length;
          bestArea = area;
        }
      }
    }
    return best;
  }

  /** 图集增长候选（保持已有坐标不变），按新增面积升序 */
  function growthCandidates(rw: number, rh: number): Array<{ w: number; h: number }> {
    const snap = (n: number): number => (pot ? nextPow2(n) : n);
    const out: Array<{ w: number; h: number }> = [];
    const push = (w: number, h: number): void => {
      if (w > maxSize || h > maxSize) return;
      if (w === W && h === H) return;
      if (!out.some((c) => c.w === w && c.h === h)) out.push({ w, h });
    };
    if (rw <= W) push(W, snap(H + rh)); // 向下增长，底部整条可容纳
    if (rh <= H) push(snap(W + rw), H); // 向右增长
    push(snap(Math.max(W, rw)), snap(H + rh)); // 双向：底部整条（新宽度）
    push(snap(W + rw), snap(Math.max(H, rh))); // 双向：右侧整条（新高度）
    // 面积升序；平局偏好更方正的尺寸（长宽差小），保证确定性
    out.sort(
      (a, b) =>
        a.w * a.h - b.w * b.h ||
        Math.abs(a.w - a.h) - Math.abs(b.w - b.h) ||
        a.h - b.h ||
        a.w - b.w
    );
    return out;
  }

  // 待放置队列：面积降序、名称升序（确定性，重复执行不漂移）
  const bySizeThenName = (a: ToPlace, b: ToPlace): number => {
    const d = b.input.w * b.input.h - a.input.w * a.input.h;
    if (d !== 0) return d;
    return a.input.name < b.input.name ? -1 : a.input.name > b.input.name ? 1 : 0;
  };
  const queue: ToPlace[] = [...toPlace].sort(bySizeThenName);

  while (queue.length > 0) {
    const { input } = queue.shift()!;
    const rw = input.w + padding * 2;
    const rh = input.h + padding * 2;

    // 1) 优先塞入空洞（旧帧零移动）
    const free = computeFree();
    const fi = findFreeRect(free, rw, rh);
    if (fi >= 0) {
      const f = free[fi]!;
      fixed.set(input.name, { x: f.x + padding, y: f.y + padding, w: input.w, h: input.h });
      continue;
    }

    // 2) 最小驱逐：只移动必要帧
    const ev = findEviction(rw, rh);
    if (ev) {
      const requeue: ToPlace[] = [];
      for (const name of ev.evict) {
        evictable.delete(name);
        movedNames.add(name);
        const keptInput = inputs.find((i) => i.name === name);
        if (keptInput) requeue.push({ input: keptInput });
      }
      fixed.set(input.name, { x: ev.x + padding, y: ev.y + padding, w: input.w, h: input.h });
      // 被驱逐的帧立即重新放置（确定性顺序）
      queue.unshift(...requeue.sort(bySizeThenName));
      continue;
    }

    // 3) 增长图集（旧帧坐标不变）
    let grown = false;
    for (const cand of growthCandidates(rw, rh)) {
      const oldW = W;
      const oldH = H;
      W = cand.w;
      H = cand.h;
      const freeNow = computeFree();
      const gi = findFreeRect(freeNow, rw, rh);
      if (gi >= 0) {
        const f = freeNow[gi]!;
        fixed.set(input.name, { x: f.x + padding, y: f.y + padding, w: input.w, h: input.h });
        grown = true;
        break;
      }
      W = oldW; // 该候选放不下，还原再试下一个
      H = oldH;
    }
    if (grown) continue;

    // 4) 增量不可行
    throw new IncrementalInfeasibleError(
      `帧「${input.name}」（含留白 ${rw}×${rh}）无法放入当前图集 ${W}×${H}：` +
        `空洞不足、需移动的帧超过 ${maxEvict} 个或增长后仍超过上限 ${maxSize}×${maxSize}`
    );
  }

  // 输出：按输入顺序
  const frames: PackedFrame[] = inputs.map((input) => {
    const p = evictable.get(input.name) ?? fixed.get(input.name);
    if (!p) throw new Error(`帧 ${input.name} 未能放入图集`);
    return {
      id: input.id,
      name: input.name,
      x: p.x,
      y: p.y,
      w: input.w,
      h: input.h,
      trim: input.trim,
      srcW: input.srcW,
      srcH: input.srcH,
      duration: input.duration
    };
  });
  const layout: PackLayout = { atlasWidth: W, atlasHeight: H, frames };

  // 摘要
  const changes: FrameChange[] = [];
  let kept = 0;
  let moved = 0;
  let added = 0;
  let replaced = 0;
  for (const input of inputs) {
    const p = evictable.get(input.name) ?? fixed.get(input.name)!;
    const base = baseByName.get(input.name);
    const to = { x: p.x, y: p.y };
    if (!base) {
      added++;
      changes.push({ name: input.name, kind: "added", to });
    } else if (base.digest !== input.digest || base.w !== input.w || base.h !== input.h) {
      replaced++;
      changes.push({ name: input.name, kind: "replaced", from: { x: base.x, y: base.y }, to });
    } else if (movedNames.has(input.name)) {
      moved++;
      changes.push({ name: input.name, kind: "moved", from: { x: base.x, y: base.y }, to });
    } else {
      kept++;
      changes.push({ name: input.name, kind: "kept", from: { x: base.x, y: base.y }, to });
    }
  }
  for (const b of deletedFrames) {
    changes.push({ name: b.name, kind: "deleted", from: { x: b.x, y: b.y } });
  }
  const summary: PackSummary = {
    strategy: opts.strategy,
    fullRepack: false,
    kept,
    moved,
    added,
    replaced,
    deleted: deletedFrames.length,
    changes,
    at: Date.now()
  };

  const newBaseline = baselineFromLayout(layout, inputs, { padding, trim: opts.trim, pot });
  return { layout, baseline: newBaseline, summary };
}
