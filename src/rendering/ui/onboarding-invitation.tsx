import { useEditorLocalization } from "./localization";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { motion, useIsPresent, usePresence } from "motion/react";
import { animateOwnedElement } from "../motion/element-motion";
import { STANDARD_EASING, TRANSITION_DURATIONS } from "../motion/transitions";
import { toolbarMotionContext, toolbarLayoutTransition } from "./toolbar-motion";
import { useToolbarOwnerGestures } from "./toolbar-owner-gestures";
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
  const { t } = useEditorLocalization();
  const { reduced, foreignWindow } = useContext(toolbarMotionContext);
  return (
    <InvitationSurface label={t("editor.tour.label")}>
      <p className="inkbook-menu-visually-hidden">{t("editor.tour.invitation")}</p>
      <Handwriting
        text={t("editor.tour.invite-first")}
        duration={700}
        reduced={reduced}
        foreignWindow={foreignWindow}
        className="inkbook-handwriting-title"
      />
      <Handwriting
        text={t("editor.tour.invite-second")}
        delay={700}
        duration={700}
        reduced={reduced}
        foreignWindow={foreignWindow}
        className="inkbook-handwriting-title"
      />
      <div className="inkbook-onboarding-actions">
        <InvitationAction label={t("editor.tour.start")} onAction={onStart}>
          <InvitationIcon icon="check" renderIcon={renderIcon} />
        </InvitationAction>
        <InvitationAction label={t("editor.tour.skip")} onAction={onDismiss}>
          <InvitationIcon icon="x" renderIcon={renderIcon} />
        </InvitationAction>
      </div>
    </InvitationSurface>
  );
}

function InvitationSurface({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  const { reduced, foreignWindow } = useContext(toolbarMotionContext);
  const present = useIsPresent();
  if (foreignWindow)
    return <NativeInvitationSurface label={label}>{children}</NativeInvitationSurface>;
  return (
    <motion.aside
      aria-label={label}
      className="inkbook-onboarding-invitation"
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      inert={!present}
      aria-hidden={!present ? true : undefined}
      transition={toolbarLayoutTransition(reduced)}
    >
      {children}
    </motion.aside>
  );
}

function NativeInvitationSurface({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  const { reduced } = useContext(toolbarMotionContext);
  const [present, safeToRemove] = usePresence();
  const ref = useRef<HTMLElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const from = first.current
      ? 0
      : Number(element.ownerDocument.defaultView!.getComputedStyle(element).opacity);
    first.current = false;
    if (reduced) {
      element.style.removeProperty("opacity");
      if (!present) safeToRemove?.();
      return;
    }
    let current = true;
    const animation = animateOwnedElement(
      element,
      { opacity: [from, present ? 1 : 0] },
      {
        duration: TRANSITION_DURATIONS.toolActiveState / 1000,
        ease: STANDARD_EASING,
        onComplete: () => {
          if (!current) return;
          if (!present) safeToRemove?.();
          else element.style.removeProperty("opacity");
        },
      },
    );
    return () => {
      current = false;
      animation.stop();
    };
  }, [present, reduced, safeToRemove]);
  return (
    <aside
      ref={ref}
      aria-label={label}
      className="inkbook-onboarding-invitation"
      inert={!present}
      aria-hidden={!present ? true : undefined}
    >
      {children}
    </aside>
  );
}

function InvitationAction({
  children,
  label,
  onAction,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly onAction: () => void;
}) {
  const { reduced, foreignWindow } = useContext(toolbarMotionContext);
  const present = useIsPresent();
  const ref = useRef<HTMLButtonElement>(null);
  const { gesture, hovering } = useToolbarOwnerGestures(ref, !present);
  useNativeInvitationFeedback(ref, foreignWindow === true, {
    reduced,
    opacity: hovering ? 0.85 : 1,
    scale: gesture === "press" ? 0.96 : 1,
  });
  const Button = foreignWindow ? "button" : motion.button;
  return (
    <Button
      type="button"
      className="inkbook-onboarding-action inkbook-onboarding-icon-action"
      aria-label={label}
      onClick={onAction}
      ref={ref}
      {...(foreignWindow
        ? {}
        : { animate: { opacity: hovering ? 0.85 : 1, scale: gesture === "press" ? 0.96 : 1 } })}
      {...(present && foreignWindow !== true
        ? { whileHover: { opacity: 0.85 }, whileTap: { scale: 0.96 } }
        : {})}
      {...(foreignWindow ? {} : { transition: toolbarLayoutTransition(reduced) })}
    >
      {children}
    </Button>
  );
}

function useNativeInvitationFeedback(
  ref: RefObject<HTMLButtonElement | null>,
  enabled: boolean,
  {
    reduced,
    opacity,
    scale,
  }: { readonly reduced: boolean; readonly opacity: number; readonly scale: number },
): void {
  const first = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || element === null) return;
    if (first.current || reduced) {
      first.current = false;
      element.style.opacity = String(opacity);
      element.style.scale = String(scale);
      return;
    }
    const style = element.ownerDocument.defaultView!.getComputedStyle(element);
    const animation = animateOwnedElement(
      element,
      {
        opacity: [Number(style.opacity || "1"), opacity],
        scale: [style.scale === "none" || !style.scale ? 1 : Number(style.scale), scale],
      },
      { duration: TRANSITION_DURATIONS.toolActiveState / 1000, ease: STANDARD_EASING },
    );
    return () => animation.stop();
  }, [enabled, opacity, reduced, ref, scale]);
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      element?.style.removeProperty("opacity");
      element?.style.removeProperty("scale");
    };
  }, [ref]);
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
