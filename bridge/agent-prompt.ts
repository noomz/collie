// `collie agent prompt <pane> <text>` on the bridge's side (SPEC V38, V39). One send through the SAME
// Send route the phone uses (`sendRoute`): the agent's own door first, the screen path only on a
// refusal before `submit` (ADR 0141), the receipt with `via`. This file adds no send path of its own.
//
// What it adds is the answer. A door's own reply is a hint (ADR 0141 point 4), so the outcome here is
// read from the receipt the journal settles: `effective` is landed, `late: "merged"` is merged or
// changed, a queued send is queued. A send the journal has not shown within the wait ends
// `unconfirmed`, never `landed`.

import type { JsonValue } from "../web/src/lib/json";
import type { SendAnswer, SendReceiptRow } from "../web/src/lib/surface/send.ts";

/** How the CLI's send ended (V39). `refused` carries the reason; `unconfirmed` is the wait's bound. */
export const PROMPT_OUTCOMES = ["landed", "queued", "merged", "refused", "unconfirmed"] as const;
export type PromptOutcome = (typeof PROMPT_OUTCOMES)[number];

/** What the socket answers a `agent.prompt` request with. */
export type AgentPromptAnswer =
  | { readonly ok: true; readonly outcome: PromptOutcome; readonly requestId: string; readonly via?: string; readonly reason?: string; readonly detail?: string }
  | { readonly ok: false; readonly error: string };

/** An answer being built: its optional words are set one statement at a time. */
interface PromptEnded {
  ok: true;
  outcome: PromptOutcome;
  requestId: string;
  via?: string;
  reason?: string;
  detail?: string;
}

/** The request's fields, as the socket parsed them. */
export interface AgentPromptRequest {
  readonly pane: string;
  readonly text: string;
  readonly requestId: string;
}

/** What this file reads of a session runtime: the route's runtime plus the receipts of one pane. */
export interface PromptRuntime {
  readonly name: string;
  readonly send?: { recent(paneId: string, limit?: number): SendReceiptRow[] };
}

export interface AgentPromptDeps<R extends PromptRuntime> {
  /** The session that holds the pane, or null. */
  runtimeOf(paneId: string): R | null;
  /** The sessions' send route, as the bridge's `/api/send` calls it. Injected so this file imports no server. */
  send(rt: R, body: JsonValue): Promise<Response>;
  /** How long a settled-but-unproved send is waited for before it ends `unconfirmed`. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Default wait for the journal's proof. The ADR 0122 bound is minutes; a terminal verb does not wait that long. */
export const PROMPT_WAIT_MS = 15_000;
export const PROMPT_POLL_MS = 250;

/** The word for a pane the bridge holds no session for. */
export const PROMPT_NO_PANE = "no such pane on this bridge";

const OPEN_BUT_NOT_SENT = new Set(["typed_not_submitted", "expired", "cancelled", "discarded"]);

/** How a row of the receipts stands: an outcome, and for a refusal the reason (null when it has none). */
interface Standing {
  readonly outcome: PromptOutcome;
  readonly reason: string | null;
}

/**
 * What a row of the receipts says now, or null while the journal has not settled it. A door's `taken`
 * send is a card until the journal shows its turn (ADR 0141 point 4), and an `unknown` may still be
 * settled `effective` by that proof, so neither ends the wait; only the bound does.
 */
function settled(row: SendReceiptRow): Standing | null {
  if (row.late === "merged") return { outcome: "merged", reason: null };
  if (row.late === "returned") return { outcome: "refused", reason: "returned" };
  if (row.outcome === "effective" || row.outcome === "steered") return { outcome: "landed", reason: null };
  if (row.outcome === "refused") return { outcome: "refused", reason: row.reason ?? null };
  if (OPEN_BUT_NOT_SENT.has(row.outcome)) return { outcome: "refused", reason: row.outcome };
  if (row.door === "taken" || row.door === "replayed") return null;
  if (row.outcome === "held" || row.door === "queued" || row.queued === true) return { outcome: "queued", reason: null };
  return null;
}

/** An answer that ended in `outcome`, with the optional words set only when there are some. */
function ended(requestId: string, outcome: PromptOutcome, via: string | undefined, reason: string | null, detail: string | undefined): AgentPromptAnswer {
  const answer: PromptEnded = { ok: true, outcome, requestId };
  if (via !== undefined) answer.via = via;
  if (reason !== null) answer.reason = reason;
  if (detail !== undefined && outcome === "refused") answer.detail = detail;
  return answer;
}

/** One CLI prompt: send through the Send route, then read what the journal proved. Never throws. */
export async function answerAgentPrompt<R extends PromptRuntime>(deps: AgentPromptDeps<R>, request: AgentPromptRequest): Promise<AgentPromptAnswer> {
  const rt = deps.runtimeOf(request.pane);
  if (rt === null || rt.send === undefined) return { ok: false, error: PROMPT_NO_PANE };
  const body: JsonValue = { id: request.requestId, pane: request.pane, text: request.text, mode: "send" };
  let response: Response;
  try {
    response = await deps.send(rt, body);
  } catch (err) {
    return { ok: false, error: `the send failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (response.status === 404) return { ok: false, error: PROMPT_NO_PANE };
  if (!response.ok) return { ok: false, error: `the bridge refused the request (${String(response.status)})` };
  // SAFETY: the Send route answers a `SendAnswer` as JSON on a 200; only `receipt` and `detail` are read, both optional.
  const answer = (await response.json()) as SendAnswer;
  const receipt = answer.receipt;
  if (receipt === undefined) return { ok: false, error: answer.detail ?? "the bridge answered with no receipt" };
  if (receipt.outcome === "refused") return ended(request.requestId, "refused", receipt.via, receipt.reason ?? null, receipt.detail);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = now() + (deps.waitMs ?? PROMPT_WAIT_MS);
  // The journal's proof is written back to the receipt; read it until it settles or the wait ends.
  for (;;) {
    const row = rt.send.recent(request.pane, 25).find((candidate) => candidate.requestId === request.requestId);
    const end = row === undefined ? null : settled(row);
    if (end !== null) return ended(request.requestId, end.outcome, receipt.via, end.reason, receipt.detail);
    if (now() >= until) return ended(request.requestId, "unconfirmed", receipt.via, null, undefined);
    await sleep(deps.pollMs ?? PROMPT_POLL_MS);
  }
}
