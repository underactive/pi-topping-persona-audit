/**
 * Project agent discovery, concurrency helper, and run-outcome helpers used by
 * agentRunner.ts.
 *
 * Agent discovery is ported from the official bundled `subagent` example
 * extension (@earendil-works/pi-coding-agent/examples/extensions/subagent).
 * Keeping it project-local avoids a dependency on the example package.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { HeadlessOptions, HeadlessResult } from "./types.ts";

// ── Agent discovery (pattern from examples/extensions/subagent/agents.ts) ──

export interface AgentConfig {
  name: string;
  description: string;
  /** Frontmatter `tools:` entries as written; `resolveAgentTools()` turns them into a session's tools. */
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

/** Where an agent definition came from, in ascending precedence order. */
export type AgentSource = "bundled" | "user" | "project";

export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * This extension's own agent definitions, resolved from the module location
 * rather than the cwd. `findNearestProjectAgentsDir` only ever walks up from
 * the audited repository, which never reaches an installed copy under
 * `node_modules`, so without this layer `/persona-audit` only works in repos that
 * happen to carry their own `.pi/agents`.
 */
export const BUNDLED_AGENTS_DIR = path.join(import.meta.dirname, "..", "agents");

/**
 * Discover agents from three layers, each overriding the previous on a name
 * collision: this extension's bundled `agents/`, the user dir
 * (~/.pi/agent/agents), then the nearest project-local `.pi/agents`. The
 * project layer is part of the audited repository and so cannot shadow a
 * bundled `persona-audit-*` agent — those are trust-critical and must not be
 * redefinable by content under review.
 */
export function discoverAgents(cwd: string): AgentConfig[] {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const agentMap = new Map<string, AgentConfig>();
  for (const agent of loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled")) agentMap.set(agent.name, agent);
  for (const agent of loadAgentsFromDir(userDir, "user")) agentMap.set(agent.name, agent);
  if (projectAgentsDir) {
    for (const agent of loadAgentsFromDir(projectAgentsDir, "project")) {
      if (agent.name.startsWith("persona-audit-")) continue;
      agentMap.set(agent.name, agent);
    }
  }
  return [...agentMap.values()];
}

// ── Agent tool lists ───

/** Whether a `tools:` entry edits a default list (`+name`/`-name`) rather than naming a tool, as pi 1.1.0+ reads it. */
function isToolModifier(entry: string): boolean {
  return entry.startsWith("+") || entry.startsWith("-");
}

/**
 * The tools an agent's sessions get: its frontmatter `tools:`, or `defaults` (the
 * role's own tools) when the file lists none. A list made only of `+name`/`-name`
 * entries edits `defaults`. Passed through, pi 1.1.0+ would apply it to pi's own
 * default tools (`read, bash, edit, write`) and lift its allowlist, so it is
 * resolved here and pi only ever receives tool names and `*` patterns.
 *
 * Throws, naming the agent file, on the lists pi rejects: names mixed with
 * `+`/`-` entries, and a `+`/`-` entry holding a `*` pattern.
 */
export function resolveAgentTools(agent: Pick<AgentConfig, "tools" | "filePath">, defaults: readonly string[]): string[] {
  const entries = agent.tools;
  if (!entries) return [...defaults];
  const modifiers = entries.filter(isToolModifier);
  if (modifiers.length === 0) return [...entries];
  if (modifiers.length < entries.length) {
    throw new Error(`Invalid tools in ${agent.filePath}: tool names cannot be mixed with +name or -name entries`);
  }
  const pattern = modifiers.find((entry) => entry.includes("*"));
  if (pattern) {
    throw new Error(`Invalid tools in ${agent.filePath}: +name and -name entries take exact tool names, not patterns: ${pattern}`);
  }
  const tools = [...defaults];
  for (const entry of modifiers) {
    const name = entry.slice(1);
    const index = tools.indexOf(name);
    if (entry.startsWith("+") && index === -1 && name) tools.push(name);
    else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
  }
  return tools;
}

/**
 * Tool options for a session that edits files but must never shell out. Dropping
 * "bash" from the allowlist is not enough on its own: since pi 1.0.4 a `*` entry
 * is a wildcard that matches bash again. pi checks `excludeTools` before the
 * allowlist, so an excluded tool is never registered, whatever the list matches.
 */
export function withoutBash(tools: readonly string[]): Pick<HeadlessOptions, "tools" | "excludeTools"> {
  return { tools: tools.filter((t) => t !== "bash"), excludeTools: ["bash"] };
}

// ── Concurrency helper ───

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current] as TIn, current);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Keep the last `maxChars` of captured output, marking any elision with a leading ellipsis. */
export function tail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `…${trimmed.slice(-maxChars)}` : trimmed;
}

/** Whether a run should be treated as failed. */
export function isFailedRun(result: HeadlessResult): boolean {
  return result.aborted || result.stopReason === "error" || result.stopReason === "aborted";
}

/** Matched against pre-network errors from resolveModelRef and the virtual-model guard. */
export function isPermanentRunFailure(errorMessage: string | undefined): boolean {
  return !!errorMessage && (errorMessage.startsWith("Model not found") || errorMessage.includes("is a virtual (router) model"));
}
