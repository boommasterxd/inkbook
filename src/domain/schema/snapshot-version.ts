import type { InkElementV1, InkSnapshotV1 } from "./types";

interface VersionedElement extends Readonly<Pick<InkElementV1, "kind" | "locked">> {
  readonly layout?: {
    readonly lines: readonly { readonly runs: readonly { readonly inkBounds?: unknown }[] }[];
  };
}

export function hasMeasuredTextInkBounds(element: VersionedElement): boolean {
  return (
    element.kind === "text" &&
    element.layout?.lines.some((line) => line.runs.some((run) => run.inkBounds !== undefined)) ===
      true
  );
}

/** Choose the oldest format that retains every element's editing semantics. */
export function elementSnapshotVersion(
  elements: Iterable<VersionedElement>,
): InkSnapshotV1["version"] {
  let version: InkSnapshotV1["version"] = 1;
  for (const element of elements) {
    if (element.kind === "image" || hasMeasuredTextInkBounds(element)) return 5;
    if (element.locked === true) version = 4;
    else if (element.kind === "text" && version < 2) version = 2;
  }
  return version;
}
