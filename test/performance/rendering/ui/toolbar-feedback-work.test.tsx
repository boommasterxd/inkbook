// @vitest-environment happy-dom

import { MotionGlobalConfig, processFrame } from "motion";
import { Window as HappyWindow } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { InkbookEditorChrome } from "../../../../src/rendering/ui/editor-chrome";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";

it.each([false, true])(
  "isolates feedback and roving focus from projection, popout=%s",
  async (popout) => {
    const popup = popout ? new HappyWindow() : undefined;
    const ownerDocument = (popup?.document ?? document) as Document;
    const environment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    MotionGlobalConfig.useManualTiming = true;
    const container = ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
    ownerDocument.body.append(container);
    const root = createRoot(container);
    let time = 0;
    const settle = async (): Promise<void> => {
      for (let frame = 0; frame < 30; frame += 1) {
        time += 1000 / 120;
        await act(async () => {
          processFrame(time);
          await Promise.resolve();
        });
      }
    };
    try {
      act(() => root.render(<InkbookEditorChrome {...createEditorChromeProps(ownerDocument)} />));
      await settle();
      const draw = container.querySelector<HTMLButtonElement>("[data-inkbook-action=draw]")!;
      const highlighter = container.querySelector<HTMLButtonElement>(
        "[data-inkbook-action=highlighter]",
      )!;
      const prototype = Object.getPrototypeOf(draw) as HTMLButtonElement;
      const reads = vi.spyOn(prototype, "getBoundingClientRect");
      const groupReads = vi.spyOn(
        Object.getPrototypeOf(container) as HTMLDivElement,
        "getBoundingClientRect",
      );
      for (const target of [draw, highlighter]) {
        act(() => target.focus());
        for (const type of ["keydown", "keyup"]) {
          act(() => {
            target.dispatchEvent(new KeyboardEvent(type, { key: " ", bubbles: true }));
          });
          await settle();
          expect(ownerDocument.activeElement).toBe(target);
        }
      }
      if (popout) {
        for (const type of ["pointerenter", "pointerdown", "pointerup", "pointerleave"]) {
          act(() => {
            draw.dispatchEvent(
              new PointerEvent(type, {
                button: 0,
                isPrimary: true,
                pointerId: 1,
                pointerType: "mouse",
                bubbles: true,
              }),
            );
          });
          await settle();
        }
      }
      expect(reads).not.toHaveBeenCalled();
      expect(groupReads).not.toHaveBeenCalled();
      expect(container.querySelector("[data-inkbook-action=draw]")).toBe(draw);
      expect(container.querySelectorAll("[role=group] button[tabindex='0']")).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      container.remove();
      popup?.close();
      vi.restoreAllMocks();
      MotionGlobalConfig.useManualTiming = false;
      delete environment.IS_REACT_ACT_ENVIRONMENT;
    }
  },
);
