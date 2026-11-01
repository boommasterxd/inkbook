import { setIcon } from "obsidian";
import { playMenuMotion } from "../../menus/feedback/menu-motion";
import {
  effectiveTransitionDuration,
  observeEffectiveMotion,
} from "../../runtime/effective-motion";
import { IMPORT_EXAMPLE_IMAGES } from "./import-example-images";
import { renderImportIcon, type ImportViewContext } from "./import-findings";

type ExampleImage = (typeof IMPORT_EXAMPLE_IMAGES)[number]["before"];

/** Real source and converted captures, with only the current pair mounted. */
export function renderImportExamples(container: HTMLElement, context: ImportViewContext): void {
  const section = container.createEl("section", { cls: "inkbook-import-examples" });
  section.createEl("h4", { text: "Example imports" });
  const warning = section.createEl("p", { cls: "inkbook-import-examples-warning" });
  renderImportIcon(warning, "triangle-alert", "inkbook-import-file-icon");
  warning.createSpan({
    text: "Stroke thickness, curves and backgrounds can change. Review the copies before removing originals.",
  });
  const navigation = section.createDiv({
    cls: "inkbook-import-pagination inkbook-import-examples-navigation",
  });
  const previous = exampleButton(navigation, "Previous example", "chevron-left");
  const status = navigation.createSpan({ cls: "inkbook-import-examples-current" });
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  const title = status.createEl("strong");
  const count = status.createSpan({ cls: "inkbook-import-page-range" });
  const next = exampleButton(navigation, "Next example", "chevron-right");
  const comparison = section.createDiv({ cls: "inkbook-import-examples-pair" });
  const before = exampleFigure(comparison, "Before · Obsidian Ink");
  const after = exampleFigure(comparison, "After · Inkbook");
  const note = section.createEl("p", { cls: "inkbook-import-examples-note" });
  let index = Math.max(
    0,
    IMPORT_EXAMPLE_IMAGES.findIndex((example) => example.id === "diagram"),
  );
  let cancelMotion: (() => void) | undefined;
  const finishMotion = (): void => {
    cancelMotion?.();
    cancelMotion = undefined;
    comparison.style.removeProperty("opacity");
  };
  const publish = (): void => {
    const example = IMPORT_EXAMPLE_IMAGES[index]!;
    title.textContent = example.title;
    count.textContent = `Example ${index + 1} of ${IMPORT_EXAMPLE_IMAGES.length}`;
    note.textContent = example.note;
    setExampleImage(before, example.before);
    setExampleImage(after, example.after);
    previous.disabled = index === 0;
    next.disabled = index === IMPORT_EXAMPLE_IMAGES.length - 1;
  };
  const turn = (direction: number, target: HTMLButtonElement): void => {
    const destination = index + direction;
    if (destination < 0 || destination >= IMPORT_EXAMPLE_IMAGES.length) return;
    finishMotion();
    context.mutate(() => {
      index = destination;
      publish();
    });
    (target.disabled ? (direction > 0 ? previous : next) : target).focus();
    const ownerWindow = comparison.ownerDocument.defaultView;
    if (ownerWindow !== null) {
      cancelMotion = playMenuMotion(
        comparison,
        { opacity: [0, 1] },
        effectiveTransitionDuration(comparison, ownerWindow, "fallback"),
      );
    }
  };
  const goPrevious = (): void => turn(-1, previous);
  const goNext = (): void => turn(1, next);
  previous.addEventListener("click", goPrevious);
  next.addEventListener("click", goNext);
  publish();
  const releaseMotion = observeEffectiveMotion(
    section,
    context.readMotion,
    (reduced) => {
      if (reduced) finishMotion();
    },
    context.observeMotion,
  );
  context.own(() => {
    finishMotion();
    releaseMotion();
    previous.removeEventListener("click", goPrevious);
    next.removeEventListener("click", goNext);
  });
}

function exampleButton(container: HTMLElement, label: string, icon: string): HTMLButtonElement {
  const button = container.createEl("button", { cls: "inkbook-import-page-button" });
  button.type = "button";
  button.setAttribute("aria-label", label);
  setIcon(button, icon);
  return button;
}

function exampleFigure(container: HTMLElement, label: string): HTMLImageElement {
  const figure = container.createEl("figure", { cls: "inkbook-import-example" });
  figure.createEl("figcaption", { text: label });
  return figure.createDiv({ cls: "inkbook-import-example-image" }).createEl("img");
}

function setExampleImage(image: HTMLImageElement, source: ExampleImage): void {
  image.width = source.width;
  image.height = source.height;
  image.alt = source.alt;
  image.src = source.src;
}
