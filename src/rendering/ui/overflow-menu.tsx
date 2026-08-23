import { useEffect, useRef, useState } from "react";

import type {
  BackgroundFlyoutState,
  BackgroundSpacing,
  BackgroundType,
  OverflowMenuAction,
  OverflowMenuState,
} from "./flyout-types";

interface OverflowMenuProps {
  readonly background: BackgroundFlyoutState;
  readonly onAction: (action: OverflowMenuAction) => void;
  readonly onBackgroundSpacingChange: (spacing: BackgroundSpacing) => void;
  readonly onBackgroundTypeChange: (type: BackgroundType) => void;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly state: OverflowMenuState;
}

const BACKGROUNDS: readonly {
  readonly icon: string;
  readonly label: string;
  readonly value: BackgroundType;
}[] = [
  { icon: "ban", label: "None", value: "none" },
  { icon: "rows-3", label: "Lines", value: "lines" },
  { icon: "ellipsis", label: "Dots", value: "dots" },
  { icon: "grid-2x2", label: "Squares", value: "squares" },
];

const SPACINGS: readonly { readonly label: string; readonly value: BackgroundSpacing }[] = [
  { label: "Small", value: "s" },
  { label: "Medium", value: "m" },
  { label: "Large", value: "l" },
  { label: "Extra large", value: "xl" },
];

const ARRANGE_ACTIONS: readonly {
  readonly action: Extract<
    OverflowMenuAction,
    "bring-forward" | "bring-to-front" | "send-backward" | "send-to-back"
  >;
  readonly icon: string;
  readonly label: string;
}[] = [
  { action: "bring-forward", icon: "arrow-up", label: "Bring forward" },
  { action: "send-backward", icon: "arrow-down", label: "Send backward" },
  { action: "bring-to-front", icon: "chevrons-up", label: "Bring to front" },
  { action: "send-to-back", icon: "chevrons-down", label: "Send to back" },
];

export function OverflowMenu(props: OverflowMenuProps) {
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const backgroundRegion = useRef<HTMLDivElement>(null);

  return (
    <div className="inkbook-overflow-menu">
      <div
        className="inkbook-overflow-background-region"
        onBlur={(event) => {
          if (!backgroundRegion.current?.contains(event.relatedTarget)) setBackgroundOpen(false);
        }}
        onFocus={() => setBackgroundOpen(true)}
        onPointerEnter={() => setBackgroundOpen(true)}
        onPointerLeave={() => setBackgroundOpen(false)}
        ref={backgroundRegion}
      >
        <MenuButton
          expanded={backgroundOpen}
          icon="grid-2x2"
          label="Background"
          onClick={() => setBackgroundOpen(true)}
          onKeyDown={(key) => {
            if (key === "ArrowRight") setBackgroundOpen(true);
            if (key === "ArrowLeft") setBackgroundOpen(false);
          }}
          renderIcon={props.renderIcon}
          submenu
        />
        {backgroundOpen ? <BackgroundSubmenu {...props} /> : null}
      </div>

      {props.state.hasSelection ? (
        <>
          <MenuSeparator />
          <MenuLabel icon="layers" label="Arrange" renderIcon={props.renderIcon} />
          {ARRANGE_ACTIONS.map((item) => (
            <MenuButton
              disabled={!props.state.arrange[item.action]}
              icon={item.icon}
              key={item.action}
              label={item.label}
              onClick={() => props.onAction(item.action)}
              renderIcon={props.renderIcon}
            />
          ))}
        </>
      ) : null}

      <MenuSeparator />
      <MenuButton
        icon="copy"
        label="Copy embed"
        onClick={() => props.onAction("copy-embed")}
        renderIcon={props.renderIcon}
      />
      <MenuSeparator />
      <MenuButton
        destructive
        disabled={!props.state.canEraseAll}
        icon="eraser"
        label="Erase all"
        onClick={() => props.onAction("erase-all")}
        renderIcon={props.renderIcon}
      />
      <MenuButton
        destructive
        icon="trash-2"
        label="Delete embed"
        onClick={() => props.onAction("delete-embed")}
        renderIcon={props.renderIcon}
      />
    </div>
  );
}

function BackgroundSubmenu(props: OverflowMenuProps) {
  return (
    <div aria-label="Background" className="inkbook-overflow-submenu" role="menu">
      {BACKGROUNDS.map((item) => (
        <MenuButton
          checked={props.background.type === item.value}
          icon={item.icon}
          key={item.value}
          label={item.label}
          onClick={() => props.onBackgroundTypeChange(item.value)}
          renderIcon={props.renderIcon}
        />
      ))}
      {props.background.type === "none" ? null : (
        <>
          <MenuSeparator />
          <MenuLabel icon="move-horizontal" label="Spacing" renderIcon={props.renderIcon} />
          {SPACINGS.map((item) => (
            <MenuButton
              checked={props.background.spacing === item.value}
              icon="move-horizontal"
              key={item.value}
              label={item.label}
              onClick={() => props.onBackgroundSpacingChange(item.value)}
              renderIcon={props.renderIcon}
            />
          ))}
        </>
      )}
    </div>
  );
}

interface MenuButtonProps {
  readonly checked?: boolean;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly icon: string;
  readonly label: string;
  readonly onClick: () => void;
  readonly onKeyDown?: (key: string) => void;
  readonly renderIcon: OverflowMenuProps["renderIcon"];
  readonly submenu?: boolean;
}

function MenuButton(props: MenuButtonProps) {
  const icon = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (icon.current !== null) props.renderIcon(icon.current, props.icon);
  }, [props.icon, props.renderIcon]);
  return (
    <button
      aria-checked={props.checked}
      aria-expanded={props.submenu === true ? props.expanded : undefined}
      aria-haspopup={props.submenu === true ? "menu" : undefined}
      className="inkbook-overflow-menu-item"
      data-destructive={props.destructive === true ? "true" : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
      onKeyDown={(event) => props.onKeyDown?.(event.key)}
      role={props.checked === undefined ? "menuitem" : "menuitemradio"}
      type="button"
    >
      <span aria-hidden="true" className="inkbook-overflow-menu-icon" ref={icon} />
      <span>{props.label}</span>
      {props.submenu === true ? (
        <MenuIcon
          className="inkbook-overflow-submenu-chevron"
          icon="chevron-right"
          renderIcon={props.renderIcon}
        />
      ) : null}
    </button>
  );
}

function MenuLabel(props: {
  readonly icon: string;
  readonly label: string;
  readonly renderIcon: OverflowMenuProps["renderIcon"];
}) {
  return (
    <div className="inkbook-overflow-menu-label">
      <MenuIcon {...props} />
      <span>{props.label}</span>
    </div>
  );
}

function MenuIcon(props: {
  readonly className?: string;
  readonly icon: string;
  readonly renderIcon: OverflowMenuProps["renderIcon"];
}) {
  const icon = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (icon.current !== null) props.renderIcon(icon.current, props.icon);
  }, [props.icon, props.renderIcon]);
  return (
    <span
      aria-hidden="true"
      className={["inkbook-overflow-menu-icon", props.className].filter(Boolean).join(" ")}
      ref={icon}
    />
  );
}

function MenuSeparator() {
  return <div className="inkbook-overflow-menu-separator" role="separator" />;
}
