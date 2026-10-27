// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  chooseInkbookAction,
  confirmInkbookAction,
} from "../../../../src/obsidian/dialogs/action-dialog";
import {
  dialogButton as button,
  installDialogTestLifecycle,
} from "../../../fixtures/obsidian/dialog";

installDialogTestLifecycle();

function app(): App {
  return { workspace: { containerEl: document.body } } as App;
}

function confirm(signal?: AbortSignal): Promise<boolean> {
  return confirmInkbookAction(app(), {
    title: "Delete embed?",
    description: "The SVG file will be kept.",
    confirmLabel: "Delete embed",
    destructive: true,
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("Obsidian action dialogs", () => {
  it.each([true, false])("returns explicit confirmation: %s", async (accepted) => {
    const result = confirm();
    expect(document.activeElement).toBe(button("Cancel"));
    expect(button("Delete embed").classList.contains("mod-warning")).toBe(true);
    button(accepted ? "Delete embed" : "Cancel").click();
    await expect(result).resolves.toBe(accepted);
    expect(document.querySelector(".inkbook-action-dialog")).toBeNull();
  });
});

describe("native dialog keyboard navigation", () => {
  it("cycles Tab and Shift+Tab inside the dialog and releases its scope on close", async () => {
    const host = document.body.createEl("button", { text: "Host navigation" });
    const result = confirm();
    const tab = (shiftKey = false): KeyboardEvent => {
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      document.activeElement?.dispatchEvent(event);
      return event;
    };
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button("Delete embed"));
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button("Close"));
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button("Cancel"));
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button("Close"));
    button("Delete embed").disabled = true;
    button("Delete embed").tabIndex = 0;
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button("Cancel"));
    button("Close").hidden = true;
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button("Cancel"));
    button("Cancel").click();
    await expect(result).resolves.toBe(false);
    host.focus();
    expect(tab().defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(host);
  });

  it("keeps the newest native dialog's Tab scope active until it closes", async () => {
    const first = confirm();
    const firstCancel = button("Cancel");
    const second = chooseInkbookAction(app(), {
      title: "Resolve conflict",
      description: "Choose which version to keep.",
      cancelLabel: "Keep current",
      actions: [{ value: "replace", label: "Use other version" }],
    });
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.activeElement?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button("Use other version"));
    button("Keep current").click();
    await expect(second).resolves.toBeNull();
    firstCancel.click();
    await expect(first).resolves.toBe(false);
  });
});

describe("Obsidian action dialog lifecycle", () => {
  it.each(["Escape", "Close", "backdrop"])("cancels through host %s", async (method) => {
    const result = confirm();
    if (method === "Escape")
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    else if (method === "Close") button("Close").click();
    else document.querySelector<HTMLElement>(".inkbook-action-dialog")?.click();
    await expect(result).resolves.toBe(false);
  });

  it.each(["reference", "duplicate"] as const)("returns selected choice %s", async (value) => {
    const result = chooseInkbookAction(app(), {
      title: "Paste Inkbook embed",
      description: "Choose how to use the drawing.",
      cancelLabel: "Keep file",
      actions: [
        { value: "reference", label: "Reference", description: "Use the existing SVG." },
        { value: "duplicate", label: "Duplicate", description: "Create a separate SVG." },
      ],
    });
    expect(document.activeElement).toBe(button("Keep file"));
    const choices = [button("Reference"), button("Duplicate")];
    expect(choices).toHaveLength(2);
    expect(choices[0]?.textContent).toBe("Reference");
    const detail = document.getElementById(choices[0]?.getAttribute("aria-describedby") ?? "");
    expect(detail?.textContent).toBe("Reference: Use the existing SVG.");
    expect(choices[0]?.contains(detail)).toBe(false);
    choices[value === "reference" ? 0 : 1]?.click();
    await expect(result).resolves.toBe(value);
  });

  it("does not open for an already aborted owner", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(confirm(controller.signal)).resolves.toBe(false);
    expect(document.querySelector(".inkbook-action-dialog")).toBeNull();
  });

  it.each(["abort", "pagehide"])("cancels and detaches listeners on %s", async (event) => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = confirm(controller.signal);
    if (event === "abort") controller.abort();
    else window.dispatchEvent(new Event("pagehide"));
    await expect(result).resolves.toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(document.querySelector(".inkbook-action-dialog")).toBeNull();
  });

  it("ignores detached actions and repeated close after cancellation", async () => {
    const controller = new AbortController();
    const settled = vi.fn();
    const result = confirm(controller.signal).then(settled);
    const staleAction = button("Delete embed");
    const staleClose = button("Close");
    staleClose.click();
    staleAction.click();
    staleClose.click();
    controller.abort();
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("renders untrusted text literally and connects the accessible description", async () => {
    const text = '<img src=x onerror="alert(1)">';
    const result = chooseInkbookAction(app(), {
      title: text,
      description: text,
      actions: [{ value: "ok", label: text, description: text }],
    });
    const dialog = document.querySelector<HTMLElement>(".inkbook-action-dialog");
    expect(dialog?.getAttribute("aria-label")).toBe(text);
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe(text);
    const description = document.getElementById(dialog?.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe(text);
    expect(dialog?.querySelector("img")).toBeNull();
    expect(dialog?.querySelector(".inkbook-dialog-choice-description span")?.textContent).toBe(
      text,
    );
    button("Cancel").click();
    await expect(result).resolves.toBeNull();
  });
});

describe("animated action ownership", () => {
  it.each(["confirm", "cancel", "abort", "pagehide"])(
    "settles once after animated %s",
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const settled = vi.fn();
        const result = confirm(controller.signal).then(settled);
        const action = button("Delete embed");
        const cancel = button("Cancel");
        if (outcome === "cancel") cancel.click();
        else action.click();
        expect(document.querySelector(".inkbook-action-dialog")).not.toBeNull();
        expect(settled).not.toHaveBeenCalled();
        action.click();
        cancel.click();
        if (outcome === "abort") controller.abort();
        if (outcome === "pagehide") window.dispatchEvent(new Event("pagehide"));
        await vi.advanceTimersByTimeAsync(120);
        await result;
        expect(settled).toHaveBeenCalledExactlyOnceWith(outcome === "confirm");
        expect(document.querySelector(".inkbook-action-dialog")).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
