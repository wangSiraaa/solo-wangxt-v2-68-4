/**
 * 动画计时：按每帧时长推进。纯函数便于测试。
 */

/** 总时长（毫秒） */
export function totalDuration(durations: number[]): number {
  return durations.reduce((a, b) => a + Math.max(1, b), 0);
}

/**
 * 给定已播放时间 t（毫秒，可超过一轮，自动循环），返回帧下标。
 * 时长小于 1ms 的按 1ms 计。
 */
export function frameIndexAt(durations: number[], t: number): number {
  const n = durations.length;
  if (n === 0) return -1;
  const total = totalDuration(durations);
  let rest = ((t % total) + total) % total;
  for (let i = 0; i < n; i++) {
    const d = Math.max(1, durations[i] ?? 1);
    if (rest < d) return i;
    rest -= d;
  }
  return n - 1;
}

/** 可步进的动画器（供 PixiJS ticker 使用） */
export class Animator {
  private acc = 0;
  index = 0;
  playing = true;

  constructor(private durations: number[]) {}

  setDurations(durations: number[]): void {
    this.durations = durations;
    if (this.index >= durations.length) this.index = 0;
  }

  reset(): void {
    this.acc = 0;
    this.index = 0;
  }

  /** 推进 deltaMs 毫秒，返回当前帧下标 */
  tick(deltaMs: number): number {
    const n = this.durations.length;
    if (n === 0) return -1;
    if (!this.playing) return this.index;
    if (this.index >= n) this.index = 0;
    this.acc += deltaMs;
    let guard = 0;
    while (this.acc >= Math.max(1, this.durations[this.index] ?? 1) && guard < n * 4) {
      this.acc -= Math.max(1, this.durations[this.index] ?? 1);
      this.index = (this.index + 1) % n;
      guard++;
    }
    return this.index;
  }
}
