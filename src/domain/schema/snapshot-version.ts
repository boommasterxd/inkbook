import type { InkElementV1, InkSnapshotV1 } from "./types";

/** Choose the oldest format that retains every element's editing semantics. */
export function elementSnapshotVersion(
  elements: Iterable<Readonly<Pick<InkElementV1, "kind" | "locked">>>,
): InkSnapshotV1["version"] {
  let version: InkSnapshotV1["version"] = 1;
  for (const element of elements) {
    if (element.locked === true) return 4;
    if (element.kind === "image") version = 3;
    else if (element.kind === "text" && version < 2) version = 2;
  }
  return version;
}
