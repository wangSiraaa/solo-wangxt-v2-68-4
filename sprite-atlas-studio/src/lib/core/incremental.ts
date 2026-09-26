import type { FrameDelta, PackReport, PackStrategy, PackedFrame, TrimRect } from "./types";
import { nextPow2 } from "./trim";
import type { PackInput, PackLayout } from "./pack";

/**
 * 稳定布局的增量重打包。
 *
 * 帧身份 = 逻辑名称 + 内容摘要（trim 后的 w/h 与内容哈希）。
 * 同名且摘要相同 = 未变化；同名摘要变化 = 替换；新名 = 新增；旧名消失 = 删除。
 *
 * 稳定优先（strategy = "stable"）：
 * 1. 未变化帧一律钉在基线坐标上，绝不主动移动；删除帧也不压缩空洞；
 * 2. 同名替换帧：新尺寸在原位置不与任何保留帧冲突就原地更新；
 * 3. 新增帧 / 无法原地的替换帧：在保留帧围出的空闲矩形（MaxRects 自由矩形表）
 *    中按「最紧凑空洞」落位；
 * 4. 仍放不下时，按「先让出大替换帧、再让出大保留帧」的顺序逐个解锁，
 *    每多让出一个就重试，直到全部落位——因此被移动的帧数最少；
 * 5. 所有选择（空洞评分、让出顺序）都是确定的：完全相同输入重复执行结果一致。
 *
 * 紧凑优先 = 调用方直接走 packFrames 全量重排，并用 buildFullReport 生成摘要。
 */

export interface FrameFingerprint {
  /** 逻辑名称（帧身份的一部分） */
  name: string;
  /** 内容尺寸（裁切后） */
  w: number;
  h: number;
  trim: TrimRect;
  srcW: number;
  srcH: number;
  /** 内容摘要（裁切后像素哈希）；同名 + 同摘要才视为未变化 */
  hash: string;
}

/** 布局基线中的一帧：内容摘要 + 基线坐标 */
export interface BaselineFrame extends FrameFingerprint {
  x: number;
  y: number;
}

/** 完整布局基线（含基线图集尺寸：删除不压缩，尺寸不小于它） */
export interface LayoutBaseline {
  atlasWidth: number;
  atlasHeight: number;
  frames: BaselineFrame[];
}

export interface IncrementalInput extends PackInput {
  hash: string;
}

export interface IncrementalResult {
  layout: PackLayout;
  report: PackReport;
}

/** 轴对齐整数矩形（增量打包内部统一使用「含留白」矩形） */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/**
 * MaxRects 自由矩形表：初始为整个边界，每占用一个矩形就把与之相交的
 * 自由矩形切成至多 4 块，再剪枝被包含的冗余矩形。
 * 自由矩形之间允许互相重叠（均为极大矩形）。
 */
class FreeRects {
  free: Rect[];
  constructor(boundW: number, boundH: number) {
    this.free = [{ x: 0, y: 0, w: boundW, h: boundH }];
  }

  occupy(r: Rect): void {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (!overlap(f, r)) {
        next.push(f);
        continue;
      }
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w)
        next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - (r.x + r.w), h: f.h });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h)
        next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - (r.y + r.h) });
    }
    // 剪枝：删除被其它自由矩形包含的块
    const kept: Rect[] = [];
    for (let i = 0; i < next.length; i++) {
      let redundant = false;
      for (let j = 0; j < next.length; j++) {
        if (i === j) continue;
        const a = next[i]!;
        const b = next[j]!;
        if (contains(b, a) && (b.w * b.h !== a.w * a.h || j < i)) {
          redundant = true;
          break;
        }
      }
      if (!redundant) kept.push(next[i]!);
    }
    this.free = kept;
  }

  /** 首选位置是否完整落在某个自由矩形内（即该位置当前可用） */
  canPlaceAt(rw: number, rh: number, x: number, y: number): boolean {
    const r = { x, y, w: rw, h: rh };
    return this.free.some((f) => contains(f, r));
  }

  /**
   * 为 (rw,rh) 选最紧凑空洞（BAF 面积余量 + 最短边贴合 + 坐标字典序），
   * 全程确定性打分，相同输入必然得到相同位置。
   */
  bestFit(rw: number, rh: number): { x: number; y: number } | null {
    let best: { x: number; y: number; score: number } | null = null;
    for (const f of this.free) {
      if (f.w < rw || f.h < rh) continue;
      const score =
        (f.w * f.h - rw * rh) * 1_000_000 +
        Math.min(f.w - rw, f.h - rh) * 10_000 +
        f.y * 100 +
        f.x;
      if (!best || score < best.score) best = { x: f.x, y: f.y, score };
    }
    return best;
  }
}

export interface IncrementalOptions {
  padding: number;
  maxSize: number;
  pot: boolean;
  strategy: PackStrategy;
}

interface PendingRect {
  name: string;
  rw: number;
  rh: number;
  /** 首选矩形左上角（含留白坐标）：通常是它在基线中的旧位置 */
  preferred?: { x: number; y: number };
}

/**
 * 按给定顺序在固定障碍下放置 pending；每帧优先首选旧位置，否则选最紧凑空洞。
 * 顺序启发式可能贪心失败，调用方可换多种确定性顺序重试。
 */
function runPlacement(
  boundW: number,
  boundH: number,
  fixed: Rect[],
  order: PendingRect[]
): Map<string, { x: number; y: number }> | null {
  const free = new FreeRects(boundW, boundH);
  for (const o of fixed) free.occupy(o);

  const placed = new Map<string, { x: number; y: number }>();
  for (const p of order) {
    let pos: { x: number; y: number } | null = null;
    if (
      p.preferred &&
      p.preferred.x >= 0 &&
      p.preferred.y >= 0 &&
      p.preferred.x + p.rw <= boundW &&
      p.preferred.y + p.rh <= boundH &&
      free.canPlaceAt(p.rw, p.rh, p.preferred.x, p.preferred.y)
    ) {
      pos = p.preferred;
    }
    if (!pos) pos = free.bestFit(p.rw, p.rh);
    if (!pos) return null;
    const box = { x: pos.x, y: pos.y, w: p.rw, h: p.rh };
    free.occupy(box);
    placed.set(p.name, pos);
  }
  return placed;
}

function byAreaThenName(a: PendingRect, b: PendingRect): number {
  const sa = a.rw * a.rh;
  const sb = b.rw * b.rh;
  if (sb !== sa) return sb - sa;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * 尝试在 [0,boundW]×[0,boundH] 内、避开 fixed 障碍放置全部 pending。
 * 先用两种确定性贪心顺序；都失败再用有界回溯（MRV + 自由矩形角点候选），
 * 保证小规模场景下只要存在可行排布就能找到，避免贪心导致不必要的多移动帧。
 */
function tryPlace(
  boundW: number,
  boundH: number,
  fixed: Rect[],
  pending: PendingRect[]
): Map<string, { x: number; y: number }> | null {
  const preferredFirst = (a: PendingRect, b: PendingRect): number => {
    if (!!a.preferred !== !!b.preferred) return a.preferred ? -1 : 1;
    return byAreaThenName(a, b);
  };
  const r1 = runPlacement(boundW, boundH, fixed, [...pending].sort(preferredFirst));
  if (r1) return r1;
  const r2 = runPlacement(boundW, boundH, fixed, [...pending].sort(byAreaThenName));
  if (r2) return r2;
  return backtrackingPlace(boundW, boundH, fixed, pending);
}

/** 有界回溯放置：每步选候选位置最少的帧（MRV），候选 = 首选位 + 自由矩形四角 */
function backtrackingPlace(
  boundW: number,
  boundH: number,
  fixed: Rect[],
  pending: PendingRect[]
): Map<string, { x: number; y: number }> | null {
  if (pending.length === 0) return new Map();
  const NODE_LIMIT = 20000;
  let nodes = 0;

  const candidatesFor = (
    free: FreeRects,
    p: PendingRect
  ): Array<{ x: number; y: number }> => {
    const raw: Array<{ x: number; y: number; score: number }> = [];
    const push = (x: number, y: number, score: number): void => {
      if (x < 0 || y < 0 || x + p.rw > boundW || y + p.rh > boundH) return;
      if (!free.canPlaceAt(p.rw, p.rh, x, y)) return;
      // 去重（同坐标只保留一次）
      if (!raw.some((c) => c.x === x && c.y === y)) raw.push({ x, y, score });
    };
    // 首选旧位置：优先回到原位（无坐标漂移）
    if (p.preferred) push(p.preferred.x, p.preferred.y, -1);
    // 各自由矩形的左上角、右上角、左下角、右下角
    for (const fr of free.free) {
      if (fr.w < p.rw || fr.h < p.rh) continue;
      const corners: Array<[number, number]> = [
        [fr.x, fr.y],
        [fr.x + fr.w - p.rw, fr.y],
        [fr.x, fr.y + fr.h - p.rh],
        [fr.x + fr.w - p.rw, fr.y + fr.h - p.rh]
      ];
      for (const [cx, cy] of corners) {
        // 越靠边越优先（沿用最紧凑 + 坐标字典序的确定性打分）
        push(cx, cy, fr.w * fr.h * 1000 + cy * 32 + cx);
      }
    }
    raw.sort((a, b) => a.score - b.score);
    return raw.map(({ x, y }) => ({ x, y }));
  };

  const dfs = (
    free: FreeRects,
    remaining: PendingRect[],
    placed: Map<string, { x: number; y: number }>
  ): Map<string, { x: number; y: number }> | null => {
    if (remaining.length === 0) return placed;
    if (++nodes > NODE_LIMIT) return null;

    // MRV：候选位置最少的帧先放；并列时大帧优先、名字字典序
    let bestIdx = -1;
    let bestCands: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < remaining.length; i++) {
      const c = candidatesFor(free, remaining[i]!);
      if (c.length === 0) return null;
      if (
        bestIdx < 0 ||
        c.length < bestCands.length ||
        (c.length === bestCands.length && byAreaThenName(remaining[i]!, remaining[bestIdx]!) < 0)
      ) {
        bestIdx = i;
        bestCands = c;
      }
    }
    const [picked] = remaining.splice(bestIdx!, 1);
    const p = picked!;
    for (const pos of bestCands) {
      const snapshot = free.free;
      free.free = snapshot.map((r) => ({ ...r }));
      free.occupy({ x: pos.x, y: pos.y, w: p.rw, h: p.rh });
      placed.set(p.name, pos);
      const r = dfs(free, remaining, placed);
      if (r) return r;
      placed.delete(p.name);
      free.free = snapshot;
    }
    remaining.splice(bestIdx!, 0, p);
    return null;
  };

  const free0 = new FreeRects(boundW, boundH);
  for (const o of fixed) free0.occupy(o);
  return dfs(free0, [...pending], new Map());
}

/**
 * 基于旧布局基线做增量打包。
 * @returns 布局 + 变更摘要；任何边界/让出组合都无法满足时返回 null，
 *          调用方应提示用户全量重排，用户取消则旧布局原样保留。
 */
export function packIncremental(
  current: IncrementalInput[],
  baseline: LayoutBaseline,
  opts: IncrementalOptions
): IncrementalResult | null {
  const { padding, maxSize, pot } = opts;
  if (current.length === 0) return null;
  if (padding < 0) throw new Error("留白不能为负数");

  const pad2 = padding * 2;
  const oldByName = new Map(baseline.frames.map((f) => [f.name, f]));
  const curByName = new Map(current.map((f) => [f.name, f]));

  // ---- 分类 ----
  // 旧基线可能没有内容哈希（1.0 版导出）：退化为按裁切后尺寸判同
  const sameContent = (old: BaselineFrame, f: IncrementalInput): boolean =>
    (old.hash === f.hash && old.w === f.w && old.h === f.h) ||
    (old.hash.startsWith("legacy:") && old.w === f.w && old.h === f.h);

  const kept: IncrementalInput[] = [];
  const replaced: IncrementalInput[] = [];
  const added: IncrementalInput[] = [];
  for (const f of current) {
    const old = oldByName.get(f.name);
    if (!old) added.push(f);
    else if (sameContent(old, f)) kept.push(f);
    else replaced.push(f);
  }
  const removed = baseline.frames.filter((f) => !curByName.has(f.name));

  /** 帧内容坐标 → 含留白矩形 */
  const boxOf = (x: number, y: number, w: number, h: number): Rect => ({
    x: x - padding,
    y: y - padding,
    w: w + pad2,
    h: h + pad2
  });

  // ---- 边界尝试序列：从基线尺寸起步（删除不压缩），逐级放大到 maxSize ----
  const bounds = buildBoundChain(baseline.atlasWidth, baseline.atlasHeight, pot, maxSize);
  if (bounds.length === 0) return null;

  const byAreaDesc = (a: IncrementalInput, b: IncrementalInput): number =>
    b.w * b.h - a.w * a.h || (a.name < b.name ? -1 : 1);

  // 每个候选边界的预处理：哪些替换帧能原地保留、哪些必须重新找位置
  interface BoundPlan {
    boundW: number;
    boundH: number;
    fixedReplaced: Set<string>;
    mobileNames: Set<string>;
  }
  const plans: BoundPlan[] = bounds.map(([boundW, boundH]) => {
    const occupied: Rect[] = [];
    for (const k of kept) {
      const o = oldByName.get(k.name)!;
      occupied.push(boxOf(o.x, o.y, o.w, o.h));
    }
    const fixedReplaced = new Set<string>();
    for (const f of [...replaced].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const old = oldByName.get(f.name)!;
      const nb = boxOf(old.x, old.y, f.w, f.h);
      const inBound =
        nb.x >= 0 && nb.y >= 0 && nb.x + nb.w <= boundW && nb.y + nb.h <= boundH;
      if (inBound && !occupied.some((o) => overlap(o, nb))) {
        fixedReplaced.add(f.name);
        occupied.push(nb);
      }
    }
    const mobileNames = new Set(
      replaced.filter((f) => !fixedReplaced.has(f.name)).map((f) => f.name)
    );
    return { boundW, boundH, fixedReplaced, mobileNames };
  });

  let solution: {
    boundW: number;
    boundH: number;
    positions: Map<string, { x: number; y: number }>;
  } | null = null;

  /** 固定障碍（保留帧 + 指定的原地替换帧），待放 = 移动替换帧 + 新增 + 让出帧 */
  const attempt = (
    plan: BoundPlan,
    yieldKept: Set<string>,
    yieldFixedReplaced: Set<string>
  ): Map<string, { x: number; y: number }> | null => {
    const { boundW, boundH, fixedReplaced, mobileNames } = plan;
    const workFixedRects: Rect[] = [];
    for (const k of kept) {
      if (!yieldKept.has(k.name)) {
        const o = oldByName.get(k.name)!;
        workFixedRects.push(boxOf(o.x, o.y, o.w, o.h));
      }
    }
    for (const f of replaced) {
      if (fixedReplaced.has(f.name) && !yieldFixedReplaced.has(f.name)) {
        const o = oldByName.get(f.name)!;
        workFixedRects.push(boxOf(o.x, o.y, f.w, f.h));
      }
    }
    const allPending: PendingRect[] = [];
    const pushMobile = (f: IncrementalInput): void => {
      const o = oldByName.get(f.name)!;
      allPending.push({
        name: f.name,
        rw: f.w + pad2,
        rh: f.h + pad2,
        preferred: { x: o.x - padding, y: o.y - padding }
      });
    };
    for (const f of replaced) {
      if (mobileNames.has(f.name) || yieldFixedReplaced.has(f.name)) pushMobile(f);
    }
    for (const f of added) {
      allPending.push({ name: f.name, rw: f.w + pad2, rh: f.h + pad2 });
    }
    for (const name of yieldKept) {
      const f = kept.find((x) => x.name === name)!;
      pushMobile(f);
    }
    return tryPlace(boundW, boundH, workFixedRects, allPending);
  };

  /** 确定性枚举 items 的所有大小为 m 的子集（字典序） */
  function* combinations(items: string[], m: number): Generator<string[]> {
    if (m === 0) {
      yield [];
      return;
    }
    if (m > items.length) return;
    const idx = Array.from({ length: m }, (_, i) => i);
    while (true) {
      yield idx.map((i) => items[i]!);
      // 从右向左找可递增位
      let k = m - 1;
      while (k >= 0 && idx[k]! === items.length - m + k) k--;
      if (k < 0) return;
      idx[k] = idx[k]! + 1;
      for (let j = k + 1; j < m; j++) idx[j] = idx[j - 1]! + 1;
    }
  }

  function binomial(n: number, k: number): number {
    if (k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  }

  const MAX_ENUM_ATTEMPTS = 4000;

  // 稳定优先：最小化「移动的保留帧数」。外层 m（让出保留帧数 0→N），内层边界从小到大。
  // 原地保留的替换帧可零代价让出（tryPlace 会优先让它们回旧位）。
  const allKeptNames = kept.map((f) => f.name).sort();
  outerM: for (let m = 0; m <= kept.length; m++) {
    for (const plan of plans) {
      // 该边界下能零代价让出的原地替换帧：全部让出
      const yieldFixedReplaced = new Set(plan.fixedReplaced);

      // m 较小时精确枚举所有子集（保证最少移动）；枚举量过大时退化为
      // 「面积从大到小」的单一贪心序列（仍给可行方案，但不保证最优）
      const exact = binomial(allKeptNames.length, m) <= MAX_ENUM_ATTEMPTS;
      const combos: Generator<string[]> = exact
        ? combinations(allKeptNames, m)
        : (function* (): Generator<string[]> {
            yield [...kept].sort(byAreaDesc).slice(0, m).map((f) => f.name);
          })();

      for (const subsetArr of combos) {
        const subset = new Set(subsetArr);
        const positions = attempt(plan, subset, yieldFixedReplaced);
        if (positions) {
          solution = { boundW: plan.boundW, boundH: plan.boundH, positions };
          break outerM;
        }
      }
    }
  }
  if (!solution) return null;
  const { positions } = solution;

  // ---- 汇总最终坐标 ----
  const coord = new Map<string, { x: number; y: number }>();
  for (const f of current) {
    const old = oldByName.get(f.name);
    const p = positions.get(f.name);
    if (p) coord.set(f.name, { x: p.x + padding, y: p.y + padding });
    else if (old) coord.set(f.name, { x: old.x, y: old.y });
    else return null; // 不可能：新增帧必有位置
  }

  // 删除不主动压缩：占用范围至少覆盖基线图集尺寸
  let usedW = baseline.atlasWidth;
  let usedH = baseline.atlasHeight;
  for (const f of current) {
    const c = coord.get(f.name)!;
    usedW = Math.max(usedW, c.x + f.w + padding);
    usedH = Math.max(usedH, c.y + f.h + padding);
  }
  const atlasWidth = pot ? nextPow2(usedW) : usedW;
  const atlasHeight = pot ? nextPow2(usedH) : usedH;
  if (atlasWidth > maxSize || atlasHeight > maxSize) return null;

  // ---- 防御性校验：不越界、含留白互不重叠 ----
  const boxes = current.map((f) => {
    const c = coord.get(f.name)!;
    return { name: f.name, r: boxOf(c.x, c.y, f.w, f.h) };
  });
  for (const a of boxes) {
    if (a.r.x < 0 || a.r.y < 0 || a.r.x + a.r.w > atlasWidth || a.r.y + a.r.h > atlasHeight) {
      return null;
    }
    for (const b of boxes) {
      if (a.name < b.name && overlap(a.r, b.r)) return null;
    }
  }

  const frames: PackedFrame[] = current.map((f) => {
    const c = coord.get(f.name)!;
    return {
      id: f.id,
      name: f.name,
      x: c.x,
      y: c.y,
      w: f.w,
      h: f.h,
      trim: f.trim,
      srcW: f.srcW,
      srcH: f.srcH,
      duration: f.duration,
      hash: f.hash
    };
  });

  return { layout: { atlasWidth, atlasHeight, frames }, report: buildReport(current, baseline, coord, true, "stable") };
}

/** 按最终坐标相对基线生成变更摘要 */
function buildReport(
  current: IncrementalInput[],
  baseline: LayoutBaseline,
  coord: Map<string, { x: number; y: number }>,
  incremental: boolean,
  strategy: PackStrategy
): PackReport {
  const oldByName = new Map(baseline.frames.map((f) => [f.name, f]));
  const curNames = new Set(current.map((f) => f.name));
  const deltas: FrameDelta[] = [];
  let kept = 0;
  let moved = 0;
  let replaced = 0;
  let added = 0;

  for (const f of current) {
    const old = oldByName.get(f.name);
    const c = coord.get(f.name)!;
    const to = { x: c.x, y: c.y, w: f.w, h: f.h };
    if (!old) {
      added++;
      deltas.push({ name: f.name, kind: "added", to, dx: 0, dy: 0 });
      continue;
    }
    const from = { x: old.x, y: old.y, w: old.w, h: old.h };
    const dx = c.x - old.x;
    const dy = c.y - old.y;
    const contentChanged =
      old.hash !== f.hash || old.w !== f.w || old.h !== f.h
        ? !(old.hash.startsWith("legacy:") && old.w === f.w && old.h === f.h)
        : false;
    if (contentChanged) {
      replaced++;
      deltas.push({ name: f.name, kind: "replaced", from, to, dx, dy });
    } else if (dx === 0 && dy === 0) {
      kept++;
      deltas.push({ name: f.name, kind: "kept", from, to, dx: 0, dy: 0 });
    } else {
      moved++;
      deltas.push({ name: f.name, kind: "moved", from, to, dx, dy });
    }
  }

  let removed = 0;
  for (const b of baseline.frames) {
    if (!curNames.has(b.name)) {
      removed++;
      deltas.push({
        name: b.name,
        kind: "removed",
        from: { x: b.x, y: b.y, w: b.w, h: b.h },
        dx: 0,
        dy: 0
      });
    }
  }

  return {
    incremental,
    strategy,
    kept,
    moved,
    replaced,
    added,
    removed,
    deltas,
    timestamp: Date.now()
  };
}

/** 全量重排后对照基线生成摘要（紧凑优先，或增量失败后的兜底重排） */
export function buildFullReport(
  current: IncrementalInput[],
  layout: PackLayout,
  baseline: LayoutBaseline | null,
  strategy: PackStrategy
): PackReport {
  const coord = new Map(layout.frames.map((f) => [f.name, { x: f.x, y: f.y }]));
  const empty: LayoutBaseline = { atlasWidth: 0, atlasHeight: 0, frames: [] };
  return buildReport(current, baseline ?? empty, coord, false, strategy);
}

/**
 * 边界尝试序列。
 * POT：基线尺寸向上取 2 的幂起步，两个方向各自翻倍直到 maxSize；
 * 非 POT：基线尺寸起步，按 2 的幂倍率放大并封顶 maxSize。
 */
function buildBoundChain(
  baseW: number,
  baseH: number,
  pot: boolean,
  maxSize: number
): Array<[number, number]> {
  if (baseW > maxSize || baseH > maxSize) return [];
  const dims = (start: number): number[] => {
    const out: number[] = [];
    let s = pot ? Math.max(1, nextPow2(start)) : Math.max(1, start);
    if (pot) {
      for (let v = s; v <= maxSize; v *= 2) out.push(v);
    } else {
      out.push(s);
      while (s < maxSize) {
        s = Math.min(maxSize, s * 2);
        if (!out.includes(s)) out.push(s);
      }
    }
    return out;
  };
  const ws = dims(baseW);
  const hs = dims(baseH);
  const chain: Array<[number, number]> = [];
  for (const w of ws) for (const h of hs) chain.push([w, h]);
  chain.sort((a, b) => a[0] * a[1] - b[0] * b[1] || a[0] - b[0] || a[1] - b[1]);
  return chain;
}
