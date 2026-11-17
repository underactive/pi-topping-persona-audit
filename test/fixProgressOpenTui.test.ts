import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { openFixProgress } from "../src/components/FixProgress.ts";
import type { Finding } from "../src/types.ts";
import { MIN_DIALOG_SIZE } from "../src/ui/dialog-fit.ts";
import { createDialogHost, press, ROOMY_TERMINAL, screen, waitForResult } from "./helpers/dialog-harness.ts";

const finding: Finding = {
  reviewer: "Security Engineer",
  file: "src/session.ts",
  line: 12,
  category: "security",
  severity: "high",
  rationale: "The cookie can be read by page scripts.",
  suggestedChange: "Set HttpOnly and Secure.",
  recommendation: "apply",
};

for (const [name, terminal] of [["a roomy terminal", ROOMY_TERMINAL], ["an 80×24 terminal", MIN_DIALOG_SIZE]] as const) test(`Fix Now gate opens the generated overlay on ${name}`, async () => {
  const host = createDialogHost({ terminal });
  const ctx = {
    ...host.ctx,
    ui: {
      ...host.ctx.ui,
      onTerminalInput: (_handler: TerminalInputHandler) => () => {},
    },
  } as ExtensionCommandContext;
  const controller = openFixProgress(ctx, finding, () => {});
  const decision = controller.gate({
    diff: "@@ -1 +1 @@\n-const secure = false;\n+const secure = true;",
    commitPlanned: false,
    attempt: 1,
  });
  const dialog = await host.dialog();
  const width = Math.min(104, terminal.columns);
  assert.match(screen(dialog, width), /FIX NOW/i);
  assert.match(screen(dialog, width), /Accept/);
  assert.ok(dialog.render(width).length <= terminal.rows, "the gate fits the terminal's rows");
  assert.equal(host.customOptions.length, 1, "the generated overlay is the only thing shown");
  await press(dialog, "a");
  assert.equal(await waitForResult(decision, "generated Fix Now decision"), "accept");
  await controller.close();
});
