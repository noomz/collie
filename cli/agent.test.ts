import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { HOST } from "../bridge/host.ts";
import { PROMPT_NO_PANE } from "../bridge/agent-prompt.ts";
import { unknownOp } from "../bridge/walky/refusals.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import { parseJsonObject, type JsonObject } from "../web/src/lib/json.ts";
import { cmdAgent, cmdAgentPrompt, NO_BRIDGE_TEXT } from "./agent.ts";
import { capture, context } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";
import { askSocket, type WalkyDeps } from "./walky.ts";

// `collie agent prompt` against a fake bridge socket in a private temp dir: the CLI's request line and
// its reading of the answer are the real ones. What the bridge does with the line (door first, journal
// proof) is bridge/agent-prompt.test.ts's. The socket is POSIX only, as the walky socket is.
const socketTest = test.skipIf(HOST.platform === "win32");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

/** A state dir with a socket in it that answers each line with `answer(request)`; `lines` holds what it was asked. */
async function fakeBridge(answer: (request: JsonObject) => JsonObject) {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-cli-"));
  const path = walkySocketPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines: JsonObject[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      const request = parseJsonObject(chunk) ?? {};
      lines.push(request);
      socket.end(`${JSON.stringify(answer(request))}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { stateDir, path, lines };
}

function deps(stateDir: string, sockets: readonly string[], over: Partial<WalkyDeps> = {}) {
  const io = capture();
  const d: WalkyDeps & { readonly io: ReturnType<typeof capture> } = {
    ctx: context({}, { stateDir }),
    files: realFiles,
    uid: process.getuid?.(),
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: (path, line) => askSocket(path, line, 2000),
    sockets: () => sockets,
    mintId: () => "cli-fixedid0001",
    ...over,
    io,
  };
  return d;
}

const said = (outcome: string, extra: JsonObject = {}): JsonObject => ({ ok: true, outcome, requestId: "cli-fixedid0001", ...extra });

describe("the request line", () => {
  socketTest("one `agent.prompt` line: the pane, the words joined, a `cli-` request id, no markers", async () => {
    const bridge = await fakeBridge(() => said("landed", { via: "pi" }));
    const d = deps(bridge.stateDir, [bridge.path], { mintId: undefined });
    expect(await cmdAgentPrompt(d, ["%3", "run", "the", "tests"])).toBe(EXIT.OK);
    expect(bridge.lines).toHaveLength(1);
    expect(bridge.lines[0]).toMatchObject({ v: 1, op: "agent.prompt", pane: "%3", text: "run the tests", markers: [] });
    expect(String(bridge.lines[0]?.requestId)).toMatch(/^cli-[0-9a-f-]{36}$/u);
  });

  socketTest("no text on the line: stdin's, minus its last newline; a terminal with no text is a usage error", async () => {
    const bridge = await fakeBridge(() => said("landed"));
    const piped = deps(bridge.stateDir, [bridge.path], { stdinIsTty: false, readStdin: async () => "from a pipe\n" });
    expect(await cmdAgentPrompt(piped, ["%3"])).toBe(EXIT.OK);
    expect(bridge.lines[0]?.text).toBe("from a pipe");
    const tty = deps(bridge.stateDir, [bridge.path]);
    expect(await cmdAgentPrompt(tty, ["%3"])).toBe(EXIT.USAGE);
    expect(await cmdAgentPrompt(tty, [])).toBe(EXIT.USAGE);
    expect(bridge.lines).toHaveLength(1);
  });

  test("`collie agent` alone and an unknown subcommand print the usage", async () => {
    const d = deps("/nonexistent", []);
    expect(await cmdAgent(d, [])).toBe(EXIT.USAGE);
    expect(await cmdAgent(d, ["nope"])).toBe(EXIT.USAGE);
    expect(d.io.stderr.join("\n")).toContain("unknown agent subcommand `nope`");
    expect(d.io.stderr.join("\n")).toContain("usage: collie agent prompt");
  });
});

describe("what it prints and the exit code it takes (V39)", () => {
  const cases: readonly [string, JsonObject, number, "out" | "err"][] = [
    ["landed", said("landed", { via: "pi" }), EXIT.OK, "out"],
    ["queued", said("queued", { via: "opencode" }), EXIT.OK, "out"],
    ["merged", said("merged", { via: "pi" }), EXIT.FAIL, "err"],
    ["refused", said("refused", { reason: "busy", detail: "The agent is working." }), EXIT.REFUSED, "err"],
    ["unconfirmed", said("unconfirmed", { via: "pi" }), EXIT.STATE, "err"],
  ];
  for (const [word, answer, exit, stream] of cases) {
    socketTest(`${word}: exit ${String(exit)}, the line on ${stream === "out" ? "stdout" : "stderr"}`, async () => {
      const bridge = await fakeBridge(() => answer);
      const d = deps(bridge.stateDir, [bridge.path]);
      expect(await cmdAgentPrompt(d, ["%1", "hi"])).toBe(exit);
      const printed = (stream === "out" ? d.io.stdout : d.io.stderr).join("\n");
      expect(printed).toContain(word === "merged" ? "merged or changed" : word);
      expect((stream === "out" ? d.io.stderr : d.io.stdout).join("")).toBe("");
      if (answer.via !== undefined) expect(printed).toContain(`via ${String(answer.via)}`);
      if (word === "refused") expect(printed).toContain("[busy]");
      if (word === "refused") expect(printed).toContain("The agent is working.");
    });
  }
});

describe("the bridges it asks", () => {
  socketTest("a bridge that holds no such pane passes it on; the next one takes it, and only that one is asked twice never", async () => {
    const first = await fakeBridge(() => ({ ok: false, error: PROMPT_NO_PANE }));
    const second = await fakeBridge(() => said("landed"));
    const d = deps(first.stateDir, [first.path, second.path]);
    expect(await cmdAgentPrompt(d, ["%1", "hi"])).toBe(EXIT.OK);
    expect(first.lines).toHaveLength(1);
    expect(second.lines).toHaveLength(1);
  });

  socketTest("no bridge holds the pane: refused, and the pane is named", async () => {
    const bridge = await fakeBridge(() => ({ ok: false, error: PROMPT_NO_PANE }));
    const d = deps(bridge.stateDir, [bridge.path]);
    expect(await cmdAgentPrompt(d, ["%9", "hi"])).toBe(EXIT.REFUSED);
    expect(d.io.stderr.join("\n")).toContain("%9");
  });

  socketTest("a bridge older than this command says it knows no such op: refused with its words, nothing retried", async () => {
    const bridge = await fakeBridge((request) => ({ ok: false, error: unknownOp(String(request.op)) }));
    const d = deps(bridge.stateDir, [bridge.path]);
    expect(await cmdAgentPrompt(d, ["%1", "hi"])).toBe(EXIT.REFUSED);
    expect(d.io.stderr.join("\n")).toContain("does not know the op");
    expect(bridge.lines).toHaveLength(1);
  });

  test("no bridge running: nothing is sent, and the exit says unreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-cli-none-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const d = deps(dir, [walkySocketPath(dir)]);
    expect(await cmdAgentPrompt(d, ["%1", "hi"])).toBe(EXIT.UNREACHABLE);
    expect(d.io.stderr.join("\n")).toContain(NO_BRIDGE_TEXT);
  });

  socketTest("a socket that took the line and never answered is `unconfirmed`, and no other bridge is tried (no retype)", async () => {
    const taking = await fakeBridge(() => said("landed"));
    const other = await fakeBridge(() => said("landed"));
    const d = deps(taking.stateDir, [taking.path, other.path], { ask: (path) => (path === taking.path ? Promise.reject(new Error("late")) : Promise.resolve(`${JSON.stringify(said("landed"))}`)) });
    expect(await cmdAgentPrompt(d, ["%1", "hi"])).toBe(EXIT.STATE);
    expect(d.io.stderr.join("\n")).toContain("unconfirmed");
    expect(other.lines).toHaveLength(0);
  });
});
