import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

test("the generated dialogs, the runtime and its reconciler load one copy of react", () => {
  // The generated files import react themselves. A second copy next to the runtime's makes every
  // hook call fail, so a split install must fail here and not on the first dialog a user opens.
  const fromGenerated = createRequire(new URL("../src/ui/generated/ui.ts", import.meta.url));
  const fromRuntime = createRequire(import.meta.resolve("@underactive/pi-topping-opentui/host"));
  const fromReconciler = createRequire(fromRuntime.resolve("react-reconciler"));

  const react = fromGenerated.resolve("react");
  assert.equal(fromRuntime.resolve("react"), react, "the runtime resolves another react than the generated files");
  assert.equal(fromReconciler.resolve("react"), react, "react-reconciler resolves another react than the generated files");
});
