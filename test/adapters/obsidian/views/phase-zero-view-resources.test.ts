// @vitest-environment happy-dom

import {
  Menu,
  type MarkdownPostProcessorContext,
  type MarkdownRenderChild,
} from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  PhaseZeroViewRegistry,
  type ViewResourceContext,
} from "../../../../src/adapters/obsidian/views";
import { INPUT_GESTURE_PROFILE_V1 } from "../../../../src/input/phase-zero";

const REPROCESSED_GENERATION_COUNT = 2;
const RETAINED_ANNOTATION_LIMIT = 128;
const EXPECTED_MENU_COUNT = 2;
const LONG_PRESS_DELAY_MS = INPUT_GESTURE_PROFILE_V1.longPressDelayMs;
const menuProbe = Menu as typeof Menu & {
  readonly positions: {
    document: Document | undefined;
    position: Readonly<{ x: number; y: number }>;
  }[];
};

function installObsidianElementProperties(element: HTMLElement): void {
  Object.defineProperties(element, {
    doc: { get: (): Document => document },
    hasPointerCapture: { value: vi.fn(() => true) },
    releasePointerCapture: { value: vi.fn() },
    setPointerCapture: { value: vi.fn() },
    win: { get: (): Window => window },
  });
}

function context(
  container: HTMLElement,
  surface: "live-preview" | "reading" | "source",
): ViewResourceContext {
  const environment = {
    doc: document,
    instanceOf: (): boolean => true,
    onWindowMigrated: (): { dispose(): void } => ({
      dispose: (): void => undefined,
    }),
    win: window,
  };
  return {
    document,
    element: environment,
    fileIdentity: "note.md",
    leaf: {
      isDeferred: false,
      readView: (): never => {
        throw new Error();
      },
    },
    surface,
    viewIdentity: { containerEl: container },
    window,
  };
}

function exerciseTouchAndZoom(
  container: HTMLElement,
  marker: SVGCircleElement,
): void {
  const selection = pointer("pointerdown", {
    button: 0,
    clientX: 48,
    clientY: 48,
    pointerId: 1,
    pointerType: "touch",
  });
  marker.dispatchEvent(selection);
  expect(selection.defaultPrevented).toBe(true);
  expect(marker.classList.contains("is-selected")).toBe(true);
  marker.dispatchEvent(pointer("pointerup", { pointerId: 1 }));
  container.dispatchEvent(
    pointer("pointerdown", {
      clientX: 20,
      clientY: 20,
      pointerId: 2,
      pointerType: "touch",
    }),
  );
  container.dispatchEvent(
    pointer("pointerdown", {
      clientX: 40,
      clientY: 20,
      pointerId: 3,
      pointerType: "touch",
    }),
  );
  const firstZoom = pointer("pointermove", {
    clientX: 48,
    clientY: 20,
    pointerId: 3,
    pointerType: "touch",
  });
  container.dispatchEvent(firstZoom);
  const firstTransform = container.querySelector("svg")?.style.transform;
  const liveZoom = pointer("pointermove", {
    clientX: 56,
    clientY: 20,
    pointerId: 3,
    pointerType: "touch",
  });
  container.dispatchEvent(liveZoom);
  const liveTransform = container.querySelector("svg")?.style.transform;
  expect(firstZoom.defaultPrevented).toBe(true);
  expect(liveZoom.defaultPrevented).toBe(true);
  expect(firstTransform).toContain("scale(1.4)");
  expect(liveTransform).toContain("scale(1.8)");
  expect(liveTransform).not.toBe(firstTransform);
  container.dispatchEvent(pointer("pointercancel", { pointerId: 2 }));
}

function exerciseTouchpadZoom(container: HTMLElement): void {
  const svg = container.querySelector("svg");
  const before = svg?.style.transform;
  const scroll = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 12,
  });
  container.dispatchEvent(scroll);
  expect(scroll.defaultPrevented).toBe(false);
  expect(svg?.style.transform).toBe(before);

  const pinch = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: -12,
  });
  Object.defineProperty(pinch, "ctrlKey", { value: true });
  container.dispatchEvent(pinch);
  expect(pinch.defaultPrevented).toBe(true);
  expect(svg?.style.transform).not.toBe(before);

  const malformed = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: Number.NaN,
  });
  Object.defineProperty(malformed, "ctrlKey", { value: true });
  const afterPinch = svg?.style.transform;
  container.dispatchEvent(malformed);
  expect(malformed.defaultPrevented).toBe(false);
  expect(svg?.style.transform).toBe(afterPinch);

  const abusive = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaMode: 2,
    deltaY: -Number.MAX_VALUE,
  });
  Object.defineProperty(abusive, "ctrlKey", { value: true });
  container.dispatchEvent(abusive);
  expect(abusive.defaultPrevented).toBe(true);
  expect(svg?.style.transform).toMatch(/^translate\(.+\) scale\([\d.]+\)$/u);
}

function exerciseContextMenus(
  container: HTMLElement,
  marker: SVGCircleElement,
): void {
  marker.dispatchEvent(
    pointer("pointerdown", {
      button: 2,
      clientX: 48,
      clientY: 48,
      pointerId: 4,
    }),
  );
  marker.dispatchEvent(pointer("pointerup", { pointerId: 4 }));
  const pluginMenu = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  marker.dispatchEvent(pluginMenu);
  expect(pluginMenu.defaultPrevented).toBe(true);
  container.dispatchEvent(pointer("pointerdown", { button: 2, pointerId: 5 }));
  container.dispatchEvent(pointer("pointerup", { pointerId: 5 }));
  const nativeMenu = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  container.dispatchEvent(nativeMenu);
  expect(nativeMenu.defaultPrevented).toBe(false);
}

function exerciseLongPressAndKeyboard(
  container: HTMLElement,
  marker: SVGCircleElement,
): void {
  vi.useFakeTimers();
  try {
    menuProbe.positions.length = 0;
    marker.dispatchEvent(
      pointer("pointerdown", {
        button: 0,
        clientX: 42,
        clientY: 54,
        pointerId: 6,
        pointerType: "touch",
      }),
    );
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS - 1);
    expect(menuProbe.positions).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(menuProbe.positions).toEqual([
      { document, position: { x: 42, y: 54 } },
    ]);
    const synthesized = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    marker.dispatchEvent(synthesized);
    expect(synthesized.defaultPrevented).toBe(true);
    expect(menuProbe.positions).toHaveLength(1);
    marker.dispatchEvent(pointer("pointerup", { pointerId: 6 }));

    marker.dispatchEvent(
      pointer("pointerdown", {
        button: 0,
        clientX: 10,
        clientY: 10,
        pointerId: 7,
        pointerType: "touch",
      }),
    );
    marker.dispatchEvent(
      pointer("pointermove", {
        clientX: 18,
        clientY: 10,
        pointerId: 7,
        pointerType: "touch",
      }),
    );
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
    expect(menuProbe.positions).toHaveLength(1);
    marker.dispatchEvent(pointer("pointerup", { pointerId: 7 }));

    container.dispatchEvent(
      pointer("pointerdown", {
        button: 0,
        clientX: 70,
        clientY: 70,
        pointerId: 8,
        pointerType: "touch",
      }),
    );
    vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
    expect(menuProbe.positions).toHaveLength(1);
    container.dispatchEvent(pointer("pointerup", { pointerId: 8 }));

    const keyboardMenu = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "F10",
      shiftKey: true,
    });
    marker.dispatchEvent(keyboardMenu);
    expect(keyboardMenu.defaultPrevented).toBe(true);
    expect(menuProbe.positions).toHaveLength(EXPECTED_MENU_COUNT);
  } finally {
    vi.useRealTimers();
  }
}

function exerciseOutsideTapDeselection(
  container: HTMLElement,
  marker: SVGCircleElement,
): void {
  marker.dispatchEvent(
    pointer("pointerdown", {
      button: 0,
      pointerId: 9,
      pointerType: "touch",
    }),
  );
  marker.dispatchEvent(pointer("pointerup", { pointerId: 9 }));
  expect(marker.classList).toContain("is-selected");
  const outsideDown = pointer("pointerdown", {
    button: 0,
    clientX: 80,
    clientY: 80,
    pointerId: 10,
    pointerType: "touch",
  });
  container.dispatchEvent(outsideDown);
  container.dispatchEvent(pointer("pointerup", { pointerId: 10 }));
  expect(outsideDown.defaultPrevented).toBe(false);
  expect(marker.classList).not.toContain("is-selected");

  marker.dispatchEvent(
    pointer("pointerdown", {
      button: 0,
      pointerId: 11,
      pointerType: "touch",
    }),
  );
  marker.dispatchEvent(pointer("pointerup", { pointerId: 11 }));
  container.dispatchEvent(
    pointer("pointerdown", {
      button: 0,
      clientX: 80,
      clientY: 80,
      pointerId: 12,
      pointerType: "touch",
    }),
  );
  container.dispatchEvent(
    pointer("pointermove", {
      clientX: 88,
      clientY: 80,
      pointerId: 12,
      pointerType: "touch",
    }),
  );
  container.dispatchEvent(pointer("pointerup", { pointerId: 12 }));
  expect(marker.classList).toContain("is-selected");
}

function pointer(type: string, options: PointerEventInit): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

describe("PhaseZeroViewRegistry", () => {
  it("uses one retained overlay and routes touch, zoom, and context menus", () => {
    const container = document.createElement("div");
    installObsidianElementProperties(container);
    document.body.append(container);
    const registry = new PhaseZeroViewRegistry();
    const binding = registry.bind(context(container, "live-preview"));

    registry.render("note.md", "B");
    const marker = container.querySelector<SVGCircleElement>(
      ".inkbook-phase-zero-marker",
    );
    expect(marker?.classList.contains("is-visible")).toBe(true);

    if (marker === null) throw new Error("Expected retained marker");
    expect(container.classList).toContain("inkbook-phase-zero-gesture-surface");
    exerciseTouchAndZoom(container, marker);
    exerciseTouchpadZoom(container);
    exerciseContextMenus(container, marker);
    exerciseLongPressAndKeyboard(container, marker);
    exerciseOutsideTapDeselection(container, marker);

    const svg = container.querySelector("svg");
    const transformBeforeDisposal = svg?.style.transform;
    binding.dispose();
    binding.dispose();
    expect(container.querySelector(".inkbook-phase-zero-overlay")).toBeNull();
    expect(container.classList).not.toContain(
      "inkbook-phase-zero-gesture-surface",
    );
    const disposedPinch = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -12,
    });
    Object.defineProperty(disposedPinch, "ctrlKey", { value: true });
    container.dispatchEvent(disposedPinch);
    expect(disposedPinch.defaultPrevented).toBe(false);
    expect(svg?.style.transform).toBe(transformBeforeDisposal);

    const reboundContainer = document.createElement("div");
    installObsidianElementProperties(reboundContainer);
    document.body.append(reboundContainer);
    registry.bind(context(reboundContainer, "reading"));
    expect(
      reboundContainer
        .querySelector(".inkbook-phase-zero-marker")
        ?.classList.contains("is-visible"),
    ).toBe(true);
    registry.dispose();
  });

  it("registers one host-owned child per current reading section generation", () => {
    const container = document.createElement("div");
    const section = document.createElement("section");
    installObsidianElementProperties(container);
    installObsidianElementProperties(section);
    container.append(section);
    document.body.append(container);
    const registry = new PhaseZeroViewRegistry();
    registry.bind(context(container, "reading"));
    const children: MarkdownRenderChild[] = [];
    const processor = {
      addChild: (child: MarkdownRenderChild): void => {
        children.push(child);
      },
      docId: "preview-1",
      getSectionInfo: (): { lineEnd: number; lineStart: number } => ({
        lineEnd: 4,
        lineStart: 1,
      }),
      sourcePath: "note.md",
    } as unknown as MarkdownPostProcessorContext;

    registry.reportReadingSection(section, processor);
    registry.reportReadingSection(section, processor);

    expect(children).toHaveLength(REPROCESSED_GENERATION_COUNT);
    registry.dispose();
    registry.dispose();
    expect(container.querySelector(".inkbook-phase-zero-overlay")).toBeNull();
  });

  it("rejects binding after disposal and ignores untrusted section bounds", () => {
    const container = document.createElement("div");
    const section = document.createElement("section");
    installObsidianElementProperties(container);
    installObsidianElementProperties(section);
    const registry = new PhaseZeroViewRegistry();
    registry.bind(context(container, "reading"));
    registry.reportReadingSection(section, {
      addChild: vi.fn(),
      docId: "preview",
      getSectionInfo: (): null => null,
      sourcePath: "note.md",
    } as unknown as MarkdownPostProcessorContext);
    registry.dispose();

    expect(() => registry.bind(context(container, "source"))).toThrow(
      "View registry is disposed.",
    );
  });
});

describe("PhaseZeroViewRegistry resource bounds", () => {
  it("evicts old retained annotation state at the fixed capacity", () => {
    const registry = new PhaseZeroViewRegistry();
    for (let index = 0; index <= RETAINED_ANNOTATION_LIMIT; index += 1) {
      registry.render(`note-${String(index)}.md`, "B");
    }
    const oldestContainer = document.createElement("div");
    const newestContainer = document.createElement("div");
    installObsidianElementProperties(oldestContainer);
    installObsidianElementProperties(newestContainer);
    registry.bind({
      ...context(oldestContainer, "source"),
      fileIdentity: "note-0.md",
    });
    registry.bind({
      ...context(newestContainer, "source"),
      fileIdentity: `note-${String(RETAINED_ANNOTATION_LIMIT)}.md`,
    });

    expect(
      oldestContainer
        .querySelector(".inkbook-phase-zero-marker")
        ?.classList.contains("is-visible"),
    ).toBe(false);
    expect(
      newestContainer
        .querySelector(".inkbook-phase-zero-marker")
        ?.classList.contains("is-visible"),
    ).toBe(true);
    registry.dispose();
  });
});
