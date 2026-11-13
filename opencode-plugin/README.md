# Collie inbox for opencode

An [opencode](https://opencode.ai) TUI plugin that lets Collie hand a phone message to the pane's live
session through the TUI's own client, instead of typing it into the terminal (ADR 0143).

**This plugin is experimental.** The bridge's opencode door that talks to it is in progress.

What it does:

- No key reaches the pane, so a draft in opencode's editor stays.
- The message goes to the server this TUI uses, whether that is the shared service, `--standalone` or
  `--server`, because it goes through the TUI's own client.
- It always queues as its own turn. It steers the running turn only when the person chose steer.
- A request id it has seen before with the same text answers `replayed` and runs nothing. The same id
  with other text is refused.
- What it answers is a hint. Collie settles the send from opencode's own store.

It listens on a private unix socket, `~/.local/state/collie/inbox/opencode/<pane key>.sock` (under
`XDG_STATE_HOME` when that is set). The pane key is the one that names the pane's beacon. The socket is
mode 0600 in a 0700 folder. It opens nothing outside a multiplexer pane (tmux, zellij, Herdr,
herdr-core, tern).

## Routes

| Route | Body | Answer |
|---|---|---|
| `GET /hello` | none | `200 {agent, inbox, pid, sessionID, server: {pid}, markers}` |
| `POST /send` | `{text, requestId, sessionID, steer?}` | `202 {state: "taken" \| "queued" \| "steered", replayed?}` |
| `GET /queue` | none | `200 {pending, left}`: request ids still in opencode's inbox, and ids that left it |

`/send` refuses without sending when the body is bad (`400`), the body is over 512 KiB (`413`), the TUI
shows another session (`409 moved`), or the id was sent with other text (`409 replay-mismatch`). When
opencode's server refuses, it answers `404`, `400` or `409`. Any other error answers `502 unsure`: the
message may have reached opencode, so it must not be sent again.

## Install

opencode loads a plugin folder, `~/.config/opencode/plugins/collie-inbox/`, with this file as its
`tui.ts` entry. Restart a running opencode TUI to load it.
