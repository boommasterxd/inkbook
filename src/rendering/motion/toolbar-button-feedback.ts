import { STANDARD_EASING, TRANSITION_DURATIONS } from "./transitions";

const transparent = "rgba(0, 0, 0, 0)";

/** Shared painted-surface targets for React and native toolbar controls. */
export function toolbarButtonFeedback(
  colors:
    | {
        readonly activeBackground?: string;
        readonly activeBorder?: string;
        readonly hover?: string;
        readonly dangerHover?: string;
        readonly accent?: string;
      }
    | undefined,
  active = false,
  danger = false,
) {
  const hover = {
    "--inkbook-toolbar-background": (danger ? colors?.dangerHover : colors?.hover) ?? transparent,
  };
  return {
    rest: {
      "--inkbook-toolbar-background": active
        ? (colors?.activeBackground ?? transparent)
        : transparent,
      "--inkbook-toolbar-border": active ? (colors?.activeBorder ?? transparent) : transparent,
      scale: active ? 0.96 : 1,
    },
    hover,
    press: { ...hover, scale: 0.92 },
    focus: { "--inkbook-toolbar-border": colors?.accent ?? transparent },
  };
}

export function toolbarButtonFeedbackTransition(reduced: boolean) {
  return {
    duration: reduced ? 0 : TRANSITION_DURATIONS.toolActiveState / 1000,
    ease: STANDARD_EASING,
  };
}
