import { useContext, useEffect, useRef } from "react";
import { motion, useIsPresent } from "motion/react";
import { toolbarMotionContext, toolbarLayoutTransition } from "./toolbar-motion";
import { Handwriting } from "./handwriting";

export function OnboardingInvitation({
  onStart,
  onDismiss,
  renderIcon,
}: {
  readonly onStart: () => void;
  readonly onDismiss: () => void;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}) {
  const { reduced } = useContext(toolbarMotionContext);
  const present = useIsPresent();
  return (
    <motion.aside
      aria-label="Inkbook quick tour"
      className="inkbook-onboarding-invitation"
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      inert={!present}
      aria-hidden={!present ? true : undefined}
      transition={toolbarLayoutTransition(reduced)}
    >
      <p className="inkbook-menu-visually-hidden">
        Do you want to start a tour? Explore the toolbar at your own pace.
      </p>
      <Handwriting
        text="do you want to"
        duration={700}
        reduced={reduced}
        className="inkbook-handwriting-title"
      />
      <Handwriting
        text="start a tour?"
        delay={700}
        duration={700}
        reduced={reduced}
        className="inkbook-handwriting-title"
      />
      <div className="inkbook-onboarding-actions">
        <motion.button
          type="button"
          className="inkbook-onboarding-action inkbook-onboarding-icon-action"
          aria-label="Start tour"
          onClick={onStart}
          whileHover={{ opacity: 0.85 }}
          whileTap={{ scale: 0.96 }}
          transition={toolbarLayoutTransition(reduced)}
        >
          <InvitationIcon icon="check" renderIcon={renderIcon} />
        </motion.button>
        <motion.button
          type="button"
          className="inkbook-onboarding-action inkbook-onboarding-icon-action"
          aria-label="Skip tour"
          onClick={onDismiss}
          whileHover={{ opacity: 0.85 }}
          whileTap={{ scale: 0.96 }}
          transition={toolbarLayoutTransition(reduced)}
        >
          <InvitationIcon icon="x" renderIcon={renderIcon} />
        </motion.button>
      </div>
    </motion.aside>
  );
}

function InvitationIcon({
  icon,
  renderIcon,
}: {
  readonly icon: string;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current !== null) renderIcon(ref.current, icon);
  }, [icon, renderIcon]);
  return <span ref={ref} className="inkbook-onboarding-action-icon" aria-hidden="true" />;
}
