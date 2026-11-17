import { useLayoutEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { getMotionDuration, MOTION_TOKENS } from "../motion/transitions";
import { handwritingDrawing } from "./handwriting-path";
import { animateOwnedElement } from "../motion/element-motion";

/** Decorative lettering: the caller supplies the equivalent accessible text. Times are milliseconds. */
export function Handwriting({
  text,
  delay = 0,
  duration = MOTION_TOKENS.surface * 4,
  reduced = false,
  className,
  foreignWindow = false,
}: {
  readonly text: string;
  readonly delay?: number;
  readonly duration?: number;
  readonly reduced?: boolean;
  readonly className?: string;
  readonly foreignWindow?: boolean | undefined;
}) {
  const drawing = useMemo(() => handwritingDrawing(text), [text]);
  const writingDuration = getMotionDuration(duration, reduced) / 1000;
  const writingDelay = getMotionDuration(delay, reduced) / 1000;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={className}
      viewBox={`0 0 ${drawing.width} ${drawing.height}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {drawing.strokes.map((stroke, index) =>
        foreignWindow ? (
          <NativeHandwritingStroke
            key={`${text}:${index}`}
            path={stroke.path}
            reduced={reduced}
            duration={writingDuration * (stroke.progressEnd - stroke.progressStart)}
            delay={writingDelay + writingDuration * stroke.progressStart}
          />
        ) : (
          <motion.path
            key={`${text}:${index}`}
            d={stroke.path}
            initial={reduced ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{
              duration: writingDuration * (stroke.progressEnd - stroke.progressStart),
              delay: writingDelay + writingDuration * stroke.progressStart,
              ease: "linear",
            }}
          />
        ),
      )}
    </svg>
  );
}

function NativeHandwritingStroke({
  path,
  reduced,
  duration,
  delay,
}: {
  readonly path: string;
  readonly reduced: boolean;
  readonly duration: number;
  readonly delay: number;
}) {
  const ref = useRef<SVGPathElement>(null);
  const settled = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (reduced || settled.current) {
      settled.current = true;
      element.style.removeProperty("stroke-dashoffset");
      element.style.removeProperty("opacity");
      element.setAttribute("stroke-dashoffset", "0");
      element.setAttribute("opacity", "1");
      return;
    }
    const animation = animateOwnedElement(
      element,
      {
        strokeDashoffset: [1, 0],
        opacity: [0, 1],
      },
      {
        duration,
        delay,
        ease: "linear",
        onComplete: () => {
          settled.current = true;
        },
      },
    );
    return () => animation.stop();
  }, [delay, duration, reduced]);
  return (
    <path
      ref={ref}
      d={path}
      pathLength="1"
      strokeDasharray="1 1"
      strokeDashoffset={reduced ? 0 : 1}
      opacity={reduced ? 1 : 0}
    />
  );
}
