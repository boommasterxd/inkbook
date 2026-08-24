import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, Ref, UIEventHandler } from "react";

import type {
  FlyoutId,
  ToolbarAction,
  ToolbarButtonDefinition,
  ToolbarState,
  ToolId,
} from "./toolbar-types";
import type { ShapeId } from "./flyout-types";
import { nextToolbarIndex, resolveToolbarFocusRecovery } from "./toolbar-focus";
import { SHAPE_ICON_IDS, STRAIGHT_HIGHLIGHTER_ICON_ID } from "./icon-ids";
import { ToolbarStyleIcon, type ToolbarStyleIconState } from "./style-icon";
import { type ToolbarButtonPresence, useToolbarButtonPresence } from "./toolbar-presence";

export { nextToolbarIndex, resolveToolbarFocusRecovery } from "./toolbar-focus";

const LEFT_BUTTONS: readonly ToolbarButtonDefinition[] = [
  { action: "finger-drawing", icon: "hand", label: "Finger drawing" },
  { action: "undo", icon: "undo-2", label: "Undo" },
  { action: "redo", icon: "redo-2", label: "Redo" },
];

const TOOL_BUTTONS: readonly ToolbarButtonDefinition[] = [
  { action: "select", icon: "mouse-pointer-2", label: "Select" },
  { action: "eraser", icon: "eraser", label: "Eraser" },
  { action: "draw", icon: "pen", label: "Draw" },
  { action: "highlighter", icon: "highlighter", label: "Highlighter" },
  {
    action: "straight-highlighter",
    icon: STRAIGHT_HIGHLIGHTER_ICON_ID,
    label: "Straight highlighter",
  },
  { action: "shape", icon: SHAPE_ICON_IDS.line, label: "Active shape" },
  { action: "shape-picker", icon: "shapes", label: "Choose shape" },
  { action: "style", icon: "palette", label: "Style" },
];

const RIGHT_BUTTONS: readonly ToolbarButtonDefinition[] = [
  { action: "lock", icon: "lock", label: "Lock" },
  { action: "overflow", icon: "more-vertical", label: "More options" },
];

const CONTEXT_BUTTONS: readonly ToolbarButtonDefinition[] = [
  { action: "copy", icon: "copy", label: "Copy" },
  { action: "cut", icon: "scissors", label: "Cut" },
  { action: "paste", icon: "clipboard-paste", label: "Paste" },
  { action: "delete", icon: "trash-2", label: "Delete" },
];

const TOOLBAR_BUTTONS: readonly ToolbarButtonDefinition[] = [
  ...LEFT_BUTTONS,
  ...TOOL_BUTTONS,
  ...RIGHT_BUTTONS,
  ...CONTEXT_BUTTONS,
];

interface IconButtonProps {
  readonly buttonClassName?: string | undefined;
  readonly definition: ToolbarButtonDefinition;
  readonly disabled: boolean;
  readonly expanded: boolean | undefined;
  readonly onAction: (action: ToolbarAction) => void;
  readonly onPresenceComplete: (action: ToolbarAction) => void;
  readonly presence: ToolbarButtonPresence;
  readonly pressed: boolean | undefined;
  readonly registerButton?:
    ((action: ToolbarAction, element: HTMLButtonElement | null) => void) | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly styleIcon: ToolbarStyleIconState;
  readonly tabIndex: number;
}

function IconButton(props: IconButtonProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const flyout = flyoutForAction(props.definition.action);

  useEffect(() => {
    if (props.definition.action !== "style" && iconRef.current !== null) {
      props.renderIcon(iconRef.current, props.definition.icon);
    }
  }, [props.definition.action, props.definition.icon, props.renderIcon]);

  return (
    <button
      aria-controls={flyout === null ? undefined : `inkbook-${flyout}-flyout`}
      aria-expanded={props.expanded}
      aria-haspopup={flyout === null ? undefined : flyout === "overflow" ? "menu" : "dialog"}
      aria-label={props.definition.label}
      aria-pressed={props.pressed}
      aria-hidden={props.presence === "exiting" ? "true" : undefined}
      className={["inkbook-toolbar-button", props.buttonClassName].filter(Boolean).join(" ")}
      data-inkbook-action={props.definition.action}
      data-presence={props.presence === "present" ? undefined : props.presence}
      disabled={props.disabled || props.presence === "exiting"}
      onAnimationEnd={(event) => {
        if (event.currentTarget === event.target) {
          props.onPresenceComplete(props.definition.action);
        }
      }}
      onClick={() => props.onAction(props.definition.action)}
      ref={(element) => props.registerButton?.(props.definition.action, element)}
      tabIndex={props.tabIndex}
      title={props.definition.label}
      type="button"
    >
      {props.definition.action === "style" ? (
        <ToolbarStyleIcon state={props.styleIcon} />
      ) : (
        <span aria-hidden="true" className="inkbook-toolbar-icon" ref={iconRef} />
      )}
    </button>
  );
}

function buttonVisible(action: ToolbarAction, state: ToolbarState): boolean {
  if (action === "finger-drawing") return state.fingerDrawingAvailable;
  if (action === "copy" || action === "cut" || action === "delete") return state.hasSelection;
  if (action === "paste") return state.canPaste;
  return true;
}

function buttonDisabled(action: ToolbarAction, state: ToolbarState): boolean {
  if (action === "undo") return !state.canUndo;
  if (action === "redo") return !state.canRedo;
  return false;
}

function pressedState(action: ToolbarAction, state: ToolbarState): boolean | undefined {
  if (action === "finger-drawing") return state.fingerDrawingEnabled;
  return isToolId(action) ? state.activeTool === action : undefined;
}

function expandedState(action: ToolbarAction, state: ToolbarState): boolean | undefined {
  const flyout = flyoutForAction(action);
  return flyout === null ? undefined : state.openFlyout === flyout;
}

function flyoutForAction(action: ToolbarAction): FlyoutId | null {
  return action === "background" ||
    action === "overflow" ||
    action === "shape-picker" ||
    action === "style"
    ? action === "shape-picker"
      ? "shape"
      : action
    : null;
}

function isToolId(action: ToolbarAction): action is ToolId {
  return (
    action === "select" ||
    action === "eraser" ||
    action === "draw" ||
    action === "highlighter" ||
    action === "straight-highlighter" ||
    action === "shape"
  );
}

interface ToolbarGroupProps {
  readonly buttonClassName?: string | undefined;
  readonly buttons: readonly ToolbarButtonDefinition[];
  readonly className: string;
  readonly fallbackFocus?: (() => void) | undefined;
  readonly label: string;
  readonly onAction: (action: ToolbarAction) => void;
  readonly registerButton?: IconButtonProps["registerButton"] | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly state: ToolbarState;
  readonly styleIcon: ToolbarStyleIconState;
}

function ToolbarGroup(props: ToolbarGroupProps) {
  const visibleButtons = props.buttons.filter((button) =>
    buttonVisible(button.action, props.state),
  );
  const enabledButtons = visibleButtons.filter(
    (button) => !buttonDisabled(button.action, props.state),
  );
  const visibleActions = visibleButtons.map((button) => button.action);
  const enabledActions = enabledButtons.map((button) => button.action);
  const visibleKey = visibleActions.join("\u0000");
  const enabledKey = enabledActions.join("\u0000");
  const [presentButtons, completePresence] = useToolbarButtonPresence(
    props.buttons,
    visibleButtons,
    visibleKey,
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonElements = useRef(new Map<ToolbarAction, HTMLButtonElement>());
  const focusBeforeUpdate = useRef<ToolbarAction | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const previousActions = useRef<readonly ToolbarAction[]>(enabledActions);
  const safeIndex = Math.min(activeIndex, Math.max(enabledButtons.length - 1, 0));
  useLayoutEffect(() => {
    const focusedAction = focusBeforeUpdate.current;
    if (focusedAction !== null && !enabledActions.includes(focusedAction)) {
      const recoveredAction = resolveToolbarFocusRecovery(
        previousActions.current,
        enabledActions,
        focusedAction,
      );
      if (recoveredAction !== null) {
        const recoveredIndex = enabledActions.indexOf(recoveredAction);
        setActiveIndex(recoveredIndex);
        buttonElements.current.get(recoveredAction)?.focus();
      } else {
        props.fallbackFocus?.();
      }
    }
    previousActions.current = enabledActions;
    focusBeforeUpdate.current = null;
    return () => {
      const group = groupRef.current;
      const activeElement = group?.ownerDocument.activeElement ?? null;
      focusBeforeUpdate.current =
        group !== null && activeElement !== null && group.contains(activeElement)
          ? toolbarActionFromElement(activeElement)
          : null;
    };
  }, [enabledKey, props.fallbackFocus]);
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const nextIndex = nextToolbarIndex(event.key, safeIndex, enabledButtons.length);
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveIndex(nextIndex);
    const nextAction = enabledActions[nextIndex];
    if (nextAction !== undefined) buttonElements.current.get(nextAction)?.focus();
  }
  if (presentButtons.length === 0) return null;

  return (
    <div
      aria-label={props.label}
      className={`inkbook-toolbar-group ${props.className}`}
      onFocus={(event) => {
        const focusedAction = toolbarActionFromElement(event.target);
        const index = focusedAction === null ? -1 : enabledActions.indexOf(focusedAction);
        if (index >= 0) setActiveIndex(index);
      }}
      onKeyDown={handleKeyDown}
      ref={groupRef}
      role="group"
    >
      {presentButtons.map(({ definition: button, presence }) => {
        const disabled = buttonDisabled(button.action, props.state);
        const index = enabledActions.indexOf(button.action);
        return (
          <IconButton
            buttonClassName={props.buttonClassName}
            definition={button}
            disabled={disabled}
            expanded={expandedState(button.action, props.state)}
            key={button.action}
            onAction={props.onAction}
            onPresenceComplete={completePresence}
            presence={presence}
            pressed={pressedState(button.action, props.state)}
            registerButton={(action, element) => {
              if (element === null) buttonElements.current.delete(action);
              else buttonElements.current.set(action, element);
              props.registerButton?.(action, element);
            }}
            renderIcon={props.renderIcon}
            styleIcon={props.styleIcon}
            tabIndex={!disabled && presence !== "exiting" && index === safeIndex ? 0 : -1}
          />
        );
      })}
    </div>
  );
}

function toolbarActionFromElement(element: Element): ToolbarAction | null {
  const action = element.getAttribute("data-inkbook-action");
  return action !== null && isToolbarAction(action) ? action : null;
}

function isToolbarAction(value: string): value is ToolbarAction {
  return TOOLBAR_BUTTONS.some((definition) => definition.action === value);
}

export interface InkbookToolbarProps {
  readonly layout: "wide" | "scrollable";
  readonly leftHanded?: boolean | undefined;
  readonly onAction: (action: ToolbarAction) => void;
  readonly onScroll?: UIEventHandler<HTMLDivElement> | undefined;
  readonly registerButton?: IconButtonProps["registerButton"] | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly selectedShape: ShapeId;
  readonly state: ToolbarState;
  readonly styleIcon: ToolbarStyleIconState;
  readonly toolbarRef?: Ref<HTMLDivElement> | undefined;
}

export function InkbookToolbar(props: InkbookToolbarProps) {
  const primaryButtons = useRef(new Map<ToolbarAction, HTMLButtonElement>());
  const focusOverflow = useCallback(() => primaryButtons.current.get("overflow")?.focus(), []);
  const className = [
    "inkbook-toolbar",
    `inkbook-toolbar-${props.layout}`,
    props.leftHanded ? "inkbook-toolbar-left-handed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div aria-label="Inkbook tools" className="inkbook-toolbar-composition" role="toolbar">
      <div className={className} onScroll={props.onScroll} ref={props.toolbarRef}>
        <ToolbarGroup
          buttons={primaryButtonsForShape(props.selectedShape)}
          className="inkbook-toolbar-track"
          label="Tools and actions"
          onAction={props.onAction}
          registerButton={(action, element) => {
            if (element === null) primaryButtons.current.delete(action);
            else primaryButtons.current.set(action, element);
            props.registerButton?.(action, element);
          }}
          renderIcon={props.renderIcon}
          state={props.state}
          styleIcon={props.styleIcon}
        />
      </div>
      <ToolbarGroup
        buttonClassName="inkbook-toolbar-context-button"
        buttons={CONTEXT_BUTTONS}
        className="inkbook-toolbar-context-actions"
        fallbackFocus={focusOverflow}
        label="Editing actions"
        onAction={props.onAction}
        registerButton={props.registerButton}
        renderIcon={props.renderIcon}
        state={props.state}
        styleIcon={props.styleIcon}
      />
    </div>
  );
}

function primaryButtonsForShape(shape: ShapeId): readonly ToolbarButtonDefinition[] {
  return [
    ...LEFT_BUTTONS,
    ...TOOL_BUTTONS.map((button) =>
      button.action === "shape"
        ? { ...button, icon: SHAPE_ICON_IDS[shape], label: `Shape: ${shapeLabel(shape)}` }
        : button,
    ),
    ...RIGHT_BUTTONS,
  ];
}

function shapeLabel(shape: ShapeId): string {
  return shape === "coordinate-system"
    ? "Coordinate system"
    : shape.charAt(0).toUpperCase() + shape.slice(1);
}
