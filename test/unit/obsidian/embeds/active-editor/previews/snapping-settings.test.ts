import { describe, expect, it } from "vitest";

import { activeSnapFeatures } from "../../../../../../src/obsidian/embeds/active-editor/previews/snapping-settings";

describe("active snapping settings", () => {
  it("disables every effective feature through the global switch", () => {
    expect(
      activeSnapFeatures({
        angles: true,
        bends: true,
        connections: true,
        enabled: false,
        structures: true,
      }),
    ).toEqual({ angles: false, bends: false, connections: false, structures: false });
  });

  it("preserves the configured per-kind combination while globally enabled", () => {
    expect(
      activeSnapFeatures({
        angles: false,
        bends: true,
        connections: false,
        enabled: true,
        structures: true,
      }),
    ).toEqual({ angles: false, bends: true, connections: false, structures: true });
  });

  it("inverts only the master state while preserving per-kind choices", () => {
    const configured = {
      angles: false,
      bends: true,
      connections: true,
      enabled: false,
      structures: false,
    };

    expect(activeSnapFeatures(configured, true)).toEqual({
      angles: false,
      bends: true,
      connections: true,
      structures: false,
    });
    expect(activeSnapFeatures({ ...configured, enabled: true }, true)).toEqual({
      angles: false,
      bends: false,
      connections: false,
      structures: false,
    });
    expect(configured).toEqual({
      angles: false,
      bends: true,
      connections: true,
      enabled: false,
      structures: false,
    });
  });
});
