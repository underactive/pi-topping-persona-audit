import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parsePersonaAuditArgs } from "../src/args.ts";
import { getFullTreeManifest } from "../src/index.ts";
import { writeFileAt } from "./helpers/gitTest.ts";

async function withFixture(
  files: string[],
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "persona-audit-exclusions-"));
  try {
    await Promise.all(files.map((file) => writeFileAt(cwd, file, `// ${file}\n`)));
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function exclusionsFrom(command: string) {
  const parsed = parsePersonaAuditArgs(command);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value.exclusions;
}

test("full-tree name exclusions prune matching directories at every depth and only directories", async () => {
  await withFixture(
    [
      "src/components/main.ts",
      "src/components/tests/unit.ts",
      "src/components/nested/tests/deep.ts",
      "src/components/tests.ts",
    ],
    async (cwd) => {
      const files = await getFullTreeManifest(cwd, "src/components", exclusionsFrom("--full --exclude tests"));
      assert.deepEqual(files, ["src/components/main.ts", "src/components/tests.ts"]);
    },
  );
});

test("full-tree path exclusions are project-root-relative, exact, and segment-safe", async () => {
  await withFixture(
    [
      "src/test/skip.ts",
      "src/testing/keep.ts",
      "packages/a/src/test/keep.ts",
      "outside/skip.ts",
    ],
    async (cwd) => {
      const files = await getFullTreeManifest(
        cwd,
        "src",
        exclusionsFrom("--full --exclude src/test --exclude outside"),
      );
      assert.deepEqual(files, ["src/testing/keep.ts"]);
    },
  );
});

test("full-tree exclusions support multiple quoted paths containing spaces", async () => {
  await withFixture(
    [
      "src/my components/main.ts",
      "src/my components/my tests/skip.ts",
      "src/my components/generated files/skip.ts",
    ],
    async (cwd) => {
      const parsed = parsePersonaAuditArgs(
        `--full "src/my components" --exclude "my tests" --exclude "src/my components/generated files"`,
      );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      const files = await getFullTreeManifest(cwd, parsed.value.scope, parsed.value.exclusions);
      assert.deepEqual(files, ["src/my components/main.ts"]);
    },
  );
});

test("full-tree built-in and user exclusions operate together", async () => {
  await withFixture(
    [
      "src/main.ts",
      "src/node_modules/dependency.ts",
      "src/custom/skip.ts",
      "node_modules.ts",
    ],
    async (cwd) => {
      const files = await getFullTreeManifest(cwd, ".", exclusionsFrom("--full --exclude custom"));
      assert.deepEqual(files, ["node_modules.ts", "src/main.ts"]);
    },
  );
});

test("excluding the selected scope returns the existing empty manifest", async () => {
  await withFixture(["src/tests/only.ts"], async (cwd) => {
    const files = await getFullTreeManifest(cwd, "src/tests", exclusionsFrom("--full --exclude tests"));
    assert.deepEqual(files, []);
  });
});
