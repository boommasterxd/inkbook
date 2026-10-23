import { motion } from "motion/react";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { observeEffectiveMotion, type ObserveMotion } from "../runtime/effective-motion";

import {
  isReducedMotion,
  STANDARD_EASING,
  type MotionPreference,
} from "../../rendering/motion/transitions";

export function createSettingsLayoutMotion(
  content: HTMLElement,
  readMotion: () => MotionPreference,
  observeMotion?: ObserveMotion,
): {
  mutate: (update: () => void) => void;
  dispose: () => void;
} {
  const wrapper = content.createDiv();
  content.before(wrapper);
  const root = createRoot(wrapper);
  let revision = 0;
  let disposed = false;
  let pendingUpdate: (() => void) | undefined;
  const Mutation = ({ tick }: { tick: number }): null => {
    useLayoutEffect(() => {
      if (pendingUpdate === undefined) return;
      const update = pendingUpdate;
      pendingUpdate = undefined;
      update();
    }, [tick]);
    return null;
  };
  const render = (instant: boolean): void => {
    flushSync(() => {
      root.render(
        <motion.div
          layout="size"
          layoutDependency={revision}
          transition={{ duration: instant ? 0 : 0.18, ease: STANDARD_EASING }}
        >
          <motion.div
            layout="position"
            layoutDependency={revision}
            ref={(node) => {
              if (node !== null && content.parentElement !== node) node.append(content);
            }}
            transition={{ duration: instant ? 0 : 0.18, ease: STANDARD_EASING }}
          >
            <Mutation tick={revision} />
          </motion.div>
        </motion.div>,
      );
    });
  };
  render(true);
  const releasePreference = observeEffectiveMotion(
    content,
    readMotion,
    (reduced) => {
      if (reduced && !disposed) {
        revision += 1;
        render(true);
      }
    },
    observeMotion,
  );
  return {
    mutate: (update) => {
      if (disposed) return;
      pendingUpdate = update;
      revision += 1;
      render(
        isReducedMotion(
          readMotion(),
          content.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      );
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pendingUpdate = undefined;
      releasePreference();
      root.unmount();
      wrapper.before(content);
      wrapper.remove();
    },
  };
}
