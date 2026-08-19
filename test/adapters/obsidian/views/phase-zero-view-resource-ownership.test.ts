// @vitest-environment happy-dom

import type {
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
} from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RESOURCE_BUDGET_V1,
  RESOURCE_CATEGORIES_V1,
  type ResourceBudgetProfileV1,
} from "../../../../src/application/resource-coordinator";
import type { Disposable } from "../../../../src/adapters/obsidian/views";
import {
  installObsidianElementProperties,
  phaseZeroRegistryHarness,
  phaseZeroViewContext,
  pointer,
} from "./phase-zero-view-test-helpers";

const STATIC_VIEW_LIMIT = 2;
const READING_LIMIT = 2;
const DOM_NODE_COUNT = 3;
const LISTENER_COUNT = 12;

function profile(
  attachedViewLimit = STATIC_VIEW_LIMIT,
  readingLimit = READING_LIMIT,
): ResourceBudgetProfileV1 {
  const base = RESOURCE_BUDGET_V1.desktopOrAndroidTablet;
  return {
    ...base,
    categoryLimits: {
      ...base.categoryLimits,
      [RESOURCE_CATEGORIES_V1.attachedView]: { count: attachedViewLimit },
      [RESOURCE_CATEGORIES_V1.readingViewChild]: {
        perScopeCount: readingLimit,
      },
      [RESOURCE_CATEGORIES_V1.readingViewObserver]: {
        perScopeCount: readingLimit,
      },
      [RESOURCE_CATEGORIES_V1.readingViewReport]: {
        perScopeCount: readingLimit,
      },
    },
  };
}

function container(): HTMLElement {
  const element = document.createElement("div");
  installObsidianElementProperties(element);
  document.body.append(element);
  return element;
}

function readingContext(
  children: MarkdownRenderChild[],
): MarkdownPostProcessorContext {
  return {
    addChild: (child: MarkdownRenderChild): void => {
      children.push(child);
    },
    docId: "preview-1",
    getSectionInfo: (element: HTMLElement) => ({
      lineEnd: Number(element.dataset.end),
      lineStart: Number(element.dataset.start),
    }),
    sourcePath: "note.md",
  } as unknown as MarkdownPostProcessorContext;
}

describe("PhaseZeroViewRegistry resource ownership", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("admits below and at the view limit, then suspends above it", () => {
    const { coordinator, registry } = phaseZeroRegistryHarness(profile());
    const bindings: Disposable[] = [];
    for (let index = 0; index <= STATIC_VIEW_LIMIT; index += 1) {
      const host = container();
      bindings.push(registry.bind(phaseZeroViewContext(host, "source")));
      const hasOverlay =
        host.querySelector(".inkbook-phase-zero-overlay") !== null;
      expect(hasOverlay).toBe(index < STATIC_VIEW_LIMIT);
    }

    const snapshot = coordinator.snapshot();
    expect(
      snapshot.categories[RESOURCE_CATEGORIES_V1.attachedView]?.current.count,
    ).toBe(STATIC_VIEW_LIMIT);
    expect(
      snapshot.categories[RESOURCE_CATEGORIES_V1.domNode]?.current.count,
    ).toBe(STATIC_VIEW_LIMIT * DOM_NODE_COUNT);
    expect(
      snapshot.categories[RESOURCE_CATEGORIES_V1.listener]?.current.count,
    ).toBe(STATIC_VIEW_LIMIT * LISTENER_COUNT);
    expect(
      snapshot.categories[RESOURCE_CATEGORIES_V1.attachedView]?.suspended.count,
    ).toBe(1);

    bindings.forEach((binding) => binding.dispose());
    registry.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("rolls back the complete static batch when listener binding fails", () => {
    const { coordinator, registry } = phaseZeroRegistryHarness(profile());
    const host = container();
    const original = host.addEventListener.bind(host);
    let calls = 0;
    vi.spyOn(host, "addEventListener").mockImplementation(
      (type, listener, options): void => {
        calls += 1;
        if (calls === DOM_NODE_COUNT) throw new Error("listener failed");
        original(type, listener, options);
      },
    );

    expect(() => registry.bind(phaseZeroViewContext(host, "source"))).toThrow(
      "listener failed",
    );
    expect(host.querySelector(".inkbook-phase-zero-overlay")).toBeNull();
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("charges captures only while claimed and releases lost captures", () => {
    const captures = new Set<number>();
    const host = document.createElement("div");
    installObsidianElementProperties(host, {
      has: (pointerId) => captures.has(pointerId),
      release: (pointerId) => captures.delete(pointerId),
      set: (pointerId) => captures.add(pointerId),
    });
    document.body.append(host);
    const { coordinator, registry } = phaseZeroRegistryHarness(profile());
    registry.bind(phaseZeroViewContext(host, "source"));
    host.dispatchEvent(
      pointer("pointerdown", { pointerId: 1, pointerType: "pen" }),
    );
    host.dispatchEvent(
      pointer("pointerdown", {
        clientX: 20,
        pointerId: STATIC_VIEW_LIMIT,
        pointerType: "pen",
      }),
    );
    host.dispatchEvent(
      pointer("pointermove", {
        clientX: 30,
        pointerId: STATIC_VIEW_LIMIT,
        pointerType: "pen",
      }),
    );
    expect(
      coordinator.snapshot().categories[RESOURCE_CATEGORIES_V1.pointerCapture]
        ?.current.count,
    ).toBe(STATIC_VIEW_LIMIT);

    for (const pointerId of [...captures]) {
      host.dispatchEvent(pointer("lostpointercapture", { pointerId }));
    }
    expect(
      coordinator.snapshot().categories[RESOURCE_CATEGORIES_V1.pointerCapture]
        ?.current.count,
    ).toBe(0);
    registry.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });
});

describe("PhaseZeroViewRegistry transient and Reading ownership", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("owns the long-press timer through cancellation and plugin unload", () => {
    const host = container();
    const { coordinator, registry } = phaseZeroRegistryHarness(profile());
    registry.bind(phaseZeroViewContext(host, "live-preview"));
    const marker = host.querySelector<SVGCircleElement>(
      ".inkbook-phase-zero-marker",
    );
    if (marker === null) throw new Error("Expected marker");
    marker.dispatchEvent(
      pointer("pointerdown", { pointerId: 1, pointerType: "touch" }),
    );
    expect(
      coordinator.snapshot().categories[RESOURCE_CATEGORIES_V1.timer]?.current
        .count,
    ).toBe(1);
    marker.dispatchEvent(pointer("pointerup", { pointerId: 1 }));
    expect(
      coordinator.snapshot().categories[RESOURCE_CATEGORIES_V1.timer]?.current
        .count,
    ).toBe(0);

    marker.dispatchEvent(
      pointer("pointerdown", {
        pointerId: STATIC_VIEW_LIMIT,
        pointerType: "touch",
      }),
    );
    registry.dispose();
    vi.runOnlyPendingTimers();
    expect(coordinator.snapshot().balanced).toBe(true);
  });

  it("owns one current and one retiring Reading generation atomically", () => {
    const host = container();
    const section = document.createElement("section");
    installObsidianElementProperties(section);
    section.dataset.start = "1";
    section.dataset.end = "4";
    host.append(section);
    const children: MarkdownRenderChild[] = [];
    const { coordinator, registry } = phaseZeroRegistryHarness(profile());
    registry.bind(phaseZeroViewContext(host, "reading"));
    const context = readingContext(children);

    registry.reportReadingSection(section, context);
    registry.reportReadingSection(section, context);
    const observer =
      coordinator.snapshot().categories[
        RESOURCE_CATEGORIES_V1.readingViewObserver
      ];
    expect(observer?.current.count).toBe(1);
    expect(observer?.highWater.count).toBe(READING_LIMIT);
    expect(children).toHaveLength(READING_LIMIT);

    registry.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });
});
