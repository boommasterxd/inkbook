import { describe, expect, it } from "vitest";

import { decideInitialPointerOwnership } from "../../../src/input/gestures";

describe("decideInitialPointerOwnership", () => {
  it("gives plugin-element touch selection priority over a drawing tool", () => {
    expect(
      decideInitialPointerOwnership({
        pointerKind: "touch",
        button: 0,
        hit: { kind: "plugin-element", elementId: "shape-1" },
        activeTool: "pen",
      }),
    ).toMatchObject({
      owner: "plugin",
      action: "select-plugin-target",
      preventDefault: true,
    });
  });

  it("leaves an unclaimed touch on Markdown and empty content native", () => {
    for (const kind of ["native-markdown", "empty-note"] as const) {
      expect(
        decideInitialPointerOwnership({
          pointerKind: "touch",
          button: 0,
          hit: { kind },
          activeTool: "pen",
        }),
      ).toMatchObject({
        owner: "host",
        action: "native",
        preventDefault: false,
        stopPropagation: false,
      });
    }
  });

  it("claims explicit handles regardless of tool and allows pen drawing", () => {
    expect(
      decideInitialPointerOwnership({
        pointerKind: "mouse",
        button: 0,
        hit: { kind: "plugin-handle", elementId: "shape-1" },
        activeTool: "shape",
      }).action,
    ).toBe("manipulate-handle");
    expect(
      decideInitialPointerOwnership({
        pointerKind: "pen",
        button: 0,
        hit: { kind: "empty-note" },
        activeTool: "highlighter",
      }).action,
    ).toBe("draw");
  });

  it("keeps secondary-button routing separate and freezes the hit", () => {
    const hit = { kind: "plugin-element", elementId: "shape-1" } as const;
    const result = decideInitialPointerOwnership({
      pointerKind: "mouse",
      button: 2,
      hit,
      activeTool: "cursor",
    });
    expect(result).toMatchObject({
      owner: "host",
      action: "native",
      frozenHit: hit,
    });
  });

  it("does not select a plugin element with a drawing mouse or pen tool", () => {
    for (const pointerKind of ["mouse", "pen"] as const) {
      expect(
        decideInitialPointerOwnership({
          pointerKind,
          button: 0,
          hit: { kind: "plugin-element", elementId: "shape-1" },
          activeTool: "pen",
        }).owner,
      ).toBe("host");
    }
  });
});
