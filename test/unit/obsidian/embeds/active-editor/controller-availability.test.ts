import { describe, expect, it, vi } from "vitest";

import { ActiveEditorAvailability } from "../../../../../src/obsidian/embeds/active-editor/controller-availability";

describe("active editor availability", () => {
  it("combines attachment and pending work into one input gate", () => {
    const onDisabled = vi.fn();
    const onStateChanged = vi.fn();
    const { inputSurface } = inputSurfaceHarness();
    const availability = new ActiveEditorAvailability({
      inputSurface,
      onDisabled,
      onStateChanged,
    });

    availability.setPending(true);
    expect(availability.acceptsInput).toBe(false);
    expect(inputSurface.inert).toBe(true);

    availability.setPending(false);
    availability.setEnabled(false);
    expect(availability.attached).toBe(false);
    expect(onDisabled).toHaveBeenCalledOnce();
    expect(inputSurface.inert).toBe(true);
    expect(onStateChanged).toHaveBeenCalledTimes(3);
  });

  it("does not repeat lifecycle work for unchanged state", () => {
    const onDisabled = vi.fn();
    const onStateChanged = vi.fn();
    const availability = new ActiveEditorAvailability({
      inputSurface: inputSurfaceHarness().inputSurface,
      onDisabled,
      onStateChanged,
    });

    availability.setEnabled(true);
    availability.setPending(false);

    expect(onDisabled).not.toHaveBeenCalled();
    expect(onStateChanged).not.toHaveBeenCalled();
  });

  it("restores focused canvas input after pending work makes it inert", () => {
    const harness = inputSurfaceHarness(true);
    const availability = availabilityFor(harness.inputSurface);

    availability.setPending(true);
    expect(harness.activeElement()).toBe(harness.body);

    availability.setPending(false);
    expect(harness.activeElement()).toBe(harness.inputSurface);
    expect(harness.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does not steal focus that moved elsewhere while work was pending", () => {
    const harness = inputSurfaceHarness(true);
    const availability = availabilityFor(harness.inputSurface);

    availability.setPending(true);
    harness.setActiveElement(harness.other);
    availability.setPending(false);

    expect(harness.activeElement()).toBe(harness.other);
    expect(harness.focus).not.toHaveBeenCalled();
  });
});

function availabilityFor(inputSurface: HTMLDivElement): ActiveEditorAvailability {
  return new ActiveEditorAvailability({
    inputSurface,
    onDisabled: vi.fn(),
    onStateChanged: vi.fn(),
  });
}

function inputSurfaceHarness(initiallyFocused = false) {
  const body = {} as HTMLElement;
  const documentElement = {} as HTMLElement;
  const other = {} as HTMLElement;
  let activeElement: Element | null = initiallyFocused ? null : body;
  let inert = false;
  const focus = vi.fn(() => {
    activeElement = inputSurface;
  });
  const ownerDocument = {
    body,
    documentElement,
    get activeElement() {
      return activeElement;
    },
  } as unknown as Document;
  const inputSurface = {
    focus,
    get inert() {
      return inert;
    },
    set inert(value: boolean) {
      inert = value;
      if (value && activeElement === inputSurface) activeElement = body;
    },
    ownerDocument,
  } as unknown as HTMLDivElement;
  if (initiallyFocused) activeElement = inputSurface;
  return {
    activeElement: () => activeElement,
    body,
    focus,
    inputSurface,
    other,
    setActiveElement: (element: Element | null) => (activeElement = element),
  };
}
