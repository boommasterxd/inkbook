import { playMenuMotion } from "../../menus/feedback/menu-motion";
import {
  effectiveTransitionDuration,
  observeEffectiveMotion,
} from "../../runtime/effective-motion";
import type { ExampleImage } from "./import-example-images";
import type { ImportViewContext } from "./import-findings";

type Side = "before" | "after";
export type ImagePair = Readonly<Record<Side, ExampleImage>>;
const SIDES = ["before", "after"] as const;
const NARROW_COMPARISON = "(width <= 480px)";

export function createImportExampleComparison(container: HTMLElement, context: ImportViewContext) {
  const owner = container.ownerDocument.defaultView!;
  const narrow = owner.matchMedia(NARROW_COMPARISON);
  const view = container.createDiv({ cls: "inkbook-import-comparison" });
  view.setAttribute("role", "group");
  view.setAttribute("aria-label", context.localization.t("import.exampleView"));
  const switches = view.createDiv({ cls: "inkbook-import-example-switches inkbook-menu-controls" });
  const comparison = view.createDiv({ cls: "inkbook-import-examples-pair" });
  let cancelMotion: (() => void) | undefined;
  let pair: ImagePair | undefined;
  const state = context.state;
  const stateKey = context.path ?? "examples";
  if (state !== undefined) state.exampleSides ??= new Map();
  let selected = state?.exampleSides?.get(stateKey) ?? "before";
  const figures = SIDES.map((side) =>
    createSide(comparison, switches, context.localization.t(`import.${side}`)),
  );
  const finishMotion = (): void => {
    cancelMotion?.();
    cancelMotion = undefined;
    comparison.style.removeProperty("opacity");
  };
  const animate = (): void => {
    finishMotion();
    cancelMotion = playMenuMotion(
      comparison,
      { opacity: [0, 1] },
      effectiveTransitionDuration(comparison, owner, "fallback"),
    );
  };
  const publish = (side: Side, index: number): void => {
    const entry = figures[index]!;
    const active = selected === side;
    entry.button.setAttribute("aria-pressed", String(active));
    entry.figure.hidden = narrow.matches && !active;
    if (!entry.figure.hidden && pair !== undefined) setImage(entry.image, pair[side], context);
  };
  const resize = (): void => {
    const focusedSwitch = figures.some(({ button }) => owner.document.activeElement === button);
    switches.hidden = !narrow.matches;
    comparison.classList.toggle("inkbook-import-example-single", narrow.matches);
    SIDES.forEach(publish);
    if (focusedSwitch && !narrow.matches) view.focus({ preventScroll: true });
  };
  view.tabIndex = -1;
  const release = SIDES.map((side, index) => {
    const { button, image } = figures[index]!;
    const prepare = (): void => {
      if (pair !== undefined) setImage(image, pair[side], context);
    };
    const select = (): void => {
      if (selected === side) return;
      selected = side;
      state?.exampleSides?.set(stateKey, side);
      SIDES.forEach(publish);
      animate();
    };
    for (const event of ["focus", "pointerenter", "pointerdown"])
      button.addEventListener(event, prepare);
    button.addEventListener("click", select);
    return () => {
      for (const event of ["focus", "pointerenter", "pointerdown"])
        button.removeEventListener(event, prepare);
      button.removeEventListener("click", select);
    };
  });
  const releaseMotion = observeEffectiveMotion(
    view,
    context.readMotion,
    (reduced) => {
      if (reduced) finishMotion();
    },
    context.observeMotion,
  );
  narrow.addEventListener("change", resize);
  resize();
  context.own(() => {
    finishMotion();
    releaseMotion();
    narrow.removeEventListener("change", resize);
    for (const dispose of release) dispose();
  });
  return {
    animate,
    publish: (images: ImagePair | undefined): void => {
      pair = images;
      for (const figure of figures) {
        figure.image.removeAttribute("src");
        figure.image.alt = "";
      }
      SIDES.forEach(publish);
    },
  };
}

function createSide(comparison: HTMLElement, buttons: HTMLElement, label: string) {
  const button = buttons.createEl("button", {
    cls: "inkbook-import-example-toggle inkbook-menu-choice",
    text: label,
  });
  button.type = "button";
  const figure = comparison.createEl("figure", { cls: "inkbook-import-example" });
  figure.id = `inkbook-import-example-${comparison.ownerDocument.defaultView!.crypto.randomUUID()}`;
  button.setAttribute("aria-controls", figure.id);
  figure.createEl("figcaption", { text: label });
  const image = figure.createDiv({ cls: "inkbook-import-example-image" }).createEl("img");
  image.decoding = "async";
  image.alt = "";
  return { button, figure, image };
}

function setImage(image: HTMLImageElement, source: ExampleImage, context: ImportViewContext): void {
  if (image.getAttribute("src") === source.src) return;
  image.width = source.width;
  image.height = source.height;
  image.alt = context.localization.t(source.alt, source.altParameters);
  image.src = source.src;
}
