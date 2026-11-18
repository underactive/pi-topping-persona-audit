/**
 * herdr activity reporting.
 *
 * herdr (https://herdr.dev) shows each pi pane as working / blocked / idle. Its
 * pi integration (`herdr-agent-state.ts`, from `herdr integration install pi`)
 * reports that from pi's `agent_start` / `agent_settled` hooks, which only fire
 * for the root session's own agent loop. A persona audit runs inside a
 * slash-command handler and does all its work in separate in-process agent
 * sessions, so the root agent never starts and herdr shows the pane as idle for
 * the whole run. The one custom event herdr's extension listens for,
 * `herdr:blocked`, is the wrong state.
 *
 * So this module reports to herdr's socket itself, which herdr only accepts
 * under two rules (herdr 0.9.5, `src/terminal/state.rs`):
 *
 * - The pane's session is owned by source `herdr:pi`, agent `pi`. A report from
 *   any other source is dropped while that owner holds the pane.
 * - Per source, a report whose `seq` is not above the last accepted one is
 *   acknowledged and then ignored, and so is a report without `seq` once the
 *   source has sent one.
 *
 * The reports must therefore come from `herdr:pi` and outrank the seq of
 * herdr's extension, which counts up by one from `Date.now() * 1000` taken when
 * its module loaded. A private counter started the same way is a coin toss on
 * load order: loaded first, every report is ignored and the audit shows idle;
 * loaded second, the reports land and then outrank herdr's extension, which is
 * ignored from then on. Here `seq` is the wall-clock time in microseconds at the
 * moment of sending, far above herdr's counter by the time an audit starts.
 *
 * Outranking herdr's extension mutes it for as long as its module lives, so
 * this module also does its job. From session start it follows the same hooks
 * herdr's extension follows (session start, agent start and settle,
 * `herdr:blocked`); after its first report it sends every change itself, with
 * an audit in flight as one more reason to be working. Whether it has taken
 * over is module state, for the same reason herdr's counter is: pi keeps a
 * loaded module across /new and session switches and evaluates every module
 * again on /reload, where herdr's counter restarts above this one and the pane
 * goes back to herdr's extension.
 *
 * Everything is best-effort. Outside herdr, or outside the TUI, this is a
 * no-op, and a dead socket is never surfaced to the user.
 */
import net from "node:net";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type HerdrAgentState = "working" | "blocked" | "idle";

export interface HerdrEnv {
  HERDR_ENV?: string;
  HERDR_SOCKET_PATH?: string;
  HERDR_PANE_ID?: string;
}

/** Per-process reporting state shared by every instance of this module's reporter. */
export interface HerdrSharedState {
  /** Last `seq` sent. */
  lastSeq: number;
  /** True once this process has reported, which mutes herdr's own extension. */
  tookOver: boolean;
}

export interface HerdrActivityOptions {
  env?: HerdrEnv;
  platform?: NodeJS.Platform;
  /** Per-attempt timeouts in ms; one attempt per entry. Mirrors herdr's own extension. */
  attemptTimeoutsMs?: number[];
  /** Wall clock in ms. Tests only. */
  now?: () => number;
  /** Replaces the module-level shared state. Tests only. */
  shared?: HerdrSharedState;
}

export interface HerdrActivity {
  /** True when the herdr env vars are present, i.e. reports may actually be sent. */
  readonly enabled: boolean;
  /**
   * Marks an audit as running or finished. Resolves once every queued report
   * has been delivered or given up on; callers in the extension don't wait.
   */
  setAuditActive(active: boolean): Promise<void>;
  /** Resolves once every queued report has been delivered or given up on. */
  flush(): Promise<void>;
}

export type HerdrHost = Pick<ExtensionAPI, "on" | "events">;
type HerdrContext = Pick<ExtensionContext, "mode" | "isIdle" | "sessionManager">;
type SessionRef = { agent_session_path: string } | { agent_session_id: string };

const SOURCE = "herdr:pi";
const AGENT = "pi";
const DEFAULT_ATTEMPT_TIMEOUTS_MS = [500, 1500];

const moduleShared: HerdrSharedState = { lastSeq: 0, tookOver: false };

function socketEndpoint(platform: NodeJS.Platform, socketPath: string): string {
  return platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

function sendOnce(endpoint: string, line: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(delivered);
    };
    const socket = net.createConnection(endpoint);
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(line));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

/** The session file when it is absolute, else the session id, as herdr's extension picks them. */
function sessionRefOf(ctx: HerdrContext | undefined): SessionRef | undefined {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (typeof file === "string" && (path.posix.isAbsolute(file) || path.win32.isAbsolute(file))) {
      return { agent_session_path: file };
    }
  } catch {
    // fall through to the id
  }
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0) return { agent_session_id: id };
  } catch {
    // no session reference
  }
  return undefined;
}

/**
 * Wires herdr reporting into the extension. Call once from the extension
 * factory, before the session starts: it follows the root session from
 * `session_start` on. Reads `HERDR_ENV`, `HERDR_SOCKET_PATH` and
 * `HERDR_PANE_ID` exactly like herdr's extension.
 */
export function attachHerdrActivity(pi: HerdrHost, options: HerdrActivityOptions = {}): HerdrActivity {
  const env = options.env ?? process.env;
  const socketPath = env.HERDR_SOCKET_PATH;
  const paneId = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !socketPath || !paneId) {
    return { enabled: false, setAuditActive: () => Promise.resolve(), flush: () => Promise.resolve() };
  }

  const endpoint = socketEndpoint(options.platform ?? process.platform, socketPath);
  const timeouts = options.attemptTimeoutsMs ?? DEFAULT_ATTEMPT_TIMEOUTS_MS;
  const now = options.now ?? Date.now;
  const shared = options.shared ?? moduleShared;

  const nextSeq = (): number => {
    shared.lastSeq = Math.max(shared.lastSeq + 1, Math.floor(now() * 1000));
    return shared.lastSeq;
  };
  const requestId = (kind: string) => `${SOURCE}:${kind}${Date.now()}:${Math.random().toString(36).slice(2)}`;

  // One report on the wire at a time, in seq order. A state report that has
  // not gone out yet is replaced by a newer one, as herdr asks.
  const queue: Array<{ kind: "session" | "state"; line: string }> = [];
  let draining: Promise<void> | undefined;
  const deliver = async (line: string) => {
    for (const timeoutMs of timeouts) {
      if (await sendOnce(endpoint, line, timeoutMs)) return;
    }
  };
  const enqueue = (kind: "session" | "state", request: object): Promise<void> => {
    if (kind === "state") {
      const stale = queue.findIndex((item) => item.kind === "state");
      if (stale >= 0) queue.splice(stale, 1);
    }
    queue.push({ kind, line: `${JSON.stringify(request)}\n` });
    // The queue is never empty here, so the loop awaits at least once and
    // `draining` is assigned before its `finally` clears it.
    draining ??= (async () => {
      try {
        while (queue.length > 0) await deliver(queue.shift()!.line);
      } finally {
        draining = undefined;
      }
    })();
    return draining;
  };

  let rootSession = false;
  let sessionRef: SessionRef | undefined;
  let agentActive = false;
  let auditActive = false;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: HerdrAgentState | undefined;
  let lastMessage: string | undefined;

  const desired = (): { state: HerdrAgentState; message?: string } => {
    if (blockedCount > 0) return { state: "blocked", message: blockedMessage };
    if (agentActive || auditActive) return { state: "working" };
    return { state: "idle" };
  };

  const publish = (force = false): Promise<void> => {
    if (!rootSession || !shared.tookOver) return Promise.resolve();
    const next = desired();
    if (!force && next.state === lastState && next.message === lastMessage) return draining ?? Promise.resolve();
    lastState = next.state;
    lastMessage = next.message;
    return enqueue("state", {
      id: requestId(""),
      method: "pane.report_agent",
      params: {
        pane_id: paneId,
        source: SOURCE,
        agent: AGENT,
        state: next.state,
        message: next.message,
        seq: nextSeq(),
        ...sessionRef,
      },
    });
  };

  const reportSession = (sessionStartSource?: string): Promise<void> => {
    if (!rootSession || !shared.tookOver || !sessionRef) return Promise.resolve();
    return enqueue("session", {
      id: requestId("session:"),
      method: "pane.report_agent_session",
      params: {
        pane_id: paneId,
        source: SOURCE,
        agent: AGENT,
        seq: nextSeq(),
        session_start_source: sessionStartSource,
        ...sessionRef,
      },
    });
  };

  // The same hooks and the same gates as herdr's extension. Until this process
  // has taken over they only keep the state current; publish() sends nothing.
  pi.events.on("herdr:blocked", (data) => {
    if (!rootSession) return;
    const event = data as { active?: unknown; label?: unknown } | undefined;
    if (!event?.active) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedMessage = undefined;
    } else {
      blockedCount += 1;
      blockedMessage = typeof event.label === "string" ? event.label : undefined;
    }
    void publish();
  });

  pi.on("session_start", async (event, ctx) => {
    // TUI only, like herdr's extension: the other modes have no pane to show.
    if (ctx?.mode !== "tui") return;
    rootSession = true;
    sessionRef = sessionRefOf(ctx);
    await reportSession(event?.reason);
    agentActive = ctx.isIdle?.() === false;
    void publish(true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) return;
    sessionRef = sessionRefOf(ctx);
    void reportSession();
    agentActive = true;
    void publish();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx?.isIdle?.() !== true) return;
    agentActive = false;
    void publish();
  });

  return {
    enabled: true,
    setAuditActive(active) {
      auditActive = active;
      if (!rootSession) return Promise.resolve();
      if (active && !shared.tookOver) {
        shared.tookOver = true;
        return publish(true);
      }
      return publish();
    },
    flush() {
      return draining ?? Promise.resolve();
    },
  };
}
