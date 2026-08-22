import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, Ref, UIEventHandler } from "react";

import type {
  FlyoutId,
  ToolbarAction,
  ToolbarButtonDefinition,
  ToolbarState,
  ToolId,
} from "./toolbar-types";
import { nextToolbarIndex, resolveToolbarFocusRecovery } from "./toolbar-focus";
import { type ToolbarButtonPresence, useToolbarButtonPresence } from "./toolbar-presence";

export { nextToolbarIndex, resolveToolbarFocusRecovery } from "./toolbar-focus";

const LEFT_BUTTONS: readonly ToolbarButtonDefinition[] = [
  { action: "finger-drawing", icon: "hand", label: "Finger drawing" },
  { action: "background", icon: "grid-3x3", label: "Background" },
  { action: "undo", icon: "undo-2", label: "Undo" },
  { action: "redo", icon: "redo-2", label: "Redo" },
];

const TOOL_BUTTONS: readonly ToolbarButtonDefinition[] = [
  { action: "select", icon: "mouse-pointer-2", label: "Select" },
  { action: "eraser", icon: "eraser", label: "Eraser" },
  { action: "draw", icon: "pen", label: "Draw" },
  { action: "highlighter", icon: "highlighter", label: "Highlighter" },
  { action: "straight-highlighter", icon: "minus", label: "Straight highlighter" },
  { action: "shape", icon: "shapes", label: "Shape" },
  { action: "style", icon: "palette", label: "Style" },
];

const RIGHT_BUTTONS: readonly ToolbarButtonDefinition[] = [
  { action: "copy", icon: "copy", label: "Copy" },
  { action: "cut", icon: "scissors", label: "Cut" },
  { action: "delete", icon: "trash-2", label: "Delete" },
  { action: "paste", icon: "clipboard-paste", label: "Paste" },
  { action: "lock", icon: "lock", label: "Lock" },
  { action: "overflow", icon: "more-vertical", label: "More options" },
];

interface IconButtonProps {
  readonly definition: ToolbarButtonDefinition;
  readonly expanded: boolean | undefined;
  readonly onAction: (action: ToolbarAction) => void;
  readonly onPresenceComplete: (action: ToolbarAction) => void;
  readonly presence: ToolbarButtonPresence;
  readonly pressed: boolean | undefined;
  readonly registerButton?:
    ((action: ToolbarAction, element: HTMLButtonElement | null) => void) | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly tabIndex: number;
}

function IconButton(props: IconButtonProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const flyout = flyoutForAction(props.definition.action);

  useEffect(() => {
    if (iconRef.current !== null) props.renderIcon(iconRef.current, props.definition.icon);
  }, [props.definition.icon, props.renderIcon]);

  return (
    <button
      aria-controls={flyout === null ? undefined : `inkbook-${flyout}-flyout`}
      aria-expanded={props.expanded}
      aria-haspopup={flyout === null ? undefined : "dialog"}
      aria-label={props.definition.label}
      aria-pressed={props.pressed}
      aria-hidden={props.presence === "exiting" ? "true" : undefined}
      className="inkbook-toolbar-button"
      data-inkbook-action={props.definition.action}
      data-presence={props.presence === "present" ? undefined : props.presence}
      disabled={props.presence === "exiting"}
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
      <span aria-hidden="true" className="inkbook-toolbar-icon" ref={iconRef} />
    </button>
  );
}

function buttonVisible(action: ToolbarAction, state: ToolbarState): boolean {
  if (action === "finger-drawing") return state.fingerDrawingAvailable;
  if (action === "undo") return state.canUndo;
  if (action === "redo") return state.canRedo;
  if (action === "copy" || action === "cut" || action === "delete") return state.hasSelection;
  if (action === "paste") return state.canPaste;
  return true;
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
  return action === "background" || action === "shape" || action === "style" ? action : null;
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
  readonly buttons: readonly ToolbarButtonDefinition[];
  readonly className: string;
  readonly label: string;
  readonly onAction: (action: ToolbarAction) => void;
  readonly registerButton?: IconButtonProps["registerButton"] | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly state: ToolbarState;
}

function ToolbarGroup(props: ToolbarGroupProps) {
  const visibleButtons = props.buttons.filter((button) =>
    buttonVisible(button.action, props.state),
  );
  const visibleActions = visibleButtons.map((button) => button.action);
  const visibleKey = visibleActions.join("\u0000");
  const [presentButtons, completePresence] = useToolbarButtonPresence(
    props.buttons,
    visibleButtons,
    visibleKey,
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonElements = useRef(new Map<ToolbarAction, HTMLButtonElement>());
  const focusBeforeUpdate = useRef<ToolbarAction | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const previousActions = useRef<readonly ToolbarAction[]>(visibleActions);
  const safeIndex = Math.min(activeIndex, Math.max(visibleButtons.length - 1, 0));

  useLayoutEffect(() => {
    const focusedAction = focusBeforeUpdate.current;
    if (focusedAction !== null && !visibleActions.includes(focusedAction)) {
      const recoveredAction = resolveToolbarFocusRecovery(
        previousActions.current,
        visibleActions,
        focusedAction,
      );
      if (recoveredAction !== null) {
        const recoveredIndex = visibleActions.indexOf(recoveredAction);
        setActiveIndex(recoveredIndex);
        buttonElements.current.get(recoveredAction)?.focus();
      }
    }
    previousActions.current = visibleActions;
    focusBeforeUpdate.current = null;
    return () => {
      const group = groupRef.current;
      const activeElement = group?.ownerDocument.activeElement ?? null;
      focusBeforeUpdate.current =
        group !== null && activeElement !== null && group.contains(activeElement)
          ? toolbarActionFromElement(activeElement)
          : null;
    };
  }, [visibleKey]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const nextIndex = nextToolbarIndex(event.key, safeIndex, visibleButtons.length);
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveIndex(nextIndex);
    const nextAction = visibleActions[nextIndex];
    if (nextAction !== undefined) buttonElements.current.get(nextAction)?.focus();
  }

  return (
    <div
      aria-label={props.label}
      className={`inkbook-toolbar-group ${props.className}`}
      onFocus={(event) => {
        const focusedAction = toolbarActionFromElement(event.target);
        const index = focusedAction === null ? -1 : visibleActions.indexOf(focusedAction);
        if (index >= 0) setActiveIndex(index);
      }}
      onKeyDown={handleKeyDown}
      ref={groupRef}
      role="group"
    >
      {presentButtons.map(({ definition: button, presence }) => {
        const index = visibleActions.indexOf(button.action);
        return (
          <IconButton
            definition={button}
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
            tabIndex={presence !== "exiting" && index === safeIndex ? 0 : -1}
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
  return [...LEFT_BUTTONS, ...TOOL_BUTTONS, ...RIGHT_BUTTONS].some(
    (definition) => definition.action === value,
  );
}

export interface InkbookToolbarProps {
  readonly layout: "wide" | "merged" | "scrollable";
  readonly leftHanded?: boolean | undefined;
  readonly onAction: (action: ToolbarAction) => void;
  readonly onScroll?: UIEventHandler<HTMLDivElement> | undefined;
  readonly registerButton?: IconButtonProps["registerButton"] | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly state: ToolbarState;
  readonly toolbarRef?: Ref<HTMLDivElement> | undefined;
}

export function InkbookToolbar(props: InkbookToolbarProps) {
  const className = [
    "inkbook-toolbar",
    `inkbook-toolbar-${props.layout}`,
    props.leftHanded ? "inkbook-toolbar-left-handed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      aria-label="Inkbook tools"
      className={className}
      onScroll={props.onScroll}
      ref={props.toolbarRef}
      role="toolbar"
    >
      <ToolbarGroup
        buttons={LEFT_BUTTONS}
        className="inkbook-toolbar-general"
        label="General actions"
        onAction={props.onAction}
        registerButton={props.registerButton}
        renderIcon={props.renderIcon}
        state={props.state}
      />
      <ToolbarGroup
        buttons={TOOL_BUTTONS}
        className="inkbook-toolbar-tools"
        label="Drawing tools"
        onAction={props.onAction}
        registerButton={props.registerButton}
        renderIcon={props.renderIcon}
        state={props.state}
      />
      <ToolbarGroup
        buttons={RIGHT_BUTTONS}
        className="inkbook-toolbar-context"
        label="Selection and document actions"
        onAction={props.onAction}
        registerButton={props.registerButton}
        renderIcon={props.renderIcon}
        state={props.state}
      />
    </div>
  );
}
