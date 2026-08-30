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
};

describe("active page-height policy", () => {
  it("grows only after less than one aligned writing line remains", () => {
    const layout = new ActivePageLayout();
    const initial = layout.committed(page, undefined);
    expect(initial).toEqual({
      animate: false,
      height: derivePageExtent(page, null).activeHeight,
    });

    expect(layout.committed(page, page.margin + 199)).toBeUndefined();
    const growth = layout.committed(page, page.margin + 201);
    expect(growth).toEqual({
      animate: true,
      height: derivePageExtent(page, page.margin + 201).activeHeight,
    });
  });

  it("shrinks when the exact derived height is at least one buffer unit lower", () => {
    const layout = new ActivePageLayout();
    layout.committed(page, undefined);
    layout.committed(page, 225);
    layout.transitionCompleted();
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

    expect(layout.transitionCompleted()).toEqual({
      animate: true,
      height: derivePageExtent(page, 525).activeHeight,
    });
    expect(layout.transitionCompleted()).toBeUndefined();
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
    expect(layout.transitionCompleted()).toBeUndefined();
  });

  it("adopts the visible height when an input or lifecycle change cancels motion", () => {
    const layout = new ActivePageLayout();
    layout.committed(page, undefined);
    layout.committed(page, 225);
    layout.committed(page, 525);

    layout.cancelTransitions(400);

    expect(layout.height).toBe(400);
    expect(layout.transitionCompleted()).toBeUndefined();
  });

  it("changes height only after the committed content extent changes", () => {
    const layout = new ActivePageLayout();
    const initialHeight = derivePageExtent(page, null).activeHeight;
    expect(layout.committed(page, undefined)).toEqual({ animate: false, height: initialHeight });
    expect(layout.committed(page, undefined)).toBeUndefined();

    expect(layout.committed(page, 225)).toEqual({
      animate: true,
      height: derivePageExtent(page, 225).activeHeight,
    });
  });
});

describe("selection move page-height policy", () => {
  it("reserves selection preview height immediately and restores it on cancellation", () => {
    const layout = new ActivePageLayout();
    const initialHeight = derivePageExtent(page, null).activeHeight;
    layout.committed(page, undefined);

    expect(layout.beginSelectionMove()).toBeUndefined();
    expect(layout.previewSelectionMove(page, 525)).toEqual({
      animate: false,
      height: derivePageExtent(page, 525).activeHeight,
    });
    expect(layout.previewSelectionMove(page, 225)).toBeUndefined();
    expect(layout.finishSelectionMove(false, page, undefined)).toEqual({
      animate: true,
      height: initialHeight,
    });
  });

  it("retains the exact committed extent after a selection preview", () => {
    const layout = new ActivePageLayout();
    layout.committed(page, undefined);
    layout.beginSelectionMove();
    layout.previewSelectionMove(page, 525);

    expect(layout.finishSelectionMove(true, page, 525)).toBeUndefined();
    expect(layout.height).toBe(derivePageExtent(page, 525).activeHeight);
  });
});
