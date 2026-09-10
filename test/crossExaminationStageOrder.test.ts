import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../src/orchestrator.ts", import.meta.url), "utf-8");

test("cross-examination stage runs after collection and before re-voice and reconcile", () => {
  const branch = source.slice(source.indexOf("// ── Steps c–e:"));
  const collection = branch.indexOf("collectReviewerFindings(");
  const crossExamination = branch.indexOf("selectCrossExaminationReviewers(selection.reviewers");
  const revoice = branch.indexOf("selectRevoiceTargets(");
  const reconcile = branch.indexOf("buildReconcileTask(");
  assert.ok(collection >= 0 && collection < crossExamination);
  assert.ok(crossExamination < revoice);
  assert.ok(revoice < reconcile);
});

test("cross-examination stage is inside the non-resume branch and uses read-only cancellable sessions", () => {
  const branchMarker = source.indexOf("// ── Steps c–e:");
  const resumeBranch = source.indexOf("if (input.resume)", branchMarker);
  const nonResumeBranch = source.indexOf("} else {", resumeBranch);
  const crossExaminationMarker = source.indexOf("// ── Step d1: reviewer cross-examination pass", nonResumeBranch);
  assert.ok(branchMarker >= 0 && resumeBranch < nonResumeBranch && nonResumeBranch < crossExaminationMarker);

  const sessionStart = source.lastIndexOf("const result = await runAgentSession({", source.indexOf("agentName: `${reviewer} cross-examination`"));
  const sessionEnd = source.indexOf("});", sessionStart);
  const session = source.slice(sessionStart, sessionEnd);
  assert.match(session, /tools: READ_ONLY_TOOLS/);
  assert.match(session, /signal: input\.signal/);
});
