import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Waits shorter than this round to `0s` in the report and are not worth displaying. */
export const MIN_WAIT_DISPLAY_MS = 1_000;

interface WaitSpan {
  start: number;
  end?: number;
}

/** Measures run work time while tracking spans spent blocked on user input. */
export class RunClock {
  private startedAt: number | undefined;
  private endedAt: number | undefined;
  private readonly waits: WaitSpan[] = [];
  private openWait: WaitSpan | undefined;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Start the clock once. */
  start(): void {
    this.startedAt ??= this.now();
  }

  /** Stop the clock once; subsequent readings stay within this run window. */
  stop(): void {
    this.endedAt ??= this.now();
  }

  /** Begin one user-decision wait span. Repeated starts leave the earliest span intact. */
  pause(): void {
    if (this.openWait) return;
    const wait: WaitSpan = { start: this.now() };
    this.waits.push(wait);
    this.openWait = wait;
  }

  /** End the current user-decision wait span, if any. */
  resume(): void {
    if (!this.openWait) return;
    this.openWait.end ??= this.now();
    this.openWait = undefined;
  }

  /** Work time since start, excluding user-decision waits. */
  activeMs(): number {
    if (this.startedAt === undefined) return 0;
    return this.workedBetween(this.startedAt, this.endedAt ?? this.now());
  }

  /** User-decision time clipped to the run's start and end window. */
  waitingMs(): number {
    if (this.startedAt === undefined) return 0;
    return this.pausedMs(this.startedAt, this.endedAt ?? this.now());
  }

  /** Work time in an arbitrary interval, excluding overlapping wait spans. */
  workedBetween(from: number, to: number): number {
    return Math.max(0, to - from - this.pausedMs(from, to));
  }

  private pausedMs(from: number, to: number): number {
    let total = 0;
    for (const wait of this.waits) {
      const waitEnd = wait.end ?? (this.endedAt ?? this.now());
      total += Math.max(0, Math.min(waitEnd, to) - Math.max(wait.start, from));
    }
    return total;
  }
}

/**
 * Bracket the clock around Pi's blocking UI prompts. The host coalesces nested
 * or overlapping prompts into one outer pair, so no depth counter is needed.
 */
export function bindUIPromptWaits(
  pi: Pick<ExtensionAPI, "on">,
  clock: () => RunClock | undefined,
): void {
  pi.on("ui_prompt_start", () => {
    clock()?.pause();
  });
  pi.on("ui_prompt_end", () => {
    clock()?.resume();
  });
}
