import { describe, expect, it } from "vitest";

import { derivePageExtent } from "../../../../../src/domain/geometry/public";
import type { PageV1 } from "../../../../../src/domain/schema/public";
import { ActivePageLayout } from "../../../../../src/obsidian/embeds/active-editor/page-layout";

const page: PageV1 = {
  activeBufferLines: 3,
  background: { type: "lines", spacing: 100 },
  innerWidth: 2000,
  lockedBufferLines: 1,
  margin: 24.3,
  writingLineHeight: 100,
};

describe("active page-height policy", () => {
  it("grows only after less than one aligned writing line remains", () => {
    const layout = new ActivePageLayout();
    const initial = layout.committed(page, undefined);
    expect(initial).toEqual({ animate: false, height: 348.6 });

    expect(layout.committed(page, 224)).toBeUndefined();
    const growth = layout.committed(page, 225);
    expect(growth).toEqual({
      animate: true,
      height: derivePageExtent(page, 225).activeHeight,
    });
  });

  it("shrinks when the exact derived height is at least one buffer unit lower", () => {
    const layout = new ActivePageLayout();
    layout.committed(page, 225);
    expect(layout.committed(page, 224)).toEqual({
      animate: true,
      height: derivePageExtent(page, 224).activeHeight,
    });
  });

  it("locks a running transition and coalesces the newest committed target", () => {
    const layout = new ActivePageLayout();
    layout.committed(page, undefined);
    expect(layout.committed(page, 225)).toEqual({
      animate: true,
      height: derivePageExtent(page, 225).activeHeight,
    });
    expect(layout.committed(page, 525)).toBeUndefined();

    expect(layout.transitionCompleted(page)).toEqual({
      animate: true,
      height: derivePageExtent(page, 525).activeHeight,
    });
    expect(layout.transitionCompleted(page)).toBeUndefined();
    expect(layout.height).toBe(derivePageExtent(page, 525).activeHeight);
  });

  it("completes a coalesced transition at its newest target for immediate input", () => {
    const layout = new ActivePageLayout();
    layout.committed(page, undefined);
    layout.committed(page, 225);
    layout.committed(page, 525);

    expect(layout.completeTransitions()).toEqual({
      animate: false,
      height: derivePageExtent(page, 525).activeHeight,
    });
    expect(layout.transitionCompleted(page)).toBeUndefined();
  });

  it("extends one buffer per completed bottom-edge transition and restores on cancel", () => {
    const layout = new ActivePageLayout();
    const initialHeight = derivePageExtent(page, null).activeHeight;
    layout.committed(page, undefined);
    layout.beginSelection();

    expect(layout.updateSelectionBottomEdge(true, page)).toEqual({
      animate: true,
      height: initialHeight + 100,
    });
    expect(layout.updateSelectionBottomEdge(true, page)).toBeUndefined();
    expect(layout.transitionCompleted(page)).toEqual({
      animate: true,
      height: initialHeight + 200,
    });
    expect(layout.finishSelection("cancel", page, undefined)).toBeUndefined();
    expect(layout.transitionCompleted(page)).toEqual({ animate: true, height: initialHeight });
  });

  it("restores the exact derived committed height after a transient extension", () => {
    const layout = new ActivePageLayout();
    layout.committed(page, undefined);
    layout.beginSelection();
    layout.updateSelectionBottomEdge(true, page);

    expect(layout.finishSelection("commit", page, 225)).toBeUndefined();
    expect(layout.transitionCompleted(page)).toEqual({
      animate: true,
      height: derivePageExtent(page, 225).activeHeight,
    });
  });
});
