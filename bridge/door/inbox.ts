// An inbox door (ADR 0141): a Collie extension in the agent's own process, reached over a private unix
// socket, that hands the text to the agent's own API so no key reaches the pane. pi's door and
// opencode's are two of these. Each gives its folder, how it reads its `/hello`, and how a heard inbox
// binds to the pane's session; finding the socket and reading its answers is the same for both.
//
// FINDING THE SOCKET. An inbox names its socket by the digest of every multiplexer marker in its
// environment (`beaconKey`), the key that names a beacon. The bridge cannot rebuild that digest: a pane
// nested in a second multiplexer carries a marker the bridge never sees, and the socket path Herdr
// exports can be another spelling of the one the bridge dials (`bridge/mux/herdr/markers.ts`). So the
// door reads the folder, asks each socket `/hello`, and joins the raw markers each one reports to the
// pane with the multiplexer's own beacon matcher, the join a beacon gets. A socket whose name is not
// the digest of the markers it reports is not one of ours. One socket must name the pane; none, or more
// than one, refuses (ambiguity is absence, `bridge/beacon/decorate.ts`).
//
// THE SOCKET'S RULES (ADR 0141 point 7, ADR 0103): every path part is walked with `lstat` before each
// connect, the same check the durable wire runs (`socketAccessProblem`), and no link is followed.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import { parseInboxQueue, parseInboxTook } from "../beacon/parse.ts";
import { beaconKey, inboxSocketName } from "../beacon/paths.ts";
import type { BeaconMarker } from "../beacon/types.ts";
import { readCapped, socketAccessProblem } from "../mux/durable/client.ts";
import type { BoundDoor, Door, DoorAnswer, DoorSend, DoorTarget, Preflight } from "./door.ts";

/** An inbox socket's name: a pane key, 16 hex. A bind name (`<key>-<hex>.sock`) is still being opened. */
const INBOX_SOCKET = /^[0-9a-f]{16}\.sock$/u;

/** The most sockets one preflight asks. More than this many open agent sessions refuses rather than waits. */
export const INBOX_MAX = 32;

/** How long one socket gets to answer `/hello`: a wedged agent in another pane must not hold up this one. */
export const HELLO_MS = 1500;

/** The largest answer read from an inbox. Every answer is a few hundred bytes. */
const REPLY_MAX_BYTES = 16 * 1024;

/** The answers that say the agent ran nothing: a bad body, an unknown route or session, not taken, too large. */
const RAN_NOTHING = new Set([400, 404, 409, 413]);

/** One answer from an inbox socket. */
export interface InboxReply {
  readonly status: number;
  readonly text: string;
}

/** The disk and the socket, as the door touches them. A test supplies its own. */
export interface InboxIo {
  /** The names in the inbox folder; none when it does not exist. */
  list(dir: string): Promise<string[]>;
  /** Why the socket at `path` may not be dialled, or null when it may (`socketAccessProblem`). */
  problem(path: string): Promise<string | null>;
  /** One HTTP request on the socket: a POST of `body` as JSON, or a GET with none. A failed connect or read throws. */
  request(path: string, route: string, body: string | undefined, signal: AbortSignal): Promise<InboxReply>;
}

/** The real folder and sockets. */
export const SYSTEM_INBOX_IO: InboxIo = {
  async list(dir) {
    try {
      return await readdir(dir);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }
  },
  problem: (path) => socketAccessProblem(path),
  async request(path, route, body, signal) {
    const url = `http://inbox${route}`;
    const response =
      body === undefined
        ? await fetch(url, { unix: path, signal })
        : await fetch(url, { unix: path, method: "POST", body, headers: { "content-type": "application/json" }, signal });
    return { status: response.status, text: await readCapped(response, REPLY_MAX_BYTES) };
  },
};

/** What every inbox's `/hello` carries: whose inbox it is, and the raw markers its socket is named by. */
export interface HelloBase {
  readonly agent: string;
  readonly markers: readonly BeaconMarker[];
}

/** A heard inbox's binding: the fields its `/send` body adds to the text and request id, or why it does not bind. */
export type InboxBind = { readonly ok: true; readonly body: Readonly<Record<string, string>> } | { readonly ok: false; readonly why: string };

/** One agent's inbox door. */
export interface InboxDoorSpec<H extends HelloBase> {
  /** The harness id the door serves, and the `agent` its inbox's `/hello` names. */
  readonly id: string;
  /** The folder the agent's inbox sockets are in. */
  readonly dir: string;
  /** The multiplexer's beacon matcher: which raw marker names which of its panes. */
  readonly matcher: BeaconMatcher;
  /** The `/hello` text, or null when it is not one this build reads. */
  parse(text: string): H | null;
  /** Whether the pane's own inbox, heard, binds to the session the pane runs. Touches nothing. */
  bind(hello: H, paneId: string): InboxBind;
  readonly io?: InboxIo;
}

/** A socket that answered `/hello`, at its path. */
interface Heard<H> {
  readonly path: string;
  readonly hello: H;
}

/** The door for an agent's inbox. */
export function inboxDoor<H extends HelloBase>(spec: InboxDoorSpec<H>): Door {
  const io = spec.io ?? SYSTEM_INBOX_IO;
  const { id, matcher } = spec;

  /** The socket's `/hello`, or null when it gives none this build reads, or its name is not its markers' key. */
  const hear = async (name: string, signal: AbortSignal): Promise<Heard<H> | null> => {
    const path = join(spec.dir, name);
    if ((await io.problem(path)) !== null) return null;
    let reply: InboxReply;
    try {
      reply = await io.request(path, "/hello", undefined, AbortSignal.any([signal, AbortSignal.timeout(HELLO_MS)]));
    } catch {
      return null;
    }
    const hello = reply.status === 200 ? spec.parse(reply.text) : null;
    if (hello === null || inboxSocketName(beaconKey(hello.markers)) !== name) return null;
    return { path, hello };
  };

  const bound = (path: string, fields: Readonly<Record<string, string>>): BoundDoor => ({
    async submit(send: DoorSend, signal: AbortSignal): Promise<DoorAnswer> {
      const problem = await io.problem(path);
      if (problem !== null) return { kind: "refused", why: `the inbox socket: ${problem}` };
      // No `steer`: the Send Protocol never hands a door a steer (ADR 0117).
      const reply = await io.request(path, "/send", JSON.stringify({ ...fields, text: send.text, requestId: send.requestId }), signal);
      if (RAN_NOTHING.has(reply.status)) return { kind: "refused", why: `${id} answered ${String(reply.status)}` };
      const took = reply.status === 202 ? parseInboxTook(reply.text) : null;
      // Anything else may have reached the agent: a throw is `uncertain`, never typed again (ADR 0141 point 2).
      if (took === null) throw new Error(`${id} answered ${String(reply.status)} with no state Collie reads`);
      if (took.replayed) return { kind: "replayed" };
      if (took.state === "steered") throw new Error(`${id} steered a send that asked for no steer`);
      return { kind: took.state };
    },
    // An inbox from before `/queue` answers 404: no word, and the card keeps today's bound.
    async queue(signal: AbortSignal) {
      if ((await io.problem(path)) !== null) return null;
      const reply = await io.request(path, "/queue", undefined, signal);
      return reply.status === 200 ? parseInboxQueue(reply.text) : null;
    },
  });

  return {
    id,
    // No inbox for the pane is `absent`: the pane has no door, and the screen path is the ordinary one
    // (SPEC V25). Only the pane's own inbox, heard and then not bound, is a refusal the receipt names.
    async preflight(target: DoorTarget, signal: AbortSignal): Promise<Preflight> {
      const scope = await matcher.scope();
      if (scope === null) return { ok: false, why: "the multiplexer's scope is unknown", absent: true };
      const names = (await io.list(spec.dir)).filter((name) => INBOX_SOCKET.test(name));
      if (names.length === 0) return { ok: false, why: `no ${id} inbox is open`, absent: true };
      if (names.length > INBOX_MAX) return { ok: false, why: `more than ${String(INBOX_MAX)} ${id} inboxes are open` };
      const heard = await Promise.all(names.map((name) => hear(name, signal)));
      const mine = heard.filter(
        (one): one is Heard<H> =>
          one !== null && one.hello.markers.some((marker) => marker.namespace === matcher.namespace && matcher.matches({ paneId: target.paneId }, marker, scope)),
      );
      const [only] = mine;
      if (only === undefined) return { ok: false, why: `no ${id} inbox names this pane`, absent: true };
      if (mine.length > 1) return { ok: false, why: `more than one ${id} inbox names this pane` };
      if (only.hello.agent !== id) return { ok: false, why: `the inbox is ${only.hello.agent}'s, not ${id}'s` };
      const binding = spec.bind(only.hello, target.paneId);
      if (!binding.ok) return { ok: false, why: binding.why };
      return { ok: true, door: bound(only.path, binding.body) };
    },
  };
}
