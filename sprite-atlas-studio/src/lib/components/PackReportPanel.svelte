<script lang="ts">
  import type { FrameDelta, PackReport } from "../core/types";

  let { report }: { report: PackReport } = $props();

  // 非删除类、实际有变化的帧排在前面；顺序 = 移动/新增/替换/删除/保持
  const rank: Record<string, number> = { moved: 0, added: 1, replaced: 2, removed: 3, kept: 4 };
  const label: Record<string, string> = {
    kept: "保持",
    moved: "移动",
    replaced: "替换",
    added: "新增",
    removed: "删除"
  };

  const changed = $derived(
    [...report.deltas]
      .filter((d) => d.kind !== "kept")
      .sort(
        (a: FrameDelta, b: FrameDelta) =>
          (rank[a.kind] ?? 99) - (rank[b.kind] ?? 99) || a.name.localeCompare(b.name)
      )
  );

  // 无任何变更计数 = 首次打包（没有基线）
  const isFirstPack = $derived(
    !report.incremental &&
      report.kept + report.moved + report.replaced + report.added + report.removed === 0
  );
</script>

{#snippet chip(kind: string, n: number)}
  <span class="chip {kind}">{label[kind]} <b>{n}</b></span>
{/snippet}

<div class="report" id="pack-report">
  <div class="title">
    {#if isFirstPack}
      首次打包结果（已作为后续增量重排的基线）
    {:else if report.incremental}
      增量打包结果（稳定优先）
    {:else}
      全量重排结果（{report.strategy === "compact" ? "紧凑优先" : "稳定优先 · 兜底重排"}）
    {/if}
  </div>
  <div class="chips">
    {@render chip("kept", report.kept)}
    {@render chip("moved", report.moved)}
    {@render chip("replaced", report.replaced)}
    {@render chip("added", report.added)}
    {@render chip("removed", report.removed)}
  </div>

  {#if changed.length > 0}
    <div class="table-wrap">
      <table id="report-table">
        <thead>
          <tr><th>帧</th><th>变更</th><th>原坐标</th><th>新坐标</th><th>位移 Δx,Δy</th></tr>
        </thead>
        <tbody>
          {#each changed as d (d.name + d.kind)}
            <tr class="{d.kind}" data-report-kind={d.kind} data-report-name={d.name}>
              <td class="name" title={d.name}>{d.name}</td>
              <td><span class="tag {d.kind}">{label[d.kind]}</span></td>
              <td class="mono">
                {#if d.from}({d.from.x}, {d.from.y}) {d.from.w}×{d.from.h}{:else}—{/if}
              </td>
              <td class="mono">
                {#if d.to}({d.to.x}, {d.to.y}) {d.to.w}×{d.to.h}{:else}—{/if}
              </td>
              <td class="mono">
                {#if d.kind === "moved" || (d.kind === "replaced" && (d.dx !== 0 || d.dy !== 0))}
                  {d.dx >= 0 ? "+" : ""}{d.dx}, {d.dy >= 0 ? "+" : ""}{d.dy}
                {:else}
                  0, 0
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="no-change mono">所有帧坐标与基线完全一致，无漂移</div>
  {/if}
</div>

<style>
  .report {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 10px;
    background: var(--panel-2);
  }
  .title {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 6px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    white-space: nowrap;
  }
  .chip b {
    font-weight: 600;
  }
  .chip.kept {
    color: #7ee2a8;
  }
  .chip.moved {
    color: #ffd166;
    border-color: #c79a2b;
  }
  .chip.replaced {
    color: #7ab8ff;
    border-color: #3f6fae;
  }
  .chip.added {
    color: #7ee2a8;
    border-color: #2e8f5a;
  }
  .chip.removed {
    color: #ff8a82;
    border-color: #a04a44;
  }
  .table-wrap {
    margin-top: 8px;
    max-height: 200px;
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
    padding: 3px 6px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  th {
    color: var(--text-dim);
  }
  td.name {
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tag {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .tag.moved {
    color: #ffd166;
  }
  .tag.replaced {
    color: #7ab8ff;
  }
  .tag.added {
    color: #7ee2a8;
  }
  .tag.removed {
    color: #ff8a82;
  }
  .no-change {
    margin-top: 6px;
    font-size: 12px;
    color: #7ee2a8;
  }
</style>
