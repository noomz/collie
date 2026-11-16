// The phone's Chromium keeps its shared memory in TMPDIR (Playwright passes --disable-dev-shm-usage),
// so the rig points TMPDIR at its own state root: a full /tmp must not crash the browser leg.
import { describe, expect, it } from "vitest";

import { P, STATE_ROOT, phoneEnv } from "./rig-lib";

describe("the phone browser's TMPDIR", () => {
  it("keeps the caller's environment and sets TMPDIR, dropping unset names", () => {
    const env = phoneEnv({ HOME: "/home/x", TMPDIR: "/tmp", GONE: undefined }, "/state/browser-tmp");
    expect(env).toEqual({ HOME: "/home/x", TMPDIR: "/state/browser-tmp" });
  });

  it("puts the browser's TMPDIR under the rig's state root, on disk", () => {
    expect(P.browserTmp).toBe(`${STATE_ROOT}/browser-tmp`);
  });
});
