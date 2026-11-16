import { importDiagnosticText } from "./import-diagnostic-text";
import {
  renderImportFinding,
  renderImportFindings,
  type ImportViewContext,
} from "./import-findings";
import { renderPagedItems } from "./paged-findings";
import type { ImportPreviewFinding } from "./preview-findings";

const CATEGORIES = [
  { category: "difference", label: "import.differences", icon: "paintbrush" },
  { category: "warning", label: "import.warnings", icon: "triangle-alert" },
  { category: "skipped", label: "import.skipped", icon: "circle-slash" },
] as const;

/** Replaces only selection-dependent findings while retaining the file list and its focus. */
export function createPreviewFindingsView(container: HTMLElement, context: ImportViewContext) {
  const region = container.createDiv();
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
    renderPreviewFindings(region, findings, {
      ...context,
      own: (dispose) => disposers.push(dispose),
    });
  };
}

export function renderPreviewFindings(
  container: HTMLElement,
  findings: readonly ImportPreviewFinding[],
  context: ImportViewContext,
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
          const copy = renderImportFinding(
            row,
            finding.warningCode === undefined
              ? importDiagnosticText(context.localization, finding.message, finding.diagnostic)
              : context.localization.t(`import.warning.${finding.warningCode}`),
            [],
            {
              icon: presentation.icon,
              tone: finding.category === "warning" ? "caution" : "neutral",
            },
          );
          const findingContext = {
            ...pageContext,
            path: `${pageContext.path ?? ""}/${encodeURIComponent(finding.warningCode ?? finding.message)}`,
          };
          renderAffectedPaths(copy, "import.affectedFiles", finding.sources, findingContext);
          renderAffectedPaths(copy, "import.affectedNotes", finding.notes, findingContext);
        },
      },
      context,
    );
  }
}

function renderAffectedPaths(
  container: HTMLElement,
  key: "import.affectedFiles" | "import.affectedNotes",
  paths: readonly string[],
  context: ImportViewContext,
): void {
  if (paths.length === 0) return;
  const label = context.localization.t(key);
  const entry = (row: HTMLElement, index: number): void => {
    row.createSpan({ text: paths[index]!, cls: "inkbook-import-finding-source" });
  };
  if (paths.length > 3) {
    renderImportFindings(
      container,
      {
        label,
        id: key,
        count: paths.length,
        icon: "files",
        entry,
      },
      context,
    );
  } else {
    const group = container.createDiv({ cls: "inkbook-import-affected-paths" });
    group.createSpan({ text: label, cls: "inkbook-import-finding-detail" });
    renderPagedItems(group, {
      label,
      count: paths.length,
      entry,
      localization: context.localization,
    });
  }
}
