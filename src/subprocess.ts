/**
 * Project agent discovery, concurrency helper, and shared telemetry
 * (OutputActivityTracker, formatToolActivity) used by agentRunner.ts.
 *
 * Agent discovery is ported from the official bundled `subagent` example
 * extension (@earendil-works/pi-coding-agent/examples/extensions/subagent).
 * Keeping it project-local avoids a dependency on the example package.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessageEvent, Message } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { StreamingWordCounter } from "./activityMeter.ts";
import type { HeadlessResult } from "./types.ts";

// ── Agent discovery (pattern from examples/extensions/subagent/agents.ts) ──

export interface AgentConfig {
  name: string;
  description: string;
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

// ── Live tool activity ────

/** Max length of a one-line tool-activity description surfaced for progress UIs. */
const ACTIVITY_MAX = 80;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Pick the most informative string argument for a one-line activity label.
 * Prefers well-known tool arg names (command, pattern, path, …); falls back to
 * the first non-empty string value.
 */
function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const preferred = ["command", "pattern", "query", "path", "file", "glob", "dir", "url", "name"];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return collapseWhitespace(value);
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim()) return collapseWhitespace(value);
  }
  return "";
}

/** Format a `tool_execution_start` event into a single-line "toolName arg" label. */
export function formatToolActivity(toolName: string, args: unknown): string {
  const detail = summarizeToolArgs(args);
  const label = detail ? `${toolName}  ${detail}` : String(toolName);
  return collapseWhitespace(label).slice(0, ACTIVITY_MAX);
}

/**
 * Tracks how much text a task is generating, for the activity monitor.
 *
 * Providers vary in what they report: some stream `usage.output` on the
 * in-flight partial, some only attach usage to the finished message, some
 * never report it at all. Exact usage always wins; otherwise words are counted
 * incrementally off the streamed deltas so the meter still moves.
 */
export class OutputActivityTracker {
  #counter = new StreamingWordCounter();
  #confirmed = 0;
  #liveExact: number | undefined;
  #liveWords = 0;
  #revision = 0;

  /** Begin a new assistant turn, discarding only the previous turn's live estimate. */
  messageStart(message: Message | undefined): void {
    if (message?.role !== "assistant") return;
    this.#resetTurn();
  }

  messageUpdate(assistantEvent: AssistantMessageEvent | undefined, partial: Message | undefined): void {
    const exact = partial?.role === "assistant" ? partial.usage?.output : undefined;
    if (typeof exact === "number" && exact > 0) this.#liveExact = exact;
    if (assistantEvent?.type !== "text_delta" && assistantEvent?.type !== "thinking_delta") return;
    // Counted per stream kind so a word split across deltas isn't double
    // counted, and interleaved thinking/text streams don't corrupt each other.
    this.#liveWords += this.#counter.count(assistantEvent.delta, assistantEvent.type);
  }

  messageEnd(message: Message | undefined): void {
    if (message?.role !== "assistant") return;
    const exact = message.usage?.output;
    const estimate = this.#liveExact ?? this.#liveWords;
    if (typeof exact === "number") {
      this.#confirmed += exact;
      if (exact !== estimate) this.#revision++;
    } else {
      this.#confirmed += estimate;
    }
    this.#resetTurn();
  }

  snapshot(): { tokens: number; revision: number } {
    return { tokens: this.#confirmed + (this.#liveExact ?? this.#liveWords), revision: this.#revision };
  }

  #resetTurn(): void {
    this.#liveExact = undefined;
    this.#liveWords = 0;
    this.#counter.reset();
  }
}

/** Whether a run should be treated as failed. */
export function isFailedRun(result: HeadlessResult): boolean {
  return result.aborted || result.stopReason === "error" || result.stopReason === "aborted";
}

/** Matched against the errorMessage resolveModelRef throws before any network call. */
export function isPermanentRunFailure(errorMessage: string | undefined): boolean {
  return !!errorMessage && errorMessage.startsWith("Model not found");
}
