// opencode's door binds a pane only where the session its plugin's TUI shows is the one Herdr names
// (SPEC V32), finds the pane's socket in opencode's own folder by the markers it reports (V11), refuses a
// TUI whose server did not answer before any text is written (V36), and reads the plugin's answers the
// way the seam needs them: what ran nothing refuses, anything else is uncertain (V23). The last block runs
// the bridge's door against the real plugin over a real socket.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";

import { activate, messageIdOf, type InboxItem, type OpencodeApi } from "../../opencode-plugin/collie-inbox.ts";
import type { BeaconMatcher } from "../beacon/decorate.ts";
import { parseOpencodeHello } from "../beacon/parse.ts";
import { beaconKey, inboxSocketName, opencodeInboxDir } from "../beacon/paths.ts";
import type { BeaconMarker } from "../beacon/types.ts";
import type { AgentSessionRef } from "../journal/types.ts";
import { askQueue, tryDoor, type DoorAnswer, type Preflight } from "./door.ts";
import type { InboxIo, InboxReply } from "./inbox.ts";
import { OPENCODE_DOOR, opencodeDoor } from "./opencode.ts";
import { doorsFor } from "./registry.ts";

const DIR = "/state/collie/inbox/opencode";
const SCOPE = "/run/herdr.sock";
const PANE = "w1:p1";
const SID = "ses_03969c19cffeJrZCPOT6zG8Bm7";
const REF: AgentSessionRef = { kind: "id", value: SID };
const TARGET = { session: "main", paneId: PANE, harness: "opencode" };
const SEND = { requestId: "req_door_oc_0001", text: "hello opencode" };
const never = new AbortController().signal;

const MATCHER: BeaconMatcher = {
  namespace: "herdr",
  scope: () => Promise.resolve(SCOPE),
  matches: (pane, marker, scope) => marker.pane === pane.paneId && marker.scope === scope,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};

const MARKERS: BeaconMarker[] = [{ namespace: "herdr", scope: SCOPE, pane: PANE }];
const NAME = inboxSocketName(beaconKey(MARKERS));

interface HelloFields {
  readonly agent?: string;
  readonly sessionID?: string | null;
  readonly server?: { pid: number | null } | null;
}
const helloText = (fields: HelloFields = {}): string =>
  JSON.stringify({ agent: "opencode", inbox: 1, pid: 42, sessionID: SID, server: { pid: 4242 }, markers: MARKERS, ...fields });

/** The pane's socket: its `/hello`, `/send` and `/queue` answers. */
interface FakeSocket {
  readonly hello?: InboxReply;
  readonly send?: InboxReply | "drop";
  readonly queue?: InboxReply;
}

function fakeIo(sockets: Record<string, FakeSocket>) {
  const sent: { path: string; body: string }[] = [];
  const at = (path: string): FakeSocket => sockets[path.slice(DIR.length + 1)] ?? {};
  const io: InboxIo = {
    list: () => Promise.resolve(Object.keys(sockets)),
    problem: () => Promise.resolve(null),
    request: (path, route, body) => {
      const socket = at(path);
      if (route === "/hello") return socket.hello === undefined ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve(socket.hello);
      if (route === "/queue") return Promise.resolve(socket.queue ?? { status: 404, text: "{}" });
      sent.push({ path, body: body ?? "" });
      return socket.send === "drop" || socket.send === undefined ? Promise.reject(new Error("socket closed")) : Promise.resolve(socket.send);
    },
  };
  return { io, sent };
}

const paneSocket = (hello: HelloFields = {}, send: InboxReply | "drop" = { status: 202, text: '{"state":"taken"}' }, queue?: InboxReply) => ({
  [NAME]: queue === undefined ? { hello: { status: 200, text: helloText(hello) }, send } : { hello: { status: 200, text: helloText(hello) }, send, queue },
});

function doorOn(sockets: Record<string, FakeSocket>, ref: AgentSessionRef | null = REF) {
  const fake = fakeIo(sockets);
  return { fake, door: opencodeDoor({ dir: DIR, matcher: MATCHER, sessionOf: (paneId) => (paneId === PANE ? (ref ?? undefined) : undefined), io: fake.io }) };
}

async function unbound(result: Promise<Preflight>): Promise<{ kind: "absent" | "refused"; why: string }> {
  const answer = await result;
  if (answer.ok) throw new Error("the door bound");
  return { kind: answer.absent === true ? "absent" : "refused", why: answer.why };
}

async function submitted(send: InboxReply | "drop"): Promise<Promise<DoorAnswer>> {
  const { door } = doorOn(paneSocket({}, send));
  const bound = await door.preflight(TARGET, never);
  if (!bound.ok) throw new Error(bound.why);
  return bound.door.submit(SEND, never);
}

describe("opencode's door binds by the session the TUI shows (V32)", () => {
  test("the TUI's session equal to the pane's binds, and `/send` carries that session with the text", async () => {
    const { fake, door } = doorOn(paneSocket());
    const bound = await door.preflight(TARGET, never);
    if (!bound.ok) throw new Error(bound.why);
    expect(await bound.door.submit(SEND, never)).toEqual({ kind: "taken" });
    expect(fake.sent).toEqual([{ path: `${DIR}/${NAME}`, body: JSON.stringify({ sessionID: SID, text: SEND.text, requestId: SEND.requestId }) }]);
  });

  test("another session, no session on screen, or a pane that names none refuses once the pane's own inbox is heard", async () => {
    expect(await unbound(doorOn(paneSocket({ sessionID: "ses_other" })).door.preflight(TARGET, never))).toEqual({
      kind: "refused",
      why: "opencode shows another session than the one the pane names",
    });
    expect((await unbound(doorOn(paneSocket({ sessionID: null })).door.preflight(TARGET, never))).kind).toBe("refused");
    expect((await unbound(doorOn(paneSocket(), null).door.preflight(TARGET, never))).kind).toBe("refused");
    // A path is pi's kind of ref, never an opencode session.
    expect((await unbound(doorOn(paneSocket(), { kind: "path", value: SID }).door.preflight(TARGET, never))).kind).toBe("refused");
  });

  test("a server that did not answer `/hello` refuses before any text is written (V36)", async () => {
    for (const server of [null, { pid: null }]) {
      const { fake, door } = doorOn(paneSocket({ server }));
      expect(await unbound(door.preflight(TARGET, never))).toEqual({ kind: "refused", why: "opencode's server did not answer" });
      expect(fake.sent).toEqual([]);
    }
    const { door } = doorOn(paneSocket({ server: null }));
    expect((await tryDoor(door, TARGET, SEND, 1000)).kind).toBe("refused");
  });

  test("an inbox that is not opencode's refuses", async () => {
    expect(await unbound(doorOn(paneSocket({ agent: "pi" })).door.preflight(TARGET, never))).toEqual({ kind: "refused", why: "the inbox is pi's, not opencode's" });
  });

  test("no socket, another pane's, or an unknown scope is no door: absent, not refused (V25)", async () => {
    expect(await unbound(doorOn({}).door.preflight(TARGET, never))).toEqual({ kind: "absent", why: "no opencode inbox is open" });
    const other = { ...TARGET, paneId: "w1:p2" };
    expect((await unbound(doorOn(paneSocket()).door.preflight(other, never))).kind).toBe("absent");
    const blind = opencodeDoor({ dir: DIR, matcher: { ...MATCHER, scope: () => Promise.resolve(null) }, sessionOf: () => REF, io: fakeIo(paneSocket()).io });
    expect((await unbound(blind.preflight(TARGET, never))).kind).toBe("absent");
  });
});

describe("opencode's answers", () => {
  test("taken, queued and a replay are hints", async () => {
    expect(await submitted({ status: 202, text: '{"state":"queued"}' })).toEqual({ kind: "queued" });
    expect(await submitted({ status: 202, text: '{"state":"taken","replayed":true}' })).toEqual({ kind: "replayed" });
  });

  test("what ran nothing refuses: a tagged server refusal, a moved TUI, a replay with other text (V33, V34, V36)", async () => {
    for (const status of [400, 404, 409, 413]) {
      expect(await submitted({ status, text: '{"code":"not-taken"}' })).toEqual({ kind: "refused", why: `opencode answered ${String(status)}` });
    }
  });

  test("an unsure answer, a steer nobody asked for, or a dropped socket is uncertain, never retyped (V23)", async () => {
    for (const send of [{ status: 502, text: '{"code":"unsure"}' }, { status: 500, text: "" }, { status: 202, text: '{"state":"steered"}' }, "drop"] as const) {
      await expect(submitted(send)).rejects.toThrow();
    }
    expect((await tryDoor(doorOn(paneSocket({}, { status: 502, text: '{"code":"unsure"}' })).door, TARGET, SEND, 1000)).kind).toBe("uncertain");
  });

  test("the bound inbox's `left` ids are the queue word (V35)", async () => {
    const { door } = doorOn(paneSocket({}, undefined, { status: 200, text: '{"pending":[],"left":["req_door_oc_0001"]}' }));
    expect(await askQueue(door, TARGET, 1000)).toEqual(["req_door_oc_0001"]);
    expect(await askQueue(doorOn(paneSocket({}, undefined, { status: 503, text: '{"code":"no-word"}' })).door, TARGET, 1000)).toBeNull();
  });
});

describe("parseOpencodeHello", () => {
  test("a missing or null server, or a null pid, is a server that did not answer", () => {
    expect(parseOpencodeHello(helloText())).toEqual({ agent: "opencode", sessionID: SID, serverPid: 4242, markers: MARKERS });
    expect(parseOpencodeHello(helloText({ server: null }))?.serverPid).toBeNull();
    expect(parseOpencodeHello(helloText({ server: { pid: null } }))?.serverPid).toBeNull();
    expect(parseOpencodeHello(JSON.stringify({ agent: "opencode", inbox: 1, sessionID: SID, markers: MARKERS }))?.serverPid).toBeNull();
  });

  test("the session id is read raw; a home screen is null", () => {
    expect(parseOpencodeHello(helloText({ sessionID: ` ${SID}` }))?.sessionID).toBe(` ${SID}`);
    expect(parseOpencodeHello(helloText({ sessionID: null }))?.sessionID).toBeNull();
  });

  test("another wire version, no markers, or a malformed field is no hello", () => {
    const base = { agent: "opencode", inbox: 1, sessionID: SID, server: { pid: 4242 }, markers: MARKERS };
    for (const bad of [
      { ...base, inbox: 2 },
      { ...base, markers: [] },
      { ...base, sessionID: 7 },
      { ...base, sessionID: "" },
      { ...base, server: "4242" },
      { ...base, server: { pid: -1 } },
      { ...base, server: { pid: 1.5 } },
    ]) {
      expect(parseOpencodeHello(JSON.stringify(bad))).toBeNull();
    }
  });
});

describe("the registry", () => {
  test("opencode's door is tried for the harness the multiplexer names `opencode`", () => {
    const doors = doorsFor({ opencode: { dir: DIR, matcher: MATCHER, sessionOf: () => REF } });
    expect(doors.get("opencode")?.id).toBe(OPENCODE_DOOR);
    expect(doorsFor({}).has("opencode")).toBe(false);
  });
});

describe("the bridge's door against the real plugin, over a real socket", () => {
  // A realpath'd base with no link in it (macOS's `/tmp` is one, and the door walks every part), short
  // enough for sun_path.
  const base = mkdtempSync("/private/tmp/coc-");
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const env = { HERDR_PANE_ID: PANE, HERDR_SOCKET_PATH: SCOPE, XDG_STATE_HOME: base };
  const HOME = "/home/nobody";

  /** A fake opencode TUI api with opencode's replay rule: an id it holds answers the stored item, whatever the text. */
  interface TuiState {
    route: { type: string; sessionID?: string };
    fail?: Error;
    readonly stored: Map<string, InboxItem>;
  }

  function fakeTui() {
    const s: TuiState = { route: { type: "session", sessionID: SID }, stored: new Map() };
    const prompts: { sessionID: string; id: string; text: string; delivery: string }[] = [];
    const api: OpencodeApi = {
      ui: { router: { current: () => s.route } },
      client: {
        server: { info: () => Promise.resolve({ pid: 4242 }) },
        session: {
          prompt(input) {
            if (s.fail !== undefined) return Promise.reject(s.fail);
            const held = s.stored.get(input.id);
            if (held !== undefined) return Promise.resolve(held);
            prompts.push(input);
            const item = { id: input.id, payload: { text: input.text } };
            s.stored.set(input.id, item);
            return Promise.resolve(item);
          },
          active: () => Promise.resolve({}),
          inbox: { list: () => Promise.resolve([]) },
        },
      },
    };
    return { api, state: s, prompts };
  }

  test("hello binds, the send reaches the pane's session queued under its message id, a repeat replays, and the queue word comes back", async () => {
    const tui = fakeTui();
    const inbox = activate(tui.api, env, HOME);
    await inbox?.ready;
    try {
      const door = opencodeDoor({ dir: opencodeInboxDir(env, HOME), matcher: MATCHER, sessionOf: () => REF });
      expect(await tryDoor(door, TARGET, SEND, 3000)).toEqual({ kind: "submitted", answer: { kind: "taken" } });
      // The session the door sent to is the pane's ref, the one the journal proof reads.
      expect(tui.prompts).toEqual([{ sessionID: SID, id: messageIdOf(SEND.requestId), text: SEND.text, delivery: "queue" }]);
      expect(await tryDoor(door, TARGET, SEND, 3000)).toEqual({ kind: "submitted", answer: { kind: "replayed" } });
      expect(await tryDoor(door, TARGET, { ...SEND, text: "other text" }, 3000)).toEqual({ kind: "refused", why: "opencode answered 409" });
      expect(await askQueue(door, TARGET, 3000)).toEqual([SEND.requestId]);

      // The TUI moved to another session after a hello: the door no longer binds, and nothing is sent.
      tui.state.route = { type: "session", sessionID: "ses_other" };
      expect((await tryDoor(door, TARGET, { requestId: "req_door_oc_0002", text: "x" }, 3000)).kind).toBe("refused");
      tui.state.route = { type: "session", sessionID: SID };

      // The TUI moved between the hello and the send: the plugin's own route check refuses, nothing is sent (V33).
      const bound = await door.preflight(TARGET, never);
      if (!bound.ok) throw new Error(bound.why);
      tui.state.route = { type: "session", sessionID: "ses_other" };
      expect(await bound.door.submit({ requestId: "req_door_oc_0005", text: "w" }, never)).toEqual({ kind: "refused", why: "opencode answered 409" });
      tui.state.route = { type: "session", sessionID: SID };

      // A server error with no tag may have come after the write: uncertain.
      tui.state.fail = new Error("socket hang up");
      expect((await tryDoor(door, TARGET, { requestId: "req_door_oc_0003", text: "y" }, 3000)).kind).toBe("uncertain");
      // A tagged refusal ran nothing: refused, and the screen path goes on.
      tui.state.fail = Object.assign(new Error("gone"), { _tag: "SessionNotFoundError" });
      expect(await tryDoor(door, TARGET, { requestId: "req_door_oc_0004", text: "z" }, 3000)).toEqual({ kind: "refused", why: "opencode answered 404" });
      expect(tui.prompts).toHaveLength(1);
    } finally {
      inbox?.close();
    }
  });
});
