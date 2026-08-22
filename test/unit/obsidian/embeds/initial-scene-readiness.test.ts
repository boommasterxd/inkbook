import { describe, expect, it } from "vitest";

import { InitialSceneReadiness } from "../../../../src/obsidian/embeds/initial-scene-readiness";

describe("initial scene readiness", () => {
  it.each(["layout-first", "scene-first"] as const)(
    "completes once after layout and the initial scene commit in %s order",
    (order) => {
      const readiness = new InitialSceneReadiness();
      const first =
        order === "layout-first" ? readiness.markLayoutReady() : readiness.markSceneCommitted();
      const second =
        order === "layout-first" ? readiness.markSceneCommitted() : readiness.markLayoutReady();

      expect(first).toBe(false);
      expect(second).toBe(true);
      expect(readiness.markLayoutReady()).toBe(false);
      expect(readiness.markSceneCommitted()).toBe(false);
    },
  );
});
