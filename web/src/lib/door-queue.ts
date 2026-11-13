// What Stop does to a message Collie queued behind a running turn, by the door it went through (SPEC V37).
//
// A screen send waits in the harness's own queue, and Stop puts it back in the input box as a draft
// (ADR 0122). pi's door does the same: Escape hands its follow-up back to the editor. opencode's door
// does not: the item stays in the server's inbox and runs after the next desk turn, so "stop the turn to
// take it back" would be false there. A send can still leave the inbox without running, through the TUI's
// queued-prompts list: delete drops it, undo puts it back in the box, and nothing tells the two apart.
// Any other door's queue is unmeasured, so the phone promises nothing of it.
//
// `via` is the receipt card's door id, absent for the screen (and from a bridge one release behind,
// which then keeps today's words).

import { SCREEN } from "./surface/send";

/** Where Stop leaves a queued message: back in the input `box`, still in the agent's `inbox`, or `unknown`. */
export type StopLeaves = "box" | "inbox" | "unknown";

/** The doors whose agent hands a queued message back to its box on Stop, beside the screen. */
const BACK_TO_BOX: ReadonlySet<string> = new Set(["pi"]);
/** The doors whose agent keeps a queued message in its inbox through Stop. */
const KEPT_IN_INBOX: ReadonlySet<string> = new Set(["opencode"]);

/** What Stop does to a message queued through `via`. */
export function stopLeaves(via: string | undefined): StopLeaves {
  if (via === undefined || via === SCREEN || BACK_TO_BOX.has(via)) return "box";
  return KEPT_IN_INBOX.has(via) ? "inbox" : "unknown";
}
