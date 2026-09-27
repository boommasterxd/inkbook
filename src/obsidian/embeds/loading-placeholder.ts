import type { MotionPreference } from "../../rendering/motion/transitions";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { applyColorScheme, type ColorSchemeBroadcaster } from "../theme/color-scheme";
import { PresentationOperationFeedback } from "./presentation-operation-feedback";

import { LoadingPlaceholderMotion } from "./loading-placeholder-motion";

export interface LoadingPlaceholder {
  readonly element: HTMLElement;
  readonly startedAt: number;
  readonly renderedHeight: number;
  dispose(): void;
}

/** Reveals a neutral surface and uses the shared delayed loading indicator. */
export function createLoadingPlaceholder(
  host: HTMLElement,
  options: {
    readonly initialHeight?: number;
    readonly motion: MotionPreference;
    readonly onHeight?: (height: number) => void;
    readonly scheme: ColorSchemeBroadcaster;
    readonly startedAt?: number;
    readonly workScheduler: WorkScheduler;
  },
): LoadingPlaceholder {
  const element = host.createDiv({
    cls: "inkbook-root inkbook-loading-placeholder",
    attr: { role: "group", "aria-label": "Loading drawing" },
  });
  element.dataset.inkbookMotion = options.motion;
  const motion = new LoadingPlaceholderMotion(element, options);
  const releaseScheme = options.scheme.subscribe((scheme) => applyColorScheme(element, scheme));
  const ownerWindow = element.ownerDocument.defaultView;
  const startedAt = options.startedAt ?? ownerWindow?.performance?.now() ?? performance.now();
  const feedback = new PresentationOperationFeedback(element, undefined, options.workScheduler);
  feedback.begin("loading", startedAt);
  return {
    element,
    startedAt,
    get renderedHeight() {
      return motion.renderedHeight;
    },
    dispose: () => {
      motion.dispose();
      feedback.dispose();
      releaseScheme();
    },
  };
}
