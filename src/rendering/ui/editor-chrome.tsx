import { editorLocalizationContext, useEditorLocalization } from "./localization";
import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, LayoutGroup, MotionConfig } from "motion/react";

import { InkbookToolbar } from "./toolbar";
import type { InkbookEditorChromeProps } from "./editor-chrome-types";
import { toolbarMotionContext, useToolbarMotion } from "./toolbar-motion";
import { OnboardingInvitation } from "./onboarding-invitation";

export type { InkbookEditorChromeProps } from "./editor-chrome-types";

export function InkbookEditorChrome(props: InkbookEditorChromeProps) {
  const localization = useEditorLocalization(props.localization);
  const composition = useRef<HTMLDivElement>(null);
  const motionState = useToolbarMotion(composition);
  const motionGroupId = useId();

  return (
    <editorLocalizationContext.Provider value={localization}>
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
            <span className="inkbook-menu-visually-hidden" role="status" aria-atomic="true">
              {props.toolbarState.actionConfirmation == null ? null : (
                <span key={props.toolbarState.actionConfirmation.sequence}>
                  {localization.t(
                    props.toolbarState.actionConfirmation.action === "copy"
                      ? "editor.ui.copied"
                      : props.toolbarState.actionConfirmation.action === "cut"
                        ? "editor.ui.cut"
                        : "editor.ui.pasted",
                  )}
                </span>
              )}
            </span>
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
    </editorLocalizationContext.Provider>
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
