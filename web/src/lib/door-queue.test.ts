import { describe, expect, it } from "vitest";
import { stopLeaves } from "./door-queue";

describe("stopLeaves (SPEC V37)", () => {
  it("a screen send and pi's door are handed back to the box; a bridge that names no door keeps today's words", () => {
    expect(stopLeaves(undefined)).toBe("box");
    expect(stopLeaves("screen")).toBe("box");
    expect(stopLeaves("pi")).toBe("box");
  });

  it("opencode keeps a queued send in its inbox through Stop, and a door nobody measured promises nothing", () => {
    expect(stopLeaves("opencode")).toBe("inbox");
    expect(stopLeaves("hermes")).toBe("unknown");
    expect(stopLeaves("claude")).toBe("unknown");
  });
});
