import { expect, test, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "test-assets");
const EXTRA = join(ASSETS, "extra");
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

async function pack(page: Page): Promise<void> {
  await page.locator("#pack-btn").click();
  await expect(page.locator("#pack-summary")).toBeVisible();
}

test("增量重打包：删除/新增/替换/重复执行/刷新/导出再导入", async ({ page }) => {
  await page.goto("/");
  await importFrames(page);
  await page.locator("#opt-padding").fill("3");

  // 首次打包（全量）
  await pack(page);
  await expect(page.locator("#summary-strategy")).toContainText("首次打包");
  await expect(page.locator("#sum-added")).toHaveText("新增 8");
  const baseTable = await readAtlasTable(page);
  const baseSummary = await page.locator("#atlas-summary").innerText();
  expect(baseSummary).toContain("图集 256×512");

  // 1) 删除 walk_07：不主动压缩，其余帧零移动
  await page.locator('[data-frame-name="walk_07.png"] button[title="删除"]').click();
  await expect(page.locator("#pack-stale")).toBeVisible();
  await pack(page);
  await expect(page.locator("#pack-stale")).toHaveCount(0);
  await expect(page.locator("#sum-kept")).toHaveText("保持 7");
  await expect(page.locator("#sum-moved")).toHaveText("移动 0");
  await expect(page.locator("#sum-deleted")).toHaveText("删除 1");
  await expect(page.locator("#atlas-summary")).toContainText("图集 256×512"); // 尺寸不变
  let table = await readAtlasTable(page);
  for (const name of FRAME_NAMES) {
    if (name === "walk_07.png") continue;
    expect(table[name], name).toEqual(baseTable[name]); // 旧帧零移动
  }
  // 坐标差异列表中出现删除记录
  await expect(page.locator('[data-change-for="walk_07.png"]')).toHaveText(/删除 walk_07\.png/);

  // 2) 新增 extra_01（12×12，塞入空洞）：旧帧零移动
  await page.locator("#png-input").setInputFiles(join(EXTRA, "extra_01.png"));
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(8);
  await pack(page);
  await expect(page.locator("#sum-kept")).toHaveText("保持 7");
  await expect(page.locator("#sum-moved")).toHaveText("移动 0");
  await expect(page.locator("#sum-added")).toHaveText("新增 1");
  await expect(page.locator("#sum-deleted")).toHaveText("删除 0");
  table = await readAtlasTable(page);
  for (const name of FRAME_NAMES) {
    if (name === "walk_07.png") continue;
    expect(table[name], name).toEqual(baseTable[name]);
  }
  expect(table["extra_01.png"]).toBeTruthy();
  const afterAdd = table;

  // 3) 同名替换 walk_04 为更大内容（68×68 → 108×108）：只移动必要帧
  await page.locator("#png-input").setInputFiles({
    name: "walk_04.png",
    mimeType: "image/png",
    buffer: readFileSync(join(EXTRA, "walk_04_big.png"))
  });
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(8); // 替换不增加帧数
  await pack(page);
  await expect(page.locator("#sum-added")).toHaveText("新增 0（含替换 1）");
  await expect(page.locator("#sum-moved")).toHaveText("移动 0"); // 本布局右侧有空洞，零移动
  await expect(page.locator("#sum-kept")).toHaveText("保持 7");
  await expect(page.locator('[data-change-for="walk_04.png"]')).toHaveText(/替换 walk_04\.png/);
  table = await readAtlasTable(page);
  expect(table["walk_04.png"]?.slice(2)).toEqual([108, 108]); // 新内容尺寸
  for (const name of Object.keys(afterAdd)) {
    if (name === "walk_04.png") continue;
    expect(table[name], name).toEqual(afterAdd[name]); // 其余帧不动
  }
  const afterReplace = table;

  // 4) 完全相同输入重复执行：不产生漂移
  await pack(page);
  await expect(page.locator("#sum-kept")).toHaveText("保持 8");
  await expect(page.locator("#sum-moved")).toHaveText("移动 0");
  await expect(page.locator("#sum-added")).toHaveText("新增 0");
  await expect(page.locator("#sum-deleted")).toHaveText("删除 0");
  expect(await readAtlasTable(page)).toEqual(afterReplace);

  // 5) 刷新后（IndexedDB 恢复基线）继续增量打包，仍以原坐标为基线
  await page.waitForTimeout(1200); // 等自动保存落盘
  await page.reload();
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(8);
  await expect(page.locator("#pack-summary")).toBeVisible(); // 摘要随项目恢复
  expect(await readAtlasTable(page)).toEqual(afterReplace);
  await pack(page);
  await expect(page.locator("#sum-kept")).toHaveText("保持 8");
  await expect(page.locator("#sum-moved")).toHaveText("移动 0");
  expect(await readAtlasTable(page)).toEqual(afterReplace);

  // 6) 导出 JSON → 清空 → 导入恢复 → 再打包仍以原坐标为基线
  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#export-json-btn").click()
  ]);
  const json = JSON.parse(readFileSync(await jsonDownload.path(), "utf-8"));
  await page.getByRole("button", { name: "清空" }).click();
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(0);
  await page.locator("#json-input").setInputFiles({
    name: "atlas.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(json))
  });
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(8);
  expect(await readAtlasTable(page)).toEqual(afterReplace);
  await pack(page);
  await expect(page.locator("#sum-kept")).toHaveText("保持 8");
  await expect(page.locator("#sum-moved")).toHaveText("移动 0");
  await expect(page.locator("#sum-added")).toHaveText("新增 0");
  await expect(page.locator("#sum-deleted")).toHaveText("删除 0");
  expect(await readAtlasTable(page)).toEqual(afterReplace); // 无漂移
});

test("增量不可行：取消保留旧布局，确认后全量重排", async ({ page }) => {
  await page.goto("/");
  await page.locator("#opt-maxsize").selectOption("512");
  await page.locator("#png-input").setInputFiles(join(ASSETS, "walk_06.png"));
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(1);
  await pack(page);
  await expect(page.locator("#atlas-summary")).toContainText("图集 256×256");
  const before = await readAtlasTable(page);

  // 新增 300×300 大图：增量无法容纳（驱逐不可能、增长超上限）
  await page.locator("#png-input").setInputFiles(join(EXTRA, "big_300.png"));
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(2);
  await page.locator("#pack-btn").click();
  await expect(page.locator("#repack-dialog")).toBeVisible();
  await expect(page.locator("#repack-reason")).toContainText("big_300.png");

  // 取消：旧布局不被污染
  await page.locator("#cancel-full-repack").click();
  await expect(page.locator("#repack-dialog")).toHaveCount(0);
  await expect(page.locator("#atlas-summary")).toContainText("图集 256×256");
  expect(await readAtlasTable(page)).toEqual(before);
  await expect(page.locator("#pack-stale")).toBeVisible(); // 仍有未打包的修改

  // 再次打包 → 确认全量重排
  await page.locator("#pack-btn").click();
  await expect(page.locator("#repack-dialog")).toBeVisible();
  await page.locator("#confirm-full-repack").click();
  await expect(page.locator("#repack-dialog")).toHaveCount(0);
  await expect(page.locator("#summary-strategy")).toContainText("全量重排");
  await expect(page.locator("#atlas-summary")).toContainText("图集 512×512");
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(2);
});

test("紧凑优先：每次都全量重排", async ({ page }) => {
  await page.goto("/");
  await importFrames(page);
  await page.locator("#opt-padding").fill("3");
  await pack(page);
  await expect(page.locator("#summary-strategy")).toContainText("稳定优先");

  // 切换为紧凑优先后，即使只删一帧也全量重排
  await page.locator("#opt-strategy").selectOption("compact");
  await page.locator('[data-frame-name="walk_07.png"] button[title="删除"]').click();
  await pack(page);
  await expect(page.locator("#summary-strategy")).toContainText("紧凑优先");
  await expect(page.locator("#summary-strategy")).toContainText("全量重排");
  await expect(page.locator("#sum-deleted")).toHaveText("删除 1");
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(7);
});
