import { useCallback, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, Ref, RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useContext } from "react";

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
  DRAWING_TOOL_ICON_IDS,
  type ActiveShapeIconState,
} from "./icon-ids";
import type { ToolbarStyleIconState } from "./style-icon";
import { useToolbarPresenceOrder } from "./toolbar-presence";
import { ToolbarIconButton, type ToolbarIconButtonProps } from "./toolbar-button";
import { toolbarMotionContext, toolbarLayoutTransition } from "./toolbar-motion";
import { TRANSITION_DURATIONS } from "../motion/transitions";

type ToolbarButtonMap = Map<ToolbarAction, HTMLButtonElement>;

const LEFT_BUTTONS: readonly ToolbarButtonDefinition[] = [
  { action: "finger-drawing", icon: "hand", label: "Finger drawing" },
  { action: "undo", icon: "undo-2", label: "Undo" },
  { action: "redo", icon: "redo-2", label: "Redo" },
];

const TOOL_BUTTONS: readonly ToolbarButtonDefinition[] = [
  { action: "select", icon: "mouse-pointer-2", label: "Select" },
  { action: "eraser", icon: "eraser", label: "Eraser" },
  { action: "draw", icon: DRAWING_TOOL_ICON_IDS.draw, label: "Draw" },
  { action: "highlighter", icon: DRAWING_TOOL_ICON_IDS.highlighter, label: "Highlighter" },
  {
    action: "straight-highlighter",
    icon: DRAWING_TOOL_ICON_IDS["straight-highlighter"],
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

function buttonPreview(action: ToolbarAction, state: ToolbarState): boolean {
  return (
    state.onboardingContextPreview === true &&
    CONTEXT_BUTTONS.some((button) => button.action === action)
  );
}

function buttonVisible(action: ToolbarAction, state: ToolbarState): boolean {
  if (buttonPreview(action, state)) return true;
  if (action === "finger-drawing") return state.fingerDrawingAvailable;
  if (action === "copy" || action === "cut" || action === "delete") return state.hasSelection;
  if (action === "paste") return state.pasteVisible;
  return true;
}

function buttonDisabled(action: ToolbarAction, state: ToolbarState): boolean {
  if (buttonPreview(action, state)) return true;
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
  readonly contextButtons?: boolean | undefined;
  readonly buttons: readonly ToolbarButtonDefinition[];
  readonly className: string;
  readonly fallbackFocus?: (() => void) | undefined;
  readonly label: string;
  readonly onAction: (action: ToolbarAction, trigger: HTMLButtonElement) => void;
  readonly registerButton?: ToolbarIconButtonProps["registerButton"] | undefined;
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
  const enabledKey = enabledActions.join("\u0000");
  const presenceOrder = useToolbarPresenceOrder(visibleActions);
  const lifecycle = useContext(toolbarMotionContext);
  const activeIndex = useRef(0);
  const buttonElements = useRef<ToolbarButtonMap>(new Map());
  const groupRef = useRef<HTMLDivElement>(null);
  const safeIndex = Math.min(activeIndex.current, Math.max(enabledButtons.length - 1, 0));
  const setActiveIndex = (index: number): void => {
    activeIndex.current = index;
    for (const [action, button] of buttonElements.current) {
      button.tabIndex = enabledActions[index] === action ? 0 : -1;
    }
  };
  useToolbarFocusRecovery(
    enabledKey,
    enabledActions,
    props.fallbackFocus,
    groupRef,
    buttonElements,
    setActiveIndex,
  );
  useLayoutEffect(() => {
    setActiveIndex(Math.min(activeIndex.current, Math.max(enabledButtons.length - 1, 0)));
  }, [enabledKey]);
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const nextIndex = nextToolbarIndex(
      resolveToolbarNavigationKey(event.key, props.reverseNavigation === true),
      Math.min(activeIndex.current, Math.max(enabledButtons.length - 1, 0)),
      enabledButtons.length,
    );
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveIndex(nextIndex);
    const nextAction = enabledActions[nextIndex];
    if (nextAction !== undefined) buttonElements.current.get(nextAction)?.focus();
  }
  return (
    <motion.div
      layout="position"
      transition={{ layout: toolbarLayoutTransition(lifecycle.reduced) }}
      aria-label={visibleButtons.length > 0 ? props.label : undefined}
      className={`inkbook-toolbar-group ${props.className}`}
      onFocus={(event) => {
        const focusedAction = toolbarActionFromElement(event.target);
        const index = focusedAction === null ? -1 : enabledActions.indexOf(focusedAction);
        if (index >= 0) setActiveIndex(index);
      }}
      onKeyDown={handleKeyDown}
      ref={groupRef}
      role={visibleButtons.length > 0 ? "group" : undefined}
    >
      <AnimatePresence initial={props.contextButtons === true} custom={presenceOrder}>
        {visibleButtons.map((button) => {
          const disabled = buttonDisabled(button.action, props.state);
          const index = enabledActions.indexOf(button.action);
          return (
            <ToolbarIconButton
              contextButton={props.contextButtons === true}
              confirmation={props.state.actionConfirmation}
              definition={button}
              disabled={disabled}
              preview={buttonPreview(button.action, props.state)}
              expanded={expandedState(button.action, props.state)}
              key={button.action}
              onAction={props.onAction}
              enterOrder={Math.max(0, presenceOrder.entering.indexOf(button.action))}
              popupRole={
                flyoutForAction(button.action) === null
                  ? undefined
                  : popupRoleForAction(button.action)
              }
              pressed={pressedState(button.action, props.state)}
              registerButton={(action, element) => {
                if (element === null) buttonElements.current.delete(action);
                else buttonElements.current.set(action, element);
                props.registerButton?.(action, element);
              }}
              renderIcon={props.renderIcon}
              styleIcon={props.styleIcon}
              tabIndex={!disabled && index === safeIndex ? 0 : -1}
              tool={isToolId(button.action)}
            />
          );
        })}
      </AnimatePresence>
    </motion.div>
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
  readonly compositionRef?: Ref<HTMLDivElement> | undefined;
  readonly layout: "wide" | "scrollable";
  readonly leftHanded?: boolean | undefined;
  readonly onAction: (action: ToolbarAction, trigger: HTMLButtonElement) => void;
  readonly registerButton?: ToolbarIconButtonProps["registerButton"] | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly selectionArea: SelectionAreaV1;
  readonly selectedShape: ShapeId;
  readonly shapeIcon: ActiveShapeIconState;
  readonly state: ToolbarState;
  readonly styleIcon: ToolbarStyleIconState;
  readonly toolbarRef?: Ref<HTMLDivElement> | undefined;
}

export function InkbookToolbar(props: InkbookToolbarProps) {
  const lifecycle = useContext(toolbarMotionContext);
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
    <motion.div
      layoutScroll
      aria-label="Inkbook tools"
      className={compositionClassName}
      ref={props.compositionRef}
      role="toolbar"
    >
      <div className="inkbook-toolbar-rail">
        <motion.div
          layout
          className={className}
          ref={props.toolbarRef}
          initial={{ scale: 0 }}
          animate={{ scale: lifecycle.locking || lifecycle.preparing ? 0 : 1 }}
          transition={{
            layout: toolbarLayoutTransition(lifecycle.reduced),
            type: "tween",
            duration:
              lifecycle.reduced || lifecycle.preparing
                ? 0
                : TRANSITION_DURATIONS.toolbarEnterExit / 1000,
            ease: lifecycle.locking ? "easeIn" : "easeOut",
          }}
        >
          <ToolbarGroup
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
        </motion.div>
        <ToolbarGroup
          contextButtons
          buttons={CONTEXT_BUTTONS}
          className="inkbook-toolbar-context-actions"
          fallbackFocus={focusContextNeighbor}
          label="Editing actions"
          onAction={props.onAction}
          registerButton={props.registerButton}
          renderIcon={props.renderIcon}
          reverseNavigation={props.leftHanded}
          state={props.state}
          styleIcon={props.styleIcon}
        />
      </div>
    </motion.div>
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
