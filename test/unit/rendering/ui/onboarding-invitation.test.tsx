// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Window as HappyWindow } from "happy-dom";
import { MotionGlobalConfig, processFrame } from "motion";
import { AnimatePresence } from "motion/react";
import { OnboardingInvitation } from "../../../../src/rendering/ui/onboarding-invitation";
import { toolbarMotionContext } from "../../../../src/rendering/ui/toolbar-motion";

async function finish(element: Element): Promise<void> {
  await act(async () => {
    for (const animation of element.getAnimations()) animation.finish();
    await Promise.resolve();
  });
}

it("offers a passive invitation and invokes only the chosen action", () => {
  const environment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "button");
  document.body.append(canvas, container);
  canvas.focus();
  const root = createRoot(container);
  const onStart = vi.fn();
  const onDismiss = vi.fn();
  const renderIcon = vi.fn((_element: HTMLElement, _icon: string) => {});
  try {
    act(() =>
      root.render(
        <toolbarMotionContext.Provider value={{ reduced: true, preparing: false, locking: false }}>
          <OnboardingInvitation onStart={onStart} onDismiss={onDismiss} renderIcon={renderIcon} />
        </toolbarMotionContext.Provider>,
      ),
    );
    expect(document.activeElement).toBe(canvas);
    expect(onStart).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Do you want to start a tour?");
    expect(renderIcon.mock.calls.map(([, icon]) => icon)).toEqual(["check", "x"]);
    const start = container.querySelector<HTMLButtonElement>('[aria-label="Start tour"]');
    const dismiss = container.querySelector<HTMLButtonElement>('[aria-label="Skip tour"]');
    expect(container.querySelectorAll("button")).toHaveLength(2);
    act(() => dismiss?.click());
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
    act(() => start?.click());
    expect(onStart).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    container.remove();
    canvas.remove();
    delete environment.IS_REACT_ACT_ENVIRONMENT;
  }
});

it("finishes pop-out presence and feedback on native animations without the main frame loop", async () => {
  const environment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  MotionGlobalConfig.useManualTiming = true;
  const owner = new HappyWindow();
  const popup = owner as unknown as Window;
  const container = popup.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  popup.document.body.append(container);
  const root = createRoot(container);
  const action = vi.fn();
  const render = (visible: boolean, reduced = false) =>
    act(() =>
      root.render(
        <toolbarMotionContext.Provider
          value={{ reduced, preparing: false, locking: false, foreignWindow: true }}
        >
          <AnimatePresence>
            {visible ? (
              <OnboardingInvitation
                key="invitation"
                onStart={action}
                onDismiss={action}
                renderIcon={vi.fn()}
              />
            ) : null}
          </AnimatePresence>
        </toolbarMotionContext.Provider>,
      ),
    );
  try {
    render(true);
    const aside = container.querySelector("aside")!;
    await finish(aside);
    const strokes = [
      ...aside.querySelectorAll<SVGPathElement>("svg.inkbook-handwriting-title path"),
    ];
    expect(strokes.length).toBeGreaterThan(0);
    for (const stroke of strokes) {
      expect(stroke.getAnimations()).toHaveLength(2);
      await finish(stroke);
      expect(stroke.style.strokeDashoffset).toBe("0");
      expect(stroke.style.opacity).toBe("1");
    }
    const button = container.querySelector("button")!;
    act(() => {
      button.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          isPrimary: true,
          button: 0,
          pointerId: 8,
          pointerType: "touch",
        }),
      );
    });
    expect(button.getAnimations()).toHaveLength(2);
    await finish(button);
    expect(Number(button.style.scale)).toBeLessThan(1);
    act(() => {
      popup.dispatchEvent(new PointerEvent("pointerup", { pointerId: 8 }));
    });
    await finish(button);
    expect(button.style.scale).toBe("1");
    expect(action).not.toHaveBeenCalled();
    render(false);
    expect(aside.inert).toBe(true);
    expect(aside.getAttribute("aria-hidden")).toBe("true");
    expect(aside.isConnected).toBe(true);
    await finish(aside);
    expect(container.querySelector("aside")).toBeNull();
    render(true);
    const next = container.querySelector("aside")!;
    render(true, true);
    for (const stroke of next.querySelectorAll<SVGPathElement>(
      "svg.inkbook-handwriting-title path",
    )) {
      expect(stroke.getAnimations()).toHaveLength(0);
      expect(stroke.getAttribute("stroke-dashoffset")).toBe("0");
      expect(stroke.getAttribute("opacity")).toBe("1");
    }
    render(true);
    for (const stroke of next.querySelectorAll("svg.inkbook-handwriting-title path"))
      expect(stroke.getAnimations()).toHaveLength(0);
    render(false);
    expect(next.getAnimations()).toHaveLength(1);
    render(false, true);
    expect(next.getAnimations()).toHaveLength(0);
    expect(container.querySelector("aside")).toBeNull();
    render(true);
    const disposed = container.querySelector("aside")!;
    act(() => root.unmount());
    expect(disposed.getAnimations()).toHaveLength(0);
  } finally {
    act(() => root.unmount());
    await owner.happyDOM.abort();
    MotionGlobalConfig.useManualTiming = false;
    delete environment.IS_REACT_ACT_ENVIRONMENT;
  }
});

it("recovers invitation presses through the owning pop-out without activating an action", () => {
  const environment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  MotionGlobalConfig.useManualTiming = true;
  processFrame(0);
  const popup = new HappyWindow() as unknown as Window;
  const container = popup.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  popup.document.body.append(container);
  const root = createRoot(container);
  const onStart = vi.fn();
  const onDismiss = vi.fn();
  const added = vi.spyOn(popup, "addEventListener");
  const removed = vi.spyOn(popup, "removeEventListener");
  let timestamp = 0;
  const dispatch = (target: EventTarget, event: Event): void => {
    act(() => {
      target.dispatchEvent(event);
    });
    act(() => {
      processFrame((timestamp += 16));
      processFrame((timestamp += 16));
    });
  };
  const pointer = (target: EventTarget, type: string): void =>
    dispatch(
      target,
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId: 7,
        pointerType: "touch",
      }),
    );
  try {
    act(() =>
      root.render(
        <toolbarMotionContext.Provider
          value={{ reduced: true, preparing: false, locking: false, foreignWindow: true }}
        >
          <OnboardingInvitation onStart={onStart} onDismiss={onDismiss} renderIcon={vi.fn()} />
        </toolbarMotionContext.Provider>,
      ),
    );
    processFrame((timestamp += 16));
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Start tour"]')!;
    act(() => button.focus());
    const resting = button.style.scale;
    pointer(button, "pointerdown");
    expect(button.style.scale).not.toBe(resting);
    const held = button.style.scale;
    pointer(window, "pointerup");
    expect(button.style.scale).toBe(held);
    pointer(popup, "pointerup");
    expect(button.style.scale).toBe(resting);
    pointer(button, "pointerdown");
    pointer(popup, "pointercancel");
    expect(button.style.scale).toBe(resting);
    pointer(button, "pointerdown");
    dispatch(popup, new Event("blur"));
    expect(button.style.scale).toBe(resting);
    dispatch(button, new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(button.style.scale).not.toBe(resting);
    dispatch(button, new KeyboardEvent("keyup", { key: " ", bubbles: true }));
    expect(button.style.scale).toBe(resting);
    expect(popup.document.activeElement).toBe(button);
    expect(onStart).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => button.click());
    expect(onStart).toHaveBeenCalledOnce();
    act(() => root.unmount());
    for (const [name, listener] of added.mock.calls)
      if (["pointerup", "pointercancel", "blur", "pagehide"].includes(name))
        expect(removed.mock.calls).toContainEqual([name, listener]);
  } finally {
    act(() => root.unmount());
    container.remove();
    MotionGlobalConfig.useManualTiming = false;
    delete environment.IS_REACT_ACT_ENVIRONMENT;
    vi.restoreAllMocks();
  }
});
