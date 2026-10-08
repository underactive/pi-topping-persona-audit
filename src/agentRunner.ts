/**
 * In-process agent-session task runner.
 *
 * Spawns isolated agent sessions via pi's createAgentSession() SDK, replaying
 * extension-registered model providers onto a fresh ModelRuntime so bridge and
 * custom models resolve identically. noExtensions prevents self-recursion.
 */

import { join } from "node:path";
import { calculateCost, type Api, type ImageContent, type Model, type Usage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { formatToolActivity, OutputActivityTracker } from "./subprocess.ts";
import type { HeadlessOptions, HeadlessResult, HeadlessUsage } from "./types.ts";

export type SessionMessage = AgentSession["messages"][number];

/** Last assistant text block — primary output channel. */
export function getFinalAssistantText(messages: readonly SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

/**
 * Concatenate ALL assistant text blocks in order. Reviewer JSON-lines output
 * may be spread across multiple assistant messages (interleaved with tool
 * calls), so collection parses this superset rather than only the last block.
 */
export function getAllAssistantText(messages: readonly SessionMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text" && part.text.trim()) parts.push(part.text);
    }
  }
  return parts.join("\n");
}

// ── Model resolution ──

/** Exact "provider/id" match, then fuzzy fallback (frontmatter `model:` may hold a fuzzy string like "sonnet"); throws with the available-model list when nothing matches. */
export function resolveModelRef(input: string | undefined, registry: ModelRegistry): Model<Api> | undefined {
  if (!input) return undefined;

  const all = registry.getAvailable();
  const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()));

  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "-");
  const query = normalize(input);

  let bestMatch: Model<Api> | undefined;
  let bestScore = 0;
  for (const m of all) {
    const id = normalize(m.id);
    const name = normalize(m.name);
    const full = normalize(`${m.provider}/${m.id}`);
    let score = 0;
    if (id === query || full === query) {
      score = 100;
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30;
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      query
        .split(/[\s\-/]+/)
        .every((part) => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
    ) {
      score = 20;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // Retry bare (no provider) so the same model under a different provider still resolves.
  if (slashIdx !== -1) {
    const bare = resolveModelRef(input.slice(slashIdx + 1), registry);
    if (bare) return bare;
  }

  const modelList = all
    .map((m) => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  throw new Error(`Model not found: "${input}".\n\nAvailable models:\n${modelList}`);
}

/**
 * API id pi assigns to virtual (router) catalog entries — `VIRTUAL_MODEL_API` in
 * pi's core/virtual-models.ts. pi exports only VIRTUAL_MODEL_STATE_ENTRY from
 * its package root, so the value is duplicated here.
 */
const VIRTUAL_MODEL_API = "pi-virtual";

/**
 * Whether a resolved catalogue entry is a virtual (router) model, mirroring pi's
 * own `isVirtualModel()`. A virtual model picks a physical model per request
 * through a router registered on the session that created it.
 */
export function isVirtualModelRef(model: { api: string } | undefined): boolean {
  return model?.api === VIRTUAL_MODEL_API;
}

/**
 * Actionable replacement for pi's "No API key found for <provider>", which is
 * what an isolated audit session reports when its model is virtual: the fresh
 * runtime replays registered providers but never the router, so pi's auth
 * preflight fails against the virtual provider, which holds no key of its own.
 *
 * The first line carries the gist; Fix Now's toast renders only that line.
 */
export function virtualModelMessage(label: string): string {
  return [
    `${label} is a virtual (router) model, and an audit session cannot run one.`,
    "Audit sessions build their own model runtime and replay only registered providers, so the router that would pick a physical model is not available, and the virtual provider has no API key of its own.",
    "Set a physical model for the Dispatch model and each phase in /persona-audit-settings, or select a physical model for this session with /model.",
  ].join(" ");
}

// Lives for as long as the registry object itself: pi hands extensions a
// stable registry per session, and dropping the registry drops its runtime
// cache with it — same lifetime rule as CATALOGUES in modelCatalogue.ts.
const RUNTIMES = new WeakMap<ModelRegistry, Promise<ModelRuntime>>();

function emptyUsage(): HeadlessUsage {
  return { turns: 0, contextTokens: 0, outputTokens: 0 };
}

export type TurnTokenUsage = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "totalTokens"> & {
  /** Provider-reported cost breakdown; only its total is used, as a fallback when registry rates are unavailable or zero. */
  cost?: Usage["cost"];
};

function nonnegativeFinite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function reportedUsageCost(usage: TurnTokenUsage): number | undefined {
  const total = usage.cost?.total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}

/** Calculate one assistant turn's cost using registry rates, with provider cost as a fallback. */
export function calculateTurnCost(model: Model<Api> | undefined, usage: TurnTokenUsage): number | undefined {
  const reported = reportedUsageCost(usage);
  if (!model) return reported;
  const cost = calculateCost(model, {
    input: nonnegativeFinite(usage.input),
    output: nonnegativeFinite(usage.output),
    cacheRead: nonnegativeFinite(usage.cacheRead),
    cacheWrite: nonnegativeFinite(usage.cacheWrite),
    cacheWrite1h: nonnegativeFinite(usage.cacheWrite1h),
    totalTokens: nonnegativeFinite(usage.totalTokens),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const total = cost.total;
  if (Number.isFinite(total) && total >= 0) {
    // Router/proxy models can carry zero rates even when their provider knows
    // the actual bill. Prefer that report instead of displaying a misleading
    // zero, while retaining registry pricing for ordinary models.
    return total > 0 || reported === undefined ? total : reported;
  }
  // Negative model-rate sentinels are not costs. A positive provider report is
  // still usable when it came from a provider with better billing metadata.
  return reported !== undefined && reported > 0 ? reported : undefined;
}

function findReportedModel(
  registry: Pick<ModelRegistry, "find">,
  provider: string | undefined,
  modelId: string | undefined,
): Model<Api> | undefined {
  if (!modelId) return undefined;
  if (provider) {
    const exact = registry.find(provider, modelId);
    if (exact) return exact;
  }
  const slash = modelId.indexOf("/");
  return slash > 0 ? registry.find(modelId.slice(0, slash), modelId.slice(slash + 1)) : undefined;
}

/** Prefer a provider-reported routed model over the model requested by the session. */
export function resolveTurnCostModel(
  fallback: Model<Api> | undefined,
  registry: Pick<ModelRegistry, "find">,
  provider: string | undefined,
  modelId: string | undefined,
  responseModel: string | undefined,
): Model<Api> | undefined {
  if (responseModel && responseModel !== modelId) {
    // A different response model means the request was routed. Do not price it
    // with the requested model if the actual model is absent from the registry;
    // calculateTurnCost can then use a provider-reported cost, if available.
    return findReportedModel(registry, provider, responseModel);
  }
  return fallback ?? findReportedModel(registry, provider, modelId);
}

/** Tracks cost per request because tiered rates applied to summed usage would overcharge. */
export class TurnCostTracker {
  #registry: Pick<ModelRegistry, "find">;
  #model: Model<Api> | undefined;
  #costUsd: number | undefined;

  constructor(registry: Pick<ModelRegistry, "find">, model: Model<Api> | undefined) {
    this.#registry = registry;
    this.#model = model;
    this.#costUsd = model ? 0 : undefined;
  }

  get costUsd(): number | undefined {
    return this.#costUsd;
  }

  addTurn(turn: { provider?: string; model?: string; responseModel?: string; usage?: TurnTokenUsage }): void {
    const turnModel = resolveTurnCostModel(
      this.#model,
      this.#registry,
      turn.provider,
      turn.model,
      turn.responseModel,
    );
    if (!this.#model && turnModel) {
      this.#model = turnModel;
      this.#costUsd = 0;
    }
    if (turn.usage) {
      const turnCost = calculateTurnCost(turnModel, turn.usage);
      if (turnCost !== undefined) this.#costUsd = (this.#costUsd ?? 0) + turnCost;
    }
  }
}

function failedResult(errorMessage: string): HeadlessResult {
  return {
    finalText: "",
    allText: "",
    aborted: false,
    stopReason: "error",
    errorMessage,
    usage: emptyUsage(),
  };
}

/** Hosts too old to report project trust are treated as untrusted, never as pi's trusted default. */
export function hostProjectTrust(ctx: { isProjectTrusted?: () => boolean }): boolean {
  return ctx.isProjectTrusted?.() ?? false;
}

/**
 * Builds the resource loader with noExtensions: true — the self-recursion guard.
 * Settings, packages, and project resources are read through the caller's trust-aware manager.
 */
export function createIsolatedResourceLoader(
  cwd: string,
  agentDir: string,
  systemPrompt: string,
  settings: SettingsManager,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noContextFiles: true,
    noThemes: true,
    // Appends rather than replaces, matching --append-system-prompt's semantics.
    appendSystemPromptOverride: (base) => (systemPrompt.trim() ? [...base, systemPrompt] : base),
  });
}

/**
 * The user's global settings, plus project settings when the project is trusted,
 * with cache warming forced off.
 *
 * Warming records cache_warm usage via sessionManager.appendUsage() without
 * an assistant message_end, so the message-driven COST column cannot show
 * that spend; forcing it off here avoids rewriting the user's settings.json.
 */
export function createHeadlessSettingsManager(
  source: Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings" | "isProjectTrusted">,
): SettingsManager {
  const projectTrusted = source.isProjectTrusted();
  const manager = SettingsManager.inMemory(
    { ...source.getGlobalSettings(), cacheWarming: "off" },
    { projectTrusted },
  );
  // inMemory() seeds the global scope only. Replaying trusted project settings
  // on top reproduces the file-backed merged view while cache warming stays off.
  if (projectTrusted) manager.applyOverrides(source.getProjectSettings());
  return manager;
}

/**
 * Builds a ModelRuntime scoped to agentDir's auth.json/models.json (so normal
 * stored-credential models resolve exactly as createAgentSession's own default
 * runtime would), replaying every provider the extension host has registered
 * at runtime (bridge/extension providers registered via
 * ModelRegistry.registerProvider()) so those models carry the same auth here.
 *
 * Cached per registry — building costs two JSON reads plus a refresh(), and a
 * session's registry stays the same across the ~200 agent sessions one audit runs.
 */
export function buildRuntimeWithExtensionProviders(source: ModelRegistry, agentDir: string): Promise<ModelRuntime> {
  const cached = RUNTIMES.get(source);
  if (cached) return cached;
  const built = buildRuntime(source, agentDir);
  RUNTIMES.set(source, built);
  built.catch(() => RUNTIMES.delete(source));
  return built;
}

async function buildRuntime(source: ModelRegistry, agentDir: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  for (const providerId of source.getRegisteredProviderIds()) {
    const native = source.getRegisteredNativeProvider(providerId);
    if (native) {
      runtime.registerNativeProvider(native);
      continue;
    }
    const config = source.getRegisteredProviderConfig(providerId);
    if (config) runtime.registerProvider(providerId, config);
  }
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

export async function promptAgentSession(session: Pick<AgentSession, "prompt">, task: string, images?: ImageContent[]): Promise<void> {
  if (images && images.length > 0) await session.prompt(task, { images });
  else await session.prompt(task);
}

export interface InteractiveAgentSession {
  prompt(task: string, images?: ImageContent[]): Promise<HeadlessResult>;
  dispose(): void;
}

export type CreateInteractiveSessionOptions = Omit<HeadlessOptions, "task">;

/** The isolated createAgentSession() options for one headless audit session. */
export function buildHeadlessSessionOptions(
  opts: CreateInteractiveSessionOptions,
  agentDir: string,
  modelRuntime: ModelRuntime,
  resourceLoader: DefaultResourceLoader,
  model: Model<Api> | undefined,
  settings: SettingsManager,
): CreateAgentSessionOptions {
  return {
    cwd: opts.cwd,
    agentDir,
    modelRuntime,
    model,
    // The SDK clamps every level to model capability, including "max".
    thinkingLevel: opts.thinking,
    tools: opts.tools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(opts.cwd),
    settingsManager: createHeadlessSettingsManager(settings),
  };
}

/**
 * Creates a persistent interactive agent session.
 * The session maintains conversation history across multiple prompt() calls
 * until dispose() is called.
 */
export async function createInteractiveAgentSession(
  opts: CreateInteractiveSessionOptions,
): Promise<InteractiveAgentSession> {
  const resolvedModel = resolveModelRef(opts.model, opts.modelRegistry);
  // A virtual (router) model cannot run here: the fresh runtime built below
  // replays registered providers, never the router, so pi fails its auth
  // preflight on the router's provider with a misleading missing-key error.
  if (resolvedModel && isVirtualModelRef(resolvedModel)) {
    throw new Error(virtualModelMessage(`${resolvedModel.provider}/${resolvedModel.id}`));
  }
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(opts.cwd, agentDir, { projectTrusted: opts.projectTrusted });
  const modelRuntime = await buildRuntimeWithExtensionProviders(opts.modelRegistry, agentDir);
  const loader = createIsolatedResourceLoader(opts.cwd, agentDir, opts.systemPrompt, settings);
  await loader.reload();

  const created = await createAgentSession(
    buildHeadlessSessionOptions(opts, agentDir, modelRuntime, loader, resolvedModel, settings),
  );
  const session = created.session;
  session.setSessionName(opts.agentName);

  let disposed = false;

  return {
    async prompt(task: string, images?: ImageContent[]): Promise<HeadlessResult> {
      if (disposed) {
        return failedResult("session is disposed");
      }

      const startIndex = session.messages.length;
      const tracker = new OutputActivityTracker();
      const usage = emptyUsage();
      let activity: string | undefined;
      let toolCalls = 0;
      const cost = new TurnCostTracker(opts.modelRegistry, resolvedModel);
      let lastProgressAt = 0;
      let provider: string | undefined;
      let modelId: string | undefined;
      let stopReason: string | undefined;
      let errorMessage: string | undefined;
      let aborted = false;
      let idleTimedOut = false;

      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let lastEventAt = Date.now();
      const armIdleTimer = () => {
        if (!opts.idleTimeoutMs || opts.idleTimeoutMs <= 0) return;
        const idleTimeoutMs = opts.idleTimeoutMs;
        if (idleTimer) clearTimeout(idleTimer);
        const checkIdle = () => {
          const elapsed = Date.now() - lastEventAt;
          if (elapsed >= idleTimeoutMs) {
            idleTimedOut = true;
            session.abort();
            return;
          }
          idleTimer = setTimeout(checkIdle, idleTimeoutMs - elapsed);
        };
        idleTimer = setTimeout(checkIdle, idleTimeoutMs);
      };

      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        lastEventAt = Date.now();
        if (event.type === "message_start" && event.message.role === "assistant") {
          tracker.messageStart(event.message);
        }
        if (event.type === "message_update" && event.message.role === "assistant") {
          tracker.messageUpdate(event.assistantMessageEvent, event.message);
          const liveTotal = event.message.usage?.totalTokens;
          if (liveTotal && liveTotal > usage.contextTokens) usage.contextTokens = liveTotal;
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const msg = event.message;
          tracker.messageEnd(msg);
          usage.turns++;
          if (msg.usage) usage.contextTokens = msg.usage.totalTokens || 0;
          if (!provider && msg.provider) provider = msg.provider;
          if (!modelId && msg.model) modelId = msg.model;
          cost.addTurn(msg);
          if (msg.stopReason) stopReason = msg.stopReason;
          if (msg.errorMessage) errorMessage = msg.errorMessage;
        }
        if (event.type === "tool_execution_start") {
          toolCalls++;
          activity = formatToolActivity(event.toolName, event.args);
        }
        if (event.type === "message_end" || event.type === "tool_execution_start" || lastEventAt - lastProgressAt >= 50) {
          lastProgressAt = lastEventAt;
          const output = tracker.snapshot();
          opts.onProgress?.({
            contextTokens: usage.contextTokens,
            turns: usage.turns,
            toolCalls,
            costUsd: cost.costUsd,
            activity,
            outputTokens: output.tokens,
            outputRevision: output.revision,
            provider,
            model: modelId,
          });
        }
      });

      const abortListener = () => {
        aborted = true;
        session.abort();
      };

      if (opts.signal?.aborted) {
        aborted = true;
        unsubscribe();
      } else {
        opts.signal?.addEventListener("abort", abortListener, { once: true });
        armIdleTimer();
        try {
          await promptAgentSession(session, task, images);
        } catch (error) {
          stopReason = "error";
          errorMessage = error instanceof Error ? error.message : String(error);
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
          unsubscribe();
          opts.signal?.removeEventListener("abort", abortListener);
        }
      }

      if (idleTimedOut) {
        stopReason = "error";
        errorMessage = `killed after ${opts.idleTimeoutMs}ms with no output (hang detected)`;
      }

      const turnMessages = session.messages.slice(startIndex);
      const finalText = getFinalAssistantText(turnMessages);
      const allText = getAllAssistantText(turnMessages);
      usage.outputTokens = tracker.snapshot().tokens;

      return {
        finalText,
        allText,
        aborted,
        stopReason,
        errorMessage,
        usage,
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      session.abort();
      session.dispose();
    },
  };
}

/** Never rejects; all failures land in the returned HeadlessResult. */
export async function runAgentSession(opts: HeadlessOptions): Promise<HeadlessResult> {
  let session: InteractiveAgentSession;
  try {
    session = await createInteractiveAgentSession(opts);
  } catch (error) {
    return failedResult(error instanceof Error ? error.message : String(error));
  }

  try {
    return await session.prompt(opts.task, opts.images);
  } finally {
    session.dispose();
  }
}
