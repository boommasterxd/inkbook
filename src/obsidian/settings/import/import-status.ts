import { animateOwnedElement } from "../../runtime/element-motion";
import { observeEffectiveMotion } from "../../runtime/effective-motion";
import type { ImportViewContext } from "./import-findings";
import { renderImportStep } from "./import-journey";
import { createImportIllustration } from "./import-illustration";

export type PendingImportOperation = "scan" | "import" | "undo" | "cleanup";

/** A decorative, operation-owned scan illustration; it never represents measured progress. */
export function renderImportStatus(
  container: HTMLElement,
  title: string,
  operation: PendingImportOperation,
  context: ImportViewContext,
): { stop: () => void } {
  const root = container.createDiv({ cls: "inkbook-import-progress" });
  if (operation === "scan" || operation === "import")
    renderImportStep(root, operation === "scan" ? 1 : 3);
  const graphic = scanIllustration(root);
  const heading = root.createEl("h3", { text: title });
  root.createEl("p", {
    cls: "inkbook-import-progress-description",
    text: descriptions[operation],
  });
  const safety = root.createEl("p", {
    cls: "inkbook-import-progress-safety",
    text:
      operation === "scan"
        ? "Your files stay unchanged. Next, you choose what to import."
        : "You can stop safely. Completed changes are recorded in import history.",
  });
  const ownerDocument = root.ownerDocument;
  let reduced = false;
  let stopped = false;
  let disposed = false;
  let animations: ReturnType<typeof animateOwnedElement>[] = [];
  const finish = (): void => {
    for (const animation of animations) animation.cancel();
    animations = [];
    for (const line of graphic.lines) line.style.removeProperty("stroke-dashoffset");
    graphic.beam.style.removeProperty("transform");
  };
  const update = (): void => {
    finish();
    if (disposed || stopped || reduced || ownerDocument.hidden) return;
    animations = graphic.lines.map((line, index) =>
      animateOwnedElement(
        line,
        { strokeDashoffset: [1, 0, 0, 1] },
        { duration: 2.4, delay: index * 0.16, repeat: Infinity, ease: "easeInOut" },
      ),
    );
    animations.push(
      animateOwnedElement(
        graphic.beam,
        { transform: ["translateY(0px)", "translateY(30px)"] },
        { duration: 1.2, repeat: Infinity, repeatType: "reverse", ease: "easeInOut" },
      ),
    );
  };
  const releasePreference = observeEffectiveMotion(
    root,
    context.readMotion,
    (nextReduced) => {
      reduced = nextReduced;
      update();
    },
    context.observeMotion,
  );
  ownerDocument.addEventListener("visibilitychange", update);
  context.own(() => {
    disposed = true;
    releasePreference();
    ownerDocument.removeEventListener("visibilitychange", update);
    finish();
  });
  return {
    stop: () => {
      stopped = true;
      finish();
      heading.textContent = "Stopping safely…";
      safety.textContent =
        operation === "scan"
          ? "Stopping the scan. Your files are unchanged."
          : "Finishing the current safe step. Your recovery files are kept.";
    },
  };
}

const descriptions: Record<PendingImportOperation, string> = {
  scan: "Checking supported Obsidian Ink handwriting linked from your notes.",
  import: "Creating editable Inkbook copies and updating embeds.",
  undo: "Restoring your Obsidian Ink embeds.",
  cleanup: "Checking backups, originals and remaining references.",
};

function scanIllustration(container: HTMLElement) {
  const namespace = "http://www.w3.org/2000/svg";
  const graphic = createImportIllustration(container, "inkbook-import-scan");
  const paper = container.ownerDocument.createElementNS(namespace, "rect");
  for (const [name, value] of Object.entries({
    x: "22",
    y: "12",
    width: "52",
    height: "72",
    rx: "8",
  }))
    paper.setAttribute(name, value);
  paper.classList.add("inkbook-import-scan-paper");
  graphic.append(paper);
  const lines = [
    "M32 33 Q36 26 39 33 T47 33 T55 33 L64 31",
    "M32 47 Q37 40 41 47 T49 47 L62 45",
    "M32 61 Q37 54 42 61 T51 61 L57 59",
  ].map((data) => {
    const line = container.ownerDocument.createElementNS(namespace, "path");
    line.setAttribute("d", data);
    line.setAttribute("pathLength", "1");
    line.setAttribute("stroke-dasharray", "1");
    line.classList.add("inkbook-import-scan-ink");
    graphic.append(line);
    return line;
  });
  const beam = container.ownerDocument.createElementNS(namespace, "rect");
  for (const [name, value] of Object.entries({
    x: "16",
    y: "27",
    width: "64",
    height: "3",
    rx: "1.5",
  }))
    beam.setAttribute(name, value);
  beam.classList.add("inkbook-import-scan-beam");
  graphic.append(beam);
  return { lines, beam };
}
