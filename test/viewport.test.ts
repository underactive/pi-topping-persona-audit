import assert from "node:assert/strict";
import { test } from "node:test";
import { FULLSCREEN_WIDGET_RESERVE_ROWS, usableTerminalRows } from "../src/components/viewport.ts";

test("usableTerminalRows takes the reserve off only in fullscreen", () => {
  assert.equal(usableTerminalRows({ terminal: { rows: 40 }, mode: "fullscreen" }, 5), 35);
  assert.equal(usableTerminalRows({ terminal: { rows: 40 }, mode: "regular" }, 5), 40);
  assert.equal(usableTerminalRows({ terminal: { rows: 40 } }, 5), 40, "a host that reports no mode reserves nothing");
  assert.equal(usableTerminalRows({ terminal: { rows: 40 }, mode: "fullscreen" }, 5, "regular"), 40, "an explicit mode overrides the host's");
});

test("usableTerminalRows falls back when the height is unknown and never drops below one row", () => {
  for (const terminal of [{ rows: 0 }, { rows: -1 }, {}, undefined]) {
    assert.equal(usableTerminalRows({ terminal }, 5), 40, `regular fallback for ${JSON.stringify(terminal)}`);
    assert.equal(usableTerminalRows({ terminal, mode: "fullscreen" }, 5), 35, `fullscreen fallback for ${JSON.stringify(terminal)}`);
  }
  assert.equal(usableTerminalRows(undefined, 5), 40, "no host at all uses the fallback");
  assert.equal(usableTerminalRows({ terminal: { rows: 3 }, mode: "fullscreen" }, 5), 1);
});

test("the docked widget gives up pi's bare fullscreen dock", () => {
  // The editor's 3-row minimum and a 2-row footer, measured on pi 1.0.0.
  assert.equal(FULLSCREEN_WIDGET_RESERVE_ROWS, 5);
});
