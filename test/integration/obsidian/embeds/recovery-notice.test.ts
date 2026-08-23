import { Notice } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  showAttachedRecoveryPanel,
  showHeadlessRecoveryNotice,
  type HeadlessRecoveryActions,
} from "../../../../src/obsidian/embeds/recovery-notice";

interface TestNoticeElement {
  readonly attributes: Map<string, string>;
  readonly children: TestNoticeElement[];
  disabled: boolean;
  dispatch(type: string): void;
  readonly removed: boolean;
  readonly textContent: string;
}

class TestListeners {
  readonly #listeners = new Map<string, Set<EventListener>>();

  get count(): number {
    return [...this.#listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }

  add(type: string, listener: EventListener): void {
    const listeners = this.#listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  remove(type: string, listener: EventListener): void {
    this.#listeners.get(type)?.delete(listener);
  }
}

class TestDialogElement {
  readonly attributes = new Map<string, string>();
  readonly children: TestDialogElement[] = [];
  disabled = false;
  id = "";
  readonly #listeners = new TestListeners();
  parent: TestDialogElement | undefined;
  readonly style: Record<string, string> = {};
  textContent = "";
  type = "";

  constructor(
    readonly owner: TestDocument,
    readonly tagName: string,
  ) {}

  readonly classList = { add: (..._names: string[]): void => undefined };

  get listenerCount(): number {
    return this.#listeners.count;
  }

  descendantText(): string[] {
    return this.descendants().map((element) => element.textContent);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.#listeners.add(type, listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.#listeners.remove(type, listener);
  }

  append(...children: TestDialogElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  createDiv(options?: { readonly cls?: string; readonly text?: string }): TestDialogElement {
    const child = this.createChild("div", options?.cls);
    child.textContent = options?.text ?? "";
    return child;
  }

  createEl(tagName: string, options?: { readonly text?: string }): TestDialogElement {
    const child = this.createChild(tagName);
    child.textContent = options?.text ?? "";
    return child;
  }

  dispatch(type: string): void {
    this.#listeners.dispatch(type, { type } as Event);
  }

  focus(): void {
    this.owner.activeElement = this;
  }

  getElementsByTagName(tagName: string): {
    length: number;
    item(index: number): TestDialogElement | null;
  } {
    const matches = this.descendants().filter((element) => element.tagName === tagName);
    return { length: matches.length, item: (index) => matches[index] ?? null };
  }

  remove(): void {
    if (this.parent === undefined) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  private createChild(tagName: string, className?: string): TestDialogElement {
    const child = new TestDialogElement(this.owner, tagName);
    if (className !== undefined) child.classList.add(className);
    this.append(child);
    return child;
  }

  private descendants(): TestDialogElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

class TestDocument {
  activeElement: TestDialogElement | undefined;
  readonly body = new TestDialogElement(this, "body");
  readonly #listeners = new TestListeners();

  get listenerCount(): number {
    return this.#listeners.count;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.#listeners.add(type, listener);
  }

  createElement(tagName: string): TestDialogElement {
    return new TestDialogElement(this, tagName);
  }

  dispatchKey(key: string, shiftKey = false): void {
    this.#listeners.dispatch("keydown", {
      key,
      preventDefault: vi.fn(),
      shiftKey,
      type: "keydown",
    } as unknown as KeyboardEvent);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.#listeners.remove(type, listener);
  }
}

function actionButtons(document: TestDocument): TestDialogElement[] {
  return headlessDialog(document)?.children[3]?.children ?? [];
}

function headlessDialog(document: TestDocument): TestDialogElement | undefined {
  return document.body.children.find(
    (element) => element.children[0]?.attributes.get("role") === "dialog",
  )?.children[0];
}

function showRecovery(
  document: TestDocument,
  overrides: Partial<HeadlessRecoveryActions> = {},
): ReturnType<typeof showHeadlessRecoveryNotice> {
  return showHeadlessRecoveryNotice(
    "drawings/page.svg",
    {
      reloadExternal: vi.fn(async () => false),
      retry: vi.fn(() => false),
      saveLocalCopy: vi.fn(async () => false),
      ...overrides,
    },
    () => document as unknown as Document,
  );
}

describe("headless recovery notice", () => {
  it("mounts in the active document at show time and keeps that owner", () => {
    const first = new TestDocument();
    const second = new TestDocument();
    showRecovery(first);

    expect(first.body.children).toHaveLength(1);
    expect(second.body.children).toHaveLength(0);
    expect(actionButtons(first).map((button) => button.textContent)).toEqual([
      "Retry",
      "Reload external version",
      "Save local copy",
    ]);
    expect(first.activeElement?.textContent).toBe("Retry");
    expect(headlessDialog(first)?.attributes.get("role")).toBe("dialog");
    expect(headlessDialog(first)?.attributes.get("aria-modal")).toBe("true");
    expect(headlessDialog(first)?.children[2]?.textContent).toBe(
      "Unsaved changes remain available for recovery.",
    );
    expect(
      headlessDialog(first)
        ?.descendantText()
        .some((text) => text.includes("drawings/page.svg")),
    ).toBe(false);
  });

  it("traps boundary focus and restores the prior owner-document focus on close", () => {
    const document = new TestDocument();
    const trigger = document.body.createEl("button", { text: "Trigger" });
    trigger.focus();
    showRecovery(document);
    const dialog = headlessDialog(document);
    const close = dialog?.children[0];
    const recoveryButtons = actionButtons(document);

    recoveryButtons[2]?.focus();
    document.dispatchKey("Tab");
    expect(document.activeElement).toBe(close);
    document.dispatchKey("Tab", true);
    expect(document.activeElement).toBe(recoveryButtons[2]);
    close?.dispatch("click");
    expect(document.activeElement).toBe(trigger);
  });

  it("disables actions while reload is pending and closes only after confirmation", async () => {
    const document = new TestDocument();
    let finish: ((confirmed: boolean) => void) | undefined;
    const reloadExternal = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    showRecovery(document, { reloadExternal });
    const recoveryButtons = actionButtons(document);

    recoveryButtons[1]?.dispatch("click");
    expect(recoveryButtons.every((button) => button.disabled)).toBe(true);
    expect(document.body.children).toHaveLength(1);
    finish?.(true);
    await vi.waitFor(() => expect(document.body.children).toHaveLength(0));
  });

  it("keeps recovery pending after a failed action and releases DOM listeners on close", async () => {
    const document = new TestDocument();
    const recovery = showRecovery(document, {
      saveLocalCopy: vi.fn(async () => Promise.reject(new Error("write failed"))),
    });
    const recoveryButtons = actionButtons(document);

    recoveryButtons[2]?.dispatch("click");
    await vi.waitFor(() => expect(recoveryButtons.every((button) => !button.disabled)).toBe(true));
    expect(document.body.children).toHaveLength(1);
    recovery.close();
    expect(document.body.children).toHaveLength(0);
    expect(document.listenerCount).toBe(0);
    expect(recoveryButtons.every((button) => button.listenerCount === 0)).toBe(true);
  });

  it("dismisses with Escape without resolving recovery", () => {
    const document = new TestDocument();
    const actions = {
      reloadExternal: vi.fn(async () => true),
      retry: vi.fn(() => true),
      saveLocalCopy: vi.fn(async () => true),
    };
    showRecovery(document, actions);

    document.dispatchKey("Escape");
    expect(document.body.children).toHaveLength(0);
    expect(actions.reloadExternal).not.toHaveBeenCalled();
    expect(actions.retry).not.toHaveBeenCalled();
    expect(actions.saveLocalCopy).not.toHaveBeenCalled();
  });
});

describe("attached recovery panel", () => {
  it("offers retry, local copy, and cancel with accessible pending behavior", async () => {
    const host = new Notice("").messageEl;
    const closed = vi.fn();
    let finish: ((confirmed: boolean) => void) | undefined;
    const panel = showAttachedRecoveryPanel(
      host,
      {
        cancel: vi.fn(() => true),
        retry: vi.fn(() => false),
        saveLocalCopy: vi.fn(
          () =>
            new Promise<boolean>((resolve) => {
              finish = resolve;
            }),
        ),
      },
      closed,
    ) as unknown as TestNoticeElement;
    const actionButtons = panel.children[1]?.children ?? [];

    expect(panel.attributes.get("role")).toBe("alert");
    expect(panel.attributes.get("aria-label")).toBe("Save failed");
    expect(panel.children[0]?.textContent).toBe("Could not save changes");
    expect(actionButtons.map((button) => button.attributes.get("aria-label"))).toEqual([
      "Retry save",
      "Save copy",
      "Continue editing",
    ]);
    expect(actionButtons.map((button) => button.children[0]?.attributes.get("data-icon"))).toEqual([
      "rotate-ccw",
      "copy-plus",
      "pencil",
    ]);
    actionButtons[0]?.dispatch("click");
    expect(actionButtons.every((button) => !button.disabled)).toBe(true);
    actionButtons[1]?.dispatch("click");
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
    finish?.(false);
    await vi.waitFor(() => expect(actionButtons.every((button) => !button.disabled)).toBe(true));
    actionButtons[2]?.dispatch("click");
    expect(panel.removed).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
