import { onTestFinished, vi } from "vitest";
import type { PointerSample } from "../../../src/editor/input/index";
import type { ActiveEditorHandleInteraction } from "../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import { TextHandleHover } from "../../../src/obsidian/embeds/active-editor/text-handle-hover";
import { immediateWorkScheduler } from "./immediate-work-scheduler";
import { appendOwnedIframe } from "./owned-iframe";

export const textHandleNavigation = {
  screenPointer: (event: PointerEvent): PointerSample => ({
    x: event.clientX,
    y: event.clientY,
    pointerId: event.pointerId,
    pointerType: "mouse",
  }),
  pageSample: (point: PointerSample) => point,
};

export function textHandleHoverFixture(handles: Pick<ActiveEditorHandleInteraction, "cursorAt">) {
  const { frame, document: child } = appendOwnedIframe();
  const content = child.createElement("div");
  content.className = "cm-content";
  child.body.append(content);
  const readFrame = vi
    .spyOn(frame, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(50, 70, 800, 600));
  let active = true;
  const hover = new TextHandleHover({
    document: child,
    ownerWindow: window,
    scheduler: immediateWorkScheduler(),
    active: () => active,
    handles,
    navigation: textHandleNavigation,
  });
  onTestFinished(() => {
    hover.dispose();
    readFrame.mockRestore();
    frame.remove();
  });
  const move = (point: { readonly x: number; readonly y: number }) =>
    content.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 1,
        pointerType: "mouse",
        clientX: point.x - 50,
        clientY: point.y - 70,
        bubbles: true,
      }),
    );
  return {
    hover,
    child,
    content,
    readFrame,
    move,
    cursor: () => child.documentElement.style.getPropertyValue("--inkbook-text-handle-cursor"),
    deactivate: () => {
      active = false;
    },
  };
}
