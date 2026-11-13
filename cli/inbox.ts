import { dirname, isAbsolute, join } from "node:path";

// The extension text, embedded at build time. `collie inbox install pi` writes THESE bytes, so the
// published binary needs no checkout (the reason `cli/docs-embed.ts` embeds the docs), and
// `cli/inbox.test.ts` fails when the embed and the file on disk differ.
import extensionText from "../pi-extension/collie-inbox.ts" with { type: "text" };
import pluginText from "../opencode-plugin/collie-inbox.ts" with { type: "text" };
import type { CliContext } from "./context.ts";
import { realpathVia } from "./hooks.ts";
import { EXIT, type Io } from "./io.ts";
import type { LinkReader } from "./link.ts";
import type { Files } from "./sys.ts";

// `collie inbox install|uninstall|status pi|opencode` — putting Collie's inbox (pi: ADR 0141, opencode:
// ADR 0143) into the agent's own global extension or plugin folder, and taking it back out. It is the person's opt-in verb: no other verb
// (bridge start, `doctor`, `update`) ever writes it, because it makes pi open a socket that types
// messages into the session.
//
// It copies the shape of `cli/hooks.ts`, and the same three guards:
//
//  1. OWNERSHIP BY A VERSION-PREFIXED MARKER. The extension's first line is `// collie-inbox v1`. A file
//     at the target without that prefix is someone else's: install refuses, uninstall leaves it, and
//     neither touches a byte. A file with our prefix at ANY version, or with other bytes, is replaced in
//     place (the self-heal); the same bytes write nothing. "Current" is decided by comparing bytes, never
//     by finding the marker and stopping.
//  2. A SYMLINKED FILE IS REFUSED, A SYMLINKED DIRECTORY IS RESOLVED. A rename onto a symlinked file
//     replaces the link, which is not what the person meant; a symlinked folder (stow, chezmoi) lands the
//     write in the real folder anyway, so `realpathVia` resolves it.
//  3. THE WRITE IS ATOMIC: temp file in the same folder, then rename.
//
// WHERE pi looks: `$PI_CODING_AGENT_DIR` (a leading `~` expanded) or `~/.pi/agent`, and `extensions/`
// directly under it. Read from pi's `dist/config.js` (`getAgentDir`, `ENV_AGENT_DIR`) and
// `core/package-manager.js` (`userDirs.extensions = join(globalBaseDir, "extensions")`) in
// `@mariozechner/pi-coding-agent`. Oh My Pi's `~/.omp/agent` is not covered.
//
// WHERE opencode looks (2.2.7, `opencode debug paths`): its config folder is `$OPENCODE_CONFIG_DIR`, else
// `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`, and the v2 TUI loader loads the plugin FOLDER
// `plugins/collie-inbox/` with `tui.ts` as its entry (a plain file listed in `tui.jsonc` is skipped). Either
// variable REPLACES the default folder: a copy left in `~/.config/opencode` does not load once one is set.
// opencode expands no `~` and reads a relative value against its working directory, so both are refused.

/** The harnesses that have an inbox, in the order `status` prints them. */
export const INBOX_HARNESSES = ["pi", "opencode"] as const;
type InboxHarness = (typeof INBOX_HARNESSES)[number];

/** The `inbox` sub-verbs, in the order the usage block prints them. */
export const INBOX_SUBCOMMANDS = ["install", "uninstall", "status"] as const;

/** What makes a file ours, at any version. The extension carries it as its own first line. */
export const INBOX_MARKER_PREFIX = "// collie-inbox v";


/**
 * The bytes `install pi` writes: the extension with LF line ends (a Windows checkout may hand CRLF).
 *
 * `with { type: "text" }` makes Bun bind the file's TEXT as the default export, but `tsc` ignores the
 * attribute and types a `.ts` import as the module it resolves to. `String()` is the identity on the
 * text at run time and states the type honestly without an assertion. `cli/inbox.test.ts` pins the value
 * to the file on disk.
 */
export const PI_EXTENSION_TEXT: string = String(extensionText).replaceAll("\r\n", "\n");

/** The bytes `install opencode` writes as the plugin folder's `tui.ts`, the same way. */
export const OPENCODE_PLUGIN_TEXT: string = String(pluginText).replaceAll("\r\n", "\n");

/** The marker version in a file's first line, or null when the file is not ours. */
export function inboxMarkerVersion(text: string): number | null {
  const first = text.split("\n", 1)[0] ?? "";
  if (!first.startsWith(INBOX_MARKER_PREFIX)) return null;
  const digits = /^\d+/u.exec(first.slice(INBOX_MARKER_PREFIX.length));
  return digits === null ? null : Number(digits[0]);
}

export interface InboxDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  readonly files: Files;
  /** `lstat` without following: the symlinked-file refusal, and the resolve of a symlinked folder. */
  readonly fs: LinkReader;
}

type Folder = { readonly kind: "ok"; readonly dir: string } | { readonly kind: "refused"; readonly reason: string };

/** What differs between the agents: where the file goes, what it is, and what the person is told. */
interface InboxSpec {
  /** The folder the file goes in, before links are resolved. */
  folder(ctx: Pick<CliContext, "home" | "env">): Folder;
  readonly fileName: string;
  readonly text: string;
  /** The folder is the plugin's own (`collie-inbox/`), so uninstall removes it once it is empty. */
  readonly ownFolder: boolean;
  /** "the pi inbox extension", for "nothing to remove — … is not installed." */
  readonly noun: string;
  readonly loadHint: string;
  readonly unloadHint: string;
}

/** pi's agent folder: `$PI_CODING_AGENT_DIR` with `~` expanded, else `~/.pi/agent`. Refused when relative. */
function piExtensionsDir(ctx: Pick<CliContext, "home" | "env">): Folder {
  const own = ctx.env.PI_CODING_AGENT_DIR?.trim() ?? "";
  const expanded =
    own === "" ? join(ctx.home, ".pi", "agent") : own === "~" ? ctx.home : own.startsWith("~/") ? join(ctx.home, own.slice(2)) : own;
  // A relative value means pi's own working directory, which no verb here can know.
  if (!isAbsolute(expanded)) {
    return { kind: "refused", reason: "PI_CODING_AGENT_DIR is a relative path, so Collie cannot tell which folder pi reads" };
  }
  return { kind: "ok", dir: join(expanded, "extensions") };
}

/** opencode's config folder, as `opencode debug paths` reports it, plus `plugins/collie-inbox`. */
function opencodePluginDir(ctx: Pick<CliContext, "home" | "env">): Folder {
  const own = ctx.env.OPENCODE_CONFIG_DIR ?? "";
  const xdg = ctx.env.XDG_CONFIG_HOME ?? "";
  const [name, config] =
    own !== "" ? ["OPENCODE_CONFIG_DIR", own] : xdg !== "" ? ["XDG_CONFIG_HOME", join(xdg, "opencode")] : [null, join(ctx.home, ".config", "opencode")];
  if (name !== null && !isAbsolute(config)) {
    return { kind: "refused", reason: `${name} is not an absolute path, so Collie cannot tell which folder opencode reads` };
  }
  return { kind: "ok", dir: join(config, "plugins", "collie-inbox") };
}

const SPECS = {
  pi: {
    folder: piExtensionsDir,
    fileName: "collie-inbox.ts",
    text: PI_EXTENSION_TEXT,
    ownFolder: false,
    noun: "the pi inbox extension",
    loadHint: "A running pi loads it after `/reload` or a restart.",
    unloadHint: "A running pi keeps it until `/reload` or a restart.",
  },
  opencode: {
    folder: opencodePluginDir,
    fileName: "tui.ts",
    text: OPENCODE_PLUGIN_TEXT,
    ownFolder: true,
    noun: "the opencode inbox plugin",
    loadHint: "A running opencode TUI loads it after a restart; until then its pane takes the screen path.",
    unloadHint: "A running opencode TUI keeps it until a restart.",
  },
} as const satisfies Record<InboxHarness, InboxSpec>;

type Resolved =
  | { readonly kind: "ok"; readonly path: string; readonly dir: string }
  | { readonly kind: "refused"; readonly reason: string };

/** The file this verb reads and writes, every guard applied: the folder resolved, the file not a link. */
function resolveTarget(deps: InboxDeps, spec: InboxSpec): Resolved {
  const folder = spec.folder(deps.ctx);
  if (folder.kind === "refused") return folder;
  const dir = realpathVia(deps.fs, folder.dir);
  const path = join(dir, spec.fileName);
  if (deps.fs.probe(path).kind === "symlink") return { kind: "refused", reason: `${path} is a symlink` };
  return { kind: "ok", path, dir };
}

export type InboxState =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "not-installed"; readonly path: string }
  | { readonly kind: "current"; readonly path: string }
  | { readonly kind: "stale"; readonly path: string; readonly at: number }
  | { readonly kind: "foreign"; readonly path: string };

/** One reading of the target, shared by all three verbs. Reads only. */
export function inboxState(deps: InboxDeps, harness: InboxHarness): InboxState {
  const spec = SPECS[harness];
  const target = resolveTarget(deps, spec);
  if (target.kind === "refused") return { kind: "refused", reason: target.reason };
  const text = deps.files.read(target.path);
  if (text === null) return { kind: "not-installed", path: target.path };
  const at = inboxMarkerVersion(text);
  if (at === null) return { kind: "foreign", path: target.path };
  return text === spec.text ? { kind: "current", path: target.path } : { kind: "stale", path: target.path, at };
}

function readHarness(deps: InboxDeps, args: readonly string[], verb: string): InboxHarness | null {
  const name = args[0];
  const found = INBOX_HARNESSES.find((h) => h === name);
  if (found !== undefined) return found;
  deps.io.err(`usage: collie inbox ${verb} {${INBOX_HARNESSES.join("|")}}`);
  if (name !== undefined && name !== "") deps.io.err(`  \`${name}\` has no inbox — only ${INBOX_HARNESSES.join(" and ")} do.`);
  return null;
}

/** `collie inbox install <harness>` — write the file, or replace our own older or changed copy. */
export function cmdInboxInstall(deps: InboxDeps, args: readonly string[]): number {
  const harness = readHarness(deps, args, "install");
  if (harness === null) return EXIT.USAGE;
  const spec = SPECS[harness];
  const state = inboxState(deps, harness);
  switch (state.kind) {
    case "refused":
      deps.io.err(`error: ${state.reason} — refusing to write there.`);
      return EXIT.FAIL;
    case "foreign":
      deps.io.err(`error: ${state.path} is not Collie's (it has no collie-inbox marker) — leaving it alone.`);
      deps.io.err(`  Move it aside, then re-run \`collie inbox install ${harness}\`.`);
      return EXIT.FAIL;
    case "current":
      deps.io.out(`${state.path} is already installed — no bytes changed.`);
      return EXIT.OK;
    case "not-installed":
    case "stale": {
      const temp = `${state.path}.collie-tmp`;
      try {
        deps.files.mkdirp(dirname(state.path));
        deps.files.write(temp, spec.text, 0o644);
        deps.files.rename(temp, state.path);
      } catch (err) {
        deps.files.remove(temp);
        deps.io.err(`error: could not write ${state.path} — ${err instanceof Error ? err.message : String(err)}`);
        return EXIT.FAIL;
      }
      deps.io.out(`✓ ${state.path}${state.kind === "stale" ? ` (replaced the older copy, v${state.at})` : ""}`);
      deps.io.out(`  ${spec.loadHint}`);
      return EXIT.OK;
    }
  }
}

/**
 * `collie inbox uninstall <harness>` — remove the file only when it carries our marker. opencode's plugin
 * folder is ours too, so it goes once it is empty: only a real folder, never a link to one, and never a
 * folder still holding something the person put there.
 */
export function cmdInboxUninstall(deps: InboxDeps, args: readonly string[]): number {
  const harness = readHarness(deps, args, "uninstall");
  if (harness === null) return EXIT.USAGE;
  const spec = SPECS[harness];
  const state = inboxState(deps, harness);
  switch (state.kind) {
    case "refused":
      deps.io.err(`error: ${state.reason} — refusing to remove it.`);
      return EXIT.FAIL;
    case "foreign":
      deps.io.err(`error: ${state.path} is not Collie's (it has no collie-inbox marker) — leaving it alone.`);
      return EXIT.FAIL;
    case "not-installed":
      deps.io.out(`nothing to remove — ${spec.noun} is not installed.`);
      return EXIT.OK;
    case "current":
    case "stale":
      try {
        deps.files.remove(state.path);
        const folder = spec.folder(deps.ctx);
        if (spec.ownFolder && folder.kind === "ok" && deps.files.entryType(folder.dir) === "directory" && deps.files.list(folder.dir).length === 0) {
          deps.files.removeTree(folder.dir);
        }
      } catch (err) {
        deps.io.err(`error: could not remove ${state.path} — ${err instanceof Error ? err.message : String(err)}`);
        return EXIT.FAIL;
      }
      deps.io.out(`✓ removed ${state.path}`);
      deps.io.out(`  ${spec.unloadHint}`);
      return EXIT.OK;
  }
}

function statusLine(harness: InboxHarness, state: InboxState): string {
  switch (state.kind) {
    case "refused":
      return `${harness}: refused — ${state.reason}`;
    case "not-installed":
      return `${harness}: not installed (${state.path}) — \`collie inbox install ${harness}\` writes it`;
    case "current":
      return `${harness}: installed and current (${state.path})`;
    case "stale":
      return `${harness}: installed but stale (v${state.at}, ${state.path}) — \`collie inbox install ${harness}\` heals it`;
    case "foreign":
      return `${harness}: a file that is not Collie's is in the way (${state.path}) — install leaves it alone`;
  }
}

/** `collie inbox status [<harness>]` — READ-ONLY. It reports; it never repairs. Bare: one line per agent. */
export function cmdInboxStatus(deps: InboxDeps, args: readonly string[]): number {
  let harnesses: readonly InboxHarness[] = INBOX_HARNESSES;
  if (args.length > 0) {
    const one = readHarness(deps, args, "status");
    if (one === null) return EXIT.USAGE;
    harnesses = [one];
  }
  for (const harness of harnesses) deps.io.out(statusLine(harness, inboxState(deps, harness)));
  return EXIT.OK;
}

export function inboxUsage(): string {
  return `usage: collie inbox {${INBOX_SUBCOMMANDS.join("|")}} {${INBOX_HARNESSES.join("|")}}`;
}

/** The parent verb. Reached by a bare `collie inbox` or a misspelt sub-verb, as `cmdHooks` is. */
export function cmdInbox(deps: InboxDeps, args: readonly string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "install":
      return cmdInboxInstall(deps, rest);
    case "uninstall":
      return cmdInboxUninstall(deps, rest);
    case "status":
      return cmdInboxStatus(deps, rest);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") deps.io.err(`error: unknown inbox subcommand \`${sub}\``);
      deps.io.err(inboxUsage());
      deps.io.err("  install     write the agent's inbox that hands a phone message to its live session: `inbox install pi`");
      deps.io.err("  uninstall   remove it again, only when it is Collie's: `inbox uninstall opencode`");
      deps.io.err("  status      whether it is installed, current or stale (reads only)");
      return EXIT.USAGE;
  }
}
