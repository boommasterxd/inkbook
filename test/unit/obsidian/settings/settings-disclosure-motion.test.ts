// @vitest-environment happy-dom

import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { createSettingsDisclosure } from "../../../../src/obsidian/settings/settings-disclosure";
import { SettingsPanelMotion } from "../../../../src/obsidian/settings/settings-panel-motion";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

installObsidianDomHelpers();

function disclosure(ownerDocument: Document = document) {
  const container = ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  ownerDocument.body.append(container);
  const result = createSettingsDisclosure(container, {
    description: "Select a tool",
    deferDescriptionUntilExpanded: true,
    expanded: false,
    panelId: "settings-disclosure-test",
    title: "Tool",
  });
  return {
    ...result,
    cleanup: () => {
      result.dispose();
      container.remove();
    },
  };
}

function popoutPanel(supportsIntrinsicSize = true) {
  const popout = new Window();
  const css = popout.CSS;
  Object.defineProperty(popout, "CSS", { value: css });
  vi.spyOn(css, "supports").mockImplementation((property) =>
    property === "interpolate-size" ? supportsIntrinsicSize : true,
  );
  const panel = popout.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as unknown as HTMLElement;
  popout.document.body.append(panel as unknown as typeof popout.document.body);
  panel.hidden = true;
  let preference: "full" | "reduced" = "full";
  let changed = (): void => undefined;
  const unsubscribe = vi.fn();
  const motion = new SettingsPanelMotion(
    panel,
    () => preference,
    (listener) => {
      changed = listener;
      return unsubscribe;
    },
  );
  const content = panel.parentElement!;
  return {
    panel,
    content,
    motion,
    unsubscribe,
    setReduced: () => {
      preference = "reduced";
      changed();
    },
    cleanup: () => {
      motion.dispose();
      popout.close();
    },
  };
}

describe("settings disclosure motion", () => {
  it("creates the visible description only on first expansion and reuses it when reopened", () => {
    const view = disclosure();
    try {
      expect(view.content.querySelector(".inkbook-settings-tool-description")).toBeNull();
      expect(
        document.getElementById(view.trigger.getAttribute("aria-describedby")!)?.textContent,
      ).toBe("Select a tool");
      view.content.createEl("button", { text: "Control" });
      view.setExpanded(true, true);
      const description = view.content.firstElementChild;
      expect(description?.textContent).toBe("Select a tool");
      const create = vi.spyOn(document, "createElementNS");
      view.setExpanded(false, true);
      view.setExpanded(true, true);
      expect(view.content.firstElementChild).toBe(description);
      expect(create).not.toHaveBeenCalled();
      create.mockRestore();
    } finally {
      view.cleanup();
    }
  });

  it("retargets the chevron from its current angle", () => {
    const view = disclosure();
    const chevron = view.trigger.querySelector<HTMLElement>(".inkbook-settings-tool-chevron");
    if (chevron === null) throw new Error("Missing chevron.");
    view.setExpanded(true, false);
    chevron.setCssProps({ rotate: "37deg" });
    view.setExpanded(false, false);
    expect(chevron.style.rotate).toBe("37deg");
    view.cleanup();
  });

  it("keeps the current hover color when the pointer leaves during entry", () => {
    const view = disclosure();
    view.trigger.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    // Simulate a rendered midpoint without waiting for wall-clock animation frames.
    const midpoint = "rgb(12, 34, 56)";
    Reflect.set(view.trigger.style, "backgroundColor", midpoint);
    view.trigger.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    expect(view.trigger.style.backgroundColor).toBe("rgb(12, 34, 56)");
    view.cleanup();
  });

  it("ends a pop-out press on its owning window and releases listeners", async () => {
    const popout = new Window();
    const add = vi.spyOn(popout, "addEventListener");
    const remove = vi.spyOn(popout, "removeEventListener");
    const view = disclosure(popout.document as unknown as Document);
    expect(add).toHaveBeenCalledWith("pointerup", expect.any(Function), true);
    view.trigger.dispatchEvent(
      new popout.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId: 7,
        pointerType: "touch",
      }) as unknown as Event,
    );
    popout.dispatchEvent(
      new popout.PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId: 7,
        pointerType: "touch",
      }),
    );
    await vi.waitFor(() => expect(view.trigger.style.backgroundColor).toBe("rgba(0, 0, 0, 0)"));
    view.cleanup();
    expect(remove).toHaveBeenCalledWith("pointerup", expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith("pointercancel", expect.any(Function), true);
    popout.close();
  });
});

describe("pop-out settings panel motion", () => {
  it("retargets loaded content with one pre-mutation height read and one animation owner", () => {
    const view = popoutPanel();
    view.motion.setExpanded(true);
    const previous = view.content.getAnimations()[0]!;
    const ownerWindow = view.content.ownerDocument.defaultView!;
    const reads = vi.spyOn(ownerWindow, "getComputedStyle");
    const update = vi.fn(() => {
      expect(reads).toHaveBeenCalledOnce();
      view.panel.append("Loaded import history.");
    });
    view.motion.updateContent(update);
    expect(update).toHaveBeenCalledOnce();
    expect(reads).toHaveBeenCalledOnce();
    expect(previous.playState).toBe("idle");
    expect(view.content.getAnimations()).toHaveLength(1);
    view.content.getAnimations()[0]!.finish();
    view.motion.setExpanded(false);
    view.content.getAnimations()[0]!.finish();
    reads.mockClear();
    view.motion.updateContent(() => view.panel.replaceChildren());
    expect(reads).not.toHaveBeenCalled();
    view.cleanup();
    reads.mockRestore();
  });

  it("exposes pop-out controls after native expansion and hides them only after collapse", () => {
    const view = popoutPanel();
    const collapsed = vi.fn(() => expect(view.panel.hidden).toBe(true));
    view.motion.setExpanded(true);
    expect(view.panel.hidden).toBe(false);
    expect(view.panel.inert).toBe(false);
    view.content.getAnimations()[0]!.finish();
    expect(view.content.style.height).toBe("auto");
    view.motion.setExpanded(false, collapsed);
    expect(view.panel.inert).toBe(true);
    expect(view.panel.hidden).toBe(false);
    expect(collapsed).not.toHaveBeenCalled();
    view.content.getAnimations()[0]!.finish();
    expect(view.panel.hidden).toBe(true);
    expect(view.content.style.height).toBe("0px");
    expect(view.content.getAnimations()).toHaveLength(0);
    expect(collapsed).toHaveBeenCalledOnce();
    view.cleanup();
  });

  it("keeps reversed pop-out expansion usable and releases interrupted animations on disposal", () => {
    const view = popoutPanel();
    const collapsed = vi.fn();
    const originalParent = view.content.parentElement!.parentElement;
    view.motion.setExpanded(true);
    view.content.getAnimations()[0]!.finish();
    view.motion.setExpanded(false, collapsed);
    const collapse = view.content.getAnimations()[0]!;
    view.motion.setExpanded(true);
    expect(collapsed).not.toHaveBeenCalled();
    expect(collapse.playState).toBe("idle");
    expect(view.content.getAnimations()).toHaveLength(1);
    view.content.getAnimations()[0]!.finish();
    expect(view.panel.hidden).toBe(false);
    expect(view.panel.inert).toBe(false);
    expect(view.content.style.height).toBe("auto");
    view.motion.setExpanded(false, collapsed);
    view.motion.dispose();
    expect(collapsed).not.toHaveBeenCalled();
    expect(view.content.getAnimations()).toHaveLength(0);
    expect(view.panel.parentElement).toBe(originalParent);
    expect(view.content.isConnected).toBe(false);
    expect(view.unsubscribe).toHaveBeenCalledOnce();
    view.cleanup();
  });
});

describe("pop-out settings panel completion fallbacks", () => {
  it("settles interrupted pop-out transitions when reduced motion changes live", () => {
    const view = popoutPanel();
    view.motion.setExpanded(true);
    view.content.getAnimations()[0]!.finish();
    expect(view.content.getAnimations()).toHaveLength(0);
    expect(view.content.style.height).toBe("auto");
    expect(view.panel.hidden).toBe(false);
    const collapsed = vi.fn(() => expect(view.panel.hidden).toBe(true));
    view.motion.setExpanded(false, collapsed);
    expect(collapsed).not.toHaveBeenCalled();
    view.setReduced();
    expect(view.content.style.height).toBe("0px");
    expect(view.panel.inert).toBe(true);
    expect(view.panel.hidden).toBe(true);
    expect(collapsed).toHaveBeenCalledOnce();
    view.setReduced();
    expect(collapsed).toHaveBeenCalledOnce();
    view.cleanup();
  });

  it("keeps pop-out controls usable without native intrinsic-size interpolation", () => {
    const view = popoutPanel(false);
    const collapsed = vi.fn(() => expect(view.panel.hidden).toBe(true));
    view.motion.setExpanded(false, collapsed);
    expect(collapsed).toHaveBeenCalledOnce();
    collapsed.mockClear();
    view.motion.setExpanded(true);
    expect(view.content.style.height).toBe("auto");
    expect(view.panel.hidden).toBe(false);
    expect(view.panel.inert).toBe(false);
    expect(view.content.getAnimations()).toHaveLength(0);
    view.motion.setExpanded(false, collapsed);
    expect(view.panel.hidden).toBe(true);
    expect(view.panel.inert).toBe(true);
    expect(collapsed).toHaveBeenCalledOnce();
    view.motion.setExpanded(true);
    expect(view.content.style.height).toBe("auto");
    expect(view.panel.hidden).toBe(false);
    expect(collapsed).toHaveBeenCalledOnce();
    view.cleanup();
  });
});

it("settles an opening and closing panel on live saved preference changes without replacing controls", () => {
  let preference: "full" | "reduced" = "full";
  let changed: () => void = () => undefined;
  const unsubscribe = vi.fn();
  const panel = document.body.createDiv();
  panel.hidden = true;
  const input = panel.createEl("input");
  document.body.append(panel);
  const motion = new SettingsPanelMotion(
    panel,
    () => preference,
    (listener) => {
      changed = listener;
      return unsubscribe;
    },
  );
  const collapsed = vi.fn(() => expect(panel.hidden).toBe(true));
  motion.setExpanded(false, collapsed);
  expect(collapsed).toHaveBeenCalledOnce();
  collapsed.mockClear();
  motion.setExpanded(true);
  input.focus();
  preference = "reduced";
  changed();
  expect(panel.hidden).toBe(false);
  expect(panel.inert).toBe(false);
  expect(panel.querySelector("input")).toBe(input);
  expect(document.activeElement).toBe(input);
  preference = "full";
  changed();
  motion.setExpanded(false, collapsed);
  expect(panel.inert).toBe(true);
  expect(collapsed).not.toHaveBeenCalled();
  preference = "reduced";
  changed();
  expect(panel.hidden).toBe(true);
  expect(collapsed).toHaveBeenCalledOnce();
  changed();
  expect(collapsed).toHaveBeenCalledOnce();
  motion.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
  panel.remove();
});

it("allows a reduced-motion completion to dispose its React root outside the commit", () => {
  const panel = document.body.createDiv();
  panel.hidden = true;
  const motion = new SettingsPanelMotion(panel, () => "reduced");
  const errors = vi.spyOn(console, "error");
  const collapsed = vi.fn(() => {
    expect(panel.hidden).toBe(true);
    motion.dispose();
  });
  try {
    motion.setExpanded(true);
    motion.setExpanded(false, collapsed);
    expect(collapsed).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
    motion.dispose();
    panel.remove();
  }
});

it("completes the current main-window collapse once and cancels interrupted callbacks", async () => {
  const panel = document.body.createDiv();
  panel.hidden = true;
  const motion = new SettingsPanelMotion(panel, () => "full");
  const interrupted = vi.fn();
  const collapsed = vi.fn(() => expect(panel.hidden).toBe(true));
  try {
    motion.setExpanded(true);
    motion.setExpanded(false, interrupted);
    motion.setExpanded(true);
    motion.setExpanded(false, collapsed);
    await vi.waitFor(() => expect(collapsed).toHaveBeenCalledOnce());
    expect(interrupted).not.toHaveBeenCalled();
    motion.setExpanded(true);
    motion.setExpanded(false, interrupted);
    motion.dispose();
    await Promise.resolve();
    expect(interrupted).not.toHaveBeenCalled();
    expect(collapsed).toHaveBeenCalledOnce();
  } finally {
    motion.dispose();
    panel.remove();
  }
});

it("releases pop-out keyboard and pointer feedback when its window loses focus or hides", async () => {
  const popout = new Window();
  const removals = vi.spyOn(popout, "removeEventListener");
  vi.spyOn(popout, "matchMedia").mockReturnValue(
    Object.assign(new EventTarget(), {
      matches: true,
    }) as unknown as ReturnType<typeof popout.matchMedia>,
  );
  const view = disclosure(popout.document as unknown as Document);
  view.trigger.focus();
  view.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  await vi.waitFor(() =>
    expect(view.trigger.style.backgroundColor).toBe("var(--background-modifier-hover)"),
  );
  popout.dispatchEvent(new popout.Event("blur"));
  expect(popout.document.activeElement).toBe(view.trigger);
  await vi.waitFor(() => expect(view.trigger.style.backgroundColor).toBe("rgba(0, 0, 0, 0)"));
  view.trigger.dispatchEvent(
    new popout.PointerEvent("pointerdown", {
      button: 0,
      isPrimary: true,
      pointerId: 4,
    }) as unknown as Event,
  );
  await vi.waitFor(() =>
    expect(view.trigger.style.backgroundColor).toBe("var(--background-modifier-hover)"),
  );
  popout.dispatchEvent(new popout.Event("pagehide"));
  await vi.waitFor(() => expect(view.trigger.style.backgroundColor).toBe("rgba(0, 0, 0, 0)"));
  view.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() =>
    expect(view.trigger.style.backgroundColor).toBe("var(--background-modifier-hover)"),
  );
  view.cleanup();
  expect(removals).toHaveBeenCalledWith("blur", expect.any(Function));
  expect(removals).toHaveBeenCalledWith("pagehide", expect.any(Function));
  popout.close();
});
