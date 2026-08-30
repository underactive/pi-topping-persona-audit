import * as path from "node:path";

export type AuditExclusions = {
  names: Set<string>;
  paths: Set<string>;
};

export type PersonaAuditArgs = {
  useDiff: boolean;
  useFull: boolean;
  baseCommit?: string;
  handoffPath?: string;
  scope: string;
  scopeGiven: boolean;
  exclusions: AuditExclusions;
};

export type ParsePersonaAuditArgsResult =
  | { ok: true; value: PersonaAuditArgs }
  | { ok: false; error: string };

export function tokenizeCommandArgs(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;

  for (const character of input) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (quote) throw new Error(`Unmatched ${quote} quote in command arguments.`);
  if (tokenStarted) tokens.push(token);
  return tokens;
}

function normalizeExclusion(value: string): { kind: "name" | "path"; value: string } | { error: string } {
  if (!value) return { error: "Error: --exclude requires a directory name or project-root-relative path." };
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return { error: `Error: --exclude path must be relative to the project root: ${value}` };
  }

  const hasSeparator = /[\\/]/.test(value);
  const normalized = path.posix.normalize(value.replace(/\\/g, "/").replace(/^\.\//, "")).replace(/\/$/, "");
  if (!normalized || normalized === ".") {
    return { error: "Error: --exclude cannot be empty or '.'." };
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    return { error: `Error: --exclude path escapes the project root: ${value}` };
  }
  return { kind: hasSeparator ? "path" : "name", value: normalized };
}

export function parsePersonaAuditArgs(input: string): ParsePersonaAuditArgsResult {
  let argsList: string[];
  try {
    argsList = tokenizeCommandArgs(input);
  } catch (error) {
    return { ok: false, error: `Error: ${error instanceof Error ? error.message : String(error)}` };
  }

  let useDiff = false;
  let useFull = false;
  let baseCommit: string | undefined;
  let handoffPath: string | undefined;
  let scope = ".";
  let scopeGiven = false;
  const exclusions: AuditExclusions = { names: new Set(), paths: new Set() };
  let hasExclusions = false;

  for (let i = 0; i < argsList.length; i++) {
    const arg = argsList[i]!;
    if (arg === "--diff") {
      useDiff = true;
    } else if (arg === "--full") {
      useFull = true;
    } else if (arg === "--base") {
      const next = argsList[++i];
      if (!next || next.startsWith("-")) return { ok: false, error: "Error: --base requires a commit." };
      baseCommit = next;
    } else if (arg === "--handoff") {
      const next = argsList[++i];
      if (!next || next.startsWith("-")) {
        return { ok: false, error: "Error: --handoff requires a path to a deferred-findings handoff file." };
      }
      handoffPath = next;
    } else if (arg === "--exclude") {
      const next = argsList[++i];
      if (next === undefined || next.startsWith("-")) {
        return { ok: false, error: "Error: --exclude requires a directory name or project-root-relative path." };
      }
      hasExclusions = true;
      const exclusion = normalizeExclusion(next);
      if ("error" in exclusion) return { ok: false, error: exclusion.error };
      exclusions[exclusion.kind === "name" ? "names" : "paths"].add(exclusion.value);
    } else if (arg && !arg.startsWith("-")) {
      scope = arg;
      scopeGiven = true;
    }
  }

  if (hasExclusions && !useFull) {
    return { ok: false, error: "Error: --exclude is only supported with --full mode." };
  }

  return {
    ok: true,
    value: { useDiff, useFull, baseCommit, handoffPath, scope, scopeGiven, exclusions },
  };
}
