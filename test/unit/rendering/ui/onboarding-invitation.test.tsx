// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { OnboardingInvitation } from "../../../../src/rendering/ui/onboarding-invitation";
import { toolbarMotionContext } from "../../../../src/rendering/ui/toolbar-motion";

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
