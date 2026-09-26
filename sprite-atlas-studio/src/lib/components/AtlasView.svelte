<script lang="ts">
  import { packResult, packStale, selectedId } from "../core/store";
  import PackReportPanel from "./PackReportPanel.svelte";

  let hoverName: string | null = null;
</script>

<div class="panel">
  <h2>图集 · 每帧位置与尺寸</h2>

  {#if !$packResult}
    <div class="empty">尚未打包。设置好参数后点击「打包图集」。</div>
  {:else}
    {#if $packResult.report}
      <PackReportPanel report={$packResult.report} />
    {/if}

    {#if $packStale}
      <div class="baseline-banner" id="baseline-banner">
        帧已变更：以下为<b>旧布局基线</b>（坐标被保留）。点击「打包图集」做增量重打包。
      </div>
    {/if}

    <div class="summary mono" id="atlas-summary">
      图集 {$packResult.atlasWidth}×{$packResult.atlasHeight} · {$packResult.frames.length} 帧 ·
      留白 {$packResult.padding}px · {$packResult.trimmed ? "已裁切透明边缘" : "未裁切"}
    </div>

    <div class="atlas-wrap checker">
      <img src={$packResult.atlasUrl} alt="atlas" id="atlas-image" draggable="false" />
      {#each $packResult.frames as f, i (f.name)}
        <button
          class="rect"
          class:active={$selectedId === f.id}
          style:left={`${(f.x / $packResult.atlasWidth) * 100}%`}
          style:top={`${(f.y / $packResult.atlasHeight) * 100}%`}
          style:width={`${(f.w / $packResult.atlasWidth) * 100}%`}
          style:height={`${(f.h / $packResult.atlasHeight) * 100}%`}
          title={`${f.name} — (${f.x}, ${f.y}) ${f.w}×${f.h}`}
          data-rect-for={f.name}
          on:mouseenter={() => (hoverName = f.name)}
          on:mouseleave={() => (hoverName = null)}
          on:click={() => selectedId.set(f.id)}
        >
          <span class="tag mono">{i + 1}</span>
        </button>
      {/each}
    </div>

    <div class="table-wrap">
      <table id="atlas-table">
        <thead>
          <tr>
            <th>#</th><th>名称</th><th>x</th><th>y</th><th>w</th><th>h</th>
            <th>裁切偏移</th><th>原始尺寸</th><th>时长</th>
          </tr>
        </thead>
        <tbody>
          {#each $packResult.frames as f, i (f.name)}
            <tr
              class:active={$selectedId === f.id || hoverName === f.name}
              data-row-for={f.name}
              on:click={() => selectedId.set(f.id)}
            >
              <td class="mono">{i + 1}</td>
              <td class="name" title={f.name}>{f.name}</td>
              <td class="mono">{f.x}</td>
              <td class="mono">{f.y}</td>
              <td class="mono">{f.w}</td>
              <td class="mono">{f.h}</td>
              <td class="mono">({f.trim.x}, {f.trim.y})</td>
              <td class="mono">{f.srcW}×{f.srcH}</td>
              <td class="mono">{f.duration}ms</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .empty {
    color: var(--text-dim);
    padding: 12px 4px;
  }
  .baseline-banner {
    font-size: 12px;
    color: #ffd166;
    background: rgba(255, 209, 102, 0.1);
    border: 1px solid rgba(255, 209, 102, 0.4);
    border-radius: 6px;
    padding: 6px 10px;
    margin-bottom: 8px;
  }
  .summary {
    color: var(--text-dim);
    margin-bottom: 8px;
  }
  .atlas-wrap {
    position: relative;
    width: 100%;
    border-radius: 8px;
    overflow: hidden;
    line-height: 0;
  }
  .atlas-wrap img {
    width: 100%;
    image-rendering: pixelated;
    display: block;
  }
  .rect {
    position: absolute;
    background: rgba(79, 140, 255, 0.08);
    border: 1px solid rgba(79, 140, 255, 0.7);
    padding: 0;
    margin: 0;
    border-radius: 0;
    cursor: pointer;
    line-height: 1;
  }
  .rect:hover,
  .rect.active {
    background: rgba(79, 140, 255, 0.25);
    border-color: #ffd166;
  }
  .tag {
    position: absolute;
    top: 0;
    left: 0;
    background: rgba(0, 0, 0, 0.65);
    color: #ffd166;
    font-size: 10px;
    padding: 1px 3px;
    pointer-events: none;
  }
  .table-wrap {
    margin-top: 10px;
    max-height: 260px;
    overflow: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th,
  td {
    text-align: left;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  th {
    color: var(--text-dim);
    position: sticky;
    top: 0;
    background: var(--panel);
  }
  tr {
    cursor: pointer;
  }
  tr.active td {
    background: rgba(79, 140, 255, 0.12);
  }
  td.name {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
