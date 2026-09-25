/**
 * 生成验证用 PNG 序列帧：不同尺寸、四周带不等厚度的透明边缘，
 * 内容为一个逐帧移动的色块 + 固定标记点，便于核对预览位置与动画。
 * 输出到 test-assets/。
 */
import { PNG } from "pngjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test-assets");
mkdirSync(outDir, { recursive: true });

// [宽, 高, 上, 右, 下, 左] —— 透明边缘厚度
const SPECS = [
  { name: "walk_01.png", size: [64, 64], margin: [10, 14, 6, 8] },
  { name: "walk_02.png", size: [64, 64], margin: [12, 10, 8, 12] },
  { name: "walk_03.png", size: [96, 48], margin: [4, 20, 4, 6] },
  { name: "walk_04.png", size: [128, 128], margin: [30, 30, 30, 30] },
  { name: "walk_05.png", size: [37, 53], margin: [3, 5, 7, 2] },
  { name: "walk_06.png", size: [200, 150], margin: [0, 0, 0, 0] }, // 无透明边缘
  { name: "walk_07.png", size: [16, 16], margin: [2, 2, 2, 2] },
  { name: "walk_08.png", size: [80, 90], margin: [25, 5, 15, 35] }
];

function setPx(png, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = r;
  png.data[i + 1] = g;
  png.data[i + 2] = b;
  png.data[i + 3] = a;
}

for (const [idx, spec] of SPECS.entries()) {
  const [w, h] = spec.size;
  const [mt, mr, mb, ml] = spec.margin;
  const png = new PNG({ width: w, height: h, fill: true });

  const cw = w - ml - mr; // 内容区宽
  const ch = h - mt - mb; // 内容区高

  // 逐帧移动的色块（内容区内）
  const boxW = Math.max(4, Math.floor(cw / 3));
  const boxH = Math.max(4, Math.floor(ch / 3));
  const bx = ml + Math.floor(((cw - boxW) * idx) / Math.max(1, SPECS.length - 1));
  const by = mt + Math.floor(((ch - boxH) * (idx % 3)) / 2);
  for (let y = by; y < by + boxH; y++) {
    for (let x = bx; x < bx + boxW; x++) {
      setPx(png, x, y, 230, 90 + idx * 15, 60);
    }
  }

  // 固定标记点：内容区左上角（用于核对裁切偏移）
  setPx(png, ml, mt, 0, 255, 128);
  // 固定标记点：内容区右下角
  setPx(png, ml + cw - 1, mt + ch - 1, 0, 128, 255);

  writeFileSync(join(outDir, spec.name), PNG.sync.write(png));
  console.log(
    `${spec.name}  ${w}x${h}  透明边缘 上${mt} 右${mr} 下${mb} 左${ml}  内容 ${cw}x${ch}`
  );
}
console.log(`\n已生成 ${SPECS.length} 个测试帧 → ${outDir}`);
