import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  InkbookToolbar,
  nextToolbarIndex,
  resolveToolbarFocusRecovery,
} from "../../../../src/rendering/ui/toolbar";
import type { ToolbarState } from "../../../../src/rendering/ui/toolbar-types";

const state: ToolbarState = {
  activeTool: "draw",
  canPaste: false,
  canRedo: false,
  canUndo: true,
  fingerDrawingAvailable: false,
  fingerDrawingEnabled: false,
  hasSelection: false,
  openFlyout: null,
};

function render(overrides: Partial<ToolbarState> = {}): string {
  return renderToStaticMarkup(
    <InkbookToolbar
      layout="wide"
      onAction={vi.fn()}
      renderIcon={vi.fn()}
      state={{ ...state, ...overrides }}
    />,
  );
}

describe("Inkbook toolbar", () => {
  it("renders one accessible toolbar with one continuous control track", () => {
    const markup = render();
    expect(markup.match(/role="toolbar"/gu)).toHaveLength(1);
    expect(markup.match(/role="group"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-label="Tools and actions"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("keeps unavailable history controls disabled and omits contextual controls", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Undo"');
    expect(markup).toMatch(/aria-label="Redo"[^>]*disabled=""/u);
    expect(markup).not.toContain('aria-label="Copy"');
    expect(markup).not.toContain('aria-label="Paste"');
    expect(markup).not.toContain('aria-label="Finger drawing"');
  });

  it("exposes selection, clipboard and flyout state", () => {
    const markup = render({ canPaste: true, hasSelection: true, openFlyout: "style" });
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).toContain('aria-label="Cut"');
    expect(markup).toContain('aria-label="Delete"');
    expect(markup).toContain('aria-label="Paste"');
    expect(markup).toContain('class="inkbook-toolbar-group inkbook-toolbar-context-actions"');
    expect(markup).toMatch(/aria-expanded="true"[^>]*aria-label="Style"/u);
    expect(markup).toContain('aria-controls="inkbook-style-flyout"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup.indexOf('class="inkbook-toolbar inkbook-toolbar-wide"')).toBeLessThan(
      markup.indexOf("inkbook-toolbar-context-actions"),
    );
  });

  it("uses roving tab stops and resolves group keyboard navigation", () => {
    const markup = render();
    expect(markup).not.toContain('data-inkbook-action="background"');
    expect(markup).toContain('data-inkbook-action="undo" tabindex="0"');
    expect(markup).toContain('data-inkbook-action="select" tabindex="-1"');
    expect(nextToolbarIndex("ArrowRight", 2, 4)).toBe(3);
    expect(nextToolbarIndex("ArrowRight", 3, 4)).toBe(0);
    expect(nextToolbarIndex("ArrowLeft", 0, 4)).toBe(3);
    expect(nextToolbarIndex("Home", 3, 4)).toBe(0);
    expect(nextToolbarIndex("End", 0, 4)).toBe(3);
    expect(nextToolbarIndex("Escape", 0, 4)).toBeNull();
    expect(nextToolbarIndex("ArrowRight", 0, 0)).toBeNull();
  });

  it("recovers focus to the nearest remaining control when a conditional control disappears", () => {
    expect(resolveToolbarFocusRecovery(["copy", "cut", "delete", "lock"], ["lock"], "cut")).toBe(
      "lock",
    );
    expect(
      resolveToolbarFocusRecovery(
        ["copy", "cut", "delete", "lock", "overflow"],
        ["lock", "overflow"],
        "cut",
      ),
    ).toBe("lock");
    expect(resolveToolbarFocusRecovery(["undo", "redo"], ["undo"], "redo")).toBe("undo");
    expect(resolveToolbarFocusRecovery(["undo"], [], "undo")).toBeNull();
  });
});
