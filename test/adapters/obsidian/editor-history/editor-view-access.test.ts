import { describe, expect, it, vi } from "vitest";

import { accessEditorViewV1 } from "../../../../src/adapters/obsidian/editor-history";

describe("accessEditorViewV1", () => {
  it("returns unavailable for absent, renamed, and malformed host properties", () => {
    expect(accessEditorViewV1({})).toEqual({
      kind: "unavailable",
      reason: "host-property-absent",
    });
    expect(accessEditorViewV1({ editorView: createEditorViewShape() })).toEqual(
      {
        kind: "unavailable",
        reason: "host-property-absent",
      },
    );
    expect(accessEditorViewV1({ cm: { dispatch: vi.fn() } })).toEqual({
      kind: "unavailable",
      reason: "host-property-malformed",
    });
  });

  it("returns the validated concrete host editor view", () => {
    const cm = createEditorViewShape();
    const result = accessEditorViewV1({ cm });

    expect(result.kind).toBe("available");
    if (result.kind === "available") expect(result.view).toBe(cm);
  });
});

function createEditorViewShape(): object {
  return {
    dispatch: vi.fn(),
    setState: vi.fn(),
    state: { update: vi.fn() },
  };
}
