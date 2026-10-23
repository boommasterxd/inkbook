import { describe, expect, it } from "vitest";

import { InitialSceneReadiness } from "../../../../../src/obsidian/embeds/active-scene/initial-scene-readiness";

describe("initial scene readiness", () => {
  it("ignores earlier commits and requests one final-layout commit", () => {
    const readiness = new InitialSceneReadiness();
    expect(readiness.markSceneCommitted()).toBe(false);
    expect(readiness.markLayoutReady()).toBe(true);
    expect(readiness.markLayoutReady()).toBe(false);
    expect(readiness.markSceneCommitted()).toBe(true);
    expect(readiness.markSceneCommitted()).toBe(false);
  });

  it("waits for a fresh commit when layout is ready before any scene frame", () => {
    const readiness = new InitialSceneReadiness();
    expect(readiness.markLayoutReady()).toBe(true);
    expect(readiness.markSceneCommitted()).toBe(true);
    expect(readiness.markLayoutReady()).toBe(false);
    expect(readiness.markSceneCommitted()).toBe(false);
  });
});
