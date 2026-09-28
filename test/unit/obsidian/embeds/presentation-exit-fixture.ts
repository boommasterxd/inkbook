import { PresentationExit } from "../../../../src/obsidian/embeds/presentation-exit";
import type { MotionPreference } from "../../../../src/rendering/motion/transitions";
import { createPresentationMotionWindow } from "../../../fixtures/obsidian/presentation-motion-window";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

export function exitHarness(
  height = 400,
  spacing = { before: 0, after: 0 },
  removeMarkdown?: (
    range: { from: number; to: number },
    source: string,
    mutate: () => void,
  ) => boolean,
) {
  const clock = createPresentationMotionWindow();
  const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  root.getBoundingClientRect = () => ({ height }) as DOMRect;
  let motion: MotionPreference = "system";
  const exit = new PresentationExit(
    root,
    clock.ownerWindow,
    workSchedulerFromFrames(clock.ownerWindow),
    () => motion,
    () => spacing,
    removeMarkdown,
  );
  return {
    ...clock,
    exit,
    root,
    setMotion: (value: MotionPreference) => {
      motion = value;
    },
    get height() {
      return Number.parseFloat(root.style.getPropertyValue("--inkbook-presentation-block-size"));
    },
  };
}
