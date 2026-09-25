<script lang="ts">
  import { frames, moveFrame, removeFrame, selectedId, setDuration } from "../core/store";

  let dragIndex: number | null = null;

  function onDragStart(i: number) {
    dragIndex = i;
  }
  function onDrop(i: number) {
    if (dragIndex === null || dragIndex === i) return;
    const list = [...$frames];
    const [moved] = list.splice(dragIndex, 1);
    if (moved) {
      list.splice(i, 0, moved);
      frames.set(list);
    }
    dragIndex = null;
  }
</script>

<div class="panel frames-panel">
  <h2>帧序列（按原顺序播放）</h2>
  {#if $frames.length === 0}
    <div class="empty">尚未导入帧。点击「导入 PNG 帧」或将 PNG 拖入页面。</div>
  {:else}
    <div id="frame-list" role="listbox" aria-label="帧序列">
      {#each $frames as f, i (f.id)}
        <div
          class="frame-item"
          class:selected={$selectedId === f.id}
          draggable="true"
          role="option"
          aria-selected={$selectedId === f.id}
          tabindex="0"
          on:dragstart={() => onDragStart(i)}
          on:dragover|preventDefault
          on:drop|preventDefault={() => onDrop(i)}
          on:click={() => selectedId.set(f.id)}
          on:keydown={(e) => e.key === "Enter" && selectedId.set(f.id)}
          data-frame-name={f.name}
        >
          <span class="idx mono">{i + 1}</span>
          <span class="thumb checker"><img src={f.url} alt={f.name} /></span>
          <span class="meta">
            <span class="name" title={f.name}>{f.name}</span>
            <span class="dim mono">{f.width}×{f.height}</span>
          </span>
          <span class="dur">
            <input
              type="number"
              min="1"
              value={f.duration}
              data-duration-for={f.name}
              on:click|stopPropagation
              on:change={(e) => setDuration(f.id, Number(e.currentTarget.value))}
            />
            ms
          </span>
          <span class="ops">
            <button title="上移" on:click|stopPropagation={() => moveFrame(f.id, -1)}>↑</button>
            <button title="下移" on:click|stopPropagation={() => moveFrame(f.id, 1)}>↓</button>
            <button title="删除" class="danger" on:click|stopPropagation={() => removeFrame(f.id)}>✕</button>
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .frames-panel {
    max-height: 52vh;
    overflow: auto;
  }
  .empty {
    color: var(--text-dim);
    padding: 12px 4px;
  }
  #frame-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .frame-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-2);
    cursor: pointer;
  }
  .frame-item.selected {
    border-color: var(--accent);
  }
  .idx {
    width: 20px;
    text-align: right;
    color: var(--text-dim);
  }
  .thumb {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    overflow: hidden;
    flex: none;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    image-rendering: pixelated;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .dim {
    color: var(--text-dim);
  }
  .dur {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .dur input {
    width: 60px;
  }
  .ops {
    display: flex;
    gap: 4px;
  }
  .ops button {
    padding: 2px 6px;
    font-size: 12px;
  }
</style>
