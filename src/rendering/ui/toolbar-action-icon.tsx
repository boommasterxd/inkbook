import { useContext, useLayoutEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";

import type { ToolbarActionConfirmation, ToolbarButtonDefinition } from "./toolbar-types";
import { TOOLBAR_ACTION_CONFIRMATION_MS } from "./toolbar-types";
import { toolbarLayoutTransition, toolbarMotionContext } from "./toolbar-motion";
import { STANDARD_EASING } from "../motion/transitions";

interface ToolbarActionIconProps {
  readonly confirmation: ToolbarActionConfirmation | null | undefined;
  readonly definition: ToolbarButtonDefinition;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

export function ToolbarActionIcon(props: ToolbarActionIconProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const confirmationRef = useRef<HTMLSpanElement>(null);
  const confirmed = props.confirmation?.action === props.definition.action;
  const { reduced } = useContext(toolbarMotionContext);

  useLayoutEffect(() => {
    if (iconRef.current !== null) props.renderIcon(iconRef.current, props.definition.icon);
  }, [props.confirmation?.sequence, props.definition.icon, props.renderIcon]);

  useLayoutEffect(() => {
    if (confirmationRef.current !== null) props.renderIcon(confirmationRef.current, "check");
  }, [props.confirmation?.sequence, props.renderIcon]);

  if (!isConfirmableAction(props.definition.action)) {
    return (
      <span aria-hidden="true" className="inkbook-toolbar-action-icon">
        <AnimatePresence initial={false} key={reduced ? props.definition.icon : "full"}>
          <ToolbarGlyph
            key={props.definition.icon}
            icon={props.definition.icon}
            reduced={reduced}
            renderIcon={props.renderIcon}
          />
        </AnimatePresence>
      </span>
    );
  }

  const transition = {
    duration: confirmed && !reduced ? TOOLBAR_ACTION_CONFIRMATION_MS / 1000 : 0,
    times: [0, 0.18, 0.72, 1],
    ease: STANDARD_EASING,
  };
  return (
    <span
      aria-hidden="true"
      className="inkbook-toolbar-action-icon"
      data-confirmed={confirmed ? "true" : undefined}
      key={confirmed ? props.confirmation?.sequence : "idle"}
    >
      <motion.span
        initial={false}
        animate={
          confirmed && !reduced
            ? { opacity: [1, 0, 0, 1], rotate: [0, -10, -10, 0], scale: [1, 0.68, 0.68, 1] }
            : { opacity: confirmed ? 0 : 1, rotate: 0, scale: 1 }
        }
        transition={transition}
        aria-hidden="true"
        className="inkbook-toolbar-icon inkbook-toolbar-action-icon-default"
        ref={iconRef}
      />
      <motion.span
        initial={false}
        animate={
          confirmed && !reduced
            ? { opacity: [0, 1, 1, 0], rotate: [10, 0, 0, -10], scale: [0.68, 1, 1, 0.68] }
            : { opacity: confirmed ? 1 : 0, rotate: 0, scale: 1 }
        }
        transition={transition}
        aria-hidden="true"
        className="inkbook-toolbar-icon inkbook-toolbar-action-icon-confirmation"
        ref={confirmationRef}
      />
    </span>
  );
}

function ToolbarGlyph({
  icon,
  reduced,
  renderIcon,
}: {
  readonly icon: string;
  readonly reduced: boolean;
  readonly renderIcon: ToolbarActionIconProps["renderIcon"];
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (ref.current !== null) renderIcon(ref.current, icon);
  }, [icon, renderIcon]);
  return (
    <motion.span
      aria-hidden="true"
      className="inkbook-toolbar-icon"
      initial={{ opacity: reduced ? 1 : 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      ref={ref}
      transition={toolbarLayoutTransition(reduced)}
    />
  );
}

function isConfirmableAction(action: string): boolean {
  return action === "copy" || action === "cut" || action === "paste";
}
