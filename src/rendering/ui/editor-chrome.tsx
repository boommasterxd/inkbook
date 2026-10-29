import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, LayoutGroup, MotionConfig } from "motion/react";

import { InkbookToolbar } from "./toolbar";
import type { InkbookEditorChromeProps } from "./editor-chrome-types";
import { toolbarMotionContext, useToolbarMotion } from "./toolbar-motion";
import { OnboardingInvitation } from "./onboarding-invitation";

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
          <AnimatePresence>
            {props.onboarding === undefined ? null : (
              <PortalInvitation
                key="onboarding"
                invitation={props.onboarding}
                renderIcon={props.renderIcon}
              />
            )}
          </AnimatePresence>
        </LayoutGroup>
      </MotionConfig>
    </toolbarMotionContext.Provider>
  );
}

function PortalInvitation({
  invitation,
  renderIcon,
}: {
  readonly invitation: NonNullable<InkbookEditorChromeProps["onboarding"]>;
  readonly renderIcon: InkbookEditorChromeProps["renderIcon"];
}) {
  return createPortal(
    <OnboardingInvitation {...invitation} renderIcon={renderIcon} />,
    invitation.container,
  );
}
