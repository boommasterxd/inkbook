import { useId, useRef } from "react";
import { LayoutGroup, MotionConfig } from "motion/react";

import { InkbookToolbar } from "./toolbar";
import type { InkbookEditorChromeProps } from "./editor-chrome-types";
import { toolbarMotionContext, useToolbarMotion } from "./toolbar-motion";

export type { InkbookEditorChromeProps } from "./editor-chrome-types";

export function InkbookEditorChrome(props: InkbookEditorChromeProps) {
  const composition = useRef<HTMLDivElement>(null);
  const motionState = useToolbarMotion(composition);
  const motionGroupId = useId();

  return (
    <toolbarMotionContext.Provider
      value={{ ...motionState, foreignWindow: props.ownerDocument.defaultView !== window }}
    >
      <MotionConfig reducedMotion={motionState.reduced ? "always" : "never"}>
        <LayoutGroup id={motionGroupId}>
          <div className="inkbook-toolbar-shell">
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
            />
          </div>
        </LayoutGroup>
      </MotionConfig>
    </toolbarMotionContext.Provider>
  );
}
