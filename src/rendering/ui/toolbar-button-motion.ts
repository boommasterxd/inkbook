import { useAnimationControls, usePresence, usePresenceData } from "motion/react";
import type { Variants } from "motion/react";
import { useEffect } from "react";

import { TOOLBAR_CONTEXT_STAGGER_MS, TRANSITION_DURATIONS } from "../motion/transitions";
import type { ToolbarPresenceOrder } from "./toolbar-presence";
import type { ToolbarAction } from "./toolbar-types";
import { toolbarLayoutTransition, type ToolbarMotionState } from "./toolbar-motion";
import type { ChromeColors } from "./chrome-palette";

/** Retarget already-retained exits when the presentation changes after removal. */
export function useToolbarButtonAnimation(
  lifecycle: ToolbarMotionState,
  {
    enterOrder,
    action,
    disabled,
    pressed,
  }: {
    readonly enterOrder: number;
    readonly action: ToolbarAction;
    readonly disabled: boolean;
    readonly pressed: boolean | undefined;
  },
) {
  const [isPresent, safeToRemove] = usePresence();
  const controls = useAnimationControls();
  const order = usePresenceData() as ToolbarPresenceOrder | undefined;
  const exitOrder = Math.max(0, order?.exiting.indexOf(action) ?? 0);
  const definition = lifecycle.locking
    ? "locked"
    : lifecycle.preparing
      ? "preparing"
      : isPresent
        ? "visible"
        : "exit";
  useEffect(() => {
    let current = true;
    const complete = (): void => {
      if (current && !isPresent) safeToRemove?.();
    };
    if (lifecycle.reduced || lifecycle.preparing) {
      controls.set(definition);
      if (!lifecycle.preparing) complete();
    } else void controls.start(definition).then(complete);
    return () => {
      current = false;
      controls.stop();
    };
  }, [
    controls,
    definition,
    disabled,
    enterOrder,
    exitOrder,
    isPresent,
    lifecycle.preparing,
    lifecycle.colors,
    lifecycle.reduced,
    pressed,
    safeToRemove,
  ]);
  return { isPresent, controls, order };
}

export function toolbarButtonVariants(
  context: boolean,
  action: ToolbarAction,
  enterOrder: number,
  lifecycle: ToolbarMotionState,
  disabled: boolean,
  pressed: boolean | undefined,
): Variants {
  const color = toolbarButtonForeground(action, lifecycle.colors, disabled, pressed);
  const foreground = color === undefined ? {} : { "--inkbook-toolbar-foreground": color };
  const shown = context
    ? { scale: 1, ...foreground }
    : { scale: 1, ...foreground, opacity: disabled ? 0.48 : 1, width: "44px", flexBasis: "44px" };
  const hidden = context ? { scale: 0 } : { scale: 0.96, opacity: 0 };
  const transition = (exiting: boolean, order = 0) => ({
    ...toolbarLayoutTransition(lifecycle.reduced),
    ...(context
      ? {
          duration: lifecycle.reduced ? 0 : TRANSITION_DURATIONS.conditionalToolbarControl / 1000,
          delay: lifecycle.reduced ? 0 : (order * TOOLBAR_CONTEXT_STAGGER_MS) / 1000,
          ease: exiting ? ("easeIn" as const) : ("easeOut" as const),
        }
      : {}),
  });
  return {
    visible: {
      ...shown,
      transition: {
        ...transition(false, enterOrder),
        "--inkbook-toolbar-foreground": toolbarLayoutTransition(lifecycle.reduced),
      },
    },
    preparing: { ...(context ? hidden : shown), transition: { duration: 0 } },
    locked: { ...(context ? hidden : shown), transition: transition(true) },
    removed: { ...hidden, transition: { duration: 0 } },
    exit: (order: ToolbarPresenceOrder | undefined) => ({
      ...hidden,
      transition: transition(true, Math.max(0, order?.exiting.indexOf(action) ?? 0)),
    }),
  };
}

export function toolbarButtonForeground(
  action: ToolbarAction,
  colors: ChromeColors | undefined,
  disabled: boolean,
  pressed: boolean | undefined,
): string | undefined {
  return disabled
    ? colors?.faint
    : action === "delete"
      ? colors?.danger
      : pressed === true
        ? colors?.accent
        : colors?.muted;
}
