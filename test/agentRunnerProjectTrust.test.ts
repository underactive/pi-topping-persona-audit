import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHeadlessSettingsManager, createIsolatedResourceLoader } from "../src/agentRunner.ts";

interface ProjectFixture {
  cwd: string;
  agentDir: string;
  markerPath: string;
  npmCommand: string[];
}

async function createProjectFixture(includePackageProbe: boolean): Promise<ProjectFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "persona-audit-trust-"));
  const agentDir = await mkdtemp(join(tmpdir(), "persona-audit-trust-agent-"));
  const markerPath = join(cwd, "npm-command-ran");
  const npmCommand = [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran")`,
    "--",
  ];

  await mkdir(join(cwd, ".pi", "skills", "probe"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify(
      includePackageProbe
        ? {
            npmCommand,
            packages: ["npm:zzz-persona-audit-trust-probe@1.0.0"],
            defaultTools: ["read"],
          }
        : { defaultTools: ["read"] },
      null,
      2,
    ),
    "utf-8",
  );
  await writeFile(
    join(cwd, ".pi", "skills", "probe", "SKILL.md"),
    "---\nname: probe\ndescription: Project trust probe.\n---\n\n# Probe\n",
    "utf-8",
  );

  return { cwd, agentDir, markerPath, npmCommand };
}

test("untrusted projects do not load project settings, packages, or skills", async (t) => {
  const previousOffline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  t.after(() => {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  });

  const fixture = await createProjectFixture(true);
  try {
    const trustedControl = SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: true });
    assert.deepEqual(
      trustedControl.getNpmCommand(),
      fixture.npmCommand,
      "the trusted control must read the marker-writing npmCommand",
    );

    const untrusted = SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: false });
    const loader = createIsolatedResourceLoader(fixture.cwd, fixture.agentDir, "", untrusted);
    await loader.reload();

    assert.equal(existsSync(fixture.markerPath), false, "an untrusted project's npmCommand must not run");
    assert.equal(existsSync(join(fixture.cwd, ".pi", "npm")), false, "an untrusted project must not install packages");
    assert.equal(
      loader.getSkills().skills.some((skill) => skill.name === "probe"),
      false,
      "an untrusted project's skills must not load",
    );

    const headless = createHeadlessSettingsManager(untrusted);
    assert.equal(headless.isProjectTrusted(), false, "headless settings must preserve the untrusted decision");
    assert.notDeepEqual(headless.getDefaultTools(), ["read"], "untrusted project settings must not be applied");
    assert.equal(headless.getCacheWarmingMode(), "off");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
    await rm(fixture.agentDir, { recursive: true, force: true });
  }
});

test("trusted projects load project settings and skills", async () => {
  const fixture = await createProjectFixture(false);
  try {
    const trusted = SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: true });
    const loader = createIsolatedResourceLoader(fixture.cwd, fixture.agentDir, "", trusted);
    await loader.reload();

    assert.equal(
      loader.getSkills().skills.some((skill) => skill.name === "probe"),
      true,
      "a trusted project's skills must load",
    );

    const headless = createHeadlessSettingsManager(trusted);
    assert.equal(headless.isProjectTrusted(), true, "headless settings must preserve the trusted decision");
    assert.deepEqual(headless.getDefaultTools(), ["read"], "trusted project settings must be applied");
    assert.equal(headless.getCacheWarmingMode(), "off");
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
    await rm(fixture.agentDir, { recursive: true, force: true });
  }
});
