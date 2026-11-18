import type { Localization } from "../../../domain/localization";
import { canonicalizeGeometryNumber } from "../../../domain/schema/canonical";
import { createImportExampleComparison, type ImagePair } from "./import-example-comparison";
import type { ExampleImage, ImportExampleId } from "./import-example-images";
import type { ImportViewContext } from "./import-findings";

const EXAMPLES: readonly ImportExampleId[] = [
  "diagram",
  "print",
  "cursive",
  "corners",
  "precision",
];
type Captures = typeof import("./import-example-images").IMPORT_EXAMPLE_IMAGES;

export interface ImportExampleGallery {
  readonly id: string;
  readonly prepare: (example: ImportExampleId) => void;
  readonly show: (example: ImportExampleId, focus?: boolean) => void;
}

export function prepareImportExamples(): void {
  void import("./import-example-images").catch(() => undefined);
}

/** Five named choices share one lazily created comparison and one pair of image slots. */
export function renderImportExamples(
  container: HTMLElement,
  context: ImportViewContext,
  initial?: ImportExampleId,
): ImportExampleGallery {
  const { localization, state } = context;
  const { section, choices, stage, note } = createGalleryStage(container, localization);

  let comparison: ReturnType<typeof createImportExampleComparison> | undefined;
  let selected: ImportExampleId | undefined;
  let published: ImportExampleId | undefined;
  let captures: Captures | undefined;
  let loading = false;
  let disposed = false;
  context.own(() => {
    disposed = true;
  });

  const buttons = new Map<ImportExampleId, HTMLButtonElement>();
  for (const example of EXAMPLES) {
    const button = choices.createEl("button", {
      cls: "inkbook-menu-choice inkbook-import-example-toggle",
      text: localization.t(`import.example.${example}.title`),
    });
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    buttons.set(example, button);
    context.own(
      bindImportExampleButton(
        button,
        () => prepare(example),
        () => show(example),
      ),
    );
  }

  function publish(example: ImportExampleId): void {
    const assets = examplePair(example, localization, captures);
    if (assets === undefined) {
      if (published !== undefined) comparison!.publish(undefined);
      published = undefined;
      note.textContent = localization.t("import.examplesLoading");
      prepare(example);
      return;
    }
    const animate = initial === undefined || example !== initial || published !== undefined;
    published = example;
    comparison!.publish(assets);
    note.textContent = localization.t(`import.example.${example}.note`);
    if (animate) comparison!.animate();
  }

  function prepare(example: ImportExampleId): void {
    if (!isCapture(example) || captures !== undefined || loading || disposed) return;
    loading = true;
    void import("./import-example-images").then(
      ({ IMPORT_EXAMPLE_IMAGES: images }) => {
        loading = false;
        if (disposed) return;
        captures = images;
        if (selected !== undefined && isCapture(selected)) publish(selected);
      },
      () => {
        loading = false;
        if (!disposed && selected !== undefined && isCapture(selected))
          note.textContent = localization.t("import.examplesUnavailable");
      },
    );
  }

  function show(example: ImportExampleId, focus = false): void {
    if (disposed) return;
    const button = buttons.get(example)!;
    if (selected !== example) {
      if (selected !== undefined) buttons.get(selected)?.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      selected = example;
      if (state !== undefined) state.example = example;
    }
    if (comparison === undefined)
      context.mutate(() => {
        stage.hidden = false;
        comparison = createImportExampleComparison(stage, context);
        stage.append(note);
      });
    if (published !== example) publish(example);
    if (focus) {
      button.focus({ preventScroll: true });
      const body = section.closest<HTMLElement>(".inkbook-import-body");
      if (body)
        body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top;
    }
  }

  const selectedExample = state?.example ?? initial;
  if (selectedExample !== undefined) show(selectedExample);
  return { id: section.id, prepare, show };
}

function createGalleryStage(container: HTMLElement, localization: Localization) {
  const section = container.createEl("section", { cls: "inkbook-import-examples" });
  section.id = `inkbook-examples-${section.ownerDocument.defaultView!.crypto.randomUUID()}`;
  const heading = section.createEl("h4", { text: localization.t("import.examples") });
  heading.id = `${section.id}-title`;
  section.setAttribute("aria-labelledby", heading.id);
  section.createEl("p", {
    cls: "inkbook-import-examples-intro",
    text: localization.t("import.examplesIntro"),
  });
  const choices = section.createDiv({
    cls: "inkbook-import-example-choices inkbook-menu-controls",
  });
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-labelledby", heading.id);
  const stage = section.createDiv();
  const note = stage.createEl("p", { cls: "inkbook-import-examples-note" });
  note.setAttribute("role", "status");
  note.setAttribute("aria-atomic", "true");
  stage.hidden = true;
  return { section, choices, stage, note };
}

export function bindImportExampleButton(
  button: HTMLButtonElement,
  prepare: () => void,
  activate: () => void,
): () => void {
  const intentEvents = ["focus", "pointerenter", "pointerdown"];
  for (const event of intentEvents) button.addEventListener(event, prepare);
  button.addEventListener("click", activate);
  return () => {
    for (const event of intentEvents) button.removeEventListener(event, prepare);
    button.removeEventListener("click", activate);
  };
}

function isCapture(example: ImportExampleId): boolean {
  return example !== "corners" && example !== "precision";
}

function examplePair(
  example: ImportExampleId,
  localization: Localization,
  captures?: Captures,
): ImagePair | undefined {
  if (example === "precision") return coordinateExample(localization);
  if (example === "corners") {
    return {
      before: roundedRectangle(18, "import.example.corners.before"),
      after: roundedRectangle(0, "import.example.corners.after"),
    };
  }
  return captures?.find(({ id }) => id === example);
}

function roundedRectangle(radius: number, alt: ExampleImage["alt"]): ExampleImage {
  // Match the source and native rectangle extents, isolating the discarded corner radius.
  return exampleSvg(
    `<rect x="82" y="30" width="116" height="70" rx="${radius}" fill="none" stroke="#212121" stroke-width="3"/>`,
    alt,
  );
}

function coordinateExample(localization: Localization): ImagePair {
  const original = 12.3456;
  return {
    before: coordinateDiagram(original, "import.example.precision.before", localization),
    after: coordinateDiagram(
      canonicalizeGeometryNumber(original),
      "import.example.precision.after",
      localization,
    ),
  };
}

function coordinateDiagram(
  coordinate: number,
  alt: ExampleImage["alt"],
  localization: Localization,
): ExampleImage {
  // The magnified axis runs from 12.345 to 12.347 in both panels.
  const x = 48 + Math.round((coordinate - 12.345) * 92_000);
  const value = localization.number(coordinate, { maximumFractionDigits: 4 });
  const diagram = `<text x="140" y="55" text-anchor="middle" font-family="sans-serif" font-size="29" fill="#212121">x = ${value}</text><path d="M48 93H232M48 86V100M140 86V100M232 86V100" fill="none" stroke="#595959" stroke-width="2"/><circle cx="${x}" cy="93" r="6" fill="#1356A1"/>`;
  return { ...exampleSvg(diagram, alt), altParameters: { value } };
}

function exampleSvg(content: string, alt: ExampleImage["alt"]): ExampleImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 130"><rect width="280" height="130" fill="#F5F5F5"/>${content}</svg>`;
  return { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, width: 280, height: 130, alt };
}
