import { describe, expect, it, vi } from "vitest";

import { ActiveEditorAvailability } from "../../../../../src/obsidian/embeds/active-editor/controller-availability";

describe("active editor availability", () => {
  it("combines attachment and pending work into one input gate", () => {
    const onDisabled = vi.fn();
    const onStateChanged = vi.fn();
    const setInputInert = vi.fn();
    const availability = new ActiveEditorAvailability({
      onDisabled,
      onStateChanged,
      setInputInert,
    });

    availability.setPending(true);
    expect(availability.acceptsInput).toBe(false);
    expect(setInputInert).toHaveBeenLastCalledWith(true);

    availability.setPending(false);
    availability.setEnabled(false);
    expect(availability.attached).toBe(false);
    expect(onDisabled).toHaveBeenCalledOnce();
    expect(setInputInert).toHaveBeenLastCalledWith(true);
    expect(onStateChanged).toHaveBeenCalledTimes(3);
  });

  it("does not repeat lifecycle work for unchanged state", () => {
    const onDisabled = vi.fn();
    const onStateChanged = vi.fn();
    const availability = new ActiveEditorAvailability({
      onDisabled,
      onStateChanged,
      setInputInert: vi.fn(),
    });

    availability.setEnabled(true);
    availability.setPending(false);

    expect(onDisabled).not.toHaveBeenCalled();
    expect(onStateChanged).not.toHaveBeenCalled();
  });
});
