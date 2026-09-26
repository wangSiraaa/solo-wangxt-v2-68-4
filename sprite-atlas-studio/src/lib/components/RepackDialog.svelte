<script lang="ts">
  import { busy, cancelFullRepack, confirmFullRepack, repackPrompt } from "../core/store";
</script>

{#if $repackPrompt}
  <div class="overlay" role="presentation">
    <button class="overlay-btn" aria-label="取消并关闭" on:click={() => cancelFullRepack()}></button>
    <div
      class="dialog"
      role="alertdialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="repack-title"
    >
      <h3 id="repack-title">⚠️ 稳定布局无法容纳本次变更</h3>
      <p class="reason">{$repackPrompt.reason}</p>
      <p class="hint">
        选择「全量重排」会忽略旧坐标重新紧凑排布；选择「取消」则保留当前旧布局，可删除/缩小部分帧后再试。
      </p>
      <div class="actions">
        <button id="repack-confirm-btn" class="primary" disabled={$busy} on:click={() => void confirmFullRepack()}>
          {$busy ? "重排中…" : "全量重排"}
        </button>
        <button id="repack-cancel-btn" disabled={$busy} on:click={cancelFullRepack}>取消（保留旧布局）</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .overlay-btn {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: none;
    background: transparent;
    cursor: default;
  }
  .dialog {
    position: relative;
    background: var(--panel);
    border: 1px solid var(--danger);
    border-radius: 10px;
    padding: 18px 20px;
    max-width: 460px;
    width: calc(100% - 40px);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  }
  h3 {
    margin: 0 0 10px;
    font-size: 15px;
  }
  .reason {
    font-size: 13px;
    line-height: 1.6;
    margin: 0 0 10px;
  }
  .hint {
    font-size: 12px;
    color: var(--text-dim);
    margin: 0 0 16px;
  }
  .actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }
</style>
