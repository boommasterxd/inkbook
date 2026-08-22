import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { BackgroundFlyout, FlyoutPortal, ShapeFlyout, StyleFlyout } from "./flyout";
import type {
  BackgroundFlyoutState,
  EditorFlyoutCallbacks,
  ShapeId,
  StyleControl,
} from "./flyout-types";
import { InkbookToolbar } from "./toolbar";
import type { ToolbarLayoutStage } from "./toolbar-layout";
import type { FlyoutId, ToolbarAction, ToolbarState } from "./toolbar-types";

export interface InkbookEditorChromeProps {
  readonly background: BackgroundFlyoutState;
  readonly callbacks: EditorFlyoutCallbacks;
  readonly canvasInput: HTMLElement | null;
  readonly layout: ToolbarLayoutStage;
  readonly leftHanded?: boolean;
  readonly onToolbarAction: (action: ToolbarAction) => void;
  readonly ownerDocument: Document;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly selectedShape: ShapeId;
  readonly styleControls: readonly StyleControl[];
  readonly toolbarState: ToolbarState;
}

export interface OverflowEdges {
  readonly end: boolean;
  readonly start: boolean;
}

const NO_OVERFLOW: OverflowEdges = { end: false, start: false };

export function InkbookEditorChrome(props: InkbookEditorChromeProps) {
  const buttons = useRef(new Map<ToolbarAction, HTMLButtonElement>());
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

  const requestedFlyout = props.toolbarState.openFlyout;
  useLayoutEffect(() => {
    if (requestedFlyout !== null && requestedFlyout !== renderedFlyout) {
      setRenderedFlyout(requestedFlyout);
    }
  }, [renderedFlyout, requestedFlyout]);

  const flyout = renderedFlyout;
  const anchor = flyout === null ? null : (buttons.current.get(flyout) ?? null);

  return (
    <>
      <div
        className="inkbook-toolbar-shell"
        data-overflow-end={overflow.end ? "true" : undefined}
        data-overflow-start={overflow.start ? "true" : undefined}
      >
        <InkbookToolbar
          layout={props.layout}
          leftHanded={props.leftHanded}
          onAction={props.onToolbarAction}
          onScroll={updateOverflow}
          registerButton={registerButton}
          renderIcon={props.renderIcon}
          state={props.toolbarState}
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
  if (flyout === "shape") {
    return <ShapeFlyout onChange={props.callbacks.onShapeChange} value={props.selectedShape} />;
  }
  return <StyleFlyout controls={props.styleControls} onChange={props.callbacks.onStyleChange} />;
}

function flyoutLabel(flyout: FlyoutId): string {
  if (flyout === "background") return "Background";
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
