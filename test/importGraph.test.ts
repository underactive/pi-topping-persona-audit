import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scanImportGraph } from "../src/index.ts";

test("scanImportGraph returns direct changed-file importers and repo-wide fan-in", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "persona-audit-imports-"));
  try {
    await mkdir(path.join(cwd, "src", "core"), { recursive: true });
    await writeFile(path.join(cwd, "src", "core", "index.ts"), "export const core = true;\n");
    await writeFile(path.join(cwd, "src", "a.ts"), "import { core } from './core';\nexport { core };\n");
    await writeFile(path.join(cwd, "src", "b.ts"), "const core = require('./core/index');\nexport { core };\n");
    await writeFile(path.join(cwd, "src", "c.ts"), "import { core } from './a.js';\nexport { core };\n");

    const graph = await scanImportGraph(cwd, ["src/core/index.ts"]);

    assert.deepEqual(graph.importers, ["src/a.ts", "src/b.ts"]);
    assert.equal(graph.fanIn.get("src/core/index.ts"), 2);
    assert.equal(graph.fanIn.get("src/a.ts"), 1);
    assert.equal(graph.fanIn.get("src/b.ts"), 0);
    assert.equal(graph.fanIn.get("src/c.ts"), 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
