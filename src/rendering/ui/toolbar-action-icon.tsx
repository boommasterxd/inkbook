import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

import type { ToolbarActionConfirmation, ToolbarButtonDefinition } from "./toolbar-types";
import { TOOLBAR_ACTION_CONFIRMATION_MS } from "./toolbar-types";

interface ToolbarActionIconProps {
  readonly confirmation: ToolbarActionConfirmation | null | undefined;
  readonly definition: ToolbarButtonDefinition;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

export function ToolbarActionIcon(props: ToolbarActionIconProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const confirmationRef = useRef<HTMLSpanElement>(null);
  const confirmed = props.confirmation?.action === props.definition.action;

  useEffect(() => {
    if (iconRef.current !== null) props.renderIcon(iconRef.current, props.definition.icon);
  }, [props.confirmation?.sequence, props.definition.icon, props.renderIcon]);

  useEffect(() => {
    if (confirmationRef.current !== null) props.renderIcon(confirmationRef.current, "check");
  }, [props.confirmation?.sequence, props.renderIcon]);

  if (!isConfirmableAction(props.definition.action)) {
    return <span aria-hidden="true" className="inkbook-toolbar-icon" ref={iconRef} />;
  }

  const style = {
    "--inkbook-toolbar-confirmation-duration": `${String(TOOLBAR_ACTION_CONFIRMATION_MS)}ms`,
  } as CSSProperties;
  return (
    <span
      aria-hidden="true"
      className="inkbook-toolbar-action-icon"
      data-confirmed={confirmed ? "true" : undefined}
      key={confirmed ? props.confirmation?.sequence : "idle"}
      style={style}
    >
      <span
        aria-hidden="true"
        className="inkbook-toolbar-icon inkbook-toolbar-action-icon-default"
        ref={iconRef}
      />
      <span
        aria-hidden="true"
        className="inkbook-toolbar-icon inkbook-toolbar-action-icon-confirmation"
        ref={confirmationRef}
      />
    </span>
  );
}

function isConfirmableAction(action: string): boolean {
  return action === "copy" || action === "cut" || action === "paste";
}
