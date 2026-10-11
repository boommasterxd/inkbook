import type { InkElementV1 } from "../../domain/schema/public";
import { codecFailure, generatedOutputLimitFailure } from "./codec-failure";
import type { ElementFragments, RenderBand } from "./element-fragments";
import type { EncodedByteBudget } from "./encoded-byte-budget";
import type { ElementAssembly, FragmentAssembly } from "./incremental-document-serializer-types";
import type { DocumentCodecResult } from "./types";

/** Collects ordered export fragments while charging complete document byte limits. */
function collectOrderedElementFragments(options: {
  readonly orders: Readonly<Record<RenderBand, readonly string[]>>;
  readonly element: (id: string) => InkElementV1;
  readonly fragment: (element: InkElementV1) => ElementFragments;
  readonly outputBudget: EncodedByteBudget;
  readonly metadataBudget: EncodedByteBudget;
}): DocumentCodecResult<FragmentAssembly> {
  const elements: InkElementV1[] = [];
  const metadata: string[] = [];
  const canonicalMetadata: string[] = [];
  const fragments: Record<RenderBand, ElementFragments[]> = { content: [], highlight: [] };
  let maximumBottom: number | null = null;
  for (const band of ["highlight", "content"] as const) {
    for (const id of options.orders[band]) {
      const element = options.element(id);
      const fragment = options.fragment(element);
      const separatorBytes = metadata.length === 0 ? 0 : 1;
      if (
        !options.metadataBudget.tryReserve(fragment.metadataBytes + separatorBytes) ||
        !options.outputBudget.tryReserve(fragment.bytes + separatorBytes)
      ) {
        return codecFailure(
          "static-output-limit-exceeded",
          "Generated document exceeds file limits.",
        );
      }
      elements.push(element);
      metadata.push(fragment.metadata);
      canonicalMetadata.push(fragment.canonicalMetadata);
      fragments[band].push(fragment);
      maximumBottom = Math.max(maximumBottom ?? 0, fragment.bottom);
    }
  }
  return {
    ok: true,
    value: {
      content: fragments.content,
      elements,
      highlight: fragments.highlight,
      maximumBottom,
      metadata,
      canonicalMetadata,
    },
  };
}

export function assembleOrderedElementFragments(
  options: Parameters<typeof collectOrderedElementFragments>[0],
): DocumentCodecResult<ElementAssembly> {
  const fragments = collectOrderedElementFragments(options);
  if (!fragments.ok) return fragments;
  if (!options.metadataBudget.tryReserve(2)) return generatedOutputLimitFailure();
  return {
    ok: true,
    value: {
      content: fragments.value.content.map(({ svg }) => svg).join(""),
      elements: fragments.value.elements,
      highlights: fragments.value.highlight.map(({ svg }) => svg).join(""),
      maximumBottom: fragments.value.maximumBottom,
      metadata: fragments.value.metadata,
      canonicalMetadata: fragments.value.canonicalMetadata,
    },
  };
}
