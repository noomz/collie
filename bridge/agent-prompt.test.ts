// `collie agent prompt` on the bridge's side (SPEC V38, V39): the same Send route the phone uses, with
// the agent's door first, and an answer read from the journal's proof, never from the door's reply.
// The rig is protocol.door.test.ts's: Claude Code 2.1.310's captured running turn and a fake door.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit.ts";
import { answerAgentPrompt, PROMPT_NO_PANE, type AgentPromptAnswer } from "./agent-prompt.ts";
import { doorRegistry, type Door, type DoorAnswer, type DoorSend, type Preflight } from "./door/door.ts";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "./mux/types.ts";
import type { SendReceipt, SendReceiptRow } from "../web/src/lib/surface/send.ts";
import { profileFor } from "../web/src/lib/surface/profile.ts";
import { sendRoute, type SendRouteRuntime } from "./server.ts";
import type { AgentStatus } from "./types.ts";
import { KeyGate } from "./surface/key-gate.ts";
import { RowRing, SendProtocol, SessionLocks } from "./surface/protocol.ts";
import { RequestStore } from "./surface/requests.ts";

const SURFACE = join(import.meta.dir, "..", "web", "src", "fixtures", "surface");
const TURN = readFileSync(join(SURFACE, "claude--v2-1-310-walky-turn-empty-box--w120.txt"), "utf8");
const QUEUED = readFileSync(join(SURFACE, "claude--v2-1-310-walky-queued-two-rows--w120.txt"), "utf8");
const RULE = "─".repeat(120);

/** The captured running turn with its box drawn from what was typed; Enter takes a text into the queue. */
class Pane {
  box = "";
  reads = 0;
  keysSeen: string[] = [];
  private queued = false;
  private readonly head: string[];
  private readonly footer: string[];

  constructor() {
    const rows = TURN.replace(/\r/gu, "").split("\n");
    while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
    const bottom = rows.findLastIndex((row) => /^─{8,}$/u.test(row));
    const top = rows.slice(0, bottom).findLastIndex((row) => /^─{8,}$/u.test(row));
    this.head = rows.slice(0, top);
    this.footer = rows.slice(bottom + 1);
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    const text = this.queued ? QUEUED : [...this.head, RULE, `❯ ${this.box}`, RULE, ...this.footer].join("\n");
    return Promise.resolve(muxOk({ paneId, text, truncated: false, revision: this.reads }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    if (!this.queued) this.box += text;
    return Promise.resolve(muxAck());
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if (key === "Enter" && this.box.length > 0) {
        this.box = "";
        this.queued = true;
      }
    }
    return Promise.resolve(muxAck());
  };
}

/** A door for `claude` whose preflight and submit answer as told, and which counts its submits. */
class FakeDoor implements Door {
  readonly id = "claude";
  submits: DoorSend[] = [];
  constructor(
    private readonly bind: () => Promise<Preflight> = () => Promise.resolve({ ok: true, door: { submit: (send) => this.submitted(send) } }),
    private readonly answer: () => Promise<DoorAnswer> = () => Promise.resolve({ kind: "taken" }),
  ) {}
  preflight = (): Promise<Preflight> => this.bind();
  submitted(send: DoorSend): Promise<DoorAnswer> {
    this.submits.push(send);
    return this.answer();
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-agent-prompt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;
const nextId = (): string => `cli-case${String(++ids).padStart(4, "0")}-3d1f9a`;

/** The bridge's own pieces, as `bridge/index.ts` wires them, with a fake clock whose sleeps may act. */
function rig(door: Door | null, status?: AgentStatus) {
  const pane = new Pane();
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "2.1.310", { log: () => undefined })),
    generation: () => "gen-1",
    muxStatus: () => status,
    doors: doorRegistry(door === null ? [] : [door]),
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const rt: SendRouteRuntime = {
    send: protocol,
    engine: { current: () => ({ agents: [{ paneId: "%1", agent: "claude" }] }), noteInput: () => undefined, pokeNow: () => undefined },
    herdr: {},
    name: "main",
  };
  const sleeps: number[] = [];
  /** What `collie agent prompt` asks the bridge, with `onSleep` acting while the CLI waits (the journal's tick). */
  const prompt = (text: string, onSleep?: (requestId: string) => void, pane_ = "%1", requestId = nextId()): Promise<AgentPromptAnswer> => {
    return answerAgentPrompt(
      {
        runtimeOf: (paneId) => (paneId === "%1" ? rt : null),
        send: (runtime, body) => sendRoute(runtime, body, { audit: new AuditLog(() => undefined), device: "cli", redact: true, acceptEncoding: null }),
        waitMs: 5_000,
        pollMs: 1_000,
        now,
        sleep: (ms) => {
          sleeps.push(ms);
          clock.now += ms;
          onSleep?.(requestId);
          return Promise.resolve();
        },
      },
      { pane: pane_, text, requestId },
    );
  };
  return { pane, protocol, prompt, sleeps };
}

describe("the door goes first and the journal answers (V38, V39)", () => {
  test("a door's send the journal shows as its own prompt is `landed`; nothing was read or typed", async () => {
    const door = new FakeDoor();
    const { pane, protocol, prompt } = rig(door);
    const answer = await prompt("hello from a terminal", (id) => protocol.proveDoor("main", "%1", [{ requestId: id, how: "landed" }]));
    expect(answer).toMatchObject({ ok: true, outcome: "landed", via: "claude" });
    expect(door.submits.map((send) => send.text)).toEqual(["hello from a terminal"]);
    expect(pane.reads).toBe(0);
    expect(pane.keysSeen).toEqual([]);
  });

  test("the door's own `taken` is only a hint: no proof inside the wait ends `unconfirmed`, never `landed`", async () => {
    const door = new FakeDoor();
    const { prompt, sleeps } = rig(door);
    const answer = await prompt("hello");
    expect(answer).toMatchObject({ ok: true, outcome: "unconfirmed", via: "claude" });
    expect(sleeps.length).toBeGreaterThan(1);
  });

  test("a turn that only contains the text is `merged`", async () => {
    const { protocol, prompt } = rig(new FakeDoor());
    const answer = await prompt("hello", (id) => protocol.proveDoor("main", "%1", [{ requestId: id, how: "merged" }]));
    expect(answer).toMatchObject({ ok: true, outcome: "merged", via: "claude" });
  });

  test("a door that put it in the agent's own queue is `queued` at once: no wait for the turn", async () => {
    const { prompt, sleeps } = rig(new FakeDoor(undefined, () => Promise.resolve({ kind: "queued" })));
    const answer = await prompt("hello");
    expect(answer).toMatchObject({ ok: true, outcome: "queued", via: "claude" });
    expect(sleeps).toEqual([]);
  });
});

describe("a refusal before submit falls back, and nothing is typed twice (V8, V23, V25)", () => {
  test("the door refuses before submit: the screen path takes it, `via` screen", async () => {
    const door = new FakeDoor(() => Promise.resolve({ ok: false, why: "no socket" }));
    const { pane, prompt } = rig(door);
    const answer = await prompt("hello");
    expect(answer).toMatchObject({ ok: true, via: "screen", outcome: "queued" });
    expect(door.submits).toEqual([]);
    expect(pane.keysSeen.at(-1)).toBe("Enter");
  });

  test("a pane with no inbox at all is the ordinary screen send", async () => {
    const { pane, prompt } = rig(new FakeDoor(() => Promise.resolve({ ok: false, why: "no pi inbox is open", absent: true })));
    const answer = await prompt("hello");
    expect(answer).toMatchObject({ ok: true, via: "screen" });
    expect(pane.keysSeen.at(-1)).toBe("Enter");
  });

  test("a submit that may have reached the agent is never typed again: `unconfirmed`, no key, one submit", async () => {
    const door = new FakeDoor(undefined, () => Promise.reject(new Error("connection dropped after write")));
    const { pane, prompt } = rig(door);
    const answer = await prompt("hello");
    expect(answer).toMatchObject({ ok: true, outcome: "unconfirmed", via: "claude" });
    expect(door.submits).toHaveLength(1);
    expect(pane.reads).toBe(0);
    expect(pane.keysSeen).toEqual([]);
  });

  test("an uncertain submit the journal later shows is `landed`", async () => {
    const door = new FakeDoor(undefined, () => Promise.reject(new Error("dropped")));
    const { protocol, prompt } = rig(door);
    const answer = await prompt("hello", (id) => protocol.proveDoor("main", "%1", [{ requestId: id, how: "landed" }]));
    expect(answer).toMatchObject({ ok: true, outcome: "landed" });
  });
});

describe("a blocked pane (V24)", () => {
  test("the door's send goes through a blocked pane", async () => {
    const door = new FakeDoor(undefined, () => Promise.resolve({ kind: "queued" }));
    const { pane, prompt } = rig(door, "blocked");
    expect(await prompt("hello")).toMatchObject({ ok: true, outcome: "queued", via: "claude" });
    expect(pane.keysSeen).toEqual([]);
  });
});

describe("what the bridge does not take", () => {
  test("a pane no session holds is an error, and nothing is sent", async () => {
    const door = new FakeDoor();
    const { prompt } = rig(door);
    expect(await prompt("hello", undefined, "%9")).toEqual({ ok: false, error: PROMPT_NO_PANE });
    expect(door.submits).toEqual([]);
  });

  test("the same request id twice: the door is asked once and the second answer is the first's", async () => {
    const door = new FakeDoor(undefined, () => Promise.resolve({ kind: "queued" }));
    const { prompt } = rig(door);
    const id = nextId();
    const first = await prompt("hello", undefined, "%1", id);
    const again = await prompt("hello", undefined, "%1", id);
    expect(again).toEqual(first);
    expect(door.submits).toHaveLength(1);
  });
});

describe("what the receipts say, mapped (V39)", () => {
  /** A runtime whose Send route answered one receipt and whose list now shows `row`. */
  function fake(over: Partial<SendReceiptRow> & Pick<SendReceiptRow, "outcome">, receipt: Partial<SendReceipt> = { outcome: "sent", via: "pi" }) {
    const row: SendReceiptRow = { requestId: "cli-map00001", at: 0, mode: "send", keys: [], gapsMs: {}, harness: "claude", version: null, ...over };
    return answerAgentPrompt(
      {
        runtimeOf: () => ({ name: "main", send: { recent: () => [row] } }),
        send: () => Promise.resolve(Response.json({ receipt: { requestId: "cli-map00001", ...receipt }, offers: [] })),
        waitMs: 0,
      },
      { pane: "%1", text: "x", requestId: "cli-map00001" },
    );
  }

  test("the agent gave it back (late returned): refused, reason returned", async () => {
    expect(await fake({ outcome: "sent", door: "queued", late: "returned" })).toMatchObject({ ok: true, outcome: "refused", reason: "returned", via: "pi" });
  });

  test("effective and steered are landed", async () => {
    expect(await fake({ outcome: "effective" })).toMatchObject({ outcome: "landed" });
    expect(await fake({ outcome: "steered" })).toMatchObject({ outcome: "landed" });
  });

  test("held is queued; expired, cancelled and typed_not_submitted are refused with the word as reason", async () => {
    expect(await fake({ outcome: "held" })).toMatchObject({ outcome: "queued" });
    for (const outcome of ["expired", "cancelled", "typed_not_submitted"] as const) {
      expect(await fake({ outcome })).toMatchObject({ outcome: "refused", reason: outcome });
    }
  });

  test("a refusal at the route keeps its reason and detail, and the list is never read", async () => {
    const answer = await answerAgentPrompt(
      {
        runtimeOf: () => ({ name: "main", send: { recent: () => [] } }),
        send: () => Promise.resolve(Response.json({ receipt: { requestId: "cli-map00001", outcome: "refused", reason: "busy", detail: "The agent is working." }, offers: [] })),
      },
      { pane: "%1", text: "x", requestId: "cli-map00001" },
    );
    expect(answer).toMatchObject({ ok: true, outcome: "refused", reason: "busy", detail: "The agent is working." });
  });

  test("a bridge that answers 404 or 400 is an error, not an outcome", async () => {
    const make = (status: number) =>
      answerAgentPrompt({ runtimeOf: () => ({ name: "main", send: { recent: () => [] } }), send: () => Promise.resolve(new Response("no", { status })) }, { pane: "%1", text: "x", requestId: "cli-map00001" });
    expect(await make(404)).toEqual({ ok: false, error: PROMPT_NO_PANE });
    expect(await make(400)).toMatchObject({ ok: false });
  });
});
