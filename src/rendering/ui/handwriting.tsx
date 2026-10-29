import { useMemo } from "react";
import { motion } from "motion/react";
import { getMotionDuration, MOTION_TOKENS } from "../motion/transitions";
import { handwritingDrawing } from "./handwriting-path";

/** Decorative lettering: the caller supplies the equivalent accessible text. Times are milliseconds. */
export function Handwriting({
  text,
  delay = 0,
  duration = MOTION_TOKENS.surface * 4,
  reduced = false,
  className,
}: {
  readonly text: string;
  readonly delay?: number;
  readonly duration?: number;
  readonly reduced?: boolean;
  readonly className?: string;
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
      {drawing.strokes.map((stroke, index) => (
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
      ))}
    </svg>
  );
}
