import { lstat } from "node:fs/promises";
import * as path from "node:path";
import type { BlastRadius, ChangeKind } from "./types.ts";

const SENSITIVITY_RULES = [
  { tag: "auth/session", pattern: /(^|\/)(auth|authentication|authorization|session|sessions|permission|permissions|acl)(\/|\.|$)/i },
  { tag: "payment/billing", pattern: /(^|\/)(payment|payments|billing|checkout|invoice|invoices)(\/|\.|$)/i },
  { tag: "database schema", pattern: /(^|\/)(migrations?|schema|schemas|database|db)(\/|\.|$)/i },
  { tag: "public API/SDK", pattern: /(^|\/)(api|public|sdk|client|exports?)(\/|\.|$)|(^|\/)index\.[cm]?[jt]sx?$/i },
  { tag: "shared config/infra", pattern: /(^|\/)(config|configs|env|infra|terraform|feature[-_]?flags?|\.github\/workflows)(\/|\.|$)|(^|\/)Dockerfile$/i },
  { tag: "serialization/crypto", pattern: /(^|\/)(serializ(e|ation)|deserializ(e|ation)|crypto|cryptography|encrypt|decrypt)(\/|\.|$)/i },
] as const;

const CHANGE_KIND_POINTS: Record<ChangeKind, number> = {
  signature: 10,
  behavior: 5,
  internal: 0,
  cosmetic: -10,
};

const CHANGE_KIND_REASONS: Record<ChangeKind, string> = {
  signature: "changes a signature",
  behavior: "changes behavior",
  internal: "internal change",
  cosmetic: "cosmetic change",
};

export function sensitivityTags(file: string): string[] {
  const normalized = file.replace(/\\/g, "/");
  return SENSITIVITY_RULES.filter((rule) => rule.pattern.test(normalized)).map((rule) => rule.tag);
}

function fanInPoints(fanIn: number): number {
  if (fanIn >= 11) return 50;
  if (fanIn >= 6) return 35;
  if (fanIn >= 3) return 22;
  if (fanIn >= 1) return 10;
  return 0;
}

export function computeBlastRadius(input: {
  fanIn: number;
  tags: string[];
  hasTest: boolean | undefined;
  changeKind: ChangeKind | undefined;
}): BlastRadius {
  const fanIn = Math.max(0, Math.floor(input.fanIn));
  const fanPoints = fanInPoints(fanIn);
  const uniqueTags = [...new Set(input.tags)];
  const sensitivityPoints = Math.min(30, uniqueTags.length * 10);
  const testPoints = input.hasTest === false ? 15 : 0;
  const changePoints = input.changeKind ? CHANGE_KIND_POINTS[input.changeKind] : 0;
  const score = Math.max(0, Math.min(100, fanPoints + sensitivityPoints + testPoints + changePoints));

  const reasons: { points: number; index: number; text: string }[] = [];
  if (fanPoints > 0) reasons.push({ points: fanPoints, index: reasons.length, text: `imported by ${fanIn} module${fanIn === 1 ? "" : "s"}` });
  for (const tag of uniqueTags.slice(0, 3)) {
    reasons.push({ points: 10, index: reasons.length, text: `${tag} code` });
  }
  if (testPoints > 0) reasons.push({ points: testPoints, index: reasons.length, text: "no tests" });
  if (input.changeKind && changePoints !== 0) {
    reasons.push({ points: changePoints, index: reasons.length, text: CHANGE_KIND_REASONS[input.changeKind] });
  }
  reasons.sort((left, right) => right.points - left.points || left.index - right.index);

  return {
    score,
    level: score >= 75 ? "critical" : score >= 50 ? "high" : score >= 25 ? "medium" : "low",
    reasons: reasons.map((reason) => reason.text),
  };
}

async function isRegularFile(candidate: string): Promise<boolean | undefined> {
  try {
    return (await lstat(candidate)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return undefined;
  }
}

export async function hasCorrespondingTest(cwd: string, file: string): Promise<boolean | undefined> {
  const root = path.resolve(cwd);
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;

  const targetState = await isRegularFile(target);
  if (targetState !== true) return undefined;

  const extension = path.extname(relative);
  if (!extension) return undefined;
  const stem = path.basename(relative, extension);
  const directory = path.dirname(relative);
  const names = [`${stem}.test${extension}`, `${stem}.spec${extension}`];
  const candidates = [
    ...names.map((name) => path.resolve(root, directory, name)),
    ...names.map((name) => path.resolve(root, directory, "__tests__", name)),
    ...names.map((name) => path.resolve(root, "test", directory, name)),
    ...names.map((name) => path.resolve(root, "tests", directory, name)),
  ];

  for (const candidate of candidates) {
    const state = await isRegularFile(candidate);
    if (state === true) return true;
    if (state === undefined) return undefined;
  }
  return false;
}
