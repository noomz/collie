import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { cropRawColumns } from "../lib/column-range";
import { AnsiOutput } from "./ansi-output";

const captured = readFileSync(join(import.meta.dirname, "..", "fixtures", "split", "claude--partial-sidebar.txt"), "utf8");

describe("the partial-height sidebar in the mirror", () => {
  it("renders the same reply and table as the left-hand pane alone", () => {
    const full = render(<AnsiOutput text={captured} agent="claude" wrap />);
    const left = render(<AnsiOutput text={cropRawColumns(captured, { start: 0, end: 122 })} agent="claude" wrap />);
    expect(full.container.textContent).toBe(left.container.textContent);
    expect(full.container.textContent).not.toContain("✕");
  });

  it("keeps full-width prose rather than hiding its tail", () => {
    const rule = "─".repeat(168);
    const text = captured.replace(`\n${rule}`, `\n${"prose ".repeat(25)}TAIL\n${rule}`);
    const full = render(<AnsiOutput text={text} agent="claude" wrap />);
    expect(full.container.textContent).toContain("TAIL");
    expect(full.container.textContent).toContain("✕");
  });
});
