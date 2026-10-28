import { motion, useIsPresent } from "motion/react";
import { useCallback, useContext, useRef } from "react";

import { toolbarMotionContext, toolbarLayoutTransition } from "./toolbar-motion";
import { toolbarButtonVariants, useToolbarButtonAnimation } from "./toolbar-button-motion";
import { useToolbarOwnerGestures } from "./toolbar-owner-gestures";
import { ToolbarActionIcon } from "./toolbar-action-icon";
import { ToolbarStyleIcon, type ToolbarStyleIconState } from "./style-icon";
import { CHROME_TRANSPARENT } from "./chrome-palette";
import type { ToolbarAction, ToolbarButtonDefinition, ToolbarState } from "./toolbar-types";

export interface ToolbarIconButtonProps {
  readonly contextButton: boolean;
  readonly confirmation: ToolbarState["actionConfirmation"];
  readonly definition: ToolbarButtonDefinition;
  readonly disabled: boolean;
  readonly expanded: boolean | undefined;
  readonly enterOrder: number;
  readonly onAction: (action: ToolbarAction, trigger: HTMLButtonElement) => void;
  readonly popupRole: "dialog" | "menu" | undefined;
  readonly pressed: boolean | undefined;
  readonly registerButton?:
    ((action: ToolbarAction, element: HTMLButtonElement | null) => void) | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly styleIcon: ToolbarStyleIconState;
  readonly tabIndex: number;
  readonly tool: boolean;
}

export function ToolbarIconButton(props: ToolbarIconButtonProps) {
  const lifecycle = useContext(toolbarMotionContext);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const present = useIsPresent();
  const { action } = props.definition;
  const { registerButton } = props;
  const setButton = useCallback(
    (element: HTMLButtonElement | null) => {
      buttonRef.current = element;
      registerButton?.(action, element);
    },
    [action, registerButton],
  );
  const { isPresent, controls, order } = useToolbarButtonAnimation(lifecycle, {
    enterOrder: props.enterOrder,
    action: props.definition.action,
    disabled: props.disabled,
    pressed: props.pressed,
  });
  const disabled = props.disabled || !isPresent || lifecycle.locking;
  return (
    <motion.button
      animate={controls}
      custom={order}
      initial={props.contextButton ? "preparing" : false}
      variants={toolbarButtonVariants(
        props.contextButton,
        props.definition.action,
        props.enterOrder,
        lifecycle,
        props.disabled,
        props.pressed,
      )}
      layout="position"
      transition={{ layout: toolbarLayoutTransition(lifecycle.reduced) }}
      {...(!disabled && lifecycle.foreignWindow !== true
        ? { whileHover: "hover", whileTap: "press" }
        : {})}
      {...(!disabled ? { whileFocus: "focus" } : {})}
      aria-expanded={props.expanded}
      aria-haspopup={props.popupRole}
      aria-label={props.definition.label}
      aria-pressed={props.pressed}
      aria-hidden={!isPresent || lifecycle.locking ? "true" : undefined}
      className={
        props.contextButton
          ? "inkbook-toolbar-button inkbook-toolbar-context-button"
          : "inkbook-toolbar-button"
      }
      data-inkbook-action={props.definition.action}
      data-inkbook-tool={props.tool ? "true" : undefined}
      data-presence={!isPresent ? "exiting" : undefined}
      disabled={disabled}
      onClick={(event) => props.onAction(props.definition.action, event.currentTarget)}
      ref={setButton}
      tabIndex={disabled ? -1 : props.tabIndex}
      type="button"
    >
      <ToolbarButtonSurface
        active={props.pressed === true && !props.tool}
        danger={props.definition.action === "delete"}
        disabled={props.disabled || !present || lifecycle.locking}
      />
      {props.tool && props.pressed === true ? (
        <motion.span
          aria-hidden="true"
          className="inkbook-toolbar-active-indicator"
          layoutId="active-tool-indicator"
          initial={false}
          transition={toolbarLayoutTransition(lifecycle.reduced)}
        />
      ) : null}
      {props.definition.action === "style" ? (
        <ToolbarStyleIcon state={props.styleIcon} />
      ) : (
        <ToolbarActionIcon
          confirmation={props.confirmation}
          definition={props.definition}
          renderIcon={props.renderIcon}
        />
      )}
    </motion.button>
  );
}

function ToolbarButtonSurface({
  active,
  danger,
  disabled,
}: {
  readonly active: boolean;
  readonly danger: boolean;
  readonly disabled: boolean;
}) {
  const { colors, reduced } = useContext(toolbarMotionContext);
  const surfaceRef = useRef<HTMLSpanElement>(null);
  const { gesture: ownerGesture } = useToolbarOwnerGestures(surfaceRef, disabled);
  const resting = {
    "--inkbook-toolbar-background": active
      ? (colors?.activeBackground ?? CHROME_TRANSPARENT)
      : CHROME_TRANSPARENT,
    "--inkbook-toolbar-border": active
      ? (colors?.activeBorder ?? CHROME_TRANSPARENT)
      : CHROME_TRANSPARENT,
    scale: active ? 0.96 : 1,
  };
  const hover = {
    "--inkbook-toolbar-background":
      (danger ? colors?.dangerHover : colors?.hover) ?? CHROME_TRANSPARENT,
  };
  return (
    <motion.span
      aria-hidden="true"
      className="inkbook-toolbar-button-surface"
      ref={surfaceRef}
      initial={{
        "--inkbook-toolbar-background": CHROME_TRANSPARENT,
        "--inkbook-toolbar-border": CHROME_TRANSPARENT,
      }}
      animate={{
        ...resting,
        ...(ownerGesture === "hover" ? hover : {}),
        ...(ownerGesture === "press" ? { scale: 0.92 } : {}),
      }}
      variants={{
        hover,
        press: { scale: 0.92 },
        focus: { "--inkbook-toolbar-border": colors?.accent ?? CHROME_TRANSPARENT },
      }}
      transition={toolbarLayoutTransition(reduced)}
    />
  );
}
