import { openDB, type IDBPDatabase } from "idb";
import type { FrameItem, LayoutBaseline, PackResult, PackSummary, Settings } from "./types";
import type { AtlasJSON } from "./serialize";

/**
 * IndexedDB 持久化：帧 PNG（Blob）、时长、设置、最近一次打包结果，
 * 以及增量重打包所需的布局基线、策略与结果摘要。
 * 全部保存在浏览器本地，不上传任何数据。
 */

const DB_NAME = "sprite-atlas-studio";
const STORE = "kv";
const PROJECT_KEY = "project";

export interface StoredPack {
  json: AtlasJSON;
  atlasBlob: Blob;
}

export interface StoredProject {
  version: 1;
  savedAt: number;
  settings: Settings;
  frames: Array<{
    id: string;
    name: string;
    duration: number;
    width: number;
    height: number;
    blob: Blob;
  }>;
  pack: StoredPack | null;
  /** 布局基线（增量重打包的坐标基准） */
  baseline?: LayoutBaseline | null;
  /** 最近一次打包的结果摘要 */
  lastSummary?: PackSummary | null;
}

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    }
  });
}

export async function saveProject(p: StoredProject): Promise<void> {
  const d = await db();
  await d.put(STORE, p, PROJECT_KEY);
}

export async function loadProject(): Promise<StoredProject | null> {
  const d = await db();
  const v = (await d.get(STORE, PROJECT_KEY)) as StoredProject | undefined;
  return v ?? null;
}

export async function clearProject(): Promise<void> {
  const d = await db();
  await d.delete(STORE, PROJECT_KEY);
}

/** 由运行时状态构造可存储对象 */
export function toStored(
  frames: FrameItem[],
  settings: Settings,
  pack: PackResult | null,
  json: AtlasJSON | null,
  baseline: LayoutBaseline | null = null,
  lastSummary: PackSummary | null = null
): StoredProject {
  return {
    version: 1,
    savedAt: Date.now(),
    settings: { ...settings },
    frames: frames.map((f) => ({
      id: f.id,
      name: f.name,
      duration: f.duration,
      width: f.width,
      height: f.height,
      blob: f.blob
    })),
    pack: pack && json ? { json, atlasBlob: pack.atlasBlob } : null,
    baseline,
    lastSummary
  };
}
