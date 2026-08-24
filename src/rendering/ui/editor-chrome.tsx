import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { BackgroundFlyout, FlyoutPortal, ShapeFlyout, StyleFlyout } from "./flyout";
import type {
  BackgroundFlyoutState,
  EditorFlyoutCallbacks,
  OverflowMenuState,
  ShapeId,
  StyleControl,
} from "./flyout-types";
import { OverflowMenu } from "./overflow-menu";
import { InkbookToolbar } from "./toolbar";
import type { ToolbarLayoutStage } from "./toolbar-layout";
import type { FlyoutId, ToolbarAction, ToolbarState } from "./toolbar-types";
import type { ToolbarStyleIconState } from "./style-icon";

export interface InkbookEditorChromeProps {
  readonly background: BackgroundFlyoutState;
  readonly callbacks: EditorFlyoutCallbacks;
  readonly canvasInput: HTMLElement | null;
  readonly layout: ToolbarLayoutStage;
  readonly leftHanded?: boolean;
  readonly onToolbarAction: (action: ToolbarAction) => void;
  readonly ownerDocument: Document;
  readonly overflowMenu: OverflowMenuState;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly selectedShape: ShapeId;
  readonly styleControls: readonly StyleControl[];
  readonly styleIcon: ToolbarStyleIconState;
  readonly toolbarState: ToolbarState;
}

export interface OverflowEdges {
  readonly end: boolean;
  readonly start: boolean;
}

const NO_OVERFLOW: OverflowEdges = { end: false, start: false };

export function InkbookEditorChrome(props: InkbookEditorChromeProps) {
  const buttons = useRef(new Map<ToolbarAction, HTMLButtonElement>());
  const shell = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<OverflowEdges>(NO_OVERFLOW);
  const [renderedFlyout, setRenderedFlyout] = useState<FlyoutId | null>(
    props.toolbarState.openFlyout,
  );
  const registerButton = useCallback((action: ToolbarAction, element: HTMLButtonElement | null) => {
    if (element === null) buttons.current.delete(action);
    else buttons.current.set(action, element);
  }, []);

  const updateOverflow = useCallback(() => {
    const element = toolbar.current;
    if (element === null) {
      setOverflow((current) => (current.start || current.end ? NO_OVERFLOW : current));
      return;
    }
    shell.current?.style.setProperty(
      "--inkbook-toolbar-main-half",
      `${String(element.getBoundingClientRect().width / 2)}px`,
    );
    const next = resolveToolbarOverflow(
      props.layout,
      element.clientWidth,
      element.scrollLeft,
      element.scrollWidth,
    );
    setOverflow((current) =>
      current.start === next.start && current.end === next.end ? current : next,
    );
  }, [props.layout]);

  useLayoutEffect(updateOverflow, [props.toolbarState, updateOverflow]);

  useLayoutEffect(() => {
    const element = toolbar.current;
    return element === null
      ? undefined
      : registerToolbarResize(element, props.ownerDocument, updateOverflow);
  }, [props.ownerDocument, updateOverflow]);

  const requestedFlyout = props.toolbarState.openFlyout;
  useLayoutEffect(() => {
    if (requestedFlyout !== null && requestedFlyout !== renderedFlyout) {
      setRenderedFlyout(requestedFlyout);
    }
  }, [renderedFlyout, requestedFlyout]);

  const flyout = renderedFlyout;
  const anchor =
    flyout === null ? null : (buttons.current.get(toolbarActionForFlyout(flyout)) ?? null);

  return (
    <>
      <div
        className="inkbook-toolbar-shell"
        data-overflow-end={overflow.end ? "true" : undefined}
        data-overflow-start={overflow.start ? "true" : undefined}
        ref={shell}
      >
        <InkbookToolbar
          layout={props.layout}
          leftHanded={props.leftHanded}
          onAction={props.onToolbarAction}
          onScroll={updateOverflow}
          registerButton={registerButton}
          renderIcon={props.renderIcon}
          selectedShape={props.selectedShape}
          state={props.toolbarState}
          styleIcon={props.styleIcon}
          toolbarRef={toolbar}
        />
        <span aria-hidden="true" className="inkbook-toolbar-edge inkbook-toolbar-edge-start" />
        <span aria-hidden="true" className="inkbook-toolbar-edge inkbook-toolbar-edge-end" />
      </div>
      {flyout === null || anchor === null ? null : (
        <EditorFlyout
          anchor={anchor}
          closing={requestedFlyout === null}
          flyout={flyout}
          onExitComplete={() => {
            if (props.toolbarState.openFlyout === null) setRenderedFlyout(null);
          }}
          props={props}
        />
      )}
    </>
  );
}

function toolbarActionForFlyout(flyout: FlyoutId): ToolbarAction {
  return flyout === "shape" ? "shape-picker" : flyout;
}

function EditorFlyout({
  anchor,
  closing,
  flyout,
  onExitComplete,
  props,
}: {
  readonly anchor: HTMLElement;
  readonly closing: boolean;
  readonly flyout: FlyoutId;
  readonly onExitComplete: () => void;
  readonly props: InkbookEditorChromeProps;
}) {
  const close = useCallback(() => props.callbacks.onFlyoutClose(flyout), [flyout, props.callbacks]);
  return (
    <FlyoutPortal
      anchor={anchor}
      canvasInput={props.canvasInput}
      closing={closing}
      id={flyout}
      label={flyoutLabel(flyout)}
      onClose={close}
      onExitComplete={onExitComplete}
      ownerDocument={props.ownerDocument}
      role={flyout === "overflow" ? "menu" : "dialog"}
      showTitle={flyout !== "overflow"}
    >
      {renderEditorFlyoutContent(flyout, props)}
    </FlyoutPortal>
  );
}

export function renderEditorFlyoutContent(
  flyout: FlyoutId,
  props: InkbookEditorChromeProps,
): ReactNode {
  if (flyout === "background") {
    return (
      <BackgroundFlyout
        onSpacingChange={props.callbacks.onBackgroundSpacingChange}
        onTypeChange={props.callbacks.onBackgroundTypeChange}
        state={props.background}
      />
    );
  }
  if (flyout === "overflow") {
    return (
      <OverflowMenu
        background={props.background}
        onAction={props.callbacks.onOverflowAction}
        onBackgroundSpacingChange={props.callbacks.onBackgroundSpacingChange}
        onBackgroundTypeChange={props.callbacks.onBackgroundTypeChange}
        renderIcon={props.renderIcon}
        state={props.overflowMenu}
      />
    );
  }
  if (flyout === "shape") {
    return <ShapeFlyout onChange={props.callbacks.onShapeChange} value={props.selectedShape} />;
  }
  return <StyleFlyout controls={props.styleControls} onChange={props.callbacks.onStyleChange} />;
}

function flyoutLabel(flyout: FlyoutId): string {
  if (flyout === "background") return "Background";
  if (flyout === "overflow") return "More options";
  if (flyout === "shape") return "Shape";
  return "Style";
}

export function resolveToolbarOverflow(
  layout: ToolbarLayoutStage,
  clientWidth: number,
  scrollLeft: number,
  scrollWidth: number,
): OverflowEdges {
  if (layout !== "scrollable") return NO_OVERFLOW;
  return {
    start: scrollLeft > 1,
    end: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

export function registerToolbarResize(
  element: Element,
  ownerDocument: Document,
  onResize: () => void,
): () => void {
  const ResizeObserverConstructor = ownerDocument.defaultView?.ResizeObserver;
  if (ResizeObserverConstructor === undefined) return () => undefined;
  const observer = new ResizeObserverConstructor(() => onResize());
  observer.observe(element);
  return () => observer.disconnect();
}
