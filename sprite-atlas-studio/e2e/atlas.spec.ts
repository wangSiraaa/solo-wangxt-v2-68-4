import { expect, test, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "test-assets");
const FRAME_NAMES = readdirSync(ASSETS).filter((f) => f.endsWith(".png")).sort();

async function importFrames(page: Page): Promise<void> {
  const files = FRAME_NAMES.map((f) => join(ASSETS, f));
  await page.locator("#png-input").setInputFiles(files);
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(FRAME_NAMES.length);
}

/** 从图集表格读出 name → [x, y, w, h] */
async function readAtlasTable(page: Page): Promise<Record<string, number[]>> {
  const rows = page.locator("#atlas-table tbody tr");
  const out: Record<string, number[]> = {};
  for (const row of await rows.all()) {
    const name = await row.locator("td").nth(1).innerText();
    const nums: number[] = [];
    for (const col of [2, 3, 4, 5]) {
      nums.push(Number(await row.locator("td").nth(col).innerText()));
    }
    out[name] = nums;
  }
  return out;
}

test("完整流程：导入 → 设置时长 → 打包 → 预览 → 导出 → 清空 → 导入 JSON 恢复", async ({
  page
}) => {
  await page.goto("/");

  // 1) 导入不同尺寸 + 透明边缘的 PNG
  await importFrames(page);

  // 2) 设置：留白 3px、裁切透明边缘（默认开启）、全部帧 100ms，首帧改为 250ms
  await page.locator("#opt-padding").fill("3");
  await expect(page.locator("#opt-trim")).toBeChecked();
  await page.locator("#uniform-duration").fill("100");
  await page.getByRole("button", { name: "应用到全部帧" }).click();
  const firstDur = page.locator(`[data-duration-for="walk_01.png"]`);
  await firstDur.fill("250");
  await firstDur.dispatchEvent("change");

  // 3) 打包
  await page.locator("#pack-btn").click();
  await expect(page.locator("#atlas-image")).toBeVisible();
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(FRAME_NAMES.length);
  const summary = await page.locator("#atlas-summary").innerText();
  expect(summary).toContain("留白 3px");
  expect(summary).toContain("已裁切透明边缘");

  // 表格中的位置尺寸（供后面与恢复结果比对）
  const tableBefore = await readAtlasTable(page);
  expect(Object.keys(tableBefore)).toHaveLength(FRAME_NAMES.length);
  for (const [name, rect] of Object.entries(tableBefore)) {
    expect(rect[2], `${name} 宽度应大于 0`).toBeGreaterThan(0);
    expect(rect[3], `${name} 高度应大于 0`).toBeGreaterThan(0);
  }

  // 4) 预览：按原顺序与时长播放（首帧 250ms，其余 100ms）
  await expect(page.locator("#preview-frame-label")).toContainText("帧 1/8");
  await expect(page.locator("#preview-atlas-info")).toContainText("图集 (");
  // 等到播放进入后续帧（首帧 250ms 后应切到帧 2）
  await expect(page.locator("#preview-frame-label")).toContainText("帧 2/8", { timeout: 3000 });
  // 播完一轮应循环回帧 1（总时长 250 + 7*100 = 950ms）
  await expect(page.locator("#preview-frame-label")).toContainText("帧 1/8", { timeout: 5000 });

  // 5) 导出 JSON 与 PNG
  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#export-json-btn").click()
  ]);
  const jsonPath = await jsonDownload.path();
  const json = JSON.parse(readFileSync(jsonPath, "utf-8"));

  const [pngDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#export-png-btn").click()
  ]);
  expect((await pngDownload.path())).toBeTruthy();

  // 校验 JSON 内容：帧列表、顺序、时长、位置尺寸、内嵌图集
  expect(json.meta.app).toBe("sprite-atlas-studio");
  expect(json.meta.frameOrder).toEqual(FRAME_NAMES);
  expect(Object.keys(json.frames)).toHaveLength(FRAME_NAMES.length);
  expect(json.frames["walk_01.png"].duration).toBe(250);
  expect(json.frames["walk_02.png"].duration).toBe(100);
  expect(typeof json.meta.atlasDataURL).toBe("string");
  expect(json.meta.atlasDataURL.startsWith("data:image/png;base64,")).toBe(true);
  // JSON 中的矩形与页面表格一致
  for (const [name, rect] of Object.entries(tableBefore)) {
    const f = json.frames[name];
    expect([f.frame.x, f.frame.y, f.frame.w, f.frame.h], name).toEqual(rect);
    expect(f.rotated).toBe(false);
  }

  // 6) 清空（同时清掉 IndexedDB）
  await page.getByRole("button", { name: "清空" }).click();
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(0);

  // 7) 导入 JSON 恢复（图集内嵌，无需另选 PNG）
  await page.locator("#json-input").setInputFiles({
    name: "atlas.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(json))
  });
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(FRAME_NAMES.length);
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(FRAME_NAMES.length);

  // 帧顺序与时长恢复
  const names = await page.locator("#frame-list .frame-item .name").allInnerTexts();
  expect(names).toEqual(FRAME_NAMES);
  await expect(page.locator(`[data-duration-for="walk_01.png"]`)).toHaveValue("250");
  await expect(page.locator(`[data-duration-for="walk_02.png"]`)).toHaveValue("100");

  // 打包结果恢复：位置尺寸与导出前一致
  const tableAfter = await readAtlasTable(page);
  expect(tableAfter).toEqual(tableBefore);

  // 预览恢复播放
  await expect(page.locator("#preview-frame-label")).toContainText("帧 1/8");
  await expect(page.locator("#preview-atlas-info")).toContainText("图集 (");

  // 8) IndexedDB 持久化：等待自动保存落盘后刷新页面，项目应恢复
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(FRAME_NAMES.length);
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(FRAME_NAMES.length);
});
