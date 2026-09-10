import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunClock, bindUIPromptWaits } from "../src/runClock.ts";

// RunClock takes an injected `now: () => number` (defaulting to Date.now) so its
// readings can be driven deterministically here. Key contract points exercised
// below: start()/stop() are idempotent (first call wins); pause() is idempotent
// and keeps the *earliest* wait span open; resume() is inert with no open wait;
// activeMs()/waitingMs() are live until stop() pins them to [startedAt, endedAt];
// workedBetween(from, to) clips wait spans to an arbitrary window and never
// returns a negative number. bindUIPromptWaits wires ui_prompt_start/end to
// pause()/resume() on whatever `clock()` currently returns, tolerating undefined.

// ── lifecycle: start/pause/resume/stop ──────────────────────────────────────

test("reports no readings before start(), and pause() alone is a no-op", () => {
  let now = 0;
  const clock = new RunClock(() => now);

  assert.equal(clock.activeMs(), 0);
  assert.equal(clock.waitingMs(), 0);

  now = 5_000;
  assert.doesNotThrow(() => clock.pause());
  assert.equal(clock.activeMs(), 0, "still unstarted, so there is nothing to measure");
  assert.equal(clock.waitingMs(), 0);
});

test("accrues 10s of work, 60s of pause, then 5s more work after resume", () => {
  let now = 0;
  const clock = new RunClock(() => now);

  clock.start();
  now = 10_000;
  clock.pause();
  now = 70_000;
  clock.resume();
  now = 75_000;

  assert.equal(clock.activeMs(), 15_000, "10s + 5s of active work");
  assert.equal(clock.waitingMs(), 60_000);
});

test("an open pause excludes active time from activeMs while waitingMs grows live", () => {
  let now = 0;
  const clock = new RunClock(() => now);

  clock.start();
  now = 10_000;
  clock.pause();
  now = 40_000; // 30s into the pause, still no resume()

  assert.equal(clock.activeMs(), 10_000, "active time is frozen for the duration of an open pause");
  assert.equal(clock.waitingMs(), 30_000, "the open pause keeps growing as now advances");
});

test("repeated pause() is idempotent and preserves the earliest wait span's start", () => {
  let now = 0;
  const clock = new RunClock(() => now);

  clock.start();
  now = 10_000;
  clock.pause();
  now = 20_000;
  clock.pause(); // already paused: must not open a second wait span at 20_000
  assert.equal(clock.waitingMs(), 10_000);

  now = 30_000;
  clock.pause(); // still idempotent
  assert.equal(clock.waitingMs(), 20_000, "waitingMs is measured from the first pause() call");

  clock.resume();
  assert.equal(clock.waitingMs(), 20_000, "the single wait span spans earliest-pause to resume");
});

test("resume() is inert when there is no open pause, both before start() and while working", () => {
  let now = 0;
  const clock = new RunClock(() => now);

  assert.doesNotThrow(() => clock.resume()); // no start(), no open wait
  assert.equal(clock.activeMs(), 0);

  clock.start();
  now = 10_000;
  clock.resume(); // never paused
  assert.equal(clock.activeMs(), 10_000);
  assert.equal(clock.waitingMs(), 0);
});

test("stop() pins activeMs()/waitingMs() to the run window, and later now() advances do not move them", () => {
  let now = 0;
  const clock = new RunClock(() => now);

  clock.start();
  now = 10_000;
  clock.stop();

  const active = clock.activeMs();
  const waiting = clock.waitingMs();
  assert.equal(active, 10_000);
  assert.equal(waiting, 0);

  now = 100_000; // time keeps moving in the world, the clock does not
  assert.equal(clock.activeMs(), active);
  assert.equal(clock.waitingMs(), waiting);

  clock.stop(); // idempotent: the first stop() already won
  assert.equal(clock.activeMs(), active);
});

// ── workedBetween ────────────────────────────────────────────────────────────

test("workedBetween clips wait spans to the query window and never returns a negative value", () => {
  let now = 0;
  const clock = new RunClock(() => now);

  clock.start();
  now = 10_000;
  clock.pause(); // wait span begins at 10_000
  now = 60_000;
  clock.resume(); // wait span ends at 60_000
  now = 75_000;
  clock.stop();

  assert.equal(clock.workedBetween(0, 75_000), 25_000, "75s window minus the 50s pause");
  assert.equal(clock.workedBetween(5_000, 65_000), 10_000, "the pause is clipped to the query window (5s + 5s)");
  assert.equal(clock.workedBetween(20_000, 30_000), 0, "a window entirely inside the pause has no worked time");
  assert.equal(clock.workedBetween(60_000, 75_000), 15_000, "a window with no overlapping pause is worked end to end");
  assert.equal(clock.workedBetween(65_000, 5_000), 0, "a reversed window (to before from) never goes negative");
  assert.equal(clock.workedBetween(100, 100), 0, "a zero-width window has no worked time");
});

test("workedBetween treats an open, never-resumed wait as growing until stop() pins its end", () => {
  let now = 0;
  const clock = new RunClock(() => now);

  clock.start();
  now = 10_000;
  clock.pause(); // still open — no resume(), no stop() yet
  now = 20_000;

  assert.equal(clock.workedBetween(10_000, 20_000), 0, "an open wait counts as waiting up to the live now()");

  now = 30_000;
  clock.stop(); // endedAt = 30_000; the wait span is still open internally

  now = 100_000; // now keeps advancing, but the open wait's end no longer follows it
  assert.equal(
    clock.workedBetween(10_000, 100_000),
    70_000,
    "past endedAt the open wait's end is pinned there, so later time counts as worked",
  );
});

// ── bindUIPromptWaits ────────────────────────────────────────────────────────

/** Fake extension API capturing pi.on() registrations by event name, so the test can fire them manually. */
function fakePi() {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    on(event: string, handler: () => void) {
      handlers.set(event, handler);
    },
  } as unknown as Pick<ExtensionAPI, "on"> & { handlers: Map<string, () => void> };
}

test("bindUIPromptWaits captures the lifecycle handlers and drives whatever the clock accessor currently returns", () => {
  let now = 0;
  let active: RunClock | undefined; // mirrors "no audit currently running"
  const pi = fakePi();

  bindUIPromptWaits(pi, () => active);

  assert.equal(pi.handlers.size, 2);
  const onPromptStart = pi.handlers.get("ui_prompt_start");
  const onPromptEnd = pi.handlers.get("ui_prompt_end");
  assert.ok(onPromptStart && onPromptEnd, "both lifecycle handlers are registered");

  // While idle, the accessor resolves to undefined: firing either event is a no-op, not a throw.
  assert.doesNotThrow(() => onPromptStart!());
  assert.doesNotThrow(() => onPromptEnd!());

  // Once an audit starts, the accessor begins returning a real clock.
  const clock = new RunClock(() => now);
  clock.start();
  active = clock;
  now = 5_000;

  onPromptStart!();
  now = 8_000;
  assert.equal(clock.waitingMs(), 3_000, "ui_prompt_start paused the clock the accessor currently returns");

  onPromptEnd!();
  assert.equal(clock.waitingMs(), 3_000, "ui_prompt_end resumed it");
  now = 9_000;
  assert.equal(clock.waitingMs(), 3_000, "no further growth once resumed");

  // The accessor reverting to undefined (audit finished) stays safe to fire against.
  active = undefined;
  assert.doesNotThrow(() => onPromptStart!());
  assert.doesNotThrow(() => onPromptEnd!());
});
