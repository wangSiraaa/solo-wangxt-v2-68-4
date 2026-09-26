import { derived, get, writable } from "svelte/store";
import type { FrameItem, PackReport, PackResult, PackedFrame, Settings, TrimRect } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { computeAlphaBBox, hashPixels } from "./trim";
import { packFrames, type PackLayout } from "./pack";
import {
  buildFullReport,
  packIncremental,
  type IncrementalInput,
  type LayoutBaseline
} from "./incremental";
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
/** 帧列表相对最近一次打包结果已变化：界面上的旧布局标记为「基线」，预览不再把它当当前结果 */
export const packStale = writable(false);
export const selectedId = writable<string | null>(null);
export const busy = writable(false);
export const status = writable<{ kind: "info" | "error"; text: string } | null>(null);

/** 增量方案放不下时的确认状态：等待用户选择全量重排或取消（取消保留旧布局） */
export const repackPrompt = writable<
  | {
      reason: string;
      /** 已裁切的待打包输入与结果画布，供确认后直接全量重排，避免重复解码 */
      inputs: IncrementalInput[];
      canvases: Map<string, HTMLCanvasElement>;
    }
  | null
>(null);

export const frameCount = derived(frames, ($f) => $f.length);
/** 未过期的打包结果（帧变化后返回 null，预览改用单帧） */
export const livePack = derived([packResult, packStale], ([$p, $stale]) =>
  $stale ? null : $p
);

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
    const current = get(frames);
    const taken = new Set(current.map((f) => f.name));
    const added: FrameItem[] = [];
    for (const file of list) {
      try {
        const img = await blobToImage(file);
        const name = uniqueName(file.name, taken);
        taken.add(name);
        added.push({
          id: uid(),
          name,
          duration: 100,
          width: img.naturalWidth,
          height: img.naturalHeight,
          blob: file,
          url: URL.createObjectURL(file)
        });
      } catch {
        notify(`无法解码图片：${file.name}`, "error");
      }
    }
    if (added.length > 0) {
      frames.set([...current, ...added]);
      // 旧布局不丢弃：它是增量重打包的基线，仅标记为过期
      if (get(packResult)) packStale.set(true);
      repackPrompt.set(null); // 帧列表已变，旧的失败提示失效
      notify(`已导入 ${added.length} 帧`);
    }
  } finally {
    busy.set(false);
  }
}

/** 替换同名帧的图片内容（同名内容变化 = 替换，增量打包时尽量原地更新） */
export async function replaceFrameFile(id: string, file: File): Promise<void> {
  const list = get(frames);
  const f = list.find((x) => x.id === id);
  const isPng = /png$/i.test(file.type) || /\.png$/i.test(file.name);
  if (!f || !isPng) return;
  busy.set(true);
  try {
    const img = await blobToImage(file);
    URL.revokeObjectURL(f.url);
    const updated: FrameItem = {
      ...f,
      width: img.naturalWidth,
      height: img.naturalHeight,
      blob: file,
      url: URL.createObjectURL(file)
    };
    frames.set(list.map((x) => (x.id === id ? updated : x)));
    if (get(packResult)) packStale.set(true);
    repackPrompt.set(null);
    notify(`已替换 ${f.name} 的图片`);
  } catch {
    notify(`无法解码图片：${file.name}`, "error");
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
  // 删除不主动压缩：旧布局保留为基线，等待增量打包
  if (get(packResult)) packStale.set(true);
  repackPrompt.set(null);
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
  // 顺序变化只影响播放/输出顺序，不改变坐标基线
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
  packStale.set(false);
  selectedId.set(null);
  lastJSON = null;
  repackPrompt.set(null);
}

// ---------- 打包 ----------

interface TrimmedFrame {
  item: FrameItem;
  canvas: HTMLCanvasElement;
  trim: TrimRect;
  hash: string;
}

/** 裁切（或保留）单帧，返回内容画布、裁切信息与内容哈希 */
async function trimFrame(item: FrameItem, doTrim: boolean): Promise<TrimmedFrame> {
  const img = await blobToImage(item.blob);
  if (!doTrim) {
    const canvas = makeCanvas(item.width, item.height);
    ctx2d(canvas).drawImage(img, 0, 0);
    const pixels = imageToPixels(img, item.width, item.height);
    return { item, canvas, trim: { x: 0, y: 0, w: item.width, h: item.height }, hash: await hashPixels(pixels) };
  }
  const pixels = imageToPixels(img, item.width, item.height);
  const bbox = computeAlphaBBox(pixels);
  if (!bbox) {
    // 完全透明：保留 1×1，避免 0 尺寸；哈希仍覆盖原始像素，同名同内容才可判同
    const canvas = makeCanvas(1, 1);
    return {
      item,
      canvas,
      trim: { x: 0, y: 0, w: 1, h: 1 },
      hash: `empty:${item.width}x${item.height}:${await hashPixels(pixels)}`
    };
  }
  const canvas = makeCanvas(bbox.w, bbox.h);
  ctx2d(canvas).drawImage(img, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
  const cropped = imageToPixels(canvas, bbox.w, bbox.h);
  return { item, canvas, trim: bbox, hash: await hashPixels(cropped) };
}

/** 由当前打包结果构造增量基线（无哈希的旧结果用 legacy 占位，按尺寸判同） */
function baselineFromResult(p: PackResult): LayoutBaseline | null {
  if (!p || p.frames.length === 0) return null;
  return {
    atlasWidth: p.atlasWidth,
    atlasHeight: p.atlasHeight,
    frames: p.frames.map((f) => ({
      name: f.name,
      w: f.w,
      h: f.h,
      trim: { ...f.trim },
      srcW: f.srcW,
      srcH: f.srcH,
      hash: f.hash || `legacy:${f.w}x${f.h}`,
      x: f.x,
      y: f.y
    }))
  };
}

/** 基线能否在当前设置下继续复用（留白/裁切口径必须一致） */
function baselineUsable(p: PackResult, s: Settings): boolean {
  return p.padding === s.padding && p.trimmed === s.trim;
}

/** 执行打包并生成图集；forceFull=true 时跳过增量直接全量重排 */
export async function pack(forceFull = false): Promise<void> {
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

    const inputs: IncrementalInput[] = trimmed.map((t) => ({
      id: t.item.id,
      name: t.item.name,
      w: t.canvas.width,
      h: t.canvas.height,
      trim: t.trim,
      srcW: t.item.width,
      srcH: t.item.height,
      duration: t.item.duration,
      hash: t.hash
    }));
    const canvases = new Map(trimmed.map((t) => [t.item.id, t.canvas]));

    const oldResult = get(packResult);
    const baseline = oldResult && baselineUsable(oldResult, s) ? baselineFromResult(oldResult) : null;

    let layout: PackLayout;
    let reportKind: { incremental: boolean; strategy: "stable" | "compact" };
    let report: PackReport;

    const useIncremental = !forceFull && s.strategy === "stable" && baseline !== null;

    if (useIncremental && baseline) {
      const inc = packIncremental(inputs, baseline, {
        padding: s.padding,
        maxSize: s.maxSize,
        pot: s.pot,
        strategy: s.strategy
      });
      if (inc) {
        layout = inc.layout;
        report = inc.report;
        reportKind = { incremental: true, strategy: "stable" };
      } else {
        // 增量方案无法满足尺寸：明确提示，不污染旧布局，等待用户选择
        repackPrompt.set({
          reason: `稳定布局无法把变更后的 ${inputs.length} 帧全部放入 ${s.maxSize}×${s.maxSize}：保留原有坐标会超出图集上限或发生重叠。可以全量重排（可能移动较多帧），或取消并保留旧布局。`,
          inputs,
          canvases
        });
        notify("增量方案放不下：请选择全量重排或取消（旧布局已保留）", "error");
        return;
      }
    } else {
      // 首次打包 / 紧凑优先 / 强制全量
      layout = packFrames(inputs, s.padding, s.maxSize, s.pot);
      if (baseline) {
        report = buildFullReport(inputs, layout, baseline, forceFull ? "stable" : s.strategy);
      } else {
        // 首次打包没有基线：不把所有帧标成「新增」，给中性摘要
        report = {
          incremental: false,
          strategy: s.strategy,
          kept: 0,
          moved: 0,
          replaced: 0,
          added: 0,
          removed: 0,
          deltas: inputs.map((f) => {
            const n = layout.frames.find((p) => p.id === f.id)!;
            return {
              name: f.name,
              kind: "kept" as const,
              to: { x: n.x, y: n.y, w: n.w, h: n.h },
              dx: 0,
              dy: 0
            };
          }),
          timestamp: Date.now()
        };
      }
      reportKind = { incremental: false, strategy: forceFull ? "stable" : s.strategy };
    }

    await commitLayout(layout, report, reportKind, s, canvases);
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
  }
}

/** 合成图集画布、更新结果与 JSON */
async function commitLayout(
  layout: PackLayout,
  report: PackReport,
  kind: { incremental: boolean; strategy: "stable" | "compact" },
  s: Settings,
  canvases: Map<string, HTMLCanvasElement>
): Promise<void> {
  const atlas = makeCanvas(layout.atlasWidth, layout.atlasHeight);
  const ctx = ctx2d(atlas);
  for (const f of layout.frames) {
    const c = canvases.get(f.id);
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
    report
  };
  packResult.set(result);
  packStale.set(false);
  repackPrompt.set(null);
  lastJSON = buildAtlasJSON(layout, {
    imageName: "atlas.png",
    trimmed: s.trim,
    settings: s,
    incremental: kind.incremental,
    report
  });

  if (kind.incremental) {
    notify(
      `增量打包完成：保持 ${report.kept} · 移动 ${report.moved} · 替换 ${report.replaced} · 新增 ${report.added} · 删除 ${report.removed}`,
      "info"
    );
  } else {
    notify(
      `全量重排完成：${layout.atlasWidth}×${layout.atlasHeight}，共 ${layout.frames.length} 帧` +
        (kind.strategy === "compact" ? "（紧凑优先）" : "")
    );
  }
}

/** 用户在提示框中选择「全量重排」 */
export async function confirmFullRepack(): Promise<void> {
  const prompt = get(repackPrompt);
  if (!prompt) return;
  const s = get(settings);
  busy.set(true);
  try {
    const { inputs, canvases } = prompt;
    const baseline = (() => {
      const old = get(packResult);
      return old && baselineUsable(old, s) ? baselineFromResult(old) : null;
    })();
    const layout = packFrames(inputs, s.padding, s.maxSize, s.pot);
    const report = buildFullReport(inputs, layout, baseline, "stable");
    await commitLayout(layout, report, { incremental: false, strategy: "stable" }, s, canvases);
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
  }
}

/** 用户在提示框中选择「取消」：关闭提示，旧布局原样保留 */
export function cancelFullRepack(): void {
  repackPrompt.set(null);
  notify("已取消：继续使用旧布局", "info");
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
 * 从导出的 JSON 恢复帧列表、时长、打包结果与增量基线。
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
    const hashByName = new Map<string, string>();
    const restoredData: Array<{ item: FrameItem; parsed: (typeof parsed.frames)[number] }> = [];
    for (const f of parsed.frames) {
      const full = makeCanvas(f.sourceSize.w, f.sourceSize.h);
      ctx2d(full).drawImage(
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
      const blob = await canvasToBlob(full);
      const id = uid();
      const item: FrameItem = {
        id,
        name: f.name,
        duration: f.duration,
        width: f.sourceSize.w,
        height: f.sourceSize.h,
        blob,
        url: URL.createObjectURL(blob)
      };
      restored.push(item);
      restoredData.push({ item, parsed: f });
    }

    // 帧身份摘要：优先用 JSON 的 contentHash；缺失（旧版导出）时从恢复出的帧重新裁切计算
    for (const { item, parsed: f } of restoredData) {
      if (f.contentHash) {
        hashByName.set(item.name, f.contentHash);
      } else {
        try {
          const t = await trimFrame(item, parsed.settings.trim !== false);
          hashByName.set(item.name, t.hash);
        } catch {
          hashByName.set(item.name, `legacy:${f.frame.w}x${f.frame.h}`);
        }
      }
    }

    const packedFrames: PackedFrame[] = restoredData.map(({ item, parsed: f }) => ({
      id: item.id,
      name: f.name,
      x: f.frame.x,
      y: f.frame.y,
      w: f.frame.w,
      h: f.frame.h,
      trim: { ...f.spriteSourceSize },
      srcW: f.sourceSize.w,
      srcH: f.sourceSize.h,
      duration: f.duration,
      hash: f.contentHash ?? hashByName.get(f.name) ?? `legacy:${f.frame.w}x${f.frame.h}`
    }));

    clearAll();
    frames.set(restored);
    settings.set({ ...parsed.settings });
    const result: PackResult = {
      atlasWidth: parsed.size.w,
      atlasHeight: parsed.size.h,
      frames: packedFrames,
      atlasBlob,
      atlasUrl: URL.createObjectURL(atlasBlob),
      padding: parsed.settings.padding,
      trimmed: parsed.settings.trim,
      ...(parsed.report ? { report: parsed.report } : {})
    };
    packResult.set(result);
    packStale.set(false);
    lastJSON = buildAtlasJSON(
      { atlasWidth: parsed.size.w, atlasHeight: parsed.size.h, frames: packedFrames },
      {
        imageName: parsed.imageName,
        trimmed: parsed.settings.trim,
        settings: parsed.settings,
        incremental: parsed.incremental,
        ...(parsed.report ? { report: parsed.report } : {})
      }
    );
    notify(`已从 JSON 恢复 ${restored.length} 帧与打包基线，可继续增量打包`);
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
  }
}

// ---------- IndexedDB 持久化 ----------

export async function saveNow(): Promise<void> {
  try {
    await saveProject(toStored(get(frames), get(settings), get(packResult), lastJSON));
    notify("项目已保存到浏览器本地（含布局基线与结果摘要）");
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
      // 刷新恢复后帧身份仍需内容摘要：优先用 JSON 里的 contentHash，
      // 缺失时（旧版本数据）从存储的原始 PNG 重新裁切计算，保证后续增量判同正确。
      const hashByName = new Map<string, string>();
      const trimOn = parsed.settings.trim !== false;
      for (const item of restored) {
        const pf = parsed.frames.find((f) => f.name === item.name);
        if (pf?.contentHash) {
          hashByName.set(item.name, pf.contentHash);
        } else {
          try {
            const t = await trimFrame(item, trimOn);
            hashByName.set(item.name, t.hash);
          } catch {
            hashByName.set(item.name, `legacy:${item.width}x${item.height}`);
          }
        }
      }
      // 以名字匹配恢复的帧 id（导出再导入/刷新后 id 会重建，名字才是帧身份）
      const idByName = new Map(restored.map((f) => [f.name, f.id]));
      const packedFrames: PackedFrame[] = parsed.frames.map((f) => ({
        id: idByName.get(f.name) ?? uid(),
        name: f.name,
        x: f.frame.x,
        y: f.frame.y,
        w: f.frame.w,
        h: f.frame.h,
        trim: { ...f.spriteSourceSize },
        srcW: f.sourceSize.w,
        srcH: f.sourceSize.h,
        duration: f.duration,
        hash: f.contentHash ?? hashByName.get(f.name) ?? `legacy:${f.frame.w}x${f.frame.h}`
      }));
      packResult.set({
        atlasWidth: parsed.size.w,
        atlasHeight: parsed.size.h,
        frames: packedFrames,
        atlasBlob: stored.pack.atlasBlob,
        atlasUrl: URL.createObjectURL(stored.pack.atlasBlob),
        padding: parsed.settings.padding,
        trimmed: parsed.settings.trim,
        ...(parsed.report ? { report: parsed.report } : {})
      });
      // 恢复时判断旧打包是否仍是当前帧列表的基线：
      // 帧名序列不一致（增/删/改名/调序）或留白/裁切口径变了，就标记为过期
      const SEP = "␟";
      const currentNames = restored.map((f) => f.name).join(SEP);
      const packedNames = parsed.frames.map((f) => f.name).join(SEP);
      const s0 = { ...DEFAULT_SETTINGS, ...stored.settings };
      packStale.set(
        currentNames !== packedNames ||
          parsed.settings.padding !== s0.padding ||
          parsed.settings.trim !== s0.trim
      );
      lastJSON = stored.pack.json;
    }
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
    void saveProject(toStored(get(frames), get(settings), get(packResult), lastJSON)).catch(() => {});
  }, 600);
}

export function startAutoSave(): void {
  frames.subscribe(() => scheduleSave());
  settings.subscribe(() => scheduleSave());
  packResult.subscribe(() => scheduleSave());
}
