import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHerdrReporter, sessionFileOf } from "../src/herdr.ts";

type Request = { id: string; method: string; params: Record<string, unknown> };

/** A stand-in for herdr's socket: records each JSON line and acks it. */
async function fakeHerdr(t: { after(fn: () => Promise<void> | void): void }, ack = true) {
  const dir = await mkdtemp(path.join(tmpdir(), "pa-herdr-"));
  const socketPath = path.join(dir, "herdr.sock");
  const received: Request[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        received.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
        if (ack) socket.write('{"ok":true}\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { socketPath, received };
}

test("reports working then idle to herdr's socket with the extension's wire shape", async (t) => {
  const { socketPath, received } = await fakeHerdr(t);
  const reporter = createHerdrReporter({
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "pane-7" },
    sessionFile: "/tmp/sessions/abc.jsonl",
  });
  assert.equal(reporter.enabled, true);

  await reporter.report("working");
  await reporter.report("idle");

  assert.equal(received.length, 2);
  assert.deepEqual(
    received.map((r) => r.params.state),
    ["working", "idle"],
  );
  for (const request of received) {
    assert.equal(request.method, "pane.report_agent");
    assert.match(request.id, /^herdr:pi:/);
    assert.equal(request.params.pane_id, "pane-7");
    assert.equal(request.params.source, "herdr:pi");
    assert.equal(request.params.agent, "pi");
    assert.equal(request.params.agent_session_path, "/tmp/sessions/abc.jsonl");
    assert.equal(typeof request.params.seq, "number");
  }
  const [first, second] = received;
  assert.ok(first && second && (second.params.seq as number) > (first.params.seq as number), "seq must increase");
});

test("relative session paths are dropped, matching herdr's extension", async (t) => {
  const { socketPath, received } = await fakeHerdr(t);
  const reporter = createHerdrReporter({
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "p" },
    sessionFile: "relative/session.jsonl",
  });
  await reporter.report("working");
  assert.equal("agent_session_path" in received[0]!.params, false);
});

test("is a no-op outside herdr", async () => {
  for (const env of [
    {},
    { HERDR_ENV: "1" },
    { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/nonexistent.sock" },
    { HERDR_ENV: "0", HERDR_SOCKET_PATH: "/nonexistent.sock", HERDR_PANE_ID: "p" },
  ]) {
    const reporter = createHerdrReporter({ env });
    assert.equal(reporter.enabled, false);
    await reporter.report("working"); // must resolve without touching the socket
  }
});

test("a dead socket resolves quietly after the retry budget", async () => {
  const reporter = createHerdrReporter({
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/nonexistent/herdr.sock", HERDR_PANE_ID: "p" },
    attemptTimeoutsMs: [50, 50],
  });
  const started = Date.now();
  await reporter.report("working");
  assert.ok(Date.now() - started < 2000);
});

test("sessionFileOf tolerates contexts without a session manager", () => {
  assert.equal(sessionFileOf(undefined), undefined);
  assert.equal(sessionFileOf({}), undefined);
  assert.equal(sessionFileOf({ sessionManager: { getSessionFile: () => "/s.jsonl" } }), "/s.jsonl");
  assert.equal(
    sessionFileOf({
      sessionManager: {
        getSessionFile: () => {
          throw new Error("boom");
        },
      },
    }),
    undefined,
  );
});
