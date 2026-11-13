// opencode's door (ADR 0143): Collie's plugin in each opencode TUI (`opencode-plugin/collie-inbox.ts`),
// reached over its private unix socket in the inbox folder's `opencode/` (`inbox.ts`). The plugin hands
// the text to the TUI's own client, `session.prompt` with `delivery: "queue"`, so the send reaches the
// server that TUI uses and no key reaches the pane. The bridge reads no opencode file and opens no HTTP
// to opencode (SPEC V31).
//
// THE BINDING (SPEC V32). The plugin says which session its TUI shows; Herdr's `agent_session` says which
// session the pane runs. The door binds only when the two are the same id, byte for byte, and `/send`
// carries that id, so the plugin refuses (409) if the TUI moved off it since. The journal proof reads the
// pane's `agent_session` too, so the session the door sent to is the one the proof reads.
//
// A TUI whose server did not answer `/hello` refuses here, before any text is written: a dead server
// would otherwise reach `/send`, fail after the request may have gone, and leave an unsure card
// (SPEC V36). A refusal falls back to the screen; an unsure send is never typed again.

import type { BeaconMatcher } from "../beacon/decorate.ts";
import { parseOpencodeHello } from "../beacon/parse.ts";
import type { AgentSessionRef } from "../journal/types.ts";
import type { Door } from "./door.ts";
import { inboxDoor, type InboxIo } from "./inbox.ts";

/** The harness id opencode's door serves. */
export const OPENCODE_DOOR = "opencode";

/** What opencode's door needs from the session it serves. */
export interface OpencodeDoorDeps {
  /** opencode's inbox folder (`opencodeInboxDir`). */
  readonly dir: string;
  /** The multiplexer's beacon matcher: which raw marker names which of its panes. */
  readonly matcher: BeaconMatcher;
  /** The session the multiplexer names on the pane now (`AgentView.agentSession`). */
  sessionOf(paneId: string): AgentSessionRef | undefined;
  readonly io?: InboxIo;
}

/** opencode's door for one session. */
export function opencodeDoor(deps: OpencodeDoorDeps): Door {
  return inboxDoor({
    id: OPENCODE_DOOR,
    dir: deps.dir,
    matcher: deps.matcher,
    io: deps.io,
    parse: parseOpencodeHello,
    bind(hello, paneId) {
      const ref = deps.sessionOf(paneId);
      if (ref?.kind !== "id") return { ok: false, why: "the pane names no opencode session" };
      if (hello.sessionID === null) return { ok: false, why: "opencode shows no session" };
      if (hello.sessionID !== ref.value) return { ok: false, why: "opencode shows another session than the one the pane names" };
      if (hello.serverPid === null) return { ok: false, why: "opencode's server did not answer" };
      return { ok: true, body: { sessionID: hello.sessionID } };
    },
  });
}
