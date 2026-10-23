import { useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";

import { STANDARD_EASING, getTransitionDuration } from "../motion/transitions";
import { createChromePalette, sameChromeColors, type ChromeColors } from "./chrome-palette";

export interface DocumentStatusBarContentProps {
  readonly icon: { name: string; viewBox: string } | null;
  readonly label: string;
  readonly motionPreference: "full" | "reduced" | "system";
  readonly paletteRevision: number;
  readonly reduced: boolean;
  readonly renderIcon: (element: HTMLElement, name: string, viewBox: string) => void;
  readonly status: string;
  readonly title: string;
}

/** React owns the native item's content so Motion can animate natural layout changes. */
export function DocumentStatusBarContent(props: DocumentStatusBarContentProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const colors = useStatusColors(rootRef, props.paletteRevision);
  const layoutTransition = {
    duration: props.reduced ? 0 : getTransitionDuration("styleChange") / 1000,
    ease: STANDARD_EASING,
  };
  return (
    <MotionConfig reducedMotion={props.reduced ? "always" : "never"}>
      <motion.span
        aria-atomic="true"
        aria-label="Inkbook save status"
        aria-live="polite"
        className="inkbook-status-bar"
        animate={
          colors === undefined
            ? {}
            : { color: props.status === "failed" ? colors.danger : colors.muted }
        }
        data-inkbook-motion={props.motionPreference}
        data-save-status={props.status}
        initial={false}
        layout
        style={{
          color: props.status === "failed" ? colors?.danger : colors?.muted,
          originX: 1,
        }}
        role="status"
        ref={rootRef}
        title={props.title}
        transition={layoutTransition}
      >
        <span className="inkbook-status-bar-announcement">{props.label}</span>
        <AnimatePresence
          initial={false}
          key={props.reduced ? props.status : "full"}
          mode="popLayout"
          anchorX="right"
        >
          <motion.span
            aria-hidden="true"
            className="inkbook-status-bar-content"
            data-save-status={props.status}
            key={props.status}
            initial={{ opacity: props.reduced ? 1 : 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            layout="position"
            layoutAnchor={false}
            transition={layoutTransition}
          >
            <StatusIcon {...props} colors={colors} />
            <span className="inkbook-status-bar-label">{props.label}</span>
          </motion.span>
        </AnimatePresence>
      </motion.span>
    </MotionConfig>
  );
}

function StatusIcon(
  props: DocumentStatusBarContentProps & { readonly colors: ChromeColors | undefined },
) {
  const ref = useRef<HTMLSpanElement>(null);
  const name = props.icon?.name;
  const viewBox = props.icon?.viewBox;
  useLayoutEffect(() => {
    if (ref.current !== null && name !== undefined && viewBox !== undefined)
      props.renderIcon(ref.current, name, viewBox);
  }, [name, viewBox, props.renderIcon]);
  const spinning = name === "loader-circle" && !props.reduced;
  return props.icon === null ? null : (
    <motion.span
      animate={{
        rotate: spinning ? 360 : 0,
        ...(props.colors === undefined
          ? {}
          : {
              color:
                props.status === "saved"
                  ? props.colors.accent
                  : props.status === "failed"
                    ? props.colors.danger
                    : props.colors.muted,
            }),
      }}
      aria-hidden="true"
      className="inkbook-status-bar-icon"
      style={{
        color:
          props.status === "saved"
            ? props.colors?.accent
            : props.status === "failed"
              ? props.colors?.danger
              : props.colors?.muted,
      }}
      ref={ref}
      transition={{
        color: {
          duration: getTransitionDuration("styleChange", props.reduced) / 1000,
          ease: STANDARD_EASING,
        },
        rotate: spinning ? { duration: 1, ease: "linear", repeat: Infinity } : { duration: 0 },
      }}
    />
  );
}

function useStatusColors(
  ref: { readonly current: HTMLElement | null },
  revision: number,
): ChromeColors | undefined {
  const [colors, setColors] = useState<ChromeColors>();
  const refresh = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    if (ref.current === null) return;
    const element = ref.current;
    const palette = createChromePalette(element);
    const update = (): void => {
      const next = palette.read();
      setColors((previous) => (sameChromeColors(previous, next) ? previous : next));
    };
    refresh.current = update;
    const observer = new element.ownerDocument.defaultView!.MutationObserver(update);
    for (const target of [element.ownerDocument.documentElement, element.ownerDocument.body])
      observer.observe(target, { attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      refresh.current = () => undefined;
      observer.disconnect();
      palette.dispose();
    };
  }, [ref]);
  useLayoutEffect(() => refresh.current(), [revision]);
  return colors;
}
