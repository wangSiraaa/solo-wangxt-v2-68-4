<script lang="ts">
  import { settings, setAllDurations, frameCount } from "../core/store";

  let uniformDuration = 100;
</script>

<div class="panel">
  <h2>打包设置</h2>
  <div class="grid">
    <label class="row">
      <input id="opt-trim" type="checkbox" bind:checked={$settings.trim} />
      裁切透明边缘
    </label>

    <label class="row">
      统一留白
      <input id="opt-padding" type="number" min="0" max="64" bind:value={$settings.padding} />
      px
    </label>

    <label class="row">
      图集最大边长
      <select id="opt-maxsize" bind:value={$settings.maxSize}>
        <option value={256}>256</option>
        <option value={512}>512</option>
        <option value={1024}>1024</option>
        <option value={2048}>2048</option>
        <option value={4096}>4096</option>
      </select>
    </label>

    <label class="row">
      <input id="opt-pot" type="checkbox" bind:checked={$settings.pot} />
      尺寸取 2 的幂（POT）
    </label>

    <label class="row">
      <input id="opt-embed" type="checkbox" bind:checked={$settings.embedAtlas} />
      导出 JSON 时内嵌图集（可独立恢复）
    </label>

    <div class="row strategy" role="radiogroup" aria-label="重排策略">
      <span class="strategy-label">增量重排策略</span>
      <label class="seg">
        <input type="radio" name="strategy" value="stable" bind:group={$settings.strategy} />
        <span title="新增/删除/替换少量帧时尽量复用旧坐标，只移动必要的帧">稳定优先</span>
      </label>
      <label class="seg">
        <input type="radio" name="strategy" value="compact" bind:group={$settings.strategy} />
        <span title="忽略旧坐标，全部重新紧凑排布（可能更省空间）">紧凑优先</span>
      </label>
    </div>

    <div class="row dim">矩形打包：maxrects-packer · 固定方向，不旋转</div>
  </div>

  <h2 style="margin-top: 14px;">帧时长</h2>
  <div class="row">
    <input id="uniform-duration" type="number" min="1" bind:value={uniformDuration} />
    ms
    <button disabled={$frameCount === 0} on:click={() => setAllDurations(uniformDuration)}>
      应用到全部帧
    </button>
  </div>
</div>

<style>
  .grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dim {
    color: var(--text-dim);
    font-size: 12px;
  }
  .strategy {
    gap: 6px;
  }
  .strategy-label {
    color: var(--text-dim);
    font-size: 12px;
    margin-right: 2px;
  }
  .seg {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 8px;
    cursor: pointer;
  }
  .seg input {
    margin: 0;
  }
</style>
