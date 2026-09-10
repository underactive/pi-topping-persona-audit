import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { rosterNameError, showRosterManager } from "../src/components/RosterEditor.ts";
import type { Roster } from "../src/modelConfig.ts";

const ENTER = "\r";
const ESCAPE = "\x1b";
const TAB = "\t";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";
const HIGHLIGHT = "\x1b[48;5;236m";
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => `${HIGHLIGHT}${text}\x1b[49m`,
  bold: (text: string) => text,
} as unknown as Theme;
const tui = { requestRender: () => {} } as unknown as TUI;

class Harness {
  component: Component | undefined;
  names: Array<string | undefined> = [];
  confirms: boolean[] = [];
  notifications: string[] = [];
  readonly ctx: ExtensionCommandContext;

  constructor() {
    this.ctx = {
      mode: "tui",
      ui: {
        custom: <T>(
          factory: (host: TUI, currentTheme: Theme, keys: KeybindingsManager, done: (value: T) => void) => Component,
        ) => new Promise<T>((resolve) => {
          this.component = factory(tui, theme, undefined as unknown as KeybindingsManager, resolve);
        }),
        input: async () => this.names.shift(),
        confirm: async () => this.confirms.shift() ?? false,
        notify: (message: string) => { this.notifications.push(message); },
      },
    } as unknown as ExtensionCommandContext;
  }

  send(...keys: string[]): void { keys.forEach((key) => this.component?.handleInput?.(key)); }
  render(): string { return (this.component?.render(80) ?? []).map(strip).join("\n"); }
  async next(): Promise<void> { await new Promise((resolve) => setImmediate(resolve)); }
}

test("roster names enforce alphanumeric length and case-insensitive uniqueness", () => {
  const rosters: Roster[] = [{ name: "Core5", reviewers: ["Security Engineer"] }];
  assert.match(rosterNameError("bad-name", rosters) ?? "", /alphanumeric/);
  assert.match(rosterNameError("core5", rosters) ?? "", /already exists/);
  assert.equal(rosterNameError("core5", rosters, 0), undefined);
});

test("roster manager creates ten-slot rosters, restores focus, excludes duplicates, and validates minimum size", async () => {
  const harness = new Harness();
  harness.names.push("Core5");
  const result = showRosterManager(harness.ctx, []);

  assert.match(harness.render(), /Create roster/);
  harness.send(ENTER);
  await harness.next();
  assert.match(harness.render(), /Slot 10/);
  assert.match(harness.render(), /❯ Slot 1/);

  harness.send(ENTER);
  await harness.next();
  for (const char of "threatmodeling") harness.send(char);
  assert.match(harness.render(), /Security Engineer/);
  assert.match(harness.render(), /─ Specialist/);
  harness.send(ENTER);
  await harness.next();
  assert.match(harness.render(), /❯ Slot 1\s+Security Engineer/);

  harness.send(DOWN, ENTER);
  await harness.next();
  for (const char of "threatmodeling") harness.send(char);
  assert.match(harness.render(), /No reviewers match filter/);
  harness.send(ESCAPE);
  await harness.next();
  assert.match(harness.render(), /❯ Slot 2/);

  harness.send(UP, BACKSPACE, TAB, ENTER);
  assert.match(harness.notifications.at(-1) ?? "", /at least one reviewer/);
  assert.match(harness.render(), /Slot 2/);

  harness.send(ESCAPE);
  await harness.next();
  harness.send(TAB, ENTER);
  assert.deepEqual(await result, []);
});

test("roster manager stages rename and confirmed deletion", async () => {
  const harness = new Harness();
  harness.names.push("Renamed");
  harness.confirms.push(true);
  const result = showRosterManager(harness.ctx, [{ name: "Core5", reviewers: ["Security Engineer"] }]);

  harness.send(ENTER);
  await harness.next();
  harness.send(TAB, RIGHT, ENTER);
  await harness.next();
  assert.match(harness.render(), /Reviewer roster: Renamed/);
  harness.send(TAB, ENTER);
  await harness.next();
  assert.match(harness.render(), /Renamed/);

  harness.send(ENTER);
  await harness.next();
  harness.send(TAB, RIGHT, RIGHT, ENTER);
  await harness.next();
  assert.match(harness.render(), /Create roster/);
  harness.send(TAB, ENTER);
  assert.deepEqual(await result, []);
});
