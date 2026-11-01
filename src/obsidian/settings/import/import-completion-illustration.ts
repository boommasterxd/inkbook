import { MOTION_TOKENS, STANDARD_EASING } from "../../../rendering/motion/transitions";
import { animateOwnedElements } from "../../runtime/element-motion";
import { observeEffectiveMotion } from "../../runtime/effective-motion";
import type { ImportViewContext } from "./import-findings";
import { createImportIllustration } from "./import-illustration";

/** One finite, decorative confirmation; semantic results never wait for motion. */
export function renderImportCompletion(container: HTMLElement, context: ImportViewContext): void {
  const namespace = "http://www.w3.org/2000/svg";
  const graphic = createImportIllustration(container, "inkbook-import-completion");
  const circle = container.ownerDocument.createElementNS(namespace, "circle");
  circle.setAttribute("cx", "48");
  circle.setAttribute("cy", "48");
  circle.setAttribute("r", "35");
  circle.classList.add("inkbook-import-completion-circle");
  const check = container.ownerDocument.createElementNS(namespace, "path");
  check.setAttribute("d", "M31 48 L43 60 L66 36");
  check.setAttribute("pathLength", "1");
  check.setAttribute("stroke-dasharray", "1");
  check.classList.add("inkbook-import-completion-check");
  graphic.append(circle, check);
  const ownerDocument = container.ownerDocument;
  let animation: ReturnType<typeof animateOwnedElements> | undefined;
  let settled = false;
  const finish = (): void => {
    settled = true;
    animation?.cancel();
    animation = undefined;
    graphic.style.removeProperty("scale");
    check.style.removeProperty("stroke-dashoffset");
  };
  const releasePreference = observeEffectiveMotion(
    container,
    context.readMotion,
    (reduced) => {
      if (reduced || ownerDocument.hidden) {
        finish();
      } else if (!settled && animation === undefined) {
        animation = animateOwnedElements(
          [
            { element: graphic, keyframes: { scale: [0.88, 1] } },
            { element: check, keyframes: { strokeDashoffset: [1, 1, 0] } },
          ],
          {
            duration: (MOTION_TOKENS.surface * 2) / 1000,
            ease: STANDARD_EASING,
            onComplete: finish,
          },
        );
      }
    },
    context.observeMotion,
  );
  const visibilityChanged = (): void => {
    if (ownerDocument.hidden) finish();
  };
  ownerDocument.addEventListener("visibilitychange", visibilityChanged);
  context.own(() => {
    finish();
    releasePreference();
    ownerDocument.removeEventListener("visibilitychange", visibilityChanged);
  });
}
