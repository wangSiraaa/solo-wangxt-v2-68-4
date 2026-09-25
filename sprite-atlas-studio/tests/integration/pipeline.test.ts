/**
 * 集成测试：用生成的真实 PNG（不同尺寸 + 透明边缘）走完整管线——
 * 裁切 → maxrects 打包 → 合成图集 → 导出 JSON → 重新导入恢复，
 * 并验证预览位置（裁切偏移）与每帧时长。
 * 在 Node 中用 @napi-rs/canvas 模拟浏览器画布。
 */
import { describe, expect, it } from "vitest";
import { createCanvas, loadImage, type Canvas, type Image } from "@napi-rs/canvas";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { computeAlphaBBox } from "../../src/lib/core/trim";
import { packFrames, type PackInput } from "../../src/lib/core/pack";
import { buildAtlasJSON, parseAtlasJSON } from "../../src/lib/core/serialize";
import { Animator, frameIndexAt } from "../../src/lib/core/animator";
import { DEFAULT_SETTINGS, type Pixels, type TrimRect } from "../../src/lib/core/types";

const ASSETS = join(__dirname, "..", "..", "test-assets");

// 与 scripts/gen-test-assets.mjs 中 SPECS 对应：[宽, 高, 上, 右, 下, 左]
const EXPECTED: Record<string, { size: [number, number]; margin: [number, number, number, number] }> = {
  "walk_01.png": { size: [64, 64], margin: [10, 14, 6, 8] },
  "walk_02.png": { size: [64, 64], margin: [12, 10, 8, 12] },
  "walk_03.png": { size: [96, 48], margin: [4, 20, 4, 6] },
  "walk_04.png": { size: [128, 128], margin: [30, 30, 30, 30] },
  "walk_05.png": { size: [37, 53], margin: [3, 5, 7, 2] },
  "walk_06.png": { size: [200, 150], margin: [0, 0, 0, 0] },
  "walk_07.png": { size: [16, 16], margin: [2, 2, 2, 2] },
  "walk_08.png": { size: [80, 90], margin: [25, 5, 15, 35] }
};

const DURATIONS = [50, 80, 120, 100, 33, 200, 90, 60];
const PADDING = 3;

function pixelsOf(img: Image, w: number, h: number): Pixels {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, w, h);
  return { data: d.data, width: d.width, height: d.height };
}

function px(p: Pixels, x: number, y: number): [number, number, number, number] {
  const i = (y * p.width + x) * 4;
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!, p.data[i + 3]!];
}

async function loadAll(): Promise<Array<{ name: string; img: Image; buf: Buffer }>> {
  const files = readdirSync(ASSETS).filter((f) => f.endsWith(".png")).sort();
  const out = [];
  for (const name of files) {
    const buf = readFileSync(join(ASSETS, name));
    out.push({ name, img: await loadImage(buf), buf });
  }
  return out;
}

describe("完整管线：真实 PNG（不同尺寸 + 透明边缘）", () => {
  it("裁切结果与生成时的透明边缘一致", async () => {
    const frames = await loadAll();
    expect(frames.length).toBe(8);
    for (const [i, f] of frames.entries()) {
      const spec = EXPECTED[f.name]!;
      const [w, h] = spec.size;
      const [mt, mr, mb, ml] = spec.margin;
      const bbox = computeAlphaBBox(pixelsOf(f.img, w, h));
      expect(bbox, f.name).toEqual({ x: ml, y: mt, w: w - ml - mr, h: h - mt - mb });
      void i;
    }
  });

  it("打包 → 合成图集 → 导出 JSON → 重新导入完整恢复", async () => {
    const frames = await loadAll();

    // 1) 裁切
    const trimmed = frames.map((f, i) => {
      const spec = EXPECTED[f.name]!;
      const [w, h] = spec.size;
      const bbox = computeAlphaBBox(pixelsOf(f.img, w, h))!;
      return { name: f.name, img: f.img, srcW: w, srcH: h, trim: bbox, duration: DURATIONS[i]! };
    });

    // 2) 打包（固定方向 + 统一留白）
    const inputs: PackInput[] = trimmed.map((t, i) => ({
      id: `f${i}`,
      name: t.name,
      w: t.trim.w,
      h: t.trim.h,
      trim: t.trim,
      srcW: t.srcW,
      srcH: t.srcH,
      duration: t.duration
    }));
    const layout = packFrames(inputs, PADDING, 1024, true);

    // 3) 合成图集
    const atlas = createCanvas(layout.atlasWidth, layout.atlasHeight);
    const actx = atlas.getContext("2d");
    for (const [i, f] of layout.frames.entries()) {
      const t = trimmed[i]!;
      actx.drawImage(t.img, t.trim.x, t.trim.y, t.trim.w, t.trim.h, f.x, f.y, f.w, f.h);
    }
    const atlasPixels: Pixels = (() => {
      const d = actx.getImageData(0, 0, atlas.width, atlas.height);
      return { data: d.data, width: d.width, height: d.height };
    })();

    // 4) 验证图集中每帧位置：内容左上角标记点（绿色）应出现在 (x, y)
    for (const [i, f] of layout.frames.entries()) {
      const t = trimmed[i]!;
      void i;
      const [r, g, b, a] = px(atlasPixels, f.x, f.y);
      expect([r, g, b], `${t.name} 内容左上角`).toEqual([0, 255, 128]);
      expect(a).toBe(255);
      // 内容右下角标记（蓝色）
      const [r2, g2, b2] = px(atlasPixels, f.x + f.w - 1, f.y + f.h - 1);
      expect([r2, g2, b2], `${t.name} 内容右下角`).toEqual([0, 128, 255]);
      // 统一留白：内容四周 PADDING 范围内应全透明
      for (let k = 1; k <= PADDING; k++) {
        if (f.x - k >= 0) expect(px(atlasPixels, f.x - k, f.y)[3], `${t.name} 左侧留白`).toBe(0);
        if (f.y - k >= 0) expect(px(atlasPixels, f.x, f.y - k)[3], `${t.name} 上侧留白`).toBe(0);
      }
    }

    // 5) 导出 JSON（内嵌图集 dataURL）
    const settings = { ...DEFAULT_SETTINGS, padding: PADDING, maxSize: 1024 };
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings,
      atlasDataURL: atlas.toDataURL("image/png")
    });
    const jsonText = JSON.stringify(json, null, 2);

    // 6) 重新导入：解析 JSON + 从内嵌图集恢复
    const parsed = parseAtlasJSON(JSON.parse(jsonText));
    expect(parsed.frames.map((f) => f.name)).toEqual(trimmed.map((t) => t.name));
    expect(parsed.frames.map((f) => f.duration)).toEqual(DURATIONS);
    expect(parsed.settings.padding).toBe(PADDING);

    const restoredAtlas = await loadImage(Buffer.from(atlas.toBuffer("image/png")));
    for (const [i, pf] of parsed.frames.entries()) {
      // 从图集切出内容，按 spriteSourceSize 放回原始尺寸 —— 应与原 PNG 逐像素一致
      const full: Canvas = createCanvas(pf.sourceSize.w, pf.sourceSize.h);
      const fctx = full.getContext("2d");
      fctx.drawImage(
        restoredAtlas,
        pf.frame.x, pf.frame.y, pf.frame.w, pf.frame.h,
        pf.spriteSourceSize.x, pf.spriteSourceSize.y, pf.frame.w, pf.frame.h
      );
      const got = fctx.getImageData(0, 0, full.width, full.height);
      const orig = pixelsOf(frames[i]!.img, pf.sourceSize.w, pf.sourceSize.h);
      expect(Buffer.from(got.data).equals(Buffer.from(orig.data)),
        `${pf.name} 恢复后应与原图逐像素一致`).toBe(true);

      // 打包结果恢复：位置尺寸与 layout 一致
      const src = layout.frames[i]!;
      expect([pf.frame.x, pf.frame.y, pf.frame.w, pf.frame.h]).toEqual([src.x, src.y, src.w, src.h]);
    }
  });

  it("预览位置：裁切内容按偏移放回后与原始帧一致", async () => {
    const frames = await loadAll();
    for (const f of frames) {
      const spec = EXPECTED[f.name]!;
      const [w, h] = spec.size;
      const bbox: TrimRect = computeAlphaBBox(pixelsOf(f.img, w, h))!;
      // 模拟预览：把裁切内容绘制到 (trim.x, trim.y)
      const stage = createCanvas(w, h);
      const sctx = stage.getContext("2d");
      sctx.drawImage(f.img, bbox.x, bbox.y, bbox.w, bbox.h, bbox.x, bbox.y, bbox.w, bbox.h);
      const got = sctx.getImageData(0, 0, w, h);
      const orig = pixelsOf(f.img, w, h);
      expect(Buffer.from(got.data).equals(Buffer.from(orig.data)), f.name).toBe(true);
    }
  });

  it("预览时长：按每帧时长推进的帧序与解析式一致", () => {
    const animator = new Animator(DURATIONS);
    const seq: number[] = [];
    // 以 16ms 步进模拟 ticker，跑两轮
    const total = DURATIONS.reduce((a, b) => a + b, 0);
    for (let t = 0; t < total * 2; t += 16) {
      seq.push(animator.tick(16));
    }
    // 与解析式抽样比对
    const sample = [0, 49, 50, 129, 130, 249, 250, 369, 370, 469, 470, 502, 503, 669, 670, 759, 760, 849, 850, 909, 910];
    for (const t of sample) {
      if (t < total) {
        const a = new Animator(DURATIONS);
        expect(a.tick(t), `t=${t}`).toBe(frameIndexAt(DURATIONS, t));
      }
    }
    // 帧序应包含循环：第一轮 8 帧播完后回到 0
    expect(seq).toContain(0);
    expect(seq.filter((v) => v === 0).length).toBeGreaterThan(1);
  });
});
