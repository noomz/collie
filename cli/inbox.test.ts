import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { capture, context, fakeFiles, fakeLinkFs, HOME } from "./fakes.ts";
import type { Environment } from "./context.ts";
import {
  cmdInbox,
  cmdInboxInstall,
  cmdInboxStatus,
  cmdInboxUninstall,
  INBOX_MARKER_PREFIX,
  type InboxDeps,
  inboxMarkerVersion,
  OPENCODE_PLUGIN_TEXT,
  PI_EXTENSION_TEXT,
} from "./inbox.ts";
import { EXIT } from "./io.ts";
import type { LinkProbe } from "./link.ts";

// `collie inbox install|uninstall|status pi|opencode`. The filesystem and the symlink probe are fakes, so no
// test reaches a real `~/.pi`.

const EXT_DIR = join(HOME, ".pi", "agent", "extensions");
const TARGET = join(EXT_DIR, "collie-inbox.ts");
/** Where a stow-style `extensions` link points. */
const DOTFILES = join("/dotfiles", "pi-extensions");

function deps(
  over: { env?: Environment; files?: Record<string, string>; probes?: Record<string, LinkProbe> } = {},
): InboxDeps & { io: ReturnType<typeof capture>; files: ReturnType<typeof fakeFiles> } {
  const io = capture();
  const files = fakeFiles(over.files ?? {});
  return { ctx: context(over.env ?? {}), io, files, fs: fakeLinkFs(over.probes ?? {}) };
}

const text = (d: ReturnType<typeof deps>, path = TARGET): string | undefined => d.files.entries.get(path)?.text;

describe("the embedded extension", () => {
  test("is exactly the file on disk, so the binary never ships a stale copy", () => {
    const onDisk = readFileSync(join(import.meta.dir, "..", "pi-extension", "collie-inbox.ts"), "utf8");
    expect(PI_EXTENSION_TEXT).toBe(onDisk.replaceAll("\r\n", "\n"));
  });

  test("starts with the ownership marker, and the marker's version reads back", () => {
    expect(PI_EXTENSION_TEXT.startsWith(INBOX_MARKER_PREFIX)).toBe(true);
    expect(inboxMarkerVersion(PI_EXTENSION_TEXT)).toBe(1);
    expect(inboxMarkerVersion("// collie-inbox v7\nrest")).toBe(7);
    expect(inboxMarkerVersion("// something else\n")).toBeNull();
    expect(inboxMarkerVersion("// collie-inbox v\n")).toBeNull();
    expect(inboxMarkerVersion("")).toBeNull();
  });
});

describe("install pi", () => {
  test("a fresh install writes the embedded bytes, creates the folder and says /reload", () => {
    const d = deps();
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d)).toBe(PI_EXTENSION_TEXT);
    expect(d.files.entryTypes.get(EXT_DIR)).toBe("directory");
    expect(d.io.stdout.join("\n")).toContain(`✓ ${TARGET}`);
    expect(d.io.stdout.join("\n")).toContain("/reload");
  });

  test("writes a temp file in the same folder and renames it into place", () => {
    const d = deps();
    cmdInboxInstall(d, ["pi"]);
    expect(d.files.ops.map((op) => op.replaceAll("\\", "/"))).toEqual([`mv ${TARGET}.collie-tmp ${TARGET}`.replaceAll("\\", "/")]);
    expect(d.files.entries.has(`${TARGET}.collie-tmp`)).toBe(false);
    expect(d.files.entries.get(TARGET)?.mode).toBe(0o644);
  });

  test("a second install writes nothing and says so", () => {
    const d = deps({ files: { [TARGET]: PI_EXTENSION_TEXT } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(d.files.ops).toEqual([]);
    expect(d.io.stdout.join("\n")).toContain("already installed");
    expect(d.io.stdout.join("\n")).not.toContain("/reload");
  });

  test("an older marker version is replaced in place", () => {
    const old = PI_EXTENSION_TEXT.replace(/^.*\n/u, "// collie-inbox v0\n");
    const d = deps({ files: { [TARGET]: old } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d)).toBe(PI_EXTENSION_TEXT);
    expect(d.io.stdout.join("\n")).toContain("replaced the older copy, v0");
    expect(d.io.stdout.join("\n")).toContain("/reload");
  });

  test("our marker with changed bytes is healed", () => {
    const d = deps({ files: { [TARGET]: `${PI_EXTENSION_TEXT}// hand edit\n` } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d)).toBe(PI_EXTENSION_TEXT);
  });

  test("a file without our marker is someone else's: refused, untouched", () => {
    const theirs = "export default function () {}\n";
    const d = deps({ files: { [TARGET]: theirs } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(text(d)).toBe(theirs);
    expect(d.files.ops).toEqual([]);
    expect(d.io.stderr.join("\n")).toContain("not Collie's");
  });

  test("a marker that is not on the first line does not make a file ours", () => {
    const theirs = `// mine\n${INBOX_MARKER_PREFIX}1\n`;
    const d = deps({ files: { [TARGET]: theirs } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(text(d)).toBe(theirs);
  });

  test("a symlinked target file is refused and nothing is written", () => {
    const d = deps({ probes: { [TARGET]: { kind: "symlink", target: "/nix/store/x-collie-inbox.ts" } } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(d.files.entries.size).toBe(0);
    expect(d.files.ops).toEqual([]);
    expect(d.io.stderr.join("\n")).toContain("is a symlink");
  });

  test("a symlinked extensions folder is resolved, and the file lands at the real path", () => {
    const d = deps({ probes: { [EXT_DIR]: { kind: "symlink", target: DOTFILES } } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d, join(DOTFILES, "collie-inbox.ts"))).toBe(PI_EXTENSION_TEXT);
    expect(d.files.entries.has(TARGET)).toBe(false);
  });

  test("PI_CODING_AGENT_DIR moves the target, as it moves pi's own agent folder", () => {
    const d = deps({ env: { PI_CODING_AGENT_DIR: "/srv/pi-agent" } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d, join("/srv/pi-agent", "extensions", "collie-inbox.ts"))).toBe(PI_EXTENSION_TEXT);
    expect(d.files.entries.has(TARGET)).toBe(false);
  });

  test("PI_CODING_AGENT_DIR expands a leading ~ the way pi does", () => {
    const d = deps({ env: { PI_CODING_AGENT_DIR: "~/work/pi" } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d, join(HOME, "work", "pi", "extensions", "collie-inbox.ts"))).toBe(PI_EXTENSION_TEXT);
  });

  test("a relative PI_CODING_AGENT_DIR is refused: no folder can be named", () => {
    const d = deps({ env: { PI_CODING_AGENT_DIR: "agent" } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(d.files.entries.size).toBe(0);
    expect(d.io.stderr.join("\n")).toContain("relative path");
  });

  test("a failed write removes the temp file and reports one line", () => {
    const d = deps();
    d.files.unrenamable.add(`${TARGET}.collie-tmp`);
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(d.files.entries.size).toBe(0);
    expect(d.io.stderr.join("\n")).toContain("could not write");
  });

  test("a missing or unknown harness is a usage error", () => {
    for (const args of [[], ["claude"], [""]]) {
      const d = deps();
      expect(cmdInboxInstall(d, args)).toBe(EXIT.USAGE);
      expect(d.io.stderr[0]).toBe("usage: collie inbox install {pi|opencode}");
      expect(d.files.entries.size).toBe(0);
    }
  });
});

describe("uninstall pi", () => {
  test("removes our file and says /reload", () => {
    const d = deps({ files: { [TARGET]: PI_EXTENSION_TEXT } });
    expect(cmdInboxUninstall(d, ["pi"])).toBe(EXIT.OK);
    expect(d.files.entries.has(TARGET)).toBe(false);
    expect(d.io.stdout.join("\n")).toContain("/reload");
  });

  test("removes our file at an older version too", () => {
    const d = deps({ files: { [TARGET]: "// collie-inbox v0\nold\n" } });
    expect(cmdInboxUninstall(d, ["pi"])).toBe(EXIT.OK);
    expect(d.files.entries.has(TARGET)).toBe(false);
  });

  test("leaves a foreign file and names it", () => {
    const theirs = "// not ours\n";
    const d = deps({ files: { [TARGET]: theirs } });
    expect(cmdInboxUninstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(text(d)).toBe(theirs);
    expect(d.io.stderr.join("\n")).toContain(TARGET);
  });

  test("a symlinked file is left alone", () => {
    const d = deps({
      files: { [TARGET]: PI_EXTENSION_TEXT },
      probes: { [TARGET]: { kind: "symlink", target: "/nix/store/x" } },
    });
    expect(cmdInboxUninstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(text(d)).toBe(PI_EXTENSION_TEXT);
  });

  test("with nothing installed it says so and succeeds", () => {
    const d = deps();
    expect(cmdInboxUninstall(d, ["pi"])).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("nothing to remove");
  });

  test("a missing harness is a usage error", () => {
    expect(cmdInboxUninstall(deps(), [])).toBe(EXIT.USAGE);
  });
});

describe("status", () => {
  const stateOf = (d: ReturnType<typeof deps>, args: string[] = ["pi"]): string => {
    expect(cmdInboxStatus(d, args)).toBe(EXIT.OK);
    return d.io.stdout.join("\n");
  };

  test("not installed", () => {
    const d = deps();
    expect(stateOf(d)).toContain("not installed");
    expect(d.files.entries.size).toBe(0);
  });

  test("installed and current", () => {
    const d = deps({ files: { [TARGET]: PI_EXTENSION_TEXT } });
    expect(stateOf(d)).toContain("installed and current");
    expect(d.files.ops).toEqual([]);
  });

  test("stale: an older marker, and our marker with other bytes", () => {
    const older = deps({ files: { [TARGET]: "// collie-inbox v0\n" } });
    expect(stateOf(older)).toContain("installed but stale (v0");
    expect(stateOf(older)).toContain("collie inbox install pi");
    expect(text(older)).toBe("// collie-inbox v0\n");
    const edited = deps({ files: { [TARGET]: `${PI_EXTENSION_TEXT}x` } });
    expect(stateOf(edited)).toContain("installed but stale");
    expect(text(edited)).toBe(`${PI_EXTENSION_TEXT}x`);
  });

  test("a foreign file is in the way", () => {
    const d = deps({ files: { [TARGET]: "mine\n" } });
    expect(stateOf(d)).toContain("is not Collie's");
    expect(text(d)).toBe("mine\n");
  });

  test("a symlinked file is reported as refused", () => {
    const d = deps({ probes: { [TARGET]: { kind: "symlink", target: "/x" } } });
    expect(stateOf(d)).toContain("refused");
  });

  test("a bare `status` reports pi and opencode, and an unknown harness is a usage error", () => {
    const lines = stateOf(deps({ files: { [TARGET]: PI_EXTENSION_TEXT } }), []).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("pi: installed and current");
    expect(lines[1]).toStartWith("opencode: not installed");
    const d = deps();
    expect(cmdInboxStatus(d, ["claude"])).toBe(EXIT.USAGE);
  });
});

describe("the parent verb", () => {
  test("dispatches the three sub-verbs", () => {
    const d = deps();
    expect(cmdInbox(d, ["install", "pi"])).toBe(EXIT.OK);
    expect(cmdInbox(d, ["status", "pi"])).toBe(EXIT.OK);
    expect(cmdInbox(d, ["uninstall", "pi"])).toBe(EXIT.OK);
    expect(d.files.entries.has(TARGET)).toBe(false);
  });

  test("a bare or misspelt sub-verb prints the usage and exits with USAGE", () => {
    const bare = deps();
    expect(cmdInbox(bare, [])).toBe(EXIT.USAGE);
    expect(bare.io.stderr[0]).toBe("usage: collie inbox {install|uninstall|status} {pi|opencode}");
    const typo = deps();
    expect(cmdInbox(typo, ["instal"])).toBe(EXIT.USAGE);
    expect(typo.io.stderr[0]).toContain("unknown inbox subcommand `instal`");
  });
});

// opencode's plugin is a FOLDER, `plugins/collie-inbox/`, with `tui.ts` as its entry (ADR 0143 pt 1). The
// folder rules come from `poc-legs/t41-paths.log` (opencode 2.2.7): OPENCODE_CONFIG_DIR, else
// XDG_CONFIG_HOME/opencode, else ~/.config/opencode; either variable replaces the default.
const OC_DIR = join(HOME, ".config", "opencode", "plugins", "collie-inbox");
const OC_TARGET = join(OC_DIR, "tui.ts");

describe("the embedded opencode plugin", () => {
  test("is exactly the file on disk, and carries the same ownership marker", () => {
    const onDisk = readFileSync(join(import.meta.dir, "..", "opencode-plugin", "collie-inbox.ts"), "utf8");
    expect(OPENCODE_PLUGIN_TEXT).toBe(onDisk.replaceAll("\r\n", "\n"));
    expect(inboxMarkerVersion(OPENCODE_PLUGIN_TEXT)).toBe(1);
  });
});

describe("install opencode", () => {
  test("a fresh install writes tui.ts in its own plugin folder and says restart", () => {
    const d = deps();
    expect(cmdInboxInstall(d, ["opencode"])).toBe(EXIT.OK);
    expect(text(d, OC_TARGET)).toBe(OPENCODE_PLUGIN_TEXT);
    expect(d.files.entryTypes.get(OC_DIR)).toBe("directory");
    expect(d.files.entries.get(OC_TARGET)?.mode).toBe(0o644);
    const out = d.io.stdout.join("\n");
    expect(out).toContain(`✓ ${OC_TARGET}`);
    expect(out).toContain("after a restart");
    expect(out).not.toContain("/reload");
    expect(d.files.entries.has(TARGET)).toBe(false);
  });

  test("OPENCODE_CONFIG_DIR wins over XDG_CONFIG_HOME, which wins over ~/.config", () => {
    const own = deps({ env: { OPENCODE_CONFIG_DIR: "/srv/oc", XDG_CONFIG_HOME: "/srv/xdg" } });
    expect(cmdInboxInstall(own, ["opencode"])).toBe(EXIT.OK);
    expect(text(own, join("/srv/oc", "plugins", "collie-inbox", "tui.ts"))).toBe(OPENCODE_PLUGIN_TEXT);
    const xdg = deps({ env: { XDG_CONFIG_HOME: "/srv/xdg" } });
    expect(cmdInboxInstall(xdg, ["opencode"])).toBe(EXIT.OK);
    expect(text(xdg, join("/srv/xdg", "opencode", "plugins", "collie-inbox", "tui.ts"))).toBe(OPENCODE_PLUGIN_TEXT);
    const empty = deps({ env: { OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "" } });
    expect(cmdInboxInstall(empty, ["opencode"])).toBe(EXIT.OK);
    expect(text(empty, OC_TARGET)).toBe(OPENCODE_PLUGIN_TEXT);
  });

  test("a relative or ~ value is refused: opencode expands neither, so no folder can be named", () => {
    for (const env of [{ OPENCODE_CONFIG_DIR: "~/oc" }, { OPENCODE_CONFIG_DIR: "oc" }, { XDG_CONFIG_HOME: "cfg" }]) {
      const d = deps({ env });
      expect(cmdInboxInstall(d, ["opencode"])).toBe(EXIT.FAIL);
      expect(d.files.entries.size).toBe(0);
      expect(d.io.stderr.join("\n")).toContain("not an absolute path");
    }
  });

  test("a second install writes nothing; our older copy is healed; a foreign tui.ts is left alone", () => {
    const same = deps({ files: { [OC_TARGET]: OPENCODE_PLUGIN_TEXT } });
    expect(cmdInboxInstall(same, ["opencode"])).toBe(EXIT.OK);
    expect(same.files.ops).toEqual([]);
    const old = deps({ files: { [OC_TARGET]: "// collie-inbox v0\nold\n" } });
    expect(cmdInboxInstall(old, ["opencode"])).toBe(EXIT.OK);
    expect(text(old, OC_TARGET)).toBe(OPENCODE_PLUGIN_TEXT);
    const theirs = "export default { id: 'mine' }\n";
    const foreign = deps({ files: { [OC_TARGET]: theirs } });
    expect(cmdInboxInstall(foreign, ["opencode"])).toBe(EXIT.FAIL);
    expect(text(foreign, OC_TARGET)).toBe(theirs);
    expect(foreign.io.stderr.join("\n")).toContain("collie inbox install opencode");
  });

  test("a symlinked tui.ts is refused; a symlinked plugin folder lands the file at the real path", () => {
    const linkedFile = deps({ probes: { [OC_TARGET]: { kind: "symlink", target: "/nix/store/x" } } });
    expect(cmdInboxInstall(linkedFile, ["opencode"])).toBe(EXIT.FAIL);
    expect(linkedFile.files.entries.size).toBe(0);
    const linkedDir = deps({ probes: { [OC_DIR]: { kind: "symlink", target: "/dotfiles/oc-inbox" } } });
    expect(cmdInboxInstall(linkedDir, ["opencode"])).toBe(EXIT.OK);
    expect(text(linkedDir, join("/dotfiles/oc-inbox", "tui.ts"))).toBe(OPENCODE_PLUGIN_TEXT);
  });
});

describe("uninstall opencode", () => {
  test("removes tui.ts and the plugin folder it leaves empty, and says restart", () => {
    const d = deps();
    cmdInboxInstall(d, ["opencode"]);
    expect(cmdInboxUninstall(d, ["opencode"])).toBe(EXIT.OK);
    expect(d.files.entries.has(OC_TARGET)).toBe(false);
    expect(d.files.entryTypes.has(OC_DIR)).toBe(false);
    expect(d.io.stdout.join("\n")).toContain("until a restart");
  });

  test("keeps the folder when the person left something else in it", () => {
    const mine = join(OC_DIR, "notes.md");
    const d = deps({ files: { [OC_TARGET]: OPENCODE_PLUGIN_TEXT, [mine]: "keep\n" } });
    expect(cmdInboxUninstall(d, ["opencode"])).toBe(EXIT.OK);
    expect(d.files.entries.has(OC_TARGET)).toBe(false);
    expect(text(d, mine)).toBe("keep\n");
    expect(d.files.ops.some((op) => op.startsWith("rm -rf"))).toBe(false);
  });

  test("keeps a plugin folder that is a link, removing only the file behind it", () => {
    const real = join("/dotfiles/oc-inbox", "tui.ts");
    const d = deps({ files: { [real]: OPENCODE_PLUGIN_TEXT }, probes: { [OC_DIR]: { kind: "symlink", target: "/dotfiles/oc-inbox" } } });
    d.files.entryTypes.set(OC_DIR, "symlink");
    expect(cmdInboxUninstall(d, ["opencode"])).toBe(EXIT.OK);
    expect(d.files.entries.has(real)).toBe(false);
    expect(d.files.ops.some((op) => op.startsWith("rm -rf"))).toBe(false);
  });

  test("leaves a foreign tui.ts, and says nothing to remove when nothing is there", () => {
    const d = deps({ files: { [OC_TARGET]: "mine\n" } });
    expect(cmdInboxUninstall(d, ["opencode"])).toBe(EXIT.FAIL);
    expect(text(d, OC_TARGET)).toBe("mine\n");
    const none = deps();
    expect(cmdInboxUninstall(none, ["opencode"])).toBe(EXIT.OK);
    expect(none.io.stdout.join("\n")).toContain("the opencode inbox plugin is not installed");
  });
});

describe("status opencode", () => {
  test("reports current, stale and the folder it reads", () => {
    const cur = deps({ files: { [OC_TARGET]: OPENCODE_PLUGIN_TEXT } });
    expect(cmdInboxStatus(cur, ["opencode"])).toBe(EXIT.OK);
    expect(cur.io.stdout).toEqual([`opencode: installed and current (${OC_TARGET})`]);
    const stale = deps({ files: { [OC_TARGET]: "// collie-inbox v0\n" } });
    cmdInboxStatus(stale, ["opencode"]);
    expect(stale.io.stdout[0]).toContain("`collie inbox install opencode` heals it");
  });
});
