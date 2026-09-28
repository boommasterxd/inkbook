import { rectangle } from "../../unit/persistence/clipboard/fixtures";

/** Large candidate exceeds element limits intentionally; discovery must not parse its body. */
export function createLargeClipboardCandidate(): string {
  const { id: _id, createdAt: _createdAt, ...element } = rectangle();
  return JSON.stringify({
    format: "inkbook-elements",
    version: 1,
    elements: Array.from({ length: 10_000 }, (_, index) => ({ clipId: `clip-${index}`, element })),
  });
}
