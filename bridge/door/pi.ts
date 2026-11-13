// pi's door (ADR 0141): the inbox extension in pi's own process (`pi-extension/collie-inbox.ts`), reached
// over its private unix socket (`inbox.ts`). It hands the text to `pi.sendUserMessage`, so no key reaches
// the pane.
//
// THE BINDING (ADR 0141 point 3). pi says which session file it writes; the multiplexer (Herdr's
// `agent_session`) or a beacon says which session the pane runs. The door binds only when the two are
// the same path, byte for byte. A pane that names no path, a pi session with no file, or another file
// refuses, and the send takes the screen path. Neither side is resolved or cleaned first: a check that
// made two spellings agree would bind where the two sides did not say the same thing.

import type { BeaconMatcher } from "../beacon/decorate.ts";
import { parseInboxHello } from "../beacon/parse.ts";
import type { AgentSessionRef } from "../journal/types.ts";
import type { Door } from "./door.ts";
import { inboxDoor, type InboxIo } from "./inbox.ts";

export { HELLO_MS, INBOX_MAX, SYSTEM_INBOX_IO, type InboxIo, type InboxReply } from "./inbox.ts";

/** The harness id pi's door serves. */
export const PI_DOOR = "pi";

/** What pi's door needs from the session it serves. */
export interface PiDoorDeps {
  /** The inbox folder (`inboxDir`). */
  readonly dir: string;
  /** The multiplexer's beacon matcher: which raw marker names which of its panes. */
  readonly matcher: BeaconMatcher;
  /** The session the multiplexer or a beacon names on the pane now (`AgentView.agentSession`). */
  sessionOf(paneId: string): AgentSessionRef | undefined;
  readonly io?: InboxIo;
}

/** pi's door for one session. */
export function piDoor(deps: PiDoorDeps): Door {
  return inboxDoor({
    id: PI_DOOR,
    dir: deps.dir,
    matcher: deps.matcher,
    io: deps.io,
    parse: parseInboxHello,
    bind(hello, paneId) {
      const ref = deps.sessionOf(paneId);
      if (ref?.kind !== "path") return { ok: false, why: "the pane names no pi session file" };
      if (hello.sessionFile === null) return { ok: false, why: "pi's session has no file" };
      if (hello.sessionFile !== ref.value) return { ok: false, why: "pi's session file is not the one the pane names" };
      return { ok: true, body: {} };
    },
  });
}
