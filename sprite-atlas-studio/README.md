# Sprite Atlas Studio

游戏美术本地序列帧 → 精灵图集工具。**纯 Web、纯本地**：所有图片处理都在浏览器内完成，不上传任何数据。

## 功能

- **导入 PNG 序列帧**：文件选择或拖拽，保持导入顺序（可拖拽/按钮调整）
- **帧时长**：逐帧设置毫秒数，或一键应用到全部帧
- **透明边缘裁切**：按 alpha 通道计算包围盒，记录 `spriteSourceSize` 偏移
- **统一留白**：每帧四周固定像素留白（打包时把矩形放大 `padding*2` 后排布，内容居中）
- **矩形打包**：maxrects-packer，**固定方向不旋转**，图集尺寸支持 POT（2 的幂）
- **动画预览**：PixiJS 按原始顺序与每帧时长循环播放；从图集取子纹理并按裁切偏移摆放（等同引擎行为），实时显示当前帧在图集中的位置/尺寸
- **图集视图**：编号框标注每帧位置，表格列出 x/y/w/h、裁切偏移、原始尺寸、时长
- **稳定布局的增量重打包**：图集生成后新增/删除/替换少量帧时，稳定优先策略下未变化帧一律复用原矩形位置（删除帧不主动压缩空洞），仅移动必要数量的帧；放不下时明确提示，可全量重排或取消保留旧结果。界面展示本次保持/移动/新增/删除/替换的帧数与每帧坐标差异（Δx、Δy），可在「稳定优先 / 紧凑优先」之间切换
- **帧身份**：逻辑名称 + 裁切后内容摘要（SHA-256）；同名内容变化视为替换，完全相同输入重复执行零漂移
- **基线持久化**：布局基线、策略与结果摘要随项目保存到 IndexedDB，并写入导出 JSON（`meta.incremental` / `meta.lastReport` / 帧 `contentHash`）；刷新或导出再导入后继续增量打包仍以原坐标为基线
- **导出**：`atlas.png` + `atlas.json`（TexturePacker Hash 兼容结构，扩展 `duration` / `frameOrder` / `settings`；可内嵌图集 dataURL）
- **导入 JSON 恢复**：从导出的 JSON 完整恢复帧列表、顺序、时长与打包结果（图集内嵌时无需另选图片；否则连同 `atlas.png` 一起选择）
- **IndexedDB 持久化**：帧 PNG（Blob）、设置与打包结果自动保存到浏览器本地，刷新后恢复

## 技术栈

Svelte 5 + TypeScript（状态与 UI）· PixiJS v8（动画预览）· maxrects-packer（矩形打包）· idb（IndexedDB）· Vite

## 开发

```bash
npm install
npm run dev        # 开发服务器
npm run build      # 构建到 dist/
npm run preview    # 预览构建产物
npm run check      # svelte-check 类型检查
```

## 测试

```bash
npm run gen-assets # 生成验证素材到 test-assets/（8 帧：不同尺寸 + 不等厚透明边缘）
npm test           # vitest：单元（裁切/打包/增量重排/计时/序列化）+ 集成（真实 PNG 全管线）
npm run e2e        # Playwright：浏览器全流程（导入→打包→预览→导出→导入恢复→刷新恢复，
                   #                  以及增量重打包：新增零移动/删除不压缩/替换最少移动/失败取消/导出导入续打包）
```

集成测试（`tests/integration/pipeline.test.ts`）用真实 PNG 验证：

- 裁切包围盒与生成素材的透明边缘完全一致
- 图集中每帧内容位置、统一留白（四周透明像素）
- 导出 JSON → 重新导入后帧列表/顺序/时长/位置尺寸完整恢复，且恢复帧与原图**逐像素一致**
- 预览计时：按每帧时长推进的帧序与解析式 `frameIndexAt` 一致

## JSON 格式

```jsonc
{
  "frames": {
    "walk_01.png": {
      "frame": { "x": 2, "y": 2, "w": 42, "h": 48 },   // 图集中的位置与尺寸
      "rotated": false,                                 // 固定方向，恒为 false
      "trimmed": true,
      "spriteSourceSize": { "x": 8, "y": 10, "w": 42, "h": 48 }, // 裁切偏移
      "sourceSize": { "w": 64, "h": 64 },               // 原始尺寸
      "duration": 100                                   // 帧时长 ms
    }
  },
  "meta": {
    "app": "sprite-atlas-studio",
    "version": "1.0.0",
    "image": "atlas.png",
    "size": { "w": 256, "h": 512 },
    "frameOrder": ["walk_01.png", "..."],   // 原始播放顺序
    "settings": {
      "trim": true, "padding": 2, "maxSize": 2048, "pot": true,
      "strategy": "stable"                  // stable=稳定优先（增量） / compact=紧凑优先（全量）
    },
    "totalDuration": 950,
    "incremental": true,                    // 最近一次是否为增量打包
    "lastReport": {                         // 最近一次结果摘要：保持/移动/替换/新增/删除 + 每帧坐标差异
      "incremental": true, "strategy": "stable",
      "kept": 6, "moved": 0, "replaced": 0, "added": 1, "removed": 0,
      "deltas": [
        { "name": "new.png", "kind": "added", "to": { "x": 64, "y": 0, "w": 30, "h": 30 }, "dx": 0, "dy": 0 }
      ],
      "timestamp": 0
    },
    "atlasDataURL": "data:image/png;base64,..."  // 可选：内嵌图集，JSON 可独立恢复
  }
}
```

每帧还可带 `contentHash`（裁切后内容的 SHA-256），与帧名共同构成帧身份。
