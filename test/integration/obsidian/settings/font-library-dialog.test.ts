// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { Keymap, Platform, type App } from "obsidian";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { Localization } from "../../../../src/domain/localization";
import type { MotionPreference } from "../../../../src/rendering/motion/transitions";
import * as elementMotion from "../../../../src/obsidian/runtime/element-motion";
import type {
  LibraryFontFace,
  VaultFontLibrary,
} from "../../../../src/obsidian/fonts/vault-font-library";
import { openFontLibraryDialog } from "../../../../src/obsidian/settings/fonts/font-library-dialog";
import { dialogButton, installDialogTestLifecycle } from "../../../fixtures/obsidian/dialog";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";
import { installPluginStyles } from "../../../fixtures/obsidian/plugin-styles";

installDialogTestLifecycle();
afterEach(() => {
  Platform.isPhone = false;
  Platform.isMobile = false;
  document.adoptedStyleSheets = [];
});

function fixture(
  signal: AbortSignal = new AbortController().signal,
  populated: boolean | number = false,
  motion: MotionPreference = "reduced",
) {
  const trigger = document.body.createEl("button", { text: "Choose font" });
  trigger.focus();
  const app = { keymap: new Keymap(), workspace: { containerEl: document.body } } as App;
  const localization = new Localization();
  const onClosed = vi.fn();
  let faces: LibraryFontFace[] = Array.from(
    { length: typeof populated === "number" ? populated : Number(populated) },
    (_, index) => ({
      id: index === 0 ? "a".repeat(64) : index.toString(16).padStart(64, "0"),
      family: `custom-example-${index}`,
      displayName: index === 0 ? "Example" : `Example ${index + 1}`,
      path: `Inkbook Fonts/example-${index}.ttf`,
      weight: 700,
      style: "normal" as const,
    }),
  );
  const remove = vi.fn(async (id: string) => {
    faces = faces.filter((face) => face.id !== id);
  });
  const library = { list: () => faces, remove } as unknown as VaultFontLibrary;
  const onChanged = vi.fn();
  const dialog = openFontLibraryDialog(app, {
    localization,
    library,
    trigger,
    onClosed,
    readMotion: () => motion,
    workScheduler: () => workSchedulerFromFrames(window),
    onChanged,
    signal,
  });
  return { dialog, localization, trigger, onClosed, onChanged, remove };
}

function stubIntrinsicHeight(surface: HTMLElement, onRead?: () => void): void {
  const css = window.CSS;
  vi.spyOn(window, "CSS", "get").mockReturnValue(css);
  vi.spyOn(css, "supports").mockReturnValue(true);
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    if (element !== surface) return computedStyle(element);
    return {
      get height() {
        onRead?.();
        return "240px";
      },
      scale: "1",
      opacity: "1",
    } as CSSStyleDeclaration;
  });
}

function spyOnHeightTransition(
  animations: MockInstance<typeof elementMotion.animateOwnedElement>,
  surface: HTMLElement,
) {
  const callIndex = animations.mock.calls.findIndex(
    ([element, frames]) => element === surface && "height" in frames,
  );
  expect(callIndex).toBeGreaterThanOrEqual(0);
  const transition = animations.mock.results[callIndex]!.value as ReturnType<
    typeof elementMotion.animateOwnedElement
  >;
  return vi.spyOn(transition, "stop");
}

function expectCompletedExit(
  context: ReturnType<typeof fixture>,
  surface: HTMLElement,
  remainingDuration: number,
): void {
  vi.advanceTimersByTime(remainingDuration);
  expect(surface.isConnected).toBe(false);
  expect(context.onClosed).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(context.trigger);
}

it("opens the library as a named dialog and returns focus on keyboard dismissal", async () => {
  const context = fixture();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const title = document.getElementById(dialog.getAttribute("aria-labelledby") ?? "");
  expect(title?.textContent).toBe("Font library");
  expect(dialog.textContent).toContain(context.localization.t("fonts.empty"));
  expect(dialog.querySelector('button[aria-label="Add font"]')).toBe(document.activeElement);
  context.localization.setLanguage("de");
  expect(title?.textContent).toBe("Schriftbibliothek");
  expect(dialog.textContent).toContain(context.localization.t("fonts.empty"));
  await assertAccessibleSemantics(dialog, ["aria-dialog-name", "button-name"]);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(context.trigger);
  expect(context.onClosed).toHaveBeenCalledOnce();
  context.dialog.closeImmediately();
  expect(context.onClosed).toHaveBeenCalledOnce();
});

it("explains source retention before removing the exact style and restores focus on cancel", async () => {
  const context = fixture(undefined, true);
  try {
    expect(document.querySelectorAll('button[aria-label="Add font"]')).toHaveLength(1);
    expect(
      document.querySelector('[data-inkbook-setting-identity="font-library-add"]'),
    ).not.toBeNull();
    const remove = dialogButton("Remove Example from library");
    expect(document.body.textContent).not.toContain(context.localization.t("fonts.retention"));
    remove.focus();
    remove.click();
    const confirmation = document.querySelector<HTMLElement>(
      '.inkbook-action-dialog[role="dialog"]',
    )!;
    expect(confirmation.textContent).toContain("Remove Example · Bold from library");
    expect(confirmation.textContent).toContain(context.localization.t("fonts.retention"));
    expect(document.activeElement).toBe(dialogButton("Cancel"));
    await assertAccessibleSemantics(confirmation, ["aria-dialog-name", "button-name"]);
    dialogButton("Cancel").click();
    await vi.waitFor(() => expect(document.activeElement).toBe(remove));
    expect(context.remove).not.toHaveBeenCalled();
    expect(context.onChanged).not.toHaveBeenCalled();
    remove.click();
    dialogButton("Remove from library").click();
    await vi.waitFor(() => expect(context.onChanged).toHaveBeenCalledOnce());
    expect(context.remove).toHaveBeenCalledExactlyOnceWith("a".repeat(64));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  } finally {
    context.dialog.closeImmediately();
  }
});

it.each(["owner", "dialog", "language"] as const)(
  "closes pending removal when its %s lifetime ends",
  async (ending) => {
    const lifetime = new AbortController();
    const context = fixture(lifetime.signal, true);
    dialogButton("Remove Example from library").click();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    if (ending === "owner") lifetime.abort();
    else if (ending === "dialog") context.dialog.closeImmediately();
    else context.localization.setLanguage("de");
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(
        ending === "language" ? 1 : 0,
      ),
    );
    expect(context.remove).not.toHaveBeenCalled();
    expect(context.onChanged).not.toHaveBeenCalled();
    context.dialog.closeImmediately();
  },
);

it("rejects an already released owner before mounting controls or retaining subscriptions", () => {
  const lifetime = new AbortController();
  lifetime.abort();
  const context = fixture(lifetime.signal);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('input[type="file"]')).toBeNull();
  expect(context.onClosed).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(context.trigger);
  context.localization.setLanguage("de");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("starts guided import from the empty library action and restores it when returning", () => {
  const context = fixture();
  const emptyAction = () =>
    document.querySelector<HTMLButtonElement>(
      '[data-inkbook-setting-identity="font-library-empty"] button[aria-label="Add font"]',
    );
  expect(emptyAction()).not.toBeNull();
  expect(document.querySelectorAll('button[aria-label="Add font"]')).toHaveLength(1);
  expect(document.querySelector('[data-inkbook-setting-identity="font-library-add"]')).toBeNull();
  emptyAction()!.click();
  expect(document.querySelector('.inkbook-font-import [aria-current="step"]')?.textContent).toBe(
    "1",
  );
  expect(document.querySelector('button[aria-label^="Choose font files"]')).not.toBeNull();
  expect(emptyAction()).toBeNull();
  document.querySelector<HTMLButtonElement>('button[aria-label="Font library"]')!.click();
  expect(document.querySelector(".inkbook-font-import")).toBeNull();
  expect(emptyAction()).not.toBeNull();
  expect(document.querySelectorAll('button[aria-label="Add font"]')).toHaveLength(1);
  context.dialog.closeImmediately();
  expect(document.activeElement).toBe(context.trigger);
});

it("captures the retained library before replacing it with upload and cancels height motion on close", () => {
  vi.useFakeTimers();
  const animations = vi.spyOn(elementMotion, "animateOwnedElement");
  const context = fixture(undefined, false, "full");
  const surface = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const captured: boolean[] = [];
  stubIntrinsicHeight(surface, () => {
    captured.push(
      surface.querySelector('[data-inkbook-setting-identity="font-library-empty"]') !== null,
    );
  });
  const heightCalls = () =>
    animations.mock.calls.filter(([element, frames]) => element === surface && "height" in frames);
  try {
    dialogButton("Add font").click();
    dialogButton("Font library").click();
    expect(captured).toHaveLength(0);
    expect(heightCalls()).toHaveLength(0);
    vi.advanceTimersByTime(120);

    dialogButton("Add font").click();
    expect(captured).toEqual([true]);
    expect(heightCalls()).toHaveLength(1);
    expect(surface.querySelector('button[aria-label^="Choose font files"]')).not.toBeNull();
    expect(
      surface.querySelector('[data-inkbook-setting-identity="font-library-empty"]'),
    ).toBeNull();
    const stop = spyOnHeightTransition(animations, surface);
    context.dialog.close();
    expect(stop).toHaveBeenCalledOnce();
    expect(surface.isConnected).toBe(true);
    expect(context.onClosed).not.toHaveBeenCalled();
    expectCompletedExit(context, surface, 120);
  } finally {
    context.dialog.closeImmediately();
    vi.useRealTimers();
  }
});

it("freezes an interrupted phone height transition when Escape dismisses the retained sheet", () => {
  Platform.isPhone = true;
  Platform.isMobile = true;
  vi.useFakeTimers();
  const animations = vi.spyOn(elementMotion, "animateOwnedElement");
  const context = fixture(undefined, false, "full");
  const surface = document.querySelector<HTMLElement>('[role="dialog"]')!;
  stubIntrinsicHeight(surface);
  try {
    vi.advanceTimersByTime(220);
    dialogButton("Add font").click();
    const stop = spyOnHeightTransition(animations, surface);
    vi.advanceTimersByTime(100);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(stop).toHaveBeenCalledOnce();
    expect(surface.isConnected).toBe(true);
    expect(surface.inert).toBe(true);
    expect(context.onClosed).not.toHaveBeenCalled();
    const frozenHeight = surface.style.height;
    expect(frozenHeight).not.toBe("");
    // Pass the abandoned height completion while the independently owned exit remains active.
    vi.advanceTimersByTime(121);
    expect(surface.isConnected).toBe(true);
    expect(surface.style.height).toBe(frozenHeight);
    expectCompletedExit(context, surface, 99);
  } finally {
    context.dialog.closeImmediately();
    vi.useRealTimers();
  }
});

it("still closes when the originating picker was replaced while management was open", () => {
  const context = fixture();
  context.trigger.remove();
  context.dialog.close();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(context.onClosed).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(document.body);
});

it("keeps phone library pagination inside shrinkable content until its owner closes", async () => {
  Platform.isPhone = true;
  Platform.isMobile = true;
  installPluginStyles("adaptive-panel", "phone-sheet-host", "font-library-dialog");
  const lifetime = new AbortController();
  const context = fixture(lifetime.signal, 9);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-label")).toBe("Font library");
  expect(dialog.querySelector('button[aria-label="Add font"]')).not.toBeNull();
  const body = dialog.querySelector<HTMLElement>(".inkbook-font-library-body")!;
  // happy-dom has no layout; protect the constraints that keep the body scrollable.
  expect(getComputedStyle(body).overflowY).toBe("auto");
  expect(getComputedStyle(body).minBlockSize).toBe("0");
  for (const selector of [
    ".inkbook-adaptive-panel-layout-host",
    ".inkbook-adaptive-panel-motion-surface",
    ".inkbook-adaptive-panel-layout-content",
  ]) {
    const element = dialog.querySelector<HTMLElement>(selector)!;
    expect(element, selector).not.toBeNull();
    const style = getComputedStyle(element);
    expect(style.display, selector).toBe("flex");
    expect(style.flexDirection, selector).toBe("column");
    expect(style.minBlockSize, selector).toBe("0");
  }
  const scroll = dialog.querySelector<HTMLElement>(".inkbook-adaptive-panel-scroll")!;
  expect(getComputedStyle(scroll).minBlockSize).toBe("0");
  expect(body.querySelectorAll(".inkbook-font-library-font-row")).toHaveLength(8);
  const next = dialogButton(context.localization.t("fonts.next"));
  expect(body.contains(next)).toBe(true);
  next.click();
  expect(body.querySelectorAll(".inkbook-font-library-font-row")).toHaveLength(1);
  expect(body.textContent).toContain("Example 9");
  dialogButton(context.localization.t("fonts.previous")).click();
  expect(body.querySelectorAll(".inkbook-font-library-font-row")).toHaveLength(8);
  await assertAccessibleSemantics(dialog, ["aria-dialog-name", "button-name"]);
  lifetime.abort();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(context.trigger);
  expect(context.onClosed).toHaveBeenCalledOnce();
});
