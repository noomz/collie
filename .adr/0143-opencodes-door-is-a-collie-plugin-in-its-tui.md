# 0143: opencode's door is a Collie plugin in its TUI

- **Status:** Proposed (2026-11-13), not built; for the maintainer to accept or turn down
- **Date:** 2026-11-13, after a throwaway PoC of opencode 2.2.7 (service, `--standalone`, Herdr
  0.9.5 two-pane) against a logging fake model
- **Shipped in:** pending
- **Trail:** the bridge as an HTTP client of opencode's service (`service.json`, HTTP Basic,
  `POST /api/session/{sid}/prompt`) · a process witness (the service's `/api/info` pid matched to
  the pane's process tree with `ps` / `lsof`) · Herdr reporting the server a pane is attached to ·
  binding by the screen alone · the `prompt_async` and `/tui/*` routes ADR 0141 left open, which
  opencode 2.x no longer has ·
  [ADR 0103](./0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md) ·
  [ADR 0117](./0117-a-steer-is-the-persons-choice-never-the-default.md) ·
  [ADR 0122](./0122-a-queued-message-is-a-card-until-the-journal-shows-it.md) ·
  [ADR 0141](./0141-a-door-beats-the-screen-and-the-journal-settles-the-send.md) ·
  [ADR 0142](./0142-the-bridge-dials-the-hermes-gateway-on-loopback-with-a-ticket-from-its-control-socket.md)

## Context

**opencode has a door, and the obvious way through it sends to the wrong pane.** An opencode TUI
is a client of a server. Usually that is the shared service named in
`~/.local/state/opencode/service.json`, which holds its URL and an HTTP Basic password. The service
takes a user turn with `POST /api/session/{sid}/prompt` and queues it behind a running turn (leg
L4, measured).

**A standalone TUI shares the service's store.** `opencode --standalone`, a service disabled in
config, or no service with `autostart` off each run their own server over the same `opencode.db`.
The shared service then answers 200 for that pane's session, and a send to it runs: a journal row
and a model reply that the pane's TUI never shows. The journal would call it delivered. Herdr
reports the standalone pane's session exactly like the others, and the service lists no attached
clients, so the bridge cannot tell the two apart from outside.

**The TUI itself knows its server.** A v2 TUI plugin runs `setup(api)` once in each TUI process,
and `api.client` is that TUI's own client to whichever server it uses. A plugin that submits
through it reaches the pane's own session by construction, on the service, on `--standalone` and
on `--server` alike (legs P2, P3). After `opencode service restart` on the same port, the old
client still delivers (P4).

## Decision (proposed)

**opencode's door is a Collie plugin running inside the person's opencode TUI, reached over its
private Unix socket like pi's inbox. The bridge never speaks HTTP to opencode.**

1. **The plugin is the person's opt-in** (ADR 0141 point 6). `collie inbox install opencode`
   writes the plugin folder `~/.config/opencode/plugins/collie-inbox/` with its `tui.ts` entry
   and an ownership marker. opencode's v2 loader loads a plugin folder, and it skips a local file
   listed in `tui.jsonc`. `uninstall` removes only what it wrote, and `status` says whether a
   running TUI has loaded it. A TUI started before the install keeps the screen path until it is
   restarted, and the verb says so.
2. **Its socket follows ADR 0141 point 7.** It is named and found the way pi's inbox is, in a
   folder of its own (`<state>/collie/inbox/opencode/`), mode 0600 in a 0700 folder, with every
   path part walked before the bridge connects. It answers `/hello` (the session the TUI's router
   shows, the markers it sees, the server pid), `/send` and `/queue`.
3. **The binding is Herdr's.** `hello.sessionID` must equal the pane's Herdr `agent_session`.
   Anything else refuses and the pane takes the screen path. No socket that names the pane, or a
   multiplexer that names no scope, is a door that is absent. opencode emits no beacon, so on
   tmux and zellij the pane keeps the screen path, as pi does today.
4. **Every send queues.** opencode's default delivery is `steer`, which merges the text into the
   running turn. The plugin always sends `delivery: "queue"`. A steer happens only when the person
   chooses it (ADR 0117). At `/send` the plugin reads the router again: a TUI that moved to
   another session answers 409 and sends nothing.
5. **Replay is the server's, checked by text.** The request id goes to opencode as
   `msg_collie<hex>`, because the server needs the `msg_` prefix. The same id returns the stored
   item and runs nothing, which is `replayed`. The server also answers 200 for the same id with
   different text, handing back the old text, so a stored text that is not the sent text refuses.
6. **The journal settles the send** (ADR 0141 point 4), through `bridge/journal/opencode.ts`. A
   client error before the request is written is a refusal and falls back. An error or timeout
   after the write keeps the card until the journal settles it, with no fallback.

Not chosen:

- **The bridge as an HTTP client of the service.** It sends a standalone pane's text to a session
  that pane's TUI never shows, and it would make the bridge read a password file and open a new
  outbound call (ADR 0142's kind) to do it.
- **A process witness** (`/api/info` pid, the pane's process tree, an open TCP connection to the
  service's port). It spawns `ps` or `lsof` per send, against the posture, and depends on
  opencode's internals.
- **Herdr reporting the attached server.** It is a fork patch and an upstream ask, it binds on
  Herdr only, and the plugin makes it unnecessary. It may strengthen the binding later.
- **Binding by the screen alone.** A standalone pane and a service pane can show the same session.

## Consequences

- **The security posture does not change.** The bridge reads no `service.json` and no password,
  and opens no HTTP connection to opencode. The door is a local socket under ADR 0141 point 7,
  so `CLAUDE.md`'s list of outbound calls stays as it is.
- **Collie ships code that runs inside the person's opencode.** The plugin is Collie's to keep
  working across opencode releases. When the plugin API changes, the plugin fails to load or its
  `hello` fails, and the pane falls back to the screen path.
- **A queued send and Escape behave differently from pi.** Escape on opencode's running turn
  leaves a queued item in the server's inbox. The item runs after the next turn at the desk and
  never returns to the editor (L5, L5b). The card stays queued until the journal settles it, late
  if need be, or ADR 0122's bound ends it `unconfirmed`. `returned` follows ADR 0141's rule only:
  the item left the inbox and the journal shows no turn with its text.
- **Open:** a service restart onto a new port. The stale client must fail before it writes, which
  is a refusal. That case is not measured.
