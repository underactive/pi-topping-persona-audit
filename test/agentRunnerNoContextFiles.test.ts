import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createIsolatedResourceLoader } from "../src/agentRunner.ts";

// Regression: the audited repo's AGENTS.md/CLAUDE.md must not be pulled into
// the base system prompt of bash+edit agent sessions. createIsolatedResourceLoader
// sets noContextFiles: true so loadProjectContextFiles() cannot pick it up.
for (const contextFile of ["AGENTS.md", "CLAUDE.md"]) {
  test(`createIsolatedResourceLoader loads no ${contextFile} from the audited cwd`, async () => {
    // A self-contained context file in a throwaway cwd rather than relying on
    // whatever happens to be globally installed on the machine running this test.
    const cwd = await mkdtemp(join(tmpdir(), "persona-audit-ctx-probe-"));
    const agentDir = await mkdtemp(join(tmpdir(), "persona-audit-ctx-agent-"));
    try {
      const marker = "PERSONA-AUDIT-CTX-PROBE-MARKER";
      await writeFile(join(cwd, contextFile), `# rules\n\n${marker}\n`, "utf-8");

      // Control: proves the fixture context file is loadable at all, so a passing
      // isolated-loader assertion below means noContextFiles actually suppressed
      // it — not that there was nothing to load in the first place.
      const unrestricted = new DefaultResourceLoader({ cwd, agentDir });
      await unrestricted.reload();
      assert.ok(
        unrestricted.getAgentsFiles().agentsFiles.some((f) => f.content.includes(marker)),
        `expected the fixture ${contextFile} to be loaded for the control to be meaningful`,
      );

      const isolated = createIsolatedResourceLoader(
        cwd,
        agentDir,
        "",
        SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
      );
      await isolated.reload();
      assert.equal(
        isolated.getAgentsFiles().agentsFiles.length,
        0,
        "isolated loader must not pull the audited repo's AGENTS.md/CLAUDE.md into context files",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
}
