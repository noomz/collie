import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { lineText, splitLines, type StyledLine } from "../blocks";
import { cropRawColumns } from "../column-range";
import { buildBlocks } from "../harness";
import { findInputFrame } from "./frame";
import { surfaceOfScreen } from "./fold";
import { extractInputDraft, extractStatusLines } from "../harness/claude";
import { requireProfile } from "./profile";
import { displayWidth } from "../text-width";
import { cutSplit, readRows, splitColumn } from "./split";

// .adr/0140 point 1: one split-screen cut, for every harness, where a read becomes rows.

const PANES = join(import.meta.dirname, "..", "..", "fixtures", "panes");
const raw = (name: string): string => readFileSync(join(PANES, name), "utf8");
/** The split capture lives beside the corpus, not in it: the corpus sweeps want a label for every pane. */
const SPLIT = join(import.meta.dirname, "..", "..", "fixtures", "split");
const rowsOf = (text: string): StyledLine[] => splitLines(parseAnsi(text));
const texts = (rows: StyledLine[]): string[] => rows.map(lineText);

// pi 1.5 with pi-sidebar-tui: a dim `│` at cell 204 on all 65 rows, the session panel to its right.
// Scrubbed to the same widths: letters and digits above the box masked, names swapped.
const SIDEBAR = join(SPLIT, "pi--v15-sidebar-split.txt");
// Captured Flightdeck sidebar: 42 split rows, then seven footer rows. Transcript characters masked at their original widths.
const PARTIAL = readFileSync(join(SPLIT, "claude--partial-sidebar.txt"), "utf8");

describe("the split-screen cut", () => {
  it("cuts the 65-row pi sidebar capture at cell 204, and the cut rows show the input box (rows 62 to 64)", () => {
    const rows = rowsOf(readFileSync(SIDEBAR, "utf8"));
    const idle = requireProfile("pi").idle;
    expect(findInputFrame(rows, idle)).toBeNull();
    expect(splitColumn(rows)).toBe(204);
    const frame = findInputFrame(readRows(readFileSync(SIDEBAR, "utf8")), idle);
    expect(frame).not.toBeNull();
    expect([frame!.top, frame!.bottom]).toEqual([62, 64]);
  });

  it("keeps exactly the cells the bridge's raw cut keeps for columns 0 to the cut", () => {
    const text = readFileSync(SIDEBAR, "utf8");
    const cut = cutSplit(rowsOf(text));
    expect(texts(cut.rows)).toEqual(texts(rowsOf(cropRawColumns(text, { start: 0, end: cut.column! }))));
  });

  it("measures the separator's column in display cells: a wide glyph left of it takes two", () => {
    const text = ["ab漢│ x", "abcd│ y", "    │ z"].join("\n");
    expect(splitColumn(rowsOf(text))).toBe(4);
    expect(texts(cutSplit(rowsOf(text)).rows)).toEqual(["ab漢", "abcd", "    "]);
  });

  it("reads a Herdr read the same: CRLF rows and a final line feed", () => {
    const text = ["left a  │ panel", "──────  │ 12:00:01", "> hi    │ ", ""].join("\r\n");
    expect(texts(readRows(text))).toEqual(["left a  ", "──────  ", "> hi    ", ""]);
  });

  it("cuts a cut read to itself", () => {
    const once = cutSplit(rowsOf(readFileSync(SIDEBAR, "utf8")));
    const twice = cutSplit(once.rows);
    expect(twice.column).toBeNull();
    expect(texts(twice.rows)).toEqual(texts(once.rows));
  });

  it("takes the leftmost separator column when two run down every row", () => {
    expect(splitColumn(rowsOf(["ab │ cd │ ef", "   │    │   ", "x  │ y  │ z"].join("\n")))).toBe(3);
  });

  it("cuts the captured partial-height sidebar without losing the input or status rows", () => {
    const rows = rowsOf(PARTIAL);
    const cut = cutSplit(rows);
    expect(cut.column).toBe(122);
    expect(texts(cut.rows)).toEqual(texts(rowsOf(cropRawColumns(PARTIAL, { start: 0, end: 122 }))));
    expect(texts(cut.rows).slice(45)).toEqual(texts(rows).slice(45));
    const frame = findInputFrame(cut.rows, requireProfile("claude").idle);
    expect(frame && [frame.top, frame.bottom]).toEqual([42, 44]);
    expect(cutSplit(cut.rows).column).toBeNull();
  });

  it.each(["", "keep this draft", "long draft ".repeat(15)])("preserves the Surface and draft for the captured footer: %s", (draft) => {
    const text = PARTIAL.replace("\n❯\n", `\n❯ ${draft}\n`);
    const rows = readRows(text);
    expect(extractInputDraft(rows)).toBe(draft.trim() || null);
    expect(extractStatusLines(rows)).toEqual(extractStatusLines(rowsOf(text)));
    expect(surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows, ask: null }, requireProfile("claude").idle).surface)
      .toEqual({ revision: 1, turn: "idle", modal: "none", composer: draft ? "draft" : "empty" });
    expect(splitColumn(rowsOf(text))).toBe(draft.length > 122 ? null : 122);
  });

  it.each(["│", "┃"])("cuts a contiguous %s sidebar above a rule and a short footer", (separator) => {
    const rows = rowsOf([`ab漢${separator} x`, `abcd${separator} y`, `    ${separator} z`, "──────────", "❯ hi", ""].join("\r\n"));
    expect(splitColumn(rows)).toBe(4);
    expect(texts(cutSplit(rows).rows)).toEqual(["ab漢", "abcd", "    ", "────", "❯ hi", ""]);
  });

  it.each([
    "prose crosses the cut",
    "❯ a draft that crosses the cut",
    "    漢",
    "   漢",
    "─────title─────",
    "────┬─────",
  ])("preserves a full-width footer: %s", (footer) => {
    const rows = rowsOf(["left│ x", "more│ y", "end │ z", footer].join("\n"));
    expect(splitColumn(rows)).toBeNull();
    expect(cutSplit(rows).rows).toBe(rows);
  });

  it("does not accept a divider that resumes after a blank row", () => {
    expect(splitColumn(rowsOf("left│ x\nmore│ y\nend │ z\n\nlast│ p"))).toBeNull();
  });

  it("does not use the footer to turn a short split or a box into a sidebar", () => {
    for (const text of [
      "left│ x\nmore│ y\n──────────\n❯",
      "│ a │ b │\n│ c │ d │\n│ e │ f │\n──────────\n❯",
      "    │ b │\n    │ d │\n    │ f │\n──────────\n❯",
    ]) expect(splitColumn(rowsOf(text))).toBeNull();
  });

  it("does not cut when one row lacks the separator in that column", () => {
    expect(splitColumn(rowsOf(["text │ p", "more │ q", "a row wider than the rest", "end  │ r"].join("\n")))).toBeNull();
  });

  it("does not cut a box filling the pane: a border in column 0 on every row", () => {
    expect(splitColumn(rowsOf(["╭──────┬────╮", "│ a    │ b  │", "│ c    │ d  │", "╰──────┴────╯"].join("\n")))).toBeNull();
  });

  it("does not cut a box with a margin: every row blank left of the separator", () => {
    expect(splitColumn(rowsOf(["  │ box │", "  │ row │", "  │ end │"].join("\n")))).toBeNull();
  });

  it("does not cut a read of fewer than three rows", () => {
    expect(splitColumn(rowsOf("a │ b\nc │ d\n"))).toBeNull();
  });

  it("leaves a whole-screen read alone", () => {
    const rows = rowsOf(raw("claude--permission-bash.txt"));
    expect(splitColumn(rows)).toBeNull();
    expect(cutSplit(rows).rows).toBe(rows);
  });
});

describe("a question read beside a split binds to the kept columns", () => {
  const PANEL = "│ panel 12:00:0";

  /** The capture with a separator and a ticking panel painted right of column `width`. */
  function besidePanel(text: string, width: number, second: number): string {
    return text
      .split(/\r?\n/)
      .map((row) => `${row}\u001b[0m${" ".repeat(Math.max(0, width - displayWidth(lineText(rowsOf(row)[0] ?? { segments: [] }))))}${PANEL}${second}`)
      .join("\n");
  }

  it("a partial-height panel leaves the dialog bound only to the kept columns", () => {
    const text = raw("claude--permission-bash.txt");
    const width = Math.max(...texts(rowsOf(text)).map(displayWidth)) + 1;
    const rows = text.split(/\r?\n/);
    const screen = `${besidePanel(rows.slice(0, -2).join("\n"), width, 1)}\n${rows.slice(-2).join("\n")}`;
    const block = buildBlocks(rowsOf(screen), { agent: "claude" }).find((entry) => entry.kind === "prompt-select");
    expect(block?.kind === "prompt-select" ? block.prompt.bindColumns : null).toEqual({ start: 0, end: width });
  });

  it("a prompt lifted from cut rows carries bindColumns 0 to the cut", () => {
    const text = raw("claude--permission-bash.txt");
    const width = Math.max(...texts(rowsOf(text)).map(displayWidth)) + 1;
    const whole = buildBlocks(rowsOf(text), { agent: "claude" }).find((block) => block.kind === "prompt-select");
    expect(whole).toBeDefined();
    const split = buildBlocks(rowsOf(besidePanel(text, width, 1)), { agent: "claude" }).find((block) => block.kind === "prompt-select");
    expect(split?.kind === "prompt-select" ? split.prompt.bindColumns : null).toEqual({ start: 0, end: width });
  });
});
