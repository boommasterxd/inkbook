import { expect, onTestFinished, vi } from "vitest";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { ActiveTextSession } from "../../../src/obsidian/embeds/active-editor/text-session";
import type { ActiveEditorController } from "../../../src/obsidian/embeds/active-editor/controller";
import { createActiveEditorModel, createHarness } from "./active-controller";
import { textElement } from "../rendering/text";

/** Exercises text activation through the real canvas pointer, reducer and gesture boundaries. */
export function selectedTextActivation(elements: readonly InkElementV1[] = [textElement()]) {
  const model = createActiveEditorModel(new ElementStore(elements));
  const harness = createHarness({ model });
  const edit = vi.spyOn(ActiveTextSession.prototype, "edit").mockResolvedValue(true);
  harness.controller.handleToolbarAction("select");
  onTestFinished(() => {
    harness.dispose();
    vi.restoreAllMocks();
  });
  return { ...harness, model, edit };
}

export function textActivationPointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  pointerType: "mouse" | "pen" | "touch" = "mouse",
  options: PointerEventInit = {},
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    isPrimary: true,
    pointerId: 7,
    pointerType,
    button: 0,
    buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
    pressure: type === "pointerup" || type === "pointercancel" ? 0 : 0.5,
    clientX: 110,
    clientY: 70,
    ...options,
  });
}

export function tapSelectedText(
  controller: Pick<ActiveEditorController, "handlePointerDown" | "handlePointerUp">,
  pointerType: "mouse" | "pen" | "touch" = "mouse",
  options: PointerEventInit = {},
): void {
  controller.handlePointerDown(textActivationPointer("pointerdown", pointerType, options));
  controller.handlePointerUp(textActivationPointer("pointerup", pointerType, options));
}

/** Encloses the standard text fixture through the real lasso gesture. */
export function lassoTextSelection(
  controller: Pick<
    ActiveEditorController,
    "handlePointerDown" | "handlePointerMove" | "handlePointerUp"
  >,
): void {
  controller.handlePointerDown(
    textActivationPointer("pointerdown", "mouse", { clientX: 0, clientY: 0 }),
  );
  for (const [clientX, clientY] of [
    [230, 0],
    [230, 140],
    [0, 140],
  ] as const)
    controller.handlePointerMove(
      textActivationPointer("pointermove", "mouse", { clientX, clientY }),
    );
  controller.handlePointerUp(
    textActivationPointer("pointerup", "mouse", { clientX: 0, clientY: 0 }),
  );
}

/** Opens the first canvas element through the supported keyboard selection and text-entry flow. */
export async function openFirstTextWithKeyboard(
  harness: Pick<ReturnType<typeof createHarness>, "controller" | "input" | "key">,
  container: HTMLElement,
): Promise<void> {
  harness.controller.handleToolbarAction("select");
  harness.input.focus();
  harness.key("Home");
  harness.key("Enter");
  await vi.waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
}
