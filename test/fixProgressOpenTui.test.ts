import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { openFixProgress } from "../src/components/FixProgress.ts";
import type { Finding } from "../src/types.ts";
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

test("Fix Now gate uses the generated overlay when the measured terminal threshold fits", async () => {
  const host = createDialogHost({ terminal: ROOMY_TERMINAL });
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
  assert.match(screen(dialog, 104), /FIX NOW/i);
  assert.match(screen(dialog, 104), /Accept/);
  assert.equal(host.customOptions.length, 2, "one invisible size probe and one generated overlay");
  await press(dialog, "a");
  assert.equal(await waitForResult(decision, "generated Fix Now decision"), "accept");
  await controller.close();
});
