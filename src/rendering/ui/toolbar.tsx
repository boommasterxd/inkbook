import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, Ref, RefObject } from "react";

import type {
  FlyoutId,
  ToolbarAction,
  ToolbarButtonDefinition,
  ToolbarState,
  ToolId,
} from "./toolbar-types";
import type { ShapeId } from "./toolbar-types";
import type { SelectionAreaV1 } from "../../domain/settings/types";
import { nextToolbarIndex, resolveToolbarFocusRecovery } from "./toolbar-focus";
import {
  activeShapeIconId,
  selectionAreaIconId,
  SHAPE_ICON_IDS,
  STRAIGHT_HIGHLIGHTER_ICON_ID,
  type ActiveShapeIconState,
} from "./icon-ids";
import { ToolbarStyleIcon, type ToolbarStyleIconState } from "./style-icon";
import {
  type PresentToolbarButton,
  type ToolbarButtonPresence,
  useToolbarButtonPresence,
} from "./toolbar-presence";
import {
  type ToolbarButtonMap,
  useToolbarElementLayoutMotion,
  useToolbarLayoutMotion,
} from "./toolbar-layout-motion";
import { ToolbarActionIcon } from "./toolbar-action-icon";

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
  { action: "paste", icon: "clipboard-paste", label: "Paste" },
  { action: "copy", icon: "copy", label: "Copy" },
  { action: "cut", icon: "scissors", label: "Cut" },
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
  readonly confirmation: ToolbarState["actionConfirmation"];
  readonly definition: ToolbarButtonDefinition;
  readonly disabled: boolean;
  readonly expanded: boolean | undefined;
  readonly onAction: (action: ToolbarAction, trigger: HTMLButtonElement) => void;
  readonly onPresenceComplete: (action: ToolbarAction) => void;
  readonly presence: ToolbarButtonPresence;
  readonly presenceOrder: number;
  readonly pressed: boolean | undefined;
  readonly registerButton?:
    ((action: ToolbarAction, element: HTMLButtonElement | null) => void) | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly styleIcon: ToolbarStyleIconState;
  readonly tabIndex: number;
}

function IconButton(props: IconButtonProps) {
  const flyout = flyoutForAction(props.definition.action);

  return (
    <button
      aria-expanded={props.expanded}
      aria-haspopup={flyout === null ? undefined : popupRoleForAction(props.definition.action)}
      aria-label={props.definition.label}
      aria-pressed={props.pressed}
      aria-hidden={props.presence === "exiting" ? "true" : undefined}
      className={["inkbook-toolbar-button", props.buttonClassName].filter(Boolean).join(" ")}
      data-inkbook-action={props.definition.action}
      data-inkbook-tool={isToolId(props.definition.action) ? "true" : undefined}
      data-presence={props.presence === "present" ? undefined : props.presence}
      data-presence-order={props.presence === "present" ? undefined : props.presenceOrder}
      disabled={props.disabled || props.presence === "exiting"}
      onAnimationEnd={(event) => {
        if (props.presence !== "present" && event.currentTarget === event.target) {
          props.onPresenceComplete(props.definition.action);
        }
      }}
      onClick={(event) => props.onAction(props.definition.action, event.currentTarget)}
      ref={(element) => props.registerButton?.(props.definition.action, element)}
      tabIndex={props.tabIndex}
      title={props.definition.label}
      type="button"
    >
      {props.definition.action === "style" ? (
        <ToolbarStyleIcon state={props.styleIcon} />
      ) : (
        <ToolbarActionIcon
          confirmation={props.confirmation}
          definition={props.definition}
          renderIcon={props.renderIcon}
        />
      )}
    </button>
  );
}

function buttonVisible(action: ToolbarAction, state: ToolbarState): boolean {
  if (action === "finger-drawing") return state.fingerDrawingAvailable;
  if (action === "copy" || action === "cut" || action === "delete") return state.hasSelection;
  if (action === "paste") return state.pasteVisible;
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

function popupRoleForAction(action: ToolbarAction): "dialog" | "menu" {
  return action === "background" || action === "style" ? "dialog" : "menu";
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
  readonly activeToolIndicator?: boolean | undefined;
  readonly buttonClassName?: string | undefined;
  readonly buttons: readonly ToolbarButtonDefinition[];
  readonly className: string;
  readonly fallbackFocus?: (() => void) | undefined;
  readonly label: string;
  readonly layoutMotionKey?: string | undefined;
  readonly onAction: (action: ToolbarAction, trigger: HTMLButtonElement) => void;
  readonly registerButton?: IconButtonProps["registerButton"] | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly reverseNavigation?: boolean | undefined;
  readonly state: ToolbarState;
  readonly styleIcon: ToolbarStyleIconState;
}

function useToolbarFocusRecovery(
  enabledKey: string,
  enabledActions: readonly ToolbarAction[],
  fallbackFocus: (() => void) | undefined,
  groupRef: RefObject<HTMLDivElement | null>,
  buttonElements: { readonly current: ToolbarButtonMap },
  setActiveIndex: (index: number) => void,
): void {
  const focusBeforeUpdate = useRef<ToolbarAction | null>(null);
  const previousActions = useRef<readonly ToolbarAction[]>(enabledActions);
  useLayoutEffect(() => {
    const focusedAction = focusBeforeUpdate.current;
    if (focusedAction !== null && !enabledActions.includes(focusedAction)) {
      const recoveredAction = resolveToolbarFocusRecovery(
        previousActions.current,
        enabledActions,
        focusedAction,
      );
      if (recoveredAction !== null) {
        setActiveIndex(enabledActions.indexOf(recoveredAction));
        buttonElements.current.get(recoveredAction)?.focus();
      } else fallbackFocus?.();
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
  }, [enabledKey, fallbackFocus]);
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
  const buttonElements = useRef<ToolbarButtonMap>(new Map());
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const layoutKey = toolbarGroupLayoutKey(props.layoutMotionKey, presentButtons);
  useToolbarLayoutMotion(layoutKey, buttonElements);
  useToolbarElementLayoutMotion(props.layoutMotionKey, groupRef);
  const safeIndex = Math.min(activeIndex, Math.max(enabledButtons.length - 1, 0));
  useToolbarFocusRecovery(
    enabledKey,
    enabledActions,
    props.fallbackFocus,
    groupRef,
    buttonElements,
    setActiveIndex,
  );
  useLayoutEffect(() => {
    if (!props.activeToolIndicator) return;
    positionActiveToolIndicator(
      indicatorRef.current,
      buttonElements.current.get(props.state.activeTool) ?? null,
    );
  });
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const nextIndex = nextToolbarIndex(
      resolveToolbarNavigationKey(event.key, props.reverseNavigation === true),
      safeIndex,
      enabledButtons.length,
    );
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
      {props.activeToolIndicator ? (
        <span aria-hidden="true" className="inkbook-toolbar-active-indicator" ref={indicatorRef} />
      ) : null}
      {presentButtons.map(({ definition: button, presence, presenceOrder }) => {
        const disabled = buttonDisabled(button.action, props.state);
        const index = enabledActions.indexOf(button.action);
        return (
          <IconButton
            buttonClassName={props.buttonClassName}
            confirmation={props.state.actionConfirmation}
            definition={button}
            disabled={disabled}
            expanded={expandedState(button.action, props.state)}
            key={button.action}
            onAction={props.onAction}
            onPresenceComplete={completePresence}
            presence={presence}
            presenceOrder={presenceOrder}
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

function toolbarGroupLayoutKey(
  motionKey: string | undefined,
  buttons: readonly PresentToolbarButton[],
): string {
  return [
    motionKey,
    ...buttons.map(({ definition, presence }) => `${definition.action}:${presence}`),
  ].join("\u0000");
}

function positionActiveToolIndicator(
  indicator: HTMLSpanElement | null,
  button: HTMLButtonElement | null,
): void {
  if (indicator === null || button === null) return;
  const buttonWidth = button.offsetWidth > 0 ? button.offsetWidth : 44;
  const offset = button.offsetLeft + (buttonWidth - 36) / 2;
  indicator.style.setProperty("--inkbook-toolbar-active-offset", `${String(offset)}px`);
  indicator.dataset.ready = "true";
}

function toolbarActionFromElement(element: Element): ToolbarAction | null {
  const action = element.getAttribute("data-inkbook-action");
  return action !== null && isToolbarAction(action) ? action : null;
}

function isToolbarAction(value: string): value is ToolbarAction {
  return TOOLBAR_BUTTONS.some((definition) => definition.action === value);
}

export interface InkbookToolbarProps {
  readonly compositionRef?: Ref<HTMLDivElement> | undefined;
  readonly layout: "wide" | "scrollable";
  readonly leftHanded?: boolean | undefined;
  readonly onAction: (action: ToolbarAction, trigger: HTMLButtonElement) => void;
  readonly registerButton?: IconButtonProps["registerButton"] | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly selectionArea: SelectionAreaV1;
  readonly selectedShape: ShapeId;
  readonly shapeIcon: ActiveShapeIconState;
  readonly state: ToolbarState;
  readonly styleIcon: ToolbarStyleIconState;
  readonly toolbarRef?: Ref<HTMLDivElement> | undefined;
}

export function InkbookToolbar(props: InkbookToolbarProps) {
  const primaryButtons = useRef(new Map<ToolbarAction, HTMLButtonElement>());
  const focusContextNeighbor = useCallback(() => {
    const buttons = [...primaryButtons.current.values()];
    if (!props.leftHanded) buttons.reverse();
    buttons.find((button) => !button.disabled)?.focus();
  }, [props.leftHanded]);
  const className = [
    "inkbook-toolbar",
    `inkbook-toolbar-${props.layout}`,
    props.leftHanded ? "inkbook-toolbar-left-handed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const compositionClassName = [
    "inkbook-toolbar-composition",
    `inkbook-toolbar-composition-${props.layout}`,
    props.leftHanded ? "inkbook-toolbar-composition-left-handed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      aria-label="Inkbook tools"
      className={compositionClassName}
      ref={props.compositionRef}
      role="toolbar"
    >
      <div className="inkbook-toolbar-rail">
        <div className={className} ref={props.toolbarRef}>
          <ToolbarGroup
            activeToolIndicator
            buttons={primaryButtonsForState(
              props.selectedShape,
              props.shapeIcon,
              props.selectionArea,
            )}
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
          fallbackFocus={focusContextNeighbor}
          label="Editing actions"
          layoutMotionKey={props.leftHanded ? "left" : "right"}
          onAction={props.onAction}
          registerButton={props.registerButton}
          renderIcon={props.renderIcon}
          reverseNavigation={props.leftHanded}
          state={props.state}
          styleIcon={props.styleIcon}
        />
      </div>
    </div>
  );
}

export function resolveToolbarNavigationKey(key: string, reversed: boolean): string {
  if (!reversed) return key;
  if (key === "ArrowLeft") return "ArrowRight";
  if (key === "ArrowRight") return "ArrowLeft";
  return key;
}

function primaryButtonsForState(
  shape: ShapeId,
  iconState: ActiveShapeIconState,
  selectionArea: SelectionAreaV1,
): readonly ToolbarButtonDefinition[] {
  return [
    ...LEFT_BUTTONS,
    ...TOOL_BUTTONS.map((button) =>
      button.action === "select"
        ? {
            ...button,
            icon: selectionAreaIconId(selectionArea),
            label: `Select: ${selectionAreaLabel(selectionArea)}`,
          }
        : button.action === "shape"
          ? {
              ...button,
              icon: activeShapeIconId(shape, iconState),
              label: `Shape: ${shapeLabel(shape)}`,
            }
          : button,
    ),
    ...RIGHT_BUTTONS,
  ];
}

function selectionAreaLabel(area: SelectionAreaV1): string {
  return area === "rectangle" ? "Rectangle" : "Lasso";
}

function shapeLabel(shape: ShapeId): string {
  return shape === "coordinate-system"
    ? "Coordinate system"
    : shape.charAt(0).toUpperCase() + shape.slice(1);
}
