import { handwritingDrawing } from "../../../rendering/ui/handwriting-path";
import { animateOwnedElement } from "../../runtime/element-motion";

/** Owns a bounded set of pen animations, never a document element or a frame loop. */
export class OnboardingInk {
  readonly #strokes: { element: SVGPathElement; delay: number; duration: number }[] = [];
  readonly #animations: ReturnType<typeof animateOwnedElement>[] = [];

  public path(svg: SVGSVGElement, delay: number, duration: number): SVGPathElement {
    const element = svg.createSvg("path");
    element.setAttribute("pathLength", "1");
    element.setAttribute("stroke-dasharray", "1");
    element.setAttribute("stroke-dashoffset", "1");
    element.setAttribute("opacity", "0");
    svg.append(element);
    this.#strokes.push({ element, delay, duration });
    return element;
  }

  public lettering(
    parent: HTMLElement,
    text: string,
    title: boolean,
    delay: number,
  ): SVGSVGElement {
    const drawing = handwritingDrawing(text);
    const svg = parent.createSvg("svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("viewBox", `0 0 ${String(drawing.width)} 20`);
    svg.setAttribute("width", String(drawing.width * (title ? 3.2 : 2.6)));
    svg.setAttribute("height", title ? "64" : "52");
    svg.classList.add(title ? "inkbook-handwriting-title" : "inkbook-handwriting-line");
    for (const stroke of drawing.strokes) {
      const duration = title ? 760 : 680;
      this.path(
        svg,
        delay + duration * stroke.progressStart,
        duration * (stroke.progressEnd - stroke.progressStart),
      ).setAttribute("d", stroke.path);
    }
    parent.append(svg);
    return svg;
  }

  public play(reduced: boolean): void {
    if (reduced) return this.finish();
    for (const { element, delay, duration } of this.#strokes) {
      const animation = animateOwnedElement(
        element,
        { strokeDashoffset: ["1", "0"], opacity: [0, 1] },
        { delay: delay / 1000, duration: duration / 1000, ease: "linear" },
      );
      void animation.finished.catch(() => undefined);
      this.#animations.push(animation);
    }
  }

  public finish(): void {
    this.dispose();
    for (const { element } of this.#strokes) {
      element.setAttribute("stroke-dashoffset", "0");
      element.setAttribute("opacity", "1");
    }
  }

  public dispose(): void {
    for (const animation of this.#animations.splice(0)) animation.cancel();
  }
}
