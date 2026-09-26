import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

/** 生成纯色（带可区分的角点）PNG 临时文件，返回路径 */
function makePng(dir: string, name: string, w: number, h: number, rgb: [number, number, number]): string {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      png.data[i] = rgb[0];
      png.data[i + 1] = rgb[1];
      png.data[i + 2] = rgb[2];
      png.data[i + 3] = 255;
    }
  }
  // 角点标记，保证不同尺寸/颜色的帧内容摘要不同
  png.data[0] = 0; png.data[1] = 255; png.data[2] = 128;
  const p = join(dir, name);
  writeFileSync(p, PNG.sync.write(png));
  return p;
}

async function readTable(page: Page): Promise<Record<string, number[]>> {
  const rows = page.locator("#atlas-table tbody tr");
  const out: Record<string, number[]> = {};
  for (const row of await rows.all()) {
    const name = await row.locator("td").nth(1).innerText();
    const nums: number[] = [];
    for (const col of [2, 3, 4, 5]) nums.push(Number(await row.locator("td").nth(col).innerText()));
    out[name] = nums;
  }
  return out;
}

async function chips(page: Page): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const chip of await page.locator("#pack-report .chip").all()) {
    const text = (await chip.innerText()).replace(/\s+/g, " ");
    const m = /^(保持|移动|替换|新增|删除)\s*(\d+)/.exec(text.trim());
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}

async function packAndWait(page: Page): Promise<void> {
  await page.locator("#pack-btn").click();
  // busy 是在 pack() 开头同步置位的；轮询直到不忙（打包结束）。
  // 即便极快完成没捕获到「处理中」也无妨：后续坐标断言全部是轮询的。
  await expect
    .poll(async () => {
      const t = (await page.locator("#pack-btn").innerText()).trim();
      return t.includes("处理中");
    }, { timeout: 30000 })
    .toBe(false);
  await expect(page.locator("#atlas-image")).toBeVisible();
}

/** 轮询等待表格中的帧坐标满足期望（打包是异步的，直接读可能读到旧结果） */
async function expectTableCoords(
  page: Page,
  expected: Record<string, number[]>
): Promise<void> {
  await expect
    .poll(async () => {
      const got = await readTable(page);
      for (const [name, rect] of Object.entries(expected)) {
        const g = got[name];
        if (!g || g.join(",") !== rect.join(",")) return null;
      }
      return "ok";
    }, { timeout: 15000 })
    .toBe("ok");
}

/** 轮询读取报告 chip（打包结果是异步更新的，需要 expect.poll 等待） */
async function expectChip(page: Page, key: string, value: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const c = await chips(page);
        return c[key] ?? null;
      },
      { timeout: 15000, message: `chip ${key} 应为 ${value}` }
    )
    .toBe(value);
}

test.describe("稳定布局增量重打包", () => {
  test("新增零移动 → 删除不压缩 → 替换 → 失败取消保留旧布局 → 紧凑全量 → 导出导入后继续增量", async ({
    page
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-inc-"));
    // 三张等宽横条：首次打包必然单列纵向排布，替换/新增时行为可预期
    const f1 = makePng(dir, "f01.png", 200, 40, [200, 60, 60]);
    const f2 = makePng(dir, "f02.png", 200, 40, [60, 200, 60]);
    const f3 = makePng(dir, "f03.png", 200, 40, [60, 60, 200]);

    await page.goto("/");

    // ---- 首次全量打包 ----
    await page.locator("#png-input").setInputFiles([f1, f2, f3]);
    await expect(page.locator("#frame-list .frame-item")).toHaveCount(3);
    await packAndWait(page);
    const base = await readTable(page);
    expect(Object.keys(base)).toHaveLength(3);

    // ---- 新增一帧：能塞入空洞/放大到下一 POT，旧帧零移动 ----
    const fNew = makePng(dir, "new.png", 30, 30, [220, 220, 60]);
    await page.locator("#png-input").setInputFiles([fNew]);
    await expect(page.locator("#frame-list .frame-item")).toHaveCount(4);
    // 旧布局仍显示为基线
    await expect(page.locator("#baseline-banner")).toBeVisible();
    await packAndWait(page);

    await expectChip(page, "保持", 3);
    await expectChip(page, "移动", 0);
    await expectChip(page, "新增", 1);
    await expectTableCoords(page, {
      "f01.png": base["f01.png"]!,
      "f02.png": base["f02.png"]!,
      "f03.png": base["f03.png"]!
    });
    // 报告表有新增行，含原坐标/新坐标列
    const addedRow = page.locator(`#report-table tr[data-report-name="new.png"]`);
    await expect(addedRow).toHaveCount(1);
    await expect(addedRow).toContainText("新增");

    // ---- 删除新增帧：不主动压缩，3 帧坐标全部还原 ----
    await page.locator(`#frame-list .frame-item[data-frame-name="new.png"] button[title="删除"]`).click();
    await expect(page.locator("#frame-list .frame-item")).toHaveCount(3);
    await packAndWait(page);
    await expectChip(page, "保持", 3);
    await expectChip(page, "移动", 0);
    await expectChip(page, "删除", 1);
    await expectTableCoords(page, {
      "f01.png": base["f01.png"]!,
      "f02.png": base["f02.png"]!,
      "f03.png": base["f03.png"]!
    });

    // ---- 替换为更大图像：单列布局下 f01 加高只会向下生长，其余帧无需移动 ----
    const fBig = makePng(dir, "f01-big.png", 200, 60, [210, 90, 90]);
    // 用同名文件替换：导入工具会去重命名，所以直接走替换按钮
    const replaceBtn = page.locator(
      `#frame-list .frame-item[data-frame-name="f01.png"] button[title^="替换"]`
    );
    const fileChooser = page.waitForEvent("filechooser");
    await replaceBtn.click();
    const chooser = await fileChooser;
    await chooser.setFiles(fBig);
    await expect(page.locator("#baseline-banner")).toBeVisible();
    await packAndWait(page);
    await expectChip(page, "替换", 1);
    await expect
      .poll(async () => (await chips(page))["移动"] ?? null, { timeout: 15000 })
      .toBeLessThanOrEqual(1);

    // ---- 增量失败：把上限调到 256 并把 f01 替换为 300×300（超出上限），
    //      弹确认框；取消后旧布局不变 ----
    const beforeFail = await readTable(page);
    await page.locator("#opt-maxsize").selectOption("256");
    const fHuge = makePng(dir, "f01-huge.png", 300, 300, [230, 120, 120]);
    {
      const btn = page.locator(
        `#frame-list .frame-item[data-frame-name="f01.png"] button[title^="替换"]`
      );
      const chooserEvent = page.waitForEvent("filechooser");
      await btn.click();
      const chooser = await chooserEvent;
      await chooser.setFiles(fHuge);
    }
    await page.locator("#pack-btn").click();
    await expect(page.locator("#repack-confirm-btn")).toBeVisible();
    await expect(page.locator("#repack-cancel-btn")).toBeVisible();
    await page.locator("#repack-cancel-btn").click();
    await expect(page.locator("#repack-confirm-btn")).toHaveCount(0);
    // 旧布局未被污染
    const afterCancel = await readTable(page);
    expect(afterCancel).toEqual(beforeFail);

    // 恢复上限后增量打包可继续（300×300 在 2048 内）
    await page.locator("#opt-maxsize").selectOption("2048");
    await packAndWait(page);
    await expectChip(page, "替换", 1);

    // ---- 紧凑优先：全量重排，报告标记为非增量 ----
    await page
      .locator('input[name="strategy"][value="compact"]')
      .check();
    await packAndWait(page);
    await expect(page.locator("#pack-report .title")).toContainText("全量重排");

    // 切回稳定优先并再打包一次（以全量结果为新基线）
    await page.locator('input[name="strategy"][value="stable"]').check();
    await packAndWait(page);
    const stableBase = await readTable(page);

    // ---- 导出 JSON → 清空 → 导入恢复 → 继续增量仍以原坐标为基线 ----
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#export-json-btn").click()
    ]);
    const jsonPath = await dl.path();
    const json = JSON.parse(readFileSync(jsonPath, "utf-8"));
    expect(json.meta.settings.strategy).toBe("stable");
    expect(json.meta.lastReport).toBeTruthy();

    await page.getByRole("button", { name: "清空" }).click();
    await expect(page.locator("#frame-list .frame-item")).toHaveCount(0);

    await page.locator("#json-input").setInputFiles({
      name: "atlas.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(json))
    });
    await expect(page.locator("#frame-list .frame-item")).toHaveCount(3);
    await expectTableCoords(page, stableBase);

    // 再新增一帧做增量：旧三帧坐标必须仍是导出时的坐标
    const fNew2 = makePng(dir, "new2.png", 24, 24, [120, 220, 220]);
    await page.locator("#png-input").setInputFiles([fNew2]);
    await expect(page.locator("#frame-list .frame-item")).toHaveCount(4);
    await packAndWait(page);
    await expectChip(page, "移动", 0);
    await expectChip(page, "新增", 1);
    await expectTableCoords(page, {
      "f01.png": stableBase["f01.png"]!,
      "f02.png": stableBase["f02.png"]!,
      "f03.png": stableBase["f03.png"]!
    });

    // ---- 刷新后（IndexedDB 恢复）继续增量打包，仍以原坐标为基线 ----
    const preRefresh = await readTable(page);
    await page.waitForTimeout(1000); // 等待防抖自动保存落盘
    await page.reload();
    await expect(page.locator("#atlas-table tbody tr")).toHaveCount(4);
    const refreshed = await readTable(page);
    expect(refreshed).toEqual(preRefresh);

    const fNew3 = makePng(dir, "new3.png", 18, 18, [200, 160, 240]);
    await page.locator("#png-input").setInputFiles([fNew3]);
    await expect(page.locator("#frame-list .frame-item")).toHaveCount(5);
    await packAndWait(page);
    await expectChip(page, "移动", 0);
    await expectChip(page, "新增", 1);
    await expectTableCoords(page, {
      "f01.png": preRefresh["f01.png"]!,
      "f02.png": preRefresh["f02.png"]!,
      "f03.png": preRefresh["f03.png"]!,
      "new2.png": preRefresh["new2.png"]!
    });

    // ---- 完全相同输入重复执行不产生漂移 ----
    await packAndWait(page);
    await expectChip(page, "移动", 0);
    await expectChip(page, "新增", 0);
    await expectChip(page, "删除", 0);
    await expectChip(page, "替换", 0);
    const repeat1 = await readTable(page);
    await packAndWait(page);
    const repeat2 = await readTable(page);
    expect(repeat2).toEqual(repeat1);
  });
});
