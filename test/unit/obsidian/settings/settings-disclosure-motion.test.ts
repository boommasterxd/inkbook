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

describe("settings disclosure motion", () => {
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

  it("keeps a pop-out disclosure operable through open and close", async () => {
    const popout = new Window();
    const panel = popout.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLElement;
    popout.document.body.append(panel as unknown as typeof popout.document.body);
    panel.hidden = true;
    const motion = new SettingsPanelMotion(panel, () => "full");
    motion.setExpanded(true);
    expect(panel.hidden).toBe(false);
    expect(panel.inert).toBe(false);
    motion.setExpanded(false);
    expect(panel.inert).toBe(true);
    await vi.waitFor(() => expect(panel.hidden).toBe(true));
    motion.dispose();
    popout.close();
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
  motion.setExpanded(false);
  expect(panel.inert).toBe(true);
  preference = "reduced";
  changed();
  expect(panel.hidden).toBe(true);
  motion.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
  panel.remove();
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
