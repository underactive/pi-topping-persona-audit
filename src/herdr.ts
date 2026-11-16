/**
 * herdr activity reporting.
 *
 * herdr (https://herdr.dev) shows each pi pane as working / blocked / idle. Its
 * bundled pi extension (`herdr-agent-state.ts`) derives that from pi's
 * `agent_start` / `agent_settled` hooks, which only fire for the root session's
 * own agent loop. A persona audit runs inside a slash-command handler and does
 * all its work in subprocess pi sessions, so the root agent never starts and
 * herdr keeps showing the pane as idle for the whole run.
 *
 * The only custom event herdr's extension listens for is `herdr:blocked`, which
 * is the wrong state. So this module speaks the same socket protocol the
 * extension uses (`pane.report_agent` over `HERDR_SOCKET_PATH`) and reports
 * `working` for the life of the audit, then `idle` when it ends. Reports use
 * the same `source` / `seq` scheme as the extension so they interleave cleanly
 * with its own reports.
 *
 * Everything is best-effort: when herdr is absent this is a no-op, and a dead
 * socket is never surfaced to the user.
 */
import net from "node:net";

export type HerdrAgentState = "working" | "blocked" | "idle";

export interface HerdrEnv {
  HERDR_ENV?: string;
  HERDR_SOCKET_PATH?: string;
  HERDR_PANE_ID?: string;
}

export interface HerdrReporterOptions {
  env?: HerdrEnv;
  platform?: NodeJS.Platform;
  /** Per-attempt timeouts in ms; one attempt per entry. Mirrors herdr's own extension. */
  attemptTimeoutsMs?: number[];
  /** Absolute path of the current pi session file, when known. Lets herdr tie the state to a session. */
  sessionFile?: string;
}

export interface HerdrReporter {
  /** True when herdr env vars are present, i.e. reports will actually be sent. */
  readonly enabled: boolean;
  report(state: HerdrAgentState, message?: string): Promise<void>;
}

const SOURCE = "herdr:pi";
const DEFAULT_ATTEMPT_TIMEOUTS_MS = [500, 1500];

/** Same scheme as herdr's extension: microsecond-ish monotonic seq so both sources order by time. */
let reportSeq = Date.now() * 1000;
function nextSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

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

/**
 * Build a reporter bound to the current herdr pane. Reads `HERDR_ENV`,
 * `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` exactly like herdr's extension.
 */
export function createHerdrReporter(options: HerdrReporterOptions = {}): HerdrReporter {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeouts = options.attemptTimeoutsMs ?? DEFAULT_ATTEMPT_TIMEOUTS_MS;
  const socketPath = env.HERDR_SOCKET_PATH;
  const paneId = env.HERDR_PANE_ID;
  const enabled = env.HERDR_ENV === "1" && !!socketPath && !!paneId;
  const sessionFile =
    typeof options.sessionFile === "string" && options.sessionFile.startsWith("/") ? options.sessionFile : undefined;

  // Serialise sends so a fast working→idle pair can't arrive out of order.
  let chain: Promise<void> = Promise.resolve();

  return {
    enabled,
    report(state, message) {
      if (!enabled) return Promise.resolve();
      const endpoint = socketEndpoint(platform, socketPath!);
      const request = {
        id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        method: "pane.report_agent",
        params: {
          pane_id: paneId,
          source: SOURCE,
          agent: "pi",
          state,
          message,
          seq: nextSeq(),
          ...(sessionFile ? { agent_session_path: sessionFile } : {}),
        },
      };
      const line = `${JSON.stringify(request)}\n`;
      chain = chain.then(async () => {
        for (const timeoutMs of timeouts) {
          if (await sendOnce(endpoint, line, timeoutMs)) return;
        }
      });
      return chain;
    },
  };
}

/** Best-effort read of the session file path off an extension context. */
export function sessionFileOf(ctx: unknown): string | undefined {
  try {
    const file = (ctx as { sessionManager?: { getSessionFile?: () => unknown } })?.sessionManager?.getSessionFile?.();
    return typeof file === "string" ? file : undefined;
  } catch {
    return undefined;
  }
}
