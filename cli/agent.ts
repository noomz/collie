import { EXIT } from "./io.ts";
import { socketPaths, type WalkyDeps } from "./walky.ts";
import { PROMPT_NO_PANE, PROMPT_OUTCOMES, type PromptOutcome } from "../bridge/agent-prompt.ts";
import { asJsonString, parseJsonObject } from "../web/src/lib/json.ts";

// `collie agent prompt <pane> <text>` (T30, SPEC V38, V39): a send from a terminal that takes the SAME
// route as the phone's. The CLI writes one `agent.prompt` line to the running bridge's local socket
// (the walky socket: its mode is the credential), and the bridge runs its Send route, the agent's own
// door first and the screen path only on a refusal before `submit` (ADR 0141). This file holds no send
// code and no second path; with no bridge running it sends nothing.
//
// What it prints is the journal's word, never the door's reply (V9): landed, queued, merged or changed,
// refused (and why), or unconfirmed (the wait ended before the journal showed it). Exit 0 only for landed
// and queued. Plain `herdr agent prompt` is unchanged and still types.

/** The usage line. */
export const AGENT_PROMPT_USAGE = "usage: collie agent prompt <pane> <text...>   (text from stdin when none is given)";

/** The CLI waits for the bridge's journal wait (15 s) and a little over. */
export const PROMPT_ASK_MS = 30_000;

export const NO_BRIDGE_TEXT = "no running Collie bridge answered on this machine, so nothing was sent";

/** What each outcome says, and the exit code it takes (V39). */
const SAYS = {
  landed: { line: "landed: the agent took it as its own turn", exit: EXIT.OK },
  queued: { line: "queued: the agent holds it for after its running turn", exit: EXIT.OK },
  merged: { line: "merged or changed: the agent's journal shows a turn that holds the text, but not exactly it", exit: EXIT.FAIL },
  refused: { line: "refused: nothing was sent", exit: EXIT.REFUSED },
  unconfirmed: { line: "unconfirmed: the agent's journal did not show the text in time; it may still arrive, do not send it again blind", exit: EXIT.STATE },
} as const satisfies Record<PromptOutcome, { readonly line: string; readonly exit: number }>;

function isOutcome(word: string | undefined): word is PromptOutcome {
  return PROMPT_OUTCOMES.some((outcome) => outcome === word);
}

/** `collie agent prompt <pane> <text...>`. */
export async function cmdAgentPrompt(deps: WalkyDeps, args: readonly string[]): Promise<number> {
  const [pane, ...rest] = args;
  if (pane === undefined || pane === "") {
    deps.io.err(AGENT_PROMPT_USAGE);
    return EXIT.USAGE;
  }
  let text = rest.join(" ");
  if (text.trim() === "" && !deps.stdinIsTty) text = (await deps.readStdin()).replace(/\n$/u, "");
  if (text.trim() === "") {
    deps.io.err(AGENT_PROMPT_USAGE);
    return EXIT.USAGE;
  }
  const requestId = deps.mintId?.() ?? `cli-${crypto.randomUUID()}`;
  const line = `${JSON.stringify({ v: 1, op: "agent.prompt", markers: [], pane, text, requestId })}\n`;
  let heard = false;
  for (const path of socketPaths(deps)) {
    // A late socket may still be running the send: one request id, asked of one bridge, never retyped.
    const raw = await deps.ask(path, line, PROMPT_ASK_MS).catch(() => undefined);
    if (raw === null) continue;
    heard = true;
    if (raw === undefined) {
      deps.io.err("unconfirmed: the bridge took the request and did not answer in time; it may still arrive, do not send it again blind");
      return SAYS.unconfirmed.exit;
    }
    const answer = parseJsonObject(raw);
    if (answer === undefined) continue;
    if (answer.ok !== true) {
      const error = asJsonString(answer.error) ?? "failed";
      if (error === PROMPT_NO_PANE || error === "not here") continue;
      deps.io.err(`refused: ${error}`);
      return EXIT.REFUSED;
    }
    const outcome = asJsonString(answer.outcome);
    if (!isOutcome(outcome)) continue;
    const says = SAYS[outcome];
    const via = asJsonString(answer.via);
    const reason = asJsonString(answer.reason);
    const detail = asJsonString(answer.detail);
    const tail = [via === undefined ? "" : ` (via ${via})`, reason === undefined ? "" : ` [${reason}]`].join("");
    const write = says.exit === EXIT.OK ? deps.io.out : deps.io.err;
    write(`${says.line}${tail}`);
    if (detail !== undefined) write(detail);
    return says.exit;
  }
  deps.io.err(heard ? `${PROMPT_NO_PANE}: ${pane}` : NO_BRIDGE_TEXT);
  return heard ? EXIT.REFUSED : EXIT.UNREACHABLE;
}

/** `collie agent <subcommand>`: only `prompt` today. */
export async function cmdAgent(deps: WalkyDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "prompt") return await cmdAgentPrompt(deps, rest);
  if (sub !== undefined && sub !== "" && sub !== "help") deps.io.err(`error: unknown agent subcommand \`${sub}\``);
  deps.io.err(AGENT_PROMPT_USAGE);
  return EXIT.USAGE;
}
