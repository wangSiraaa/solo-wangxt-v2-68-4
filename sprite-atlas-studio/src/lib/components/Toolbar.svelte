<script lang="ts">
  import {
    addFiles,
    busy,
    clearStorage,
    exportJSON,
    exportPNG,
    frameCount,
    importJSON,
    pack,
    packResult,
    saveNow
  } from "../core/store";

  let pngInput: HTMLInputElement;
  let jsonInput: HTMLInputElement;

  function onPngPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files?.length) void addFiles(input.files);
    input.value = "";
  }

  async function onJsonPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    const json = files.find((f) => f.name.toLowerCase().endsWith(".json"));
    const atlas = files.find((f) => f.name.toLowerCase().endsWith(".png"));
    if (!json) return;
    await importJSON(json, atlas);
  }
</script>

<div class="toolbar">
  <input
    bind:this={pngInput}
    id="png-input"
    type="file"
    accept="image/png,.png"
    multiple
    hidden
    on:change={onPngPicked}
  />
  <input
    bind:this={jsonInput}
    id="json-input"
    type="file"
    accept=".json,application/json,image/png"
    multiple
    hidden
    on:change={onJsonPicked}
  />

  <button class="primary" on:click={() => pngInput.click()}>导入 PNG 帧</button>
  <button on:click={() => jsonInput.click()} title="选择导出的 atlas.json（可连同 atlas.png 一起选）">
    导入 JSON 恢复
  </button>

  <span class="sep"></span>

  <button class="primary" id="pack-btn" disabled={$busy || $frameCount === 0} on:click={() => void pack()}>
    {$busy ? "处理中…" : "打包图集"}
  </button>
  <button id="export-png-btn" disabled={!$packResult} on:click={exportPNG}>导出图集 PNG</button>
  <button id="export-json-btn" disabled={!$packResult} on:click={() => void exportJSON()}>导出 JSON</button>

  <span class="sep"></span>

  <button on:click={() => void saveNow()} title="保存到 IndexedDB">保存项目</button>
  <button class="danger" on:click={() => void clearStorage()}>清空</button>

  <span class="count mono">{$frameCount} 帧</span>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px 16px;
  }
  .sep {
    width: 1px;
    height: 22px;
    background: var(--border);
  }
  .count {
    margin-left: auto;
    color: var(--text-dim);
  }
</style>
