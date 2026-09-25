import { describe, expect, it } from "vitest";
import { buildAtlasJSON, parseAtlasJSON, JSON_APP_ID } from "../../src/lib/core/serialize";
import { packFrames, type PackInput } from "../../src/lib/core/pack";
import { DEFAULT_SETTINGS } from "../../src/lib/core/types";

function makeLayout() {
  const inputs: PackInput[] = [
    { id: "1", name: "run_01.png", w: 42, h: 48, trim: { x: 8, y: 10, w: 42, h: 48 }, srcW: 64, srcH: 64, duration: 50 },
    { id: "2", name: "run_02.png", w: 70, h: 40, trim: { x: 6, y: 4, w: 70, h: 40 }, srcW: 96, srcH: 48, duration: 80 },
    { id: "3", name: "run_03.png", w: 200, h: 150, trim: { x: 0, y: 0, w: 200, h: 150 }, srcW: 200, srcH: 150, duration: 120 }
  ];
  return packFrames(inputs, 2, 1024, true);
}

describe("buildAtlasJSON / parseAtlasJSON", () => {
  it("导出后再导入：帧列表、顺序、时长、位置、裁切信息完整恢复", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: { ...DEFAULT_SETTINGS, padding: 2, maxSize: 1024 },
      atlasDataURL: "data:image/png;base64,AAAA"
    });

    const parsed = parseAtlasJSON(JSON.parse(JSON.stringify(json)));

    expect(parsed.size).toEqual({ w: layout.atlasWidth, h: layout.atlasHeight });
    expect(parsed.frames.map((f) => f.name)).toEqual(["run_01.png", "run_02.png", "run_03.png"]);
    expect(parsed.frames.map((f) => f.duration)).toEqual([50, 80, 120]);
    expect(parsed.settings.padding).toBe(2);
    expect(parsed.atlasDataURL).toBe("data:image/png;base64,AAAA");

    for (const [i, f] of parsed.frames.entries()) {
      const src = layout.frames[i]!;
      expect(f.frame).toEqual({ x: src.x, y: src.y, w: src.w, h: src.h });
      expect(f.spriteSourceSize).toEqual({
        x: src.trim.x,
        y: src.trim.y,
        w: src.trim.w,
        h: src.trim.h
      });
      expect(f.sourceSize).toEqual({ w: src.srcW, h: src.srcH });
    }
  });

  it("JSON 可序列化为字符串再解析（模拟写盘/读盘）", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS
    });
    const text = JSON.stringify(json, null, 2);
    const parsed = parseAtlasJSON(JSON.parse(text));
    expect(parsed.frames).toHaveLength(3);
    expect(parsed.imageName).toBe("atlas.png");
  });

  it("拒绝非本工具 JSON", () => {
    expect(() => parseAtlasJSON({ frames: {}, meta: { app: "other" } })).toThrow(/meta\.app/);
    expect(() => parseAtlasJSON(null)).toThrow(/顶层/);
    expect(() => parseAtlasJSON({})).toThrow(/meta/);
  });

  it("拒绝越界帧矩形", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: true,
      settings: DEFAULT_SETTINGS
    });
    const tampered = JSON.parse(JSON.stringify(json));
    tampered.frames["run_01.png"].frame.x = 10000;
    expect(() => parseAtlasJSON(tampered)).toThrow(/超出图集范围/);
  });

  it("meta.app 标识正确", () => {
    const layout = makeLayout();
    const json = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: false,
      settings: DEFAULT_SETTINGS
    });
    expect(json.meta.app).toBe(JSON_APP_ID);
    expect(json.meta.totalDuration).toBe(50 + 80 + 120);
  });
});
