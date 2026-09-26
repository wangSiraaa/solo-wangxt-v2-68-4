import { derived, get, writable } from "svelte/store";
import type {
  FrameItem,
  LayoutBaseline,
  PackResult,
  PackedFrame,
  Settings,
  TrimRect
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { computeAlphaBBox } from "./trim";
import {
  IncrementalInfeasibleError,
  packFull,
  packIncremental,
  type IncFrameInput,
  type IncrementalResult
} from "./incremental";
import { digestPixels } from "./digest";
import { buildAtlasJSON, parseAtlasJSON, type AtlasJSON } from "./serialize";
import {
  blobToImage,
  canvasToBlob,
  canvasToDataURL,
  ctx2d,
  dataURLToBlob,
  downloadBlob,
  imageToPixels,
  makeCanvas,
  uid
} from "./image";
import { clearProject, loadProject, saveProject, toStored } from "./db";

export const frames = writable<FrameItem[]>([]);
export const settings = writable<Settings>({ ...DEFAULT_SETTINGS });
export const packResult = writable<PackResult | null>(null);
export const selectedId = writable<string | null>(null);
export const busy = writable(false);
export const status = writable<{ kind: "info" | "error"; text: string } | null>(null);

/** 布局基线：上次成功打包的稳定布局，增量重打包以其坐标为基准 */
export const baseline = writable<LayoutBaseline | null>(null);
/** 帧列表在打包后被修改过（旧布局仍保留展示，打包后清除） */
export const packStale = writable(false);
/** 增量布局不可行时挂起的确认：等待用户选择全量重排或取消 */
export const pendingRepack = writable<{ reason: string } | null>(null);

export const frameCount = derived(frames, ($f) => $f.length);

let statusTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, kind: "info" | "error" = "info"): void {
  status.set({ kind, text });
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.set(null), 5000);
}

/** 当前打包结果对应的 JSON（不含内嵌图集，供存储/导出复用） */
let lastJSON: AtlasJSON | null = null;
export function getLastJSON(): AtlasJSON | null {
  return lastJSON;
}

// ---------- 帧导入 ----------

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let i = 2;
  while (taken.has(`${stem}_${i}${ext}`)) i++;
  return `${stem}_${i}${ext}`;
}

export async function addFiles(files: Iterable<File>): Promise<void> {
  const list = [...files].filter((f) => /png$/i.test(f.type) || /\.png$/i.test(f.name));
  if (list.length === 0) {
    notify("请选择 PNG 图片", "error");
    return;
  }
  busy.set(true);
  try {
    const next = [...get(frames)];
    let added = 0;
    let replaced = 0;
    for (const file of list) {
      try {
        const img = await blobToImage(file);
        // 同名视为替换：保留 id 与时长，仅更新内容（帧身份 = 逻辑名称 + 内容摘要）
        const idx = next.findIndex((f) => f.name === file.name);
        if (idx >= 0) {
          const old = next[idx]!;
          URL.revokeObjectURL(old.url);
          next[idx] = {
            ...old,
            width: img.naturalWidth,
            height: img.naturalHeight,
            blob: file,
            url: URL.createObjectURL(file)
          };
          replaced++;
        } else {
          const taken = new Set(next.map((f) => f.name));
          next.push({
            id: uid(),
            name: uniqueName(file.name, taken),
            duration: 100,
            width: img.naturalWidth,
            height: img.naturalHeight,
            blob: file,
            url: URL.createObjectURL(file)
          });
          added++;
        }
      } catch {
        notify(`无法解码图片：${file.name}`, "error");
      }
    }
    if (added > 0 || replaced > 0) {
      frames.set(next);
      if (get(packResult)) packStale.set(true); // 旧布局保留展示，标记待更新
      const parts: string[] = [];
      if (added > 0) parts.push(`新增 ${added} 帧`);
      if (replaced > 0) parts.push(`替换 ${replaced} 帧`);
      notify(`已导入：${parts.join("，")}`);
    }
  } finally {
    busy.set(false);
  }
}

export function removeFrame(id: string): void {
  const list = get(frames);
  const f = list.find((x) => x.id === id);
  if (!f) return;
  URL.revokeObjectURL(f.url);
  frames.set(list.filter((x) => x.id !== id));
  if (get(packResult)) packStale.set(true);
}

export function moveFrame(id: string, dir: -1 | 1): void {
  const list = [...get(frames)];
  const i = list.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const a = list[i]!;
  list[i] = list[j]!;
  list[j] = a;
  frames.set(list);
  if (get(packResult)) packStale.set(true);
}

export function setDuration(id: string, ms: number): void {
  if (!Number.isFinite(ms)) return;
  const v = Math.max(1, Math.round(ms));
  frames.set(get(frames).map((f) => (f.id === id ? { ...f, duration: v } : f)));
}

export function setAllDurations(ms: number): void {
  const v = Math.max(1, Math.round(ms));
  frames.set(get(frames).map((f) => ({ ...f, duration: v })));
}

export function clearAll(): void {
  for (const f of get(frames)) URL.revokeObjectURL(f.url);
  const pack = get(packResult);
  if (pack) URL.revokeObjectURL(pack.atlasUrl);
  frames.set([]);
  packResult.set(null);
  selectedId.set(null);
  baseline.set(null);
  packStale.set(false);
  pendingRepack.set(null);
  lastJSON = null;
}

// ---------- 打包 ----------

interface TrimmedFrame {
  item: FrameItem;
  canvas: HTMLCanvasElement;
  trim: TrimRect;
  /** 内容摘要（解码后 RGBA），与名称共同决定帧身份 */
  digest: string;
}

/** 裁切（或保留）单帧，返回内容画布、裁切信息与内容摘要 */
async function trimFrame(item: FrameItem, doTrim: boolean): Promise<TrimmedFrame> {
  const img = await blobToImage(item.blob);
  const pixels = imageToPixels(img, item.width, item.height);
  const digest = digestPixels(pixels);
  if (!doTrim) {
    const canvas = makeCanvas(item.width, item.height);
    ctx2d(canvas).drawImage(img, 0, 0);
    return { item, canvas, trim: { x: 0, y: 0, w: item.width, h: item.height }, digest };
  }
  const bbox = computeAlphaBBox(pixels);
  if (!bbox) {
    // 完全透明：保留 1×1，避免 0 尺寸
    const canvas = makeCanvas(1, 1);
    return { item, canvas, trim: { x: 0, y: 0, w: 1, h: 1 }, digest };
  }
  const canvas = makeCanvas(bbox.w, bbox.h);
  ctx2d(canvas).drawImage(img, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
  return { item, canvas, trim: bbox, digest };
}

/** 应用打包结果：合成图集、更新 stores（只有成功才会调用，失败/取消不污染旧布局） */
async function applyPackOutcome(outcome: IncrementalResult, trimmed: TrimmedFrame[]): Promise<void> {
  const { layout, summary } = outcome;
  const s = get(settings);

  const atlas = makeCanvas(layout.atlasWidth, layout.atlasHeight);
  const ctx = ctx2d(atlas);
  const canvasById = new Map(trimmed.map((t) => [t.item.id, t.canvas]));
  for (const f of layout.frames) {
    const c = canvasById.get(f.id);
    if (c) ctx.drawImage(c, f.x, f.y);
  }

  const old = get(packResult);
  if (old) URL.revokeObjectURL(old.atlasUrl);
  const atlasBlob = await canvasToBlob(atlas);
  const result: PackResult = {
    atlasWidth: layout.atlasWidth,
    atlasHeight: layout.atlasHeight,
    frames: layout.frames,
    atlasBlob,
    atlasUrl: URL.createObjectURL(atlasBlob),
    padding: s.padding,
    trimmed: s.trim,
    summary
  };
  packResult.set(result);
  baseline.set(outcome.baseline);
  packStale.set(false);
  pendingRepack.set(null);
  lastJSON = buildAtlasJSON(layout, {
    imageName: "atlas.png",
    trimmed: s.trim,
    settings: s
  });
  notify(
    `打包完成：${layout.atlasWidth}×${layout.atlasHeight}，共 ${layout.frames.length} 帧 · ` +
      `保持 ${summary.kept} · 移动 ${summary.moved} · 新增 ${summary.added} · 删除 ${summary.deleted}`
  );
}

/**
 * 执行打包并生成图集。
 * 稳定优先：有基线时做增量重打包（复用未变化帧坐标）；
 * 紧凑优先或强制：全量重排。
 * 增量不可行时不改动旧结果，挂起 pendingRepack 等待用户确认。
 */
export async function pack(opts: { forceFull?: boolean } = {}): Promise<void> {
  const list = get(frames);
  if (list.length === 0) {
    notify("请先导入 PNG 帧", "error");
    return;
  }
  const s = get(settings);
  busy.set(true);
  try {
    const trimmed: TrimmedFrame[] = [];
    for (const item of list) trimmed.push(await trimFrame(item, s.trim));

    const inputs: IncFrameInput[] = trimmed.map((t) => ({
      id: t.item.id,
      name: t.item.name,
      w: t.canvas.width,
      h: t.canvas.height,
      trim: t.trim,
      srcW: t.item.width,
      srcH: t.item.height,
      duration: t.item.duration,
      digest: t.digest
    }));

    const base = get(baseline);
    const incOpts = {
      padding: s.padding,
      maxSize: s.maxSize,
      pot: s.pot,
      trim: s.trim,
      strategy: s.strategy
    };

    let outcome: IncrementalResult;
    if (opts.forceFull) {
      outcome = packFull(inputs, base, incOpts, "按确认执行全量重排");
    } else if (s.strategy === "compact") {
      outcome = packFull(inputs, base, incOpts, "紧凑优先：全量重排");
    } else if (!base) {
      outcome = packFull(inputs, null, incOpts, "首次打包");
    } else {
      try {
        outcome = packIncremental(inputs, base, incOpts);
      } catch (e) {
        if (e instanceof IncrementalInfeasibleError) {
          // 不触碰旧布局，等待用户选择全量重排或取消
          pendingRepack.set({ reason: e.message });
          notify("增量布局无法满足尺寸，请选择全量重排或取消", "error");
          return;
        }
        throw e;
      }
    }
    await applyPackOutcome(outcome, trimmed);
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
  }
}

/** 确认全量重排（放弃增量稳定性） */
export async function confirmFullRepack(): Promise<void> {
  pendingRepack.set(null);
  await pack({ forceFull: true });
}

/** 取消全量重排，保留原有布局 */
export function cancelFullRepack(): void {
  pendingRepack.set(null);
  notify("已取消全量重排，保留原有布局");
}

// ---------- 导出 ----------

export function exportPNG(): void {
  const p = get(packResult);
  if (!p) {
    notify("请先打包", "error");
    return;
  }
  downloadBlob(p.atlasBlob, "atlas.png");
}

export async function exportJSON(): Promise<void> {
  const p = get(packResult);
  if (!p || !lastJSON) {
    notify("请先打包", "error");
    return;
  }
  const s = get(settings);
  let json = lastJSON;
  if (s.embedAtlas) {
    const dataURL = canvasToDataURL(await blobToCanvas(p.atlasBlob));
    json = { ...lastJSON, meta: { ...lastJSON.meta, atlasDataURL: dataURL } };
  }
  downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }), "atlas.json");
  notify("已导出 atlas.png 与 atlas.json");
}

async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const img = await blobToImage(blob);
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  ctx2d(c).drawImage(img, 0, 0);
  return c;
}

// ---------- 导入 JSON 恢复 ----------

/**
 * 从导出的 JSON 恢复帧列表、时长与打包结果。
 * 图集图片来源：JSON 内嵌的 atlasDataURL，或用户同时选择的 atlas.png。
 */
export async function importJSON(jsonFile: File, atlasFile?: File): Promise<void> {
  busy.set(true);
  try {
    const raw: unknown = JSON.parse(await jsonFile.text());
    const parsed = parseAtlasJSON(raw);

    let atlasBlob: Blob;
    if (parsed.atlasDataURL) {
      atlasBlob = dataURLToBlob(parsed.atlasDataURL);
    } else if (atlasFile) {
      atlasBlob = atlasFile;
    } else {
      throw new Error("该 JSON 未内嵌图集，请同时选择导出的 atlas.png");
    }

    const atlasImg = await blobToImage(atlasBlob);
    if (atlasImg.naturalWidth < parsed.size.w || atlasImg.naturalHeight < parsed.size.h) {
      throw new Error(
        `图集图片尺寸 ${atlasImg.naturalWidth}×${atlasImg.naturalHeight} 小于 JSON 声明的 ${parsed.size.w}×${parsed.size.h}`
      );
    }

    // 从图集切出每帧内容，再按 spriteSourceSize 放回原始尺寸画布
    const restored: FrameItem[] = [];
    const packedFrames: PackedFrame[] = [];
    const baselineFrames: LayoutBaseline["frames"] = [];
    for (const f of parsed.frames) {
      const full = makeCanvas(f.sourceSize.w, f.sourceSize.h);
      const fctx = ctx2d(full);
      fctx.drawImage(
        atlasImg,
        f.frame.x,
        f.frame.y,
        f.frame.w,
        f.frame.h,
        f.spriteSourceSize.x,
        f.spriteSourceSize.y,
        f.frame.w,
        f.frame.h
      );
      // 内容摘要：从重新编码的 blob 解码计算，与打包时的计算路径完全一致，
      // 保证「导出 → 导入 → 再打包」帧身份稳定（恢复帧与原图逐像素一致）
      const blob = await canvasToBlob(full);
      const decoded = await blobToImage(blob);
      const digest = digestPixels(imageToPixels(decoded, full.width, full.height));
      const id = uid();
      restored.push({
        id,
        name: f.name,
        duration: f.duration,
        width: f.sourceSize.w,
        height: f.sourceSize.h,
        blob,
        url: URL.createObjectURL(blob)
      });
      packedFrames.push({
        id,
        name: f.name,
        x: f.frame.x,
        y: f.frame.y,
        w: f.frame.w,
        h: f.frame.h,
        trim: { ...f.spriteSourceSize },
        srcW: f.sourceSize.w,
        srcH: f.sourceSize.h,
        duration: f.duration
      });
      baselineFrames.push({
        name: f.name,
        digest,
        x: f.frame.x,
        y: f.frame.y,
        w: f.frame.w,
        h: f.frame.h
      });
    }

    clearAll();
    frames.set(restored);
    settings.set({ ...parsed.settings });
    packResult.set({
      atlasWidth: parsed.size.w,
      atlasHeight: parsed.size.h,
      frames: packedFrames,
      atlasBlob,
      atlasUrl: URL.createObjectURL(atlasBlob),
      padding: parsed.settings.padding,
      trimmed: parsed.settings.trim
    });
    // 以导入的坐标为基线，后续增量打包继续复用原位置
    baseline.set({
      atlasWidth: parsed.size.w,
      atlasHeight: parsed.size.h,
      padding: parsed.settings.padding,
      trim: parsed.settings.trim,
      pot: parsed.settings.pot,
      frames: baselineFrames
    });
    packStale.set(false);
    lastJSON = buildAtlasJSON(
      { atlasWidth: parsed.size.w, atlasHeight: parsed.size.h, frames: packedFrames },
      { imageName: parsed.imageName, trimmed: parsed.settings.trim, settings: parsed.settings }
    );
    notify(`已从 JSON 恢复 ${restored.length} 帧与打包结果`);
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
  }
}

// ---------- IndexedDB 持久化 ----------

export async function saveNow(): Promise<void> {
  try {
    await saveProject(
      toStored(get(frames), get(settings), get(packResult), lastJSON, get(baseline), get(packResult)?.summary ?? null)
    );
    notify("项目已保存到浏览器本地");
  } catch (e) {
    notify(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export async function restoreFromDB(): Promise<boolean> {
  try {
    const stored = await loadProject();
    if (!stored || stored.frames.length === 0) return false;
    const restored: FrameItem[] = stored.frames.map((f) => ({
      id: f.id,
      name: f.name,
      duration: f.duration,
      width: f.width,
      height: f.height,
      blob: f.blob,
      url: URL.createObjectURL(f.blob)
    }));
    frames.set(restored);
    settings.set({ ...DEFAULT_SETTINGS, ...stored.settings });
    if (stored.pack) {
      const parsed = parseAtlasJSON(stored.pack.json);
      const packedFrames: PackedFrame[] = parsed.frames.map((f, i) => ({
        id: restored[i]?.id ?? uid(),
        name: f.name,
        x: f.frame.x,
        y: f.frame.y,
        w: f.frame.w,
        h: f.frame.h,
        trim: { ...f.spriteSourceSize },
        srcW: f.sourceSize.w,
        srcH: f.sourceSize.h,
        duration: f.duration
      }));
      packResult.set({
        atlasWidth: parsed.size.w,
        atlasHeight: parsed.size.h,
        frames: packedFrames,
        atlasBlob: stored.pack.atlasBlob,
        atlasUrl: URL.createObjectURL(stored.pack.atlasBlob),
        padding: parsed.settings.padding,
        trimmed: parsed.settings.trim,
        ...(stored.lastSummary ? { summary: stored.lastSummary } : {})
      });
      lastJSON = stored.pack.json;
    }
    // 恢复布局基线：刷新后继续增量打包仍以原坐标为基准
    baseline.set(stored.baseline ?? null);
    packStale.set(false);
    return true;
  } catch {
    return false;
  }
}

export async function clearStorage(): Promise<void> {
  await clearProject();
  clearAll();
  notify("已清空本地项目");
}

// 自动保存（防抖）
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveProject(
      toStored(get(frames), get(settings), get(packResult), lastJSON, get(baseline), get(packResult)?.summary ?? null)
    ).catch(() => {});
  }, 600);
}

export function startAutoSave(): void {
  frames.subscribe(() => scheduleSave());
  settings.subscribe(() => scheduleSave());
  packResult.subscribe(() => scheduleSave());
  baseline.subscribe(() => scheduleSave());
}
