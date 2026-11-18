import { importDiagnosticText } from "./import-diagnostic-text";
import {
  renderImportDisclosure,
  renderImportFinding,
  renderImportFindings,
  type ImportViewContext,
} from "./import-findings";
import { renderPagedItems } from "./paged-findings";
import { quantity } from "./import-quantity";
import type { ImportPreviewFinding } from "./preview-findings";
import { bindImportExampleButton, type ImportExampleGallery } from "./import-examples";
import { englishImportWarning } from "../../../persistence/import/obsidian-ink/warnings";

const CATEGORIES = [
  { category: "difference", label: "import.differences", icon: "paintbrush" },
  { category: "warning", label: "import.warnings", icon: "triangle-alert" },
  { category: "skipped", label: "import.skipped", icon: "circle-slash" },
] as const;

const FINDING_EXAMPLES = [
  ["squareCorners", "corners"],
  ["nativeBrush", "diagram"],
  ["nativePrecision", "precision"],
] as const;

/** Replaces only selection-dependent findings while retaining the file list and its focus. */
export function createPreviewFindingsView(
  container: HTMLElement,
  context: ImportViewContext,
  gallery: ImportExampleGallery,
) {
  const region = container.createDiv({ cls: "inkbook-import-review-findings" });
  const disposers: Array<() => void> = [];
  let current: readonly ImportPreviewFinding[] | undefined;
  const release = (): void => {
    for (const dispose of disposers.splice(0)) dispose();
  };
  context.own(release);
  return (findings: readonly ImportPreviewFinding[]): void => {
    if (findings === current) return;
    current = findings;
    release();
    region.replaceChildren();
    renderPreviewFindings(
      region,
      findings,
      { ...context, own: (dispose) => disposers.push(dispose) },
      gallery,
    );
  };
}

export function renderPreviewFindings(
  container: HTMLElement,
  findings: readonly ImportPreviewFinding[],
  context: ImportViewContext,
  gallery?: ImportExampleGallery,
): void {
  for (const presentation of CATEGORIES) {
    const groups = findings.filter((finding) => finding.category === presentation.category);
    renderImportFindings(
      container,
      {
        ...presentation,
        label: context.localization.t(presentation.label),
        id: presentation.label,
        count: groups.length,
        entry: (row, index, pageContext) => {
          const finding = groups[index]!;
          row.classList.add("inkbook-import-review-finding");
          const copy = renderImportFinding(
            row,
            finding.warningCode === undefined
              ? importDiagnosticText(context.localization, finding.message, finding.diagnostic)
              : context.localization.t(`import.warning.${finding.warningCode}`),
            [],
            {
              tone: finding.category === "warning" ? "caution" : "neutral",
            },
          );
          const findingContext = {
            ...pageContext,
            path: `${pageContext.path ?? ""}/${encodeURIComponent(finding.warningCode ?? finding.message)}`,
          };
          if (gallery !== undefined) renderFindingExample(copy, finding, findingContext, gallery);
          renderAffectedPaths(copy, finding, findingContext);
        },
      },
      context,
    );
  }
}

function renderFindingExample(
  container: HTMLElement,
  finding: ImportPreviewFinding,
  context: ImportViewContext,
  gallery: ImportExampleGallery,
): void {
  const match = FINDING_EXAMPLES.find(([code]) =>
    finding.warningCode === undefined
      ? finding.message === englishImportWarning(code)
      : finding.warningCode === code,
  );
  if (match === undefined) return;
  const [, id] = match;
  const button = container.createEl("button", {
    cls: "inkbook-import-example-link inkbook-menu-choice",
    text: context.localization.t("import.showExample", {
      title: context.localization.t(`import.example.${id}.title`),
    }),
  });
  button.type = "button";
  button.setAttribute("aria-controls", gallery.id);
  context.own(
    bindImportExampleButton(
      button,
      () => gallery.prepare(id),
      () => gallery.show(id, true),
    ),
  );
}

function renderAffectedPaths(
  container: HTMLElement,
  finding: ImportPreviewFinding,
  context: ImportViewContext,
): void {
  const groups = [
    { paths: finding.sources, label: "import.affectedFiles", noun: "handwriting" },
    { paths: finding.notes, label: "import.affectedNotes", noun: "note" },
  ] as const;
  const affected = groups.filter(({ paths }) => paths.length > 0);
  if (affected.length === 0) return;
  const { localization } = context;
  const title = affected
    .map(({ paths, noun }) => quantity(paths.length, noun, localization))
    .join(" · ");
  renderImportDisclosure(
    container,
    {
      id: "origins",
      title,
      description: localization.t("import.findingsReview", { label: title }),
      icon: "files",
      populate: (content, scope) => {
        for (const { label: key, paths } of affected) {
          const group = content.createDiv({ cls: "inkbook-import-affected-paths" });
          const label = localization.t(key);
          group.createSpan({ text: label, cls: "inkbook-import-finding-detail" });
          const pageKey = `${scope.context.path}/${key}`;
          const state = context.state?.findings.get(pageKey) ?? { expanded: true };
          context.state?.findings.set(pageKey, state);
          renderPagedItems(group, {
            label,
            localization,
            count: paths.length,
            state,
            mutate: context.mutate,
            entry: (row, index) =>
              row.createSpan({ text: paths[index]!, cls: "inkbook-import-finding-source" }),
          });
        }
      },
    },
    context,
  );
}
