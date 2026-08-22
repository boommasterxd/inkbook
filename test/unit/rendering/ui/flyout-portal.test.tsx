import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  createdHost: { remove: vi.fn() },
  panel: {
    offsetHeight: 160,
    offsetWidth: 220,
    style: { left: "", top: "" },
  },
  portalHost: {},
  setHost: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup !== undefined) hooks.cleanups.push(cleanup);
    },
    useLayoutEffect: (effect: () => void) => effect(),
    useRef: () => ({ current: hooks.panel }),
    useState: () => [hooks.portalHost, hooks.setHost],
  };
});

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

import { FlyoutPortal } from "../../../../src/rendering/ui/flyout";

interface TestAnimationEvent {
  readonly animationName: string;
  readonly currentTarget: HTMLDivElement;
  readonly target: HTMLDivElement;
}

function hasAnimationEndHandler(
  value: unknown,
): value is { readonly onAnimationEnd: (event: TestAnimationEvent) => void } {
  return (
    typeof value === "object" &&
    value !== null &&
    "onAnimationEnd" in value &&
    typeof value.onAnimationEnd === "function"
  );
}

describe("flyout portal", () => {
  it("uses owner-document lifecycle, positioning, and accessible dialog markup", () => {
    const ownerEvents = new EventTarget();
    const ownerDocument = ownerEvents as unknown as Document;
    Object.assign(ownerDocument, {
      body: { createDiv: vi.fn(() => hooks.createdHost) },
      documentElement: { clientHeight: 600, clientWidth: 800 },
    });
    const anchor = {
      focus: vi.fn(),
      getBoundingClientRect: () => ({ bottom: 84, left: 80, top: 40 }),
    } as unknown as HTMLElement;

    const element = FlyoutPortal({
      anchor,
      canvasInput: null,
      children: <button type="button">Choice</button>,
      id: "shape",
      label: "Shape",
      onClose: vi.fn(),
      ownerDocument,
    });
    if (!isValidElement(element)) throw new Error("Expected an accessible flyout element.");
    const markup = renderToStaticMarkup(element);

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('id="inkbook-shape-flyout"');
    expect(hooks.panel.style).toEqual({
      left: "80px",
      maxBlockSize: "584px",
      maxInlineSize: "784px",
      top: "92px",
    });
    expect(hooks.setHost).toHaveBeenCalledWith(hooks.createdHost);
    hooks.cleanups.forEach((cleanup) => cleanup());
    expect(hooks.createdHost.remove).toHaveBeenCalledOnce();
  });

  it("keeps a closing panel present until its exit animation completes", () => {
    const ownerDocument = Object.assign(new EventTarget(), {
      body: { createDiv: vi.fn(() => hooks.createdHost) },
      documentElement: { clientHeight: 600, clientWidth: 800 },
    }) as unknown as Document;
    const anchor = {
      focus: vi.fn(),
      getBoundingClientRect: () => ({ bottom: 84, left: 80, top: 40 }),
    } as unknown as HTMLElement;
    const onExitComplete = vi.fn();
    const element = FlyoutPortal({
      anchor,
      canvasInput: null,
      children: <button type="button">Choice</button>,
      closing: true,
      id: "shape",
      label: "Shape",
      onClose: vi.fn(),
      onExitComplete,
      ownerDocument,
    });
    if (!isValidElement(element)) throw new Error("Expected a closing flyout element.");
    expect(renderToStaticMarkup(element)).toContain('data-state="closing"');
    const panel = { contains: () => false } as unknown as HTMLDivElement;
    if (!hasAnimationEndHandler(element.props)) throw new Error("Expected an exit handler.");
    element.props.onAnimationEnd({
      animationName: "inkbook-flyout-exit",
      currentTarget: panel,
      target: panel,
    });
    expect(onExitComplete).toHaveBeenCalledOnce();
  });
});
