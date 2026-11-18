import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  attachHerdrActivity,
  type HerdrActivity,
  type HerdrEnv,
  type HerdrHost,
  type HerdrSharedState,
} from "../src/herdr.ts";

type Params = Record<string, unknown> & { source: string; seq?: number };
type Request = { id: string; method: string; params: Params };
type Received = Request & { from: "persona-audit" | "herdr-extension"; accepted: boolean };

/**
 * herdr's pane, reduced to the rules that decide whether a report counts
 * (herdr 0.9.5, src/terminal/state.rs): the source that owns the pane's
 * session is the only one heard, and per source a report counts only if its
 * seq is above the last one that counted (no seq counts only before the first).
 * Every report is acknowledged either way, as herdr does.
 */
class FakePane {
  state: string | undefined;
  message: string | undefined;
  sessionRef: unknown;
  owner: string | undefined;
  readonly received: Received[] = [];
  private readonly lastSeq = new Map<string, number>();

  apply(request: Request, from: Received["from"]): void {
    const { source, seq } = request.params;
    const last = this.lastSeq.get(source);
    const newer = seq === undefined ? last === undefined : last === undefined || seq > last;
    const accepted = newer && (this.owner === undefined || this.owner === source);
    this.received.push({ ...request, from, accepted });
    if (!accepted) return;
    if (seq !== undefined) this.lastSeq.set(source, seq);
    this.owner = source;
    const ref = request.params.agent_session_path ?? request.params.agent_session_id;
    if (ref !== undefined) this.sessionRef = ref;
    if (request.method === "pane.report_agent") {
      this.state = request.params.state as string;
      this.message = request.params.message as string | undefined;
    }
  }

  from(who: Received["from"]): Received[] {
    return this.received.filter((r) => r.from === who);
  }
}

/** herdr's socket in front of a FakePane. */
async function fakeHerdr(t: { after(fn: () => Promise<void> | void): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "pa-herdr-"));
  const socketPath = path.join(dir, "herdr.sock");
  const pane = new FakePane();
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        pane.apply(JSON.parse(buffer.slice(0, newline)) as Request, "persona-audit");
        buffer = buffer.slice(newline + 1);
        socket.write('{"ok":true}\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const env: HerdrEnv = { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p1" };
  return { pane, env };
}

type Handler = (event: unknown, ctx: unknown) => unknown;

/** The slice of pi's extension API the reporter uses, with a way to fire its hooks. */
function fakePi() {
  const hooks = new Map<string, Handler[]>();
  const channels = new Map<string, Array<(data: unknown) => void>>();
  const host = {
    on(event: string, handler: Handler) {
      hooks.set(event, [...(hooks.get(event) ?? []), handler]);
      return () => {};
    },
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        channels.set(channel, [...(channels.get(channel) ?? []), handler]);
        return () => {};
      },
      emit(channel: string, data: unknown) {
        for (const handler of channels.get(channel) ?? []) handler(data);
      },
    },
  };
  return {
    host: host as unknown as HerdrHost,
    hooks,
    async fire(event: string, payload: unknown, ctx: unknown) {
      for (const handler of hooks.get(event) ?? []) await handler(payload, ctx);
    },
    emit: host.events.emit,
  };
}

function tuiContext(options: { idle?: () => boolean; file?: string; id?: string; mode?: string } = {}) {
  return {
    mode: options.mode ?? "tui",
    isIdle: options.idle ?? (() => true),
    sessionManager: {
      getSessionFile: () => options.file ?? "/tmp/sessions/a.jsonl",
      getSessionId: () => options.id ?? "a",
    },
  };
}

/**
 * Stand-in for herdr's own pi extension (integration v9): the same hooks and,
 * what matters here, the same seq: one up from `Date.now() * 1000` taken when
 * the module loads. Reports go straight to the pane.
 */
function herdrExtension(pi: ReturnType<typeof fakePi>, pane: FakePane, now: () => number) {
  let seq = now() * 1000;
  let root = false;
  let active = false;
  let blocked = 0;
  let label: string | undefined;
  let last: string | undefined;
  let ref: Record<string, string> = {};
  const send = (method: string, params: Record<string, unknown>) =>
    pane.apply(
      { id: `herdr:pi:${seq}`, method, params: { pane_id: "w1:p1", source: "herdr:pi", agent: "pi", seq: ++seq, ...params, ...ref } },
      "herdr-extension",
    );
  const publish = (force = false) => {
    const state = blocked > 0 ? "blocked" : active ? "working" : "idle";
    if (!force && state === last) return;
    last = state;
    send("pane.report_agent", { state, ...(blocked > 0 ? { message: label } : {}) });
  };
  const readRef = (ctx: ReturnType<typeof tuiContext>) => {
    ref = { agent_session_path: ctx.sessionManager.getSessionFile() };
  };
  pi.hooks.set("session_start", [
    ...(pi.hooks.get("session_start") ?? []),
    (event, ctx) => {
      const c = ctx as ReturnType<typeof tuiContext>;
      if (c.mode !== "tui") return;
      root = true;
      readRef(c);
      send("pane.report_agent_session", { session_start_source: (event as { reason?: string }).reason });
      active = c.isIdle() === false;
      publish(true);
    },
  ]);
  pi.hooks.set("agent_start", [
    ...(pi.hooks.get("agent_start") ?? []),
    (_event, ctx) => {
      if (!root) return;
      readRef(ctx as ReturnType<typeof tuiContext>);
      send("pane.report_agent_session", {});
      active = true;
      publish();
    },
  ]);
  pi.hooks.set("agent_settled", [
    ...(pi.hooks.get("agent_settled") ?? []),
    (_event, ctx) => {
      if (!root || (ctx as ReturnType<typeof tuiContext>).isIdle() !== true) return;
      active = false;
      publish();
    },
  ]);
  pi.host.events.on("herdr:blocked", (data) => {
    if (!root) return;
    const event = data as { active?: boolean; label?: string };
    if (event.active) {
      blocked += 1;
      label = event.label;
    } else {
      blocked = Math.max(0, blocked - 1);
    }
    publish();
  });
}

const freshShared = (): HerdrSharedState => ({ lastSeq: 0, tookOver: false });

/** Lets queued reports reach the fake socket. */
function settle(activity: HerdrActivity): Promise<void> {
  return activity.flush();
}

for (const order of ["herdr's extension loads first", "persona-audit loads first"] as const) {
  test(`an audit shows as working in herdr when ${order}, and later agent turns still report`, async (t) => {
    const { pane, env } = await fakeHerdr(t);
    let clock = 1_763_500_000_000;
    const now = () => clock;
    const pi = fakePi();
    let activity!: HerdrActivity;
    const attachOurs = () => {
      activity = attachHerdrActivity(pi.host, { env, now, shared: freshShared() });
    };
    if (order === "persona-audit loads first") {
      attachOurs();
      clock += 40; // loading takes a while; herdr's counter starts later and higher
      herdrExtension(pi, pane, now);
    } else {
      herdrExtension(pi, pane, now);
      clock += 40;
      attachOurs();
    }

    const ctx = tuiContext();
    await pi.fire("session_start", { reason: "startup" }, ctx);
    assert.equal(pane.state, "idle");
    assert.equal(pane.from("persona-audit").length, 0, "nothing of ours goes out before an audit");

    clock += 30_000;
    await activity.setAuditActive(true);
    assert.equal(pane.state, "working", "the audit must show as working");

    clock += 60_000;
    await activity.setAuditActive(false);
    assert.equal(pane.state, "idle");

    // herdr's extension is outranked from here on; the root agent's own turns
    // must still come through.
    clock += 5_000;
    let idle = false;
    const turnCtx = tuiContext({ idle: () => idle });
    await pi.fire("agent_start", {}, turnCtx);
    await settle(activity);
    assert.equal(pane.state, "working", "a later agent turn must show as working");
    idle = true;
    clock += 5_000;
    await pi.fire("agent_settled", {}, turnCtx);
    await settle(activity);
    assert.equal(pane.state, "idle");
    assert.equal(pane.owner, "herdr:pi");
  });
}

test("reports nothing while no audit has run, leaving the pane to herdr's extension", async (t) => {
  const { pane, env } = await fakeHerdr(t);
  const pi = fakePi();
  const activity = attachHerdrActivity(pi.host, { env, shared: freshShared() });
  let idle = true;
  const ctx = tuiContext({ idle: () => idle });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  idle = false;
  await pi.fire("agent_start", {}, ctx);
  pi.emit("herdr:blocked", { active: true, label: "Approve?" });
  pi.emit("herdr:blocked", { active: false });
  idle = true;
  await pi.fire("agent_settled", {}, ctx);
  await activity.setAuditActive(false);
  assert.equal(pane.received.length, 0);
});

test("a prompt that blocks mid-audit shows as blocked, then working again", async (t) => {
  const { pane, env } = await fakeHerdr(t);
  const pi = fakePi();
  const activity = attachHerdrActivity(pi.host, { env, shared: freshShared() });
  await pi.fire("session_start", { reason: "startup" }, tuiContext());
  await activity.setAuditActive(true);
  pi.emit("herdr:blocked", { active: true, label: "Approve the fix?" });
  await settle(activity);
  assert.equal(pane.state, "blocked");
  assert.equal(pane.message, "Approve the fix?");
  pi.emit("herdr:blocked", { active: false });
  await settle(activity);
  assert.equal(pane.state, "working");
  assert.equal(pane.message, undefined);
});

test("after taking over, a new session is reported before its state, with the start reason", async (t) => {
  const { pane, env } = await fakeHerdr(t);
  const pi = fakePi();
  const activity = attachHerdrActivity(pi.host, { env, shared: freshShared() });
  await pi.fire("session_start", { reason: "startup" }, tuiContext());
  await activity.setAuditActive(true);
  await activity.setAuditActive(false);
  const before = pane.received.length;

  await pi.fire("session_start", { reason: "new" }, tuiContext({ file: "/tmp/sessions/b.jsonl" }));
  await settle(activity);
  const after = pane.received.slice(before);
  assert.deepEqual(
    after.map((r) => r.method),
    ["pane.report_agent_session", "pane.report_agent"],
  );
  assert.equal(after[0]!.params.session_start_source, "new");
  assert.equal(after[0]!.params.agent_session_path, "/tmp/sessions/b.jsonl");
  assert.ok(after.every((r) => r.accepted));
  assert.equal(pane.sessionRef, "/tmp/sessions/b.jsonl");
});

test("the takeover outlives a reporter instance, as herdr's counter does", async (t) => {
  const { pane, env } = await fakeHerdr(t);
  const shared = freshShared();
  const first = fakePi();
  const activity = attachHerdrActivity(first.host, { env, shared });
  await first.fire("session_start", { reason: "startup" }, tuiContext());
  await activity.setAuditActive(true);
  await activity.setAuditActive(false);

  // /new re-runs the extension factory against the same loaded module.
  const second = fakePi();
  const next = attachHerdrActivity(second.host, { env, shared });
  let idle = false;
  const ctx = tuiContext({ idle: () => idle });
  await second.fire("session_start", { reason: "new" }, ctx);
  await settle(next);
  assert.equal(pane.state, "working", "the new session is mid-turn");
  idle = true;
  await second.fire("agent_settled", {}, ctx);
  await settle(next);
  assert.equal(pane.state, "idle");
});

test("wire shape matches herdr's extension, with seq from the wall clock in microseconds", async (t) => {
  const { pane, env } = await fakeHerdr(t);
  const pi = fakePi();
  const startedAt = Date.now();
  const activity = attachHerdrActivity(pi.host, { env, shared: freshShared() });
  await pi.fire("session_start", { reason: "startup" }, tuiContext());
  await activity.setAuditActive(true);
  await activity.setAuditActive(false);

  const ours = pane.from("persona-audit");
  assert.deepEqual(
    ours.map((r) => r.params.state),
    ["working", "idle"],
  );
  for (const request of ours) {
    assert.equal(request.method, "pane.report_agent");
    assert.match(request.id, /^herdr:pi:/);
    assert.equal(request.params.pane_id, "w1:p1");
    assert.equal(request.params.source, "herdr:pi");
    assert.equal(request.params.agent, "pi");
    assert.equal(request.params.agent_session_path, "/tmp/sessions/a.jsonl");
    assert.ok((request.params.seq as number) >= startedAt * 1000, "seq is wall-clock microseconds");
    assert.ok(Number.isSafeInteger(request.params.seq));
  }
  assert.ok((ours[1]!.params.seq as number) > (ours[0]!.params.seq as number), "seq must increase");
});

test("the session file is used when absolute, else the session id", async (t) => {
  for (const [file, expected] of [
    ["C:\\Users\\me\\sessions\\a.jsonl", { agent_session_path: "C:\\Users\\me\\sessions\\a.jsonl" }],
    ["relative/a.jsonl", { agent_session_id: "a" }],
  ] as const) {
    const { pane, env } = await fakeHerdr(t);
    const pi = fakePi();
    const activity = attachHerdrActivity(pi.host, { env, shared: freshShared() });
    await pi.fire("session_start", { reason: "startup" }, tuiContext({ file }));
    await activity.setAuditActive(true);
    const [report] = pane.received;
    assert.ok(report);
    for (const [key, value] of Object.entries(expected)) assert.equal(report.params[key], value);
    assert.equal(
      "agent_session_path" in expected ? "agent_session_id" in report.params : "agent_session_path" in report.params,
      false,
    );
  }
});

test("stays out of sessions that are not the TUI", async (t) => {
  const { pane, env } = await fakeHerdr(t);
  const pi = fakePi();
  const activity = attachHerdrActivity(pi.host, { env, shared: freshShared() });
  await pi.fire("session_start", { reason: "startup" }, tuiContext({ mode: "rpc" }));
  await activity.setAuditActive(true);
  await activity.setAuditActive(false);
  assert.equal(pane.received.length, 0);
});

test("is a no-op outside herdr", async () => {
  for (const env of [
    {},
    { HERDR_ENV: "1" },
    { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/nonexistent.sock" },
    { HERDR_ENV: "0", HERDR_SOCKET_PATH: "/nonexistent.sock", HERDR_PANE_ID: "p" },
  ]) {
    const pi = fakePi();
    const activity = attachHerdrActivity(pi.host, { env, shared: freshShared() });
    assert.equal(activity.enabled, false);
    assert.equal(pi.hooks.size, 0, "no hooks outside herdr");
    await activity.setAuditActive(true); // must resolve without touching a socket
  }
});

test("a dead socket resolves quietly after the retry budget", async () => {
  const pi = fakePi();
  const activity = attachHerdrActivity(pi.host, {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/nonexistent/herdr.sock", HERDR_PANE_ID: "p" },
    attemptTimeoutsMs: [50, 50],
    shared: freshShared(),
  });
  await pi.fire("session_start", { reason: "startup" }, tuiContext());
  const started = Date.now();
  await activity.setAuditActive(true);
  assert.ok(Date.now() - started < 2000);
});
