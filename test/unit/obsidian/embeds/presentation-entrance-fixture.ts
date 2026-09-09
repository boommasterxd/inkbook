import {
  PresentationEntrance,
  type PresentationEntranceState,
} from "../../../../src/obsidian/embeds/presentation-entrance";
import type { MotionPreference } from "../../../../src/rendering/motion/transitions";

import { createPresentationMotionWindow } from "../../../fixtures/obsidian/presentation-motion-window";

export function entranceHarness(state?: PresentationEntranceState) {
  const clock = createPresentationMotionWindow();
  const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  const preview = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  root.append(preview);
  let height = 400;
  let presented = 0;
  let motion: MotionPreference = "system";
  preview.getBoundingClientRect = () => ({ height }) as DOMRect;
  const entrance = new PresentationEntrance({
    motion: () => motion,
    onPresented: () => {
      presented += 1;
    },
    ownerWindow: clock.ownerWindow,
    preview,
    root,
    ...(state === undefined ? {} : { state }),
  });
  return {
    entrance,
    frames: clock.frames,
    listeners: clock.listeners,
    preview,
    root,
    get presented() {
      return presented;
    },
    get renderedHeight() {
      return Number.parseFloat(root.style.getPropertyValue("--inkbook-presentation-block-size"));
    },
    setHeight: (value: number) => {
      height = value;
    },
    setMotion: (value: MotionPreference) => {
      motion = value;
    },
    setSystemReduced: clock.setReduced,
    frame: clock.frame,
  };
}
