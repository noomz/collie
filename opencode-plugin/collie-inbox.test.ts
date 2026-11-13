import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { beaconKey, INBOX_SUBDIR as BRIDGE_INBOX_SUBDIR, OPENCODE_INBOX_SUBDIR as BRIDGE_OPENCODE_SUBDIR, opencodeInboxSocketPath } from "../bridge/beacon/paths.ts";
import { INBOX_VERSION as BRIDGE_INBOX_VERSION } from "../bridge/beacon/types.ts";
import { readEnvMarkers } from "../cli/beacon.ts";
import { parseJsonObject, type JsonObject } from "../web/src/lib/json.ts";
import { REQUEST_ID as PHONE_REQUEST_ID } from "../web/src/lib/surface/send.ts";
import {
  activate,
  INBOX_SUBDIR,
  INBOX_VERSION,
  KEEP_REQUEST_IDS,
  MAX_BODY_BYTES,
  markersOf,
  messageIdOf,
  OPENCODE_INBOX_SUBDIR,
  paneKey,
  REQUEST_ID,
  SERVER_INFO_MS,
  socketPathOf,
  type InboxItem,
  type OpencodeApi,
} from "./collie-inbox.ts";

// The opencode inbox driven by a fake TUI api: no opencode process. The fake server keeps opencode's
// replay rule (an id it holds answers the stored item, whatever the text, T29 L2b) and its inbox.

const TMUX_ENV = { TMUX_PANE: "%98", TMUX: "/tmp/tmux-501/default,123,0" };
const SID = "ses_one";

// A literal /tmp: macOS's tmpdir is long enough to push a socket path past sun_path.
const temps: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync("/tmp/collie-oc-");
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An error the way opencode's client throws one: an `Error` carrying `_tag`. */
function tagged(tag: string, message = tag): Error {
  return Object.assign(new Error(message), { _tag: tag });
}

interface FakeState {
  route: { type: string; sessionID?: string } | undefined;
  running: boolean;
  serverPid: number | "hang";
  fail?: Error;
  listFails?: boolean;
  /** The server's stored items by id, and which of them still wait in the inbox. */
  stored: Map<string, InboxItem>;
  inbox: Set<string>;
}

function fakeOpencode(state: Partial<FakeState> = {}) {
  const s: FakeState = { route: { type: "session", sessionID: SID }, running: false, serverPid: 4242, stored: new Map(), inbox: new Set(), ...state };
  const prompts: { sessionID: string; id: string; text: string; delivery: string }[] = [];
  const api: OpencodeApi = {
    ui: { router: { current: () => s.route } },
    client: {
      server: { info: () => (s.serverPid === "hang" ? new Promise(() => {}) : Promise.resolve({ pid: s.serverPid })) },
      session: {
        prompt(input) {
          if (s.fail !== undefined) return Promise.reject(s.fail);
          const held = s.stored.get(input.id);
          if (held !== undefined) return Promise.resolve(held);
          prompts.push(input);
          const item = { id: input.id, payload: { text: input.text } };
          s.stored.set(input.id, item);
          if (s.running) s.inbox.add(input.id);
          return Promise.resolve(item);
        },
        active: () => Promise.resolve(s.running ? { [SID]: { type: "running" } } : {}),
        inbox: {
          list: () => (s.listFails === true ? Promise.reject(new Error("down")) : Promise.resolve([...s.inbox].map((id) => ({ id })))),
        },
      },
    },
  };
  return { api, state: s, prompts };
}

async function call(sock: string, method: string, url: string, body?: string): Promise<[number, JsonObject | undefined]> {
  const res = await fetch(`http://inbox${url}`, { unix: sock, method, body });
  return [res.status, parseJsonObject(await res.text())];
}

const send = (sock: string, body: JsonObject) => call(sock, "POST", "/send", JSON.stringify(body));
const plain = (text: string, requestId: string, extra: JsonObject = {}): JsonObject => ({ text, requestId, sessionID: SID, ...extra });

/** An inbox opened in a fresh state dir, in a tmux pane. */
async function opened(state: Partial<FakeState> = {}) {
  const dir = stateDir();
  const env = { ...TMUX_ENV, XDG_STATE_HOME: dir };
  const fake = fakeOpencode(state);
  const inbox = activate(fake.api, env, "/home/nobody");
  expect(inbox).toBeDefined();
  await inbox?.ready;
  const sock = socketPathOf(env, "/home/nobody")!;
  return { ...fake, env, dir, sock, close: () => inbox?.close() };
}

describe("the socket's name is the bridge's", () => {
  const envs = {
    tmux: TMUX_ENV,
    herdr: { HERDR_PANE_ID: "w5:p2", HERDR_SOCKET_PATH: "/run/herdr.sock" },
    "herdr-core": { HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/run/hc.sock" },
    zellij: { ZELLIJ_PANE_ID: "3", ZELLIJ_SESSION_NAME: "work" },
    tern: { TERN_PANE: "4", TERN_PANE_SOCKET: "/run/tern.sock" },
    nested: { ...TMUX_ENV, ZELLIJ_PANE_ID: "3", ZELLIJ_SESSION_NAME: "work" },
  };
  for (const [name, env] of Object.entries(envs)) {
    test(`${name}: the markers, the key and the path match the beacon's and the bridge's`, () => {
      const withState = { ...env, XDG_STATE_HOME: "/tmp/s" };
      expect(markersOf(withState)).toEqual(readEnvMarkers(withState));
      expect(paneKey(markersOf(withState))).toBe(beaconKey(readEnvMarkers(withState)));
      expect(socketPathOf(withState, "/home/x")).toBe(opencodeInboxSocketPath(beaconKey(readEnvMarkers(withState)), withState, "/home/x"));
      expect(socketPathOf(env, "/home/x")).toBe(opencodeInboxSocketPath(beaconKey(readEnvMarkers(env)), env, "/home/x"));
    });
  }

  test("the folders, the wire version and the request-id rule are Collie's", () => {
    expect(INBOX_SUBDIR).toBe(BRIDGE_INBOX_SUBDIR);
    expect(OPENCODE_INBOX_SUBDIR).toBe(BRIDGE_OPENCODE_SUBDIR);
    expect(INBOX_VERSION).toBe(BRIDGE_INBOX_VERSION);
    expect(REQUEST_ID.source).toBe(PHONE_REQUEST_ID.source);
  });

  test("outside a multiplexer, or past sun_path, there is no socket", () => {
    expect(socketPathOf({}, "/home/x")).toBeUndefined();
    expect(socketPathOf({ ...TMUX_ENV, XDG_STATE_HOME: `/tmp/${"d".repeat(80)}` }, "/home/x")).toBeUndefined();
    expect(activate(fakeOpencode().api, {}, "/home/x")).toBeUndefined();
  });

  test("a request id maps to one msg_collie id, the same every time", () => {
    expect(messageIdOf("req-00001")).toMatch(/^msg_collie[0-9a-f]{32}$/u);
    expect(messageIdOf("req-00001")).toBe(messageIdOf("req-00001"));
    expect(messageIdOf("req-00002")).not.toBe(messageIdOf("req-00001"));
  });
});

describe("opening and closing", () => {
  test("the socket is 0600 in a 0700 folder of opencode's own", async () => {
    const { sock, close } = await opened();
    expect(lstatSync(sock).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(sock, "..")).mode & 0o777).toBe(0o700);
    expect(join(sock, "..").endsWith(join(INBOX_SUBDIR, OPENCODE_INBOX_SUBDIR))).toBe(true);
    close();
    expect(existsSync(sock)).toBe(false);
  });

  test("a folder that is a link opens nothing", async () => {
    const dir = stateDir();
    const elsewhere = stateDir();
    mkdirSync(join(dir, "collie", INBOX_SUBDIR), { recursive: true });
    symlinkSync(elsewhere, join(dir, "collie", INBOX_SUBDIR, OPENCODE_INBOX_SUBDIR));
    const env = { ...TMUX_ENV, XDG_STATE_HOME: dir };
    await activate(fakeOpencode().api, env, "/home/x")?.ready;
    expect(existsSync(socketPathOf(env, "/home/x")!)).toBe(false);
  });

  test("an older TUI closing never removes a newer one's socket", async () => {
    const first = await opened();
    const second = fakeOpencode({ route: { type: "session", sessionID: "ses_two" } });
    const newer = activate(second.api, first.env, "/home/nobody");
    await newer?.ready;
    first.close();
    expect(existsSync(first.sock)).toBe(true);
    expect((await call(first.sock, "GET", "/hello"))[1]?.sessionID).toBe("ses_two");
    newer?.close();
    expect(existsSync(first.sock)).toBe(false);
  });
});

describe("/hello", () => {
  test("names opencode, the session the TUI shows, the pids and the raw markers", async () => {
    const { sock, env, state, close } = await opened();
    const [status, body] = await call(sock, "GET", "/hello");
    expect(status).toBe(200);
    expect(body).toMatchObject({ agent: "opencode", inbox: 1, pid: process.pid, sessionID: SID, server: { pid: 4242 } });
    expect(body?.markers).toEqual(markersOf(env));
    state.route = { type: "home" };
    expect((await call(sock, "GET", "/hello"))[1]?.sessionID).toBeNull();
    close();
  });

  test("a server that does not answer gives a null pid, never a hung hello", async () => {
    const { sock, close } = await opened({ serverPid: "hang" });
    const started = Date.now();
    const [status, body] = await call(sock, "GET", "/hello");
    expect(status).toBe(200);
    expect(body?.server).toEqual({ pid: null });
    expect(Date.now() - started).toBeLessThan(SERVER_INFO_MS + 500);
    close();
  });
});

describe("/send", () => {
  test("idle: taken, sent once as a queued turn under its msg_collie id", async () => {
    const { sock, prompts, close } = await opened();
    expect(await send(sock, plain("phone one", "req-00001"))).toEqual([202, { state: "taken" }]);
    expect(prompts).toEqual([{ sessionID: SID, id: messageIdOf("req-00001"), text: "phone one", delivery: "queue" }]);
    close();
  });

  test("busy: queued as its own turn; steer only when asked", async () => {
    const { sock, prompts, close } = await opened({ running: true });
    expect(await send(sock, plain("two", "req-00002"))).toEqual([202, { state: "queued" }]);
    expect(await send(sock, plain("three", "req-00003", { steer: true }))).toEqual([202, { state: "steered" }]);
    expect(prompts.map((p) => p.delivery)).toEqual(["queue", "steer"]);
    close();
  });

  test("text is sent as written: lines and a trailing newline kept", async () => {
    const { sock, prompts, close } = await opened();
    expect((await send(sock, plain("one\ntwo\n", "req-00004")))[0]).toBe(202);
    expect(prompts[0]?.text).toBe("one\ntwo\n");
    close();
  });

  test("a TUI that moved to another session, or to its home screen, sends nothing", async () => {
    const { sock, state, prompts, close } = await opened();
    state.route = { type: "session", sessionID: "ses_other" };
    expect(await send(sock, plain("x", "req-00005"))).toEqual([409, { code: "moved", sessionID: "ses_other" }]);
    state.route = { type: "home" };
    expect(await send(sock, plain("x", "req-00005"))).toEqual([409, { code: "moved", sessionID: null }]);
    expect(prompts).toEqual([]);
    close();
  });

  test("the same id and text is replayed and runs nothing", async () => {
    const { sock, prompts, close } = await opened();
    await send(sock, plain("once", "req-00006"));
    expect(await send(sock, plain("once", "req-00006"))).toEqual([202, { state: "taken", replayed: true }]);
    expect(prompts).toHaveLength(1);
    close();
  });

  test("the same id with other text refuses, whether this TUI remembers the id or only the server does", async () => {
    const { sock, prompts, state, close } = await opened();
    await send(sock, plain("first", "req-00007"));
    expect(await send(sock, plain("second", "req-00007"))).toEqual([409, { code: "replay-mismatch" }]);
    // A restarted TUI: the server still holds the id with its old text.
    state.stored.set(messageIdOf("req-00008"), { id: messageIdOf("req-00008"), payload: { text: "old" } });
    expect(await send(sock, plain("new", "req-00008"))).toEqual([409, { code: "replay-mismatch" }]);
    expect(prompts.map((p) => p.text)).toEqual(["first"]);
    close();
  });

  test("the server's own refusals refuse; any other error is unsure", async () => {
    const cases: [Error, number, string][] = [
      [tagged("SessionNotFoundError"), 404, "no-session"],
      [tagged("InvalidRequestError"), 400, "bad-request"],
      [tagged("ConflictError"), 409, "not-taken"],
      [tagged("RequestError", "socket closed"), 502, "unsure"],
      [tagged("ResponseError"), 502, "unsure"],
      [new Error("timeout"), 502, "unsure"],
    ];
    const { sock, state, close } = await opened();
    for (const [index, [err, status, code]] of cases.entries()) {
      state.fail = err;
      const [got, body] = await send(sock, plain("x", `req-err-${index}0`));
      expect([got, body?.code]).toEqual([status, code]);
    }
    // A refused or unsure send is not remembered: the same id may come again.
    state.fail = undefined;
    expect((await send(sock, plain("x", "req-err-00")))[0]).toBe(202);
    close();
  });

  test("a bad body, an unknown route or too large a body runs nothing", async () => {
    const { sock, prompts, close } = await opened();
    for (const body of ["nope", "[]", JSON.stringify({ text: "x", requestId: "req-00009" }), JSON.stringify(plain("", "req-00009")), JSON.stringify(plain("x", "bad id")), JSON.stringify(plain("x", "req-00009", { steer: "yes" }))]) {
      expect(await call(sock, "POST", "/send", body)).toEqual([400, { code: "bad-request" }]);
    }
    expect(await call(sock, "POST", "/send", "x".repeat(MAX_BODY_BYTES + 1))).toEqual([413, { code: "too-large" }]);
    expect(await call(sock, "GET", "/send")).toEqual([404, { code: "not-found" }]);
    expect(prompts).toEqual([]);
    close();
  });

  test(`keeps the last ${KEEP_REQUEST_IDS} ids`, async () => {
    const { sock, state, prompts, close } = await opened();
    for (let index = 0; index <= KEEP_REQUEST_IDS; index += 1) await send(sock, plain("x", `req-keep-${index}`));
    // The oldest is forgotten here; the server's replay still holds it.
    state.stored.clear();
    await send(sock, plain("x", "req-keep-0"));
    expect(prompts).toHaveLength(KEEP_REQUEST_IDS + 2);
    close();
  });
});

describe("/queue", () => {
  test("pending while in the inbox or while the session runs; left once both say so, and it stays left", async () => {
    const { sock, state, close } = await opened({ running: true });
    await send(sock, plain("wait", "req-q0001"));
    expect(await call(sock, "GET", "/queue")).toEqual([200, { pending: ["req-q0001"], left: [] }]);
    // The turn ahead ended and this one started: out of the inbox, still running.
    state.inbox.clear();
    expect(await call(sock, "GET", "/queue")).toEqual([200, { pending: ["req-q0001"], left: [] }]);
    state.running = false;
    expect(await call(sock, "GET", "/queue")).toEqual([200, { pending: [], left: ["req-q0001"] }]);
    state.running = true;
    expect(await call(sock, "GET", "/queue")).toEqual([200, { pending: [], left: ["req-q0001"] }]);
    close();
  });

  test("an item left in the inbox after the turn stops stays pending (Escape, T29 L5)", async () => {
    const { sock, state, close } = await opened({ running: true });
    await send(sock, plain("stuck", "req-q0002"));
    state.running = false;
    expect(await call(sock, "GET", "/queue")).toEqual([200, { pending: ["req-q0002"], left: [] }]);
    close();
  });

  test("a server that does not answer gives no word", async () => {
    const { sock, state, close } = await opened({ running: true });
    await send(sock, plain("wait", "req-q0003"));
    state.listFails = true;
    expect(await call(sock, "GET", "/queue")).toEqual([503, { code: "no-word" }]);
    close();
  });

  test("nothing sent: an empty answer", async () => {
    const { sock, close } = await opened();
    expect(await call(sock, "GET", "/queue")).toEqual([200, { pending: [], left: [] }]);
    close();
  });
});
