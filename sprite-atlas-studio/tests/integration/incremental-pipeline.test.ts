/**
 * 集成测试：稳定布局的增量重打包（真实 PNG）。
 * 覆盖验收项：
 * - 新增能塞入空洞时旧帧零移动
 * - 删除帧不主动压缩
 * - 替换为更大图像只移动必要帧
 * - 导出 JSON → 重新导入后继续增量打包仍以原坐标为基线
 * - 完全相同输入重复执行不产生漂移
 */
import { describe, expect, it } from "vitest";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { computeAlphaBBox } from "../../src/lib/core/trim";
import { digestPixels } from "../../src/lib/core/digest";
import {
  packFull,
  packIncremental,
  type IncFrameInput,
  type IncrementalOptions
} from "../../src/lib/core/incremental";
import { buildAtlasJSON, parseAtlasJSON } from "../../src/lib/core/serialize";
import type { LayoutBaseline, Pixels } from "../../src/lib/core/types";

const ASSETS = join(__dirname, "..", "..", "test-assets");
const OPTS: IncrementalOptions = {
  padding: 3,
  maxSize: 2048,
  pot: true,
  trim: true,
  strategy: "stable"
};

async function loadFrame(name: string, dir = ASSETS): Promise<IncFrameInput> {
  const img: Image = await loadImage(readFileSync(join(dir, name)));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height);
  const pixels: Pixels = { data: d.data, width: d.width, height: d.height };
  const trim = computeAlphaBBox(pixels)!;
  return {
    id: name,
    name,
    w: trim.w,
    h: trim.h,
    trim,
    srcW: img.width,
    srcH: img.height,
    duration: 100,
    digest: digestPixels(pixels)
  };
}

async function loadAll(): Promise<IncFrameInput[]> {
  const files = readdirSync(ASSETS).filter((f) => f.endsWith(".png")).sort();
  return Promise.all(files.map((f) => loadFrame(f)));
}

function positions(layout: { frames: Array<{ name: string; x: number; y: number }> }) {
  return new Map(layout.frames.map((f) => [f.name, { x: f.x, y: f.y }]));
}

describe("增量重打包（真实 PNG）", () => {
  it("删除帧不压缩；新增小帧塞入空洞，旧帧零移动", async () => {
    const all = await loadAll();
    const first = packFull(all, null, OPTS, "首次打包");
    const before = positions(first.layout);

    // 删除 walk_07，新增 extra_01（12×12，恰能塞入 walk_07 留下的 18×18 空洞）
    const extra = await loadFrame("extra_01.png", join(ASSETS, "extra"));
    const next = [...all.filter((f) => f.name !== "walk_07.png"), extra];
    const r = packIncremental(next, first.baseline, OPTS);

    expect(r.summary.deleted).toBe(1);
    expect(r.summary.added).toBe(1);
    expect(r.summary.moved).toBe(0);
    expect(r.summary.kept).toBe(7);
    // 图集尺寸不变（不主动压缩）
    expect(r.layout.atlasWidth).toBe(first.layout.atlasWidth);
    expect(r.layout.atlasHeight).toBe(first.layout.atlasHeight);
    // 全部旧帧坐标与首次打包一致
    for (const f of r.layout.frames) {
      if (f.name === "extra_01.png") continue;
      expect(positions(r.layout).get(f.name), f.name).toEqual(before.get(f.name));
    }
  });

  it("替换为更大图像：只移动必要帧，未受影响帧保持原位", async () => {
    const all = await loadAll();
    const first = packFull(all, null, OPTS, "首次打包");
    const before = positions(first.layout);

    // walk_04 同名替换为内容更大的版本（68×68 → 108×108）
    const big = await loadFrame("walk_04_big.png", join(ASSETS, "extra"));
    const replaced = all.map((f) =>
      f.name === "walk_04.png" ? { ...big, id: f.id, name: f.name } : f
    );
    const r = packIncremental(replaced, first.baseline, OPTS);

    expect(r.summary.replaced).toBe(1);
    expect(r.summary.deleted).toBe(0);
    // 本布局右侧有足够空洞，替换帧零移动落位；即使需要移动也只能是极少数
    expect(r.summary.moved).toBeLessThanOrEqual(2);
    expect(r.summary.kept).toBeGreaterThanOrEqual(5);
    // 未受影响帧坐标不变
    let unchanged = 0;
    for (const f of r.layout.frames) {
      if (f.name === "walk_04.png") continue;
      if (JSON.stringify(positions(r.layout).get(f.name)) === JSON.stringify(before.get(f.name))) {
        unchanged++;
      }
    }
    expect(unchanged).toBeGreaterThanOrEqual(5);
    // 替换帧尺寸更新为新内容
    const w4 = r.layout.frames.find((f) => f.name === "walk_04.png")!;
    expect([w4.w, w4.h]).toEqual([108, 108]);
  });

  it("完全相同输入重复执行不产生漂移", async () => {
    const all = await loadAll();
    const first = packFull(all, null, OPTS, "首次打包");
    const second = packIncremental(all, first.baseline, OPTS);
    expect(second.summary.kept).toBe(8);
    expect(second.summary.moved).toBe(0);
    expect(second.layout).toEqual(first.layout);
    expect(second.baseline).toEqual(first.baseline);
    const third = packIncremental(all, second.baseline, OPTS);
    expect(third.layout).toEqual(first.layout);
  });

  it("导出 JSON → 重新导入后，继续增量打包仍以原坐标为基线", async () => {
    const all = await loadAll();
    const first = packFull(all, null, OPTS, "首次打包");

    // 合成图集（与 store 中相同的绘制逻辑）
    const atlas = createCanvas(first.layout.atlasWidth, first.layout.atlasHeight);
    const actx = atlas.getContext("2d");
    for (const f of first.layout.frames) {
      const img = await loadImage(readFileSync(join(ASSETS, f.name)));
      actx.drawImage(img, f.trim.x, f.trim.y, f.trim.w, f.trim.h, f.x, f.y, f.w, f.h);
    }
    const json = buildAtlasJSON(first.layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: { trim: true, padding: 3, maxSize: 2048, pot: true, embedAtlas: true, strategy: "stable" },
      atlasDataURL: atlas.toDataURL("image/png")
    });

    // —— 模拟「导出 → 清空 → 导入 JSON 恢复」——
    const parsed = parseAtlasJSON(JSON.parse(JSON.stringify(json)));
    const restoredInputs: IncFrameInput[] = [];
    const baselineFrames: LayoutBaseline["frames"] = [];
    for (const pf of parsed.frames) {
      // 从图集切出内容放回原始尺寸画布（与 importJSON 相同）
      const full = createCanvas(pf.sourceSize.w, pf.sourceSize.h);
      const fctx = full.getContext("2d");
      fctx.drawImage(
        atlas,
        pf.frame.x, pf.frame.y, pf.frame.w, pf.frame.h,
        pf.spriteSourceSize.x, pf.spriteSourceSize.y, pf.frame.w, pf.frame.h
      );
      const d = fctx.getImageData(0, 0, full.width, full.height);
      const digest = digestPixels({ data: d.data, width: full.width, height: full.height });
      const orig = all.find((f) => f.name === pf.name)!;
      restoredInputs.push({
        ...orig,
        digest // 恢复帧的摘要（应与原帧一致：逐像素相同）
      });
      baselineFrames.push({
        name: pf.name,
        digest,
        x: pf.frame.x,
        y: pf.frame.y,
        w: pf.frame.w,
        h: pf.frame.h
      });
    }
    // 恢复帧摘要与原帧一致（像素级恢复 ⇒ 身份稳定）
    for (const ri of restoredInputs) {
      const orig = all.find((f) => f.name === ri.name)!;
      expect(ri.digest, ri.name).toBe(orig.digest);
    }

    const importedBaseline: LayoutBaseline = {
      atlasWidth: parsed.size.w,
      atlasHeight: parsed.size.h,
      padding: parsed.settings.padding,
      trim: parsed.settings.trim,
      pot: parsed.settings.pot,
      frames: baselineFrames
    };

    // 导入后不加任何修改直接再打包：全部保持，坐标与首次打包逐位一致（无漂移）
    const repack = packIncremental(restoredInputs, importedBaseline, OPTS);
    expect(repack.summary.kept).toBe(8);
    expect(repack.summary.moved).toBe(0);
    expect(repack.summary.added).toBe(0);
    expect(repack.summary.deleted).toBe(0);
    expect(positions(repack.layout)).toEqual(positions(first.layout));
    expect(repack.layout.atlasWidth).toBe(first.layout.atlasWidth);
    expect(repack.layout.atlasHeight).toBe(first.layout.atlasHeight);

    // 导入后再新增一帧：仍以原坐标为基线，旧帧零移动
    const extra = await loadFrame("extra_01.png", join(ASSETS, "extra"));
    const r2 = packIncremental(
      [...restoredInputs.filter((f) => f.name !== "walk_07.png"), extra],
      importedBaseline,
      OPTS
    );
    expect(r2.summary.moved).toBe(0);
    expect(r2.summary.kept).toBe(7);
    for (const f of r2.layout.frames) {
      if (f.name === "extra_01.png") continue;
      expect(positions(r2.layout).get(f.name), f.name).toEqual(positions(first.layout).get(f.name));
    }
  });
});
