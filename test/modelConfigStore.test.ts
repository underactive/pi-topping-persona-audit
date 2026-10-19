import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadPersonaAuditConfig,
  personaAuditSettingsPath,
  savePersonaAuditConfig,
  updatePersonaAuditConfig,
} from "../src/modelConfig.ts";

function withAgentDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "persona-audit-store-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("save writes tab-indented JSON, mode 0600, and load reads it back", () => {
  withAgentDir(() => {
    const config = { ...loadPersonaAuditConfig(), temperament: "caustic" as const };
    assert.equal(savePersonaAuditConfig(config).ok, true);
    const text = readFileSync(personaAuditSettingsPath(), "utf8");
    assert.ok(text.startsWith('{\n\t"'));
    assert.equal(statSync(personaAuditSettingsPath()).mode & 0o777, 0o600);
    assert.equal(loadPersonaAuditConfig().temperament, "caustic");
  });
});

test("update merges into the file as it is now", () => {
  withAgentDir(() => {
    assert.equal(updatePersonaAuditConfig((c) => ({ ...c, temperament: "lkml" })).ok, true);
    assert.equal(updatePersonaAuditConfig((c) => ({ ...c, maxVerifyRounds: 5 })).ok, true);
    const loaded = loadPersonaAuditConfig();
    assert.equal(loaded.temperament, "lkml");
    assert.equal(loaded.maxVerifyRounds, 5);
  });
});

test("update refuses a corrupt file and leaves it untouched", () => {
  withAgentDir(() => {
    assert.equal(savePersonaAuditConfig(loadPersonaAuditConfig()).ok, true);
    writeFileSync(personaAuditSettingsPath(), "{nope");
    const result = updatePersonaAuditConfig((c) => c);
    assert.equal(result.ok, false);
    assert.equal(readFileSync(personaAuditSettingsPath(), "utf8"), "{nope");
    assert.equal(loadPersonaAuditConfig().temperament, "calibrated");
  });
});
