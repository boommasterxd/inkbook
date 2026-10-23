import { useCallback, useId, useLayoutEffect, useRef } from "react";
import { LayoutGroup, MotionConfig } from "motion/react";

import { InkbookToolbar } from "./toolbar";
import { toolbarMainHalfWidth } from "./toolbar-layout";
import { editorChromeLayoutKey } from "./editor-chrome-snapshot";
import type { InkbookEditorChromeProps } from "./editor-chrome-types";
import { toolbarMotionContext, useToolbarMotion } from "./toolbar-motion";

export type { InkbookEditorChromeProps } from "./editor-chrome-types";

export function InkbookEditorChrome(props: InkbookEditorChromeProps) {
  const composition = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const motionState = useToolbarMotion(composition);
  const motionGroupId = useId();
  const toolbarLayoutKey = editorChromeLayoutKey(props);
  const measureToolbar = useCallback(() => {
    const main = toolbar.current;
    if (main === null) return;
    shell.current?.style.setProperty(
      "--inkbook-toolbar-main-half",
      `${String(toolbarMainHalfWidth(main))}px`,
    );
  }, []);

  useLayoutEffect(measureToolbar, [measureToolbar, toolbarLayoutKey]);
  useLayoutEffect(() => {
    const element = composition.current;
    return element === null
      ? undefined
      : registerToolbarResize(element, props.ownerDocument, measureToolbar);
  }, [measureToolbar, props.ownerDocument]);

  return (
    <toolbarMotionContext.Provider
      value={{ ...motionState, foreignWindow: props.ownerDocument.defaultView !== window }}
    >
      <MotionConfig reducedMotion={motionState.reduced ? "always" : "never"}>
        <LayoutGroup id={motionGroupId}>
          <div className="inkbook-toolbar-shell" ref={shell}>
            <InkbookToolbar
              compositionRef={composition}
              layout={props.layout}
              leftHanded={props.leftHanded}
              onAction={props.onToolbarAction}
              renderIcon={props.renderIcon}
              selectionArea={props.selectionArea}
              selectedShape={props.selectedShape}
              shapeIcon={props.shapeIcon}
              state={props.toolbarState}
              styleIcon={props.styleIcon}
              toolbarRef={toolbar}
            />
          </div>
        </LayoutGroup>
      </MotionConfig>
    </toolbarMotionContext.Provider>
  );
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
