// collie-inbox v1
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// Collie's inbox for opencode: the agent's own door (ADR 0143). A phone send reaches the pane's live
// session through the TUI's own client, `api.client.session.prompt`, and no key is typed into the pane.
// Because the client is the TUI's own, the send reaches whichever server this TUI uses: the shared
// service, `--standalone` and `--server` alike. The bridge never speaks HTTP to opencode.
//
// It listens on a private unix socket named by the pane, with three routes:
//
//   GET  /hello  who is here: the session the TUI shows (the bridge binds a send to it), the pid, the
//                server's pid, and the raw multiplexer markers the socket is named by. A hint (ADR 0024).
//   POST /send   `{ text, requestId, sessionID, steer? }`. The session must still be the one the TUI
//                shows. The text always queues as its own turn (`delivery: "queue"`): opencode's default,
//                steer, merges it into the running turn, so steer happens only when the person chose it.
//                `taken` when the session was idle, `queued` when busy, `steered` when asked. A request
//                id seen before with the same text answers `replayed` and runs nothing; with other text
//                it refuses. These answers are hints too: opencode's store settles the send.
//   GET  /queue  which sends this TUI took are still in the server's inbox (`pending`), and which LEFT
//                it with the session no longer running (`left`): each one ran, or was cancelled. Which of
//                the two is the journal's to say, never this answer's.
//
// THE SOCKET is `<XDG_STATE_HOME or ~/.local/state>/collie/inbox/opencode/<pane key>.sock`, the key being
// the digest that names the pane's beacon (`bridge/beacon/paths.ts` `opencodeInboxSocketPath`). Mode 0600
// in a 0700 folder that is this user's own and not a link; anything else opens no socket. Outside a
// multiplexer there is no pane to name, and nothing opens.
//
// opencode runs `setup` once in each TUI process, from the plugin folder
// `~/.config/opencode/plugins/collie-inbox/tui.ts`. A newer TUI in the same pane takes the socket over,
// and an older one never removes the newer one's.
//
// SELF-CONTAINED by design: `collie inbox install opencode` copies this one file, and opencode loads it with
// node's modules only. The marker table, the digest and the request-id rule are copies of Collie's own, and
// `collie-inbox.test.ts` pins each one to its original.

/** The inbox wire version `/hello` reports. */
export const INBOX_VERSION = 1;

/** The largest `/send` body read, in bytes: Collie's 64 Ki UTF-16 units, at up to six JSON bytes each. */
export const MAX_BODY_BYTES = 512 * 1024;

/** How many request ids are kept for replay and for `/queue`. The oldest goes first. */
export const KEEP_REQUEST_IDS = 500;

/** A request id as the phone mints it: Collie's `REQUEST_ID` (`web/src/lib/surface/send.ts`). */
export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The inboxes' folder: Collie's `INBOX_SUBDIR`. */
export const INBOX_SUBDIR = "inbox";

/** opencode's own folder inside it: Collie's `OPENCODE_INBOX_SUBDIR`. */
export const OPENCODE_INBOX_SUBDIR = "opencode";

/** The longest socket path that fits `sun_path` everywhere (104 bytes on macOS, with its NUL). */
export const MAX_SOCKET_PATH_BYTES = 103;

/** How long `/hello` waits for the server's pid. A server that is down or restarting answers `null`. */
export const SERVER_INFO_MS = 200;

/** What the name the socket is first bound under adds to the path: `-<4 hex>` (see `open`). */
const BIND_SUFFIX_BYTES = 5;

/**
 * The errors opencode's server answers when it ran nothing: the request was refused, so the bridge may
 * fall back to the screen. Any other error (a transport error, a bad status, a timeout) may have come after
 * the request was written, so the send is unsure and is never typed again.
 */
const REFUSED_TAGS = new Map([
  ["SessionNotFoundError", { status: 404, code: "no-session" }],
  ["InvalidRequestError", { status: 400, code: "bad-request" }],
  ["ConflictError", { status: 409, code: "not-taken" }],
]);

/** One multiplexer's pane identity, raw, as `collie beacon emit` records it (`BeaconMarker`). */
export type Marker = {
  readonly namespace: string;
  readonly scope: string;
  readonly pane: string;
};

/** Where each multiplexer puts the pane identity in the env: `cli/beacon.ts` `MUX_ENV_MARKERS`. */
const MUX_ENV_MARKERS: readonly { namespace: string; paneVar: string; scopeVar: string; scopeOf(raw: string): string }[] = [
  // `$TMUX` is `<socket path>,<server pid>,<session index>`; the scope is the socket path.
  { namespace: "tmux", paneVar: "TMUX_PANE", scopeVar: "TMUX", scopeOf: (raw) => raw.split(",")[0] ?? raw },
  { namespace: "tern", paneVar: "TERN_PANE", scopeVar: "TERN_PANE_SOCKET", scopeOf: (raw) => raw },
  { namespace: "zellij", paneVar: "ZELLIJ_PANE_ID", scopeVar: "ZELLIJ_SESSION_NAME", scopeOf: (raw) => raw },
  { namespace: "herdr", paneVar: "HERDR_PANE_ID", scopeVar: "HERDR_SOCKET_PATH", scopeOf: (raw) => raw },
  { namespace: "herdr-core", paneVar: "HC_TERMINAL_ID", scopeVar: "HC_TERMINAL_SOCKET", scopeOf: (raw) => raw },
];

type Env = Readonly<Record<string, string | undefined>>;

/** Every multiplexer this process is inside, as `readEnvMarkers` reads them. A missing scope skips one. */
export function markersOf(env: Env): Marker[] {
  const markers: Marker[] = [];
  for (const source of MUX_ENV_MARKERS) {
    const pane = env[source.paneVar]?.trim();
    const rawScope = env[source.scopeVar]?.trim();
    if (!pane || !rawScope) continue;
    const scope = source.scopeOf(rawScope).trim();
    if (scope === "") continue;
    markers.push({ namespace: source.namespace, scope, pane });
  }
  return markers;
}

/** The pane key: Collie's `beaconKey`, a digest of every marker in a canonical order. */
export function paneKey(markers: readonly Marker[]): string {
  const canonical = markers
    .map((marker) => [marker.namespace, marker.scope, marker.pane].join("\u0000"))
    .toSorted()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** This pane's socket, or undefined when there is none to open: no multiplexer, or a path past sun_path. */
export function socketPathOf(env: Env, home: string): string | undefined {
  const markers = markersOf(env);
  if (markers.length === 0) return undefined;
  const xdg = env.XDG_STATE_HOME?.trim() ?? "";
  const base = xdg !== "" && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  const path = join(base, "collie", INBOX_SUBDIR, OPENCODE_INBOX_SUBDIR, `${paneKey(markers)}.sock`);
  return Buffer.byteLength(path) + BIND_SUFFIX_BYTES <= MAX_SOCKET_PATH_BYTES ? path : undefined;
}

/**
 * The message id a request id goes to opencode under. opencode needs the `msg_` prefix, and the same request
 * id must always give the same message id, so the server's own replay holds across a TUI restart.
 */
export function messageIdOf(requestId: string): string {
  return `msg_collie${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
}

/** An item in opencode's session inbox, as `session.prompt` and `session.inbox.list` return it. */
export interface InboxItem {
  readonly id: string;
  readonly payload?: { readonly text?: string };
}

/** The part of opencode's TUI plugin API this plugin uses (`api` in `setup(api)`). */
export interface OpencodeApi {
  readonly ui: { readonly router: { current(): { readonly type: string; readonly sessionID?: string } | undefined } };
  readonly client: {
    readonly server: { info(): Promise<{ readonly pid?: number }> };
    readonly session: {
      prompt(input: { sessionID: string; id: string; text: string; delivery: "queue" | "steer" }): Promise<InboxItem>;
      active(): Promise<Readonly<Record<string, { readonly type?: string } | undefined>>>;
      readonly inbox: { list(input: { sessionID: string }): Promise<readonly InboxItem[]> };
    };
  };
}

// THE PARSE BOUNDARY: a `/send` body is the one input this plugin reads, and it is parsed here, once,
// the way Collie's `web/src/lib/json.ts` parses (a copy, as the file must stand alone).

/** Any value JSON can carry. */
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object. */
type JsonObject = { [key: string]: JsonValue | undefined };

/** A value's own primitive tag: `[object String]`, `[object Object]`. A parsed document cannot spoof it. */
const tagOf = (value: JsonValue | undefined): string => Object.prototype.toString.call(value);

interface Reply {
  readonly status: number;
  readonly body: JsonObject;
}

const BAD_REQUEST: Reply = { status: 400, body: { code: "bad-request" } };

interface SendRequest {
  readonly text: string;
  readonly requestId: string;
  readonly sessionID: string;
  readonly steer: boolean;
}

/** The fields of a `/send` body, or undefined when it is not one. */
function sendOf(raw: string): SendRequest | undefined {
  let body: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; there is nothing else it can return.
    body = JSON.parse(raw) as JsonValue;
  } catch {
    return undefined;
  }
  if (tagOf(body) !== "[object Object]") return undefined;
  // SAFETY: the tag check above passed, and `[object Object]` from a parsed document is a plain object.
  const { text, requestId, sessionID, steer } = body as JsonObject;
  for (const field of [text, requestId, sessionID]) if (tagOf(field) !== "[object String]") return undefined;
  // SAFETY: the loop above checked each tag: each value IS a string.
  const [message, id, session] = [text as string, requestId as string, sessionID as string];
  if (message === "" || session === "" || !REQUEST_ID.test(id)) return undefined;
  if (steer !== undefined && steer !== true && steer !== false) return undefined;
  return { text: message, requestId: id, sessionID: session, steer: steer === true };
}

/** The session the TUI shows, or undefined on its home screen or when the router cannot be read. */
function routeOf(api: OpencodeApi): string | undefined {
  try {
    const route = api.ui.router.current();
    return route?.type === "session" ? route.sessionID : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the session is running a turn: true, false, or undefined when the server did not say. */
async function runningOf(api: OpencodeApi, sessionID: string): Promise<boolean | undefined> {
  try {
    return (await api.client.session.active())[sessionID]?.type === "running";
  } catch {
    return undefined;
  }
}

/** The server's pid, or null when it does not answer within {@link SERVER_INFO_MS}. */
async function serverPidOf(api: OpencodeApi): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SERVER_INFO_MS);
  });
  try {
    const info = api.client.server.info().then(
      (answer) => answer.pid ?? null,
      () => null,
    );
    return await Promise.race([info, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A failed `session.prompt`, by its error's `_tag`: refused when the server said it ran nothing, else unsure. */
function errorReply(tag: string, why: string): Reply {
  const refused = REFUSED_TAGS.get(tag);
  if (refused !== undefined) return { status: refused.status, body: { code: refused.code, why } };
  return { status: 502, body: { code: "unsure", why } };
}

/** The inode of the socket at `path`, or undefined when there is no socket there. */
function socketInode(path: string): number | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isSocket() ? stat.ino : undefined;
  } catch {
    return undefined;
  }
}

/** A send this TUI took: where it went, and whether it has left the server's inbox. */
interface Tracked {
  readonly text: string;
  readonly reply: Reply;
  readonly sessionID: string;
  readonly messageId: string;
  left: boolean;
}

/** An inbox this TUI opened: `ready` settles once the socket listens or failed to open. */
export interface Inbox {
  readonly ready: Promise<void>;
  close(): void;
}

/**
 * Open this TUI's inbox when it runs in a multiplexer pane, or answer undefined when there is no pane.
 * `env` and `home` are the process's own in production.
 */
export function activate(api: OpencodeApi, env: Env, home: string): Inbox | undefined {
  const sock = socketPathOf(env, home);
  if (sock === undefined) return undefined;
  const markers = markersOf(env);
  let server: Server | undefined;
  let opened: number | undefined;
  let closed = false;
  // The sends this TUI took, by request id, oldest first.
  const taken = new Map<string, Tracked>();

  const send = async (raw: string): Promise<Reply> => {
    const request = sendOf(raw);
    if (request === undefined) return BAD_REQUEST;
    const earlier = taken.get(request.requestId);
    if (earlier !== undefined) {
      if (earlier.text !== request.text) return { status: 409, body: { code: "replay-mismatch" } };
      return { status: earlier.reply.status, body: { ...earlier.reply.body, replayed: true } };
    }
    // The TUI may have moved to another session since the bridge's `/hello`: then nothing is sent.
    const route = routeOf(api);
    if (route !== request.sessionID) return { status: 409, body: { code: "moved", sessionID: route ?? null } };
    const running = await runningOf(api, request.sessionID);
    const messageId = messageIdOf(request.requestId);
    let item: InboxItem;
    try {
      item = await api.client.session.prompt({
        sessionID: request.sessionID,
        id: messageId,
        text: request.text,
        delivery: request.steer ? "steer" : "queue",
      });
    } catch (err) {
      // opencode's client throws an `Error` carrying `_tag`; anything else has no tag and is unsure.
      if (!(err instanceof Error)) return errorReply("", String(err));
      return errorReply("_tag" in err ? String(err._tag) : "", err.message);
    }
    // The server answers an id it already holds with the item it stored, whatever the text: a send this
    // TUI does not remember (a restart) with other text ran nothing and is refused.
    if (item?.payload?.text !== request.text) return { status: 409, body: { code: "replay-mismatch" } };
    const state = running === false ? "taken" : request.steer ? "steered" : "queued";
    const reply: Reply = { status: 202, body: { state } };
    taken.set(request.requestId, { text: request.text, reply, sessionID: request.sessionID, messageId, left: false });
    const oldest = taken.keys().next();
    if (taken.size > KEEP_REQUEST_IDS && oldest.done !== true) taken.delete(oldest.value);
    return reply;
  };

  // `left` needs both words: gone from the inbox, and the session not running. An idle session's item
  // leaves the inbox as its turn starts, before the journal holds the turn, so the inbox alone is too soon.
  // Once left, a send stays left.
  const queue = async (): Promise<Reply> => {
    const waiting = [...taken.values()].filter((entry) => !entry.left);
    const sessions = [...new Set(waiting.map((entry) => entry.sessionID))];
    if (sessions.length > 0) {
      let active: Awaited<ReturnType<OpencodeApi["client"]["session"]["active"]>>;
      const inboxes = new Map<string, Set<string>>();
      try {
        active = await api.client.session.active();
        for (const sessionID of sessions) {
          inboxes.set(sessionID, new Set((await api.client.session.inbox.list({ sessionID })).map((item) => item.id)));
        }
      } catch {
        return { status: 503, body: { code: "no-word" } };
      }
      for (const entry of waiting) {
        const inInbox = inboxes.get(entry.sessionID)?.has(entry.messageId) ?? true;
        if (!inInbox && active[entry.sessionID]?.type !== "running") entry.left = true;
      }
    }
    const ids = (left: boolean) => [...taken].flatMap(([id, entry]) => (entry.left === left ? [id] : []));
    return { status: 200, body: { pending: ids(false), left: ids(true) } };
  };

  const hello = async (): Promise<Reply> => ({
    status: 200,
    body: { agent: "opencode", inbox: INBOX_VERSION, pid: process.pid, sessionID: routeOf(api) ?? null, server: { pid: await serverPidOf(api) }, markers },
  });

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const answer = ({ status, body }: Reply): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const reply = (work: Promise<Reply>): void => {
      void work.catch((): Reply => ({ status: 500, body: { code: "failed" } })).then(answer);
    };
    if (req.method === "GET" && req.url === "/hello") return reply(hello());
    if (req.method === "GET" && req.url === "/queue") return reply(queue());
    if (req.method !== "POST" || req.url !== "/send") return answer({ status: 404, body: { code: "not-found" } });
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (bytes > MAX_BODY_BYTES) return answer({ status: 413, body: { code: "too-large" } });
      reply(send(Buffer.concat(chunks).toString("utf8")));
    });
  };

  // Only the socket this instance opened: a newer TUI may already be listening at the path.
  const close = (): void => {
    closed = true;
    server?.close();
    server = undefined;
    if (opened !== undefined && socketInode(sock) === opened) rmSync(sock, { force: true });
    opened = undefined;
    process.off("exit", close);
  };

  // The folder must be a real folder, this user's own; then it is made 0700 and the socket 0600. Any
  // failure opens no socket, and the bridge's preflight finds no door.
  //
  // The socket is bound under a name of its own and then renamed over the pane's name. Closing a unix
  // socket server unlinks the name it was BOUND under, so an older TUI that closes after a newer one
  // opened unlinks only its own, long-gone bind name, never the newer socket.
  const open = async (): Promise<void> => {
    const bound = `${sock.slice(0, -".sock".length)}-${randomBytes(2).toString("hex")}.sock`;
    const next = createServer(handle);
    try {
      const dir = dirname(sock);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.()) return;
      chmodSync(dir, 0o700);
      await new Promise<void>((resolve, reject) => {
        next.once("error", reject);
        next.listen(bound, resolve);
      });
      chmodSync(bound, 0o600);
      if (closed) throw new Error("closed while opening");
      renameSync(bound, sock);
      server = next;
      opened = socketInode(sock);
      process.once("exit", close);
    } catch {
      next.close();
      rmSync(bound, { force: true });
    }
  };

  return { ready: open(), close };
}

/** opencode's entry: runs once in each TUI process. */
function setup(api: OpencodeApi): () => void {
  const inbox = activate(api, process.env, homedir());
  return () => inbox?.close();
}

export default { id: "collie.inbox", setup };
