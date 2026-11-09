import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { findMarkdownInkbookEmbeds, MARKDOWN_EMBED_LIMITS } from "../markdown-embed";
import {
  correlateNativeExportCandidates,
  nativeExportImage,
  type StaticExportCandidate,
} from "./native-export-candidates";
import type { EmbedIntegrationPorts } from "../presentation/presentation-port";

/** Only semantic HTML inside the supplied renderer root is inspected. */
export async function collectExportBlocks(
  root: HTMLElement,
  scheduler: WorkScheduler,
  signal: AbortSignal,
): Promise<HTMLElement[]> {
  const blocks: HTMLElement[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, 1, {
    acceptNode: (node) => {
      const element = node as Element;
      if (
        ["code", "pre", "svg"].includes(element.localName) ||
        element.hasAttribute("data-inkbook-export")
      )
        return 2;
      return 1;
    },
  });
  let current: Node | null = root;
  while (current !== null) {
    const pending = scheduler.checkpoint(signal, "background");
    if (pending !== undefined) await pending;
    signal.throwIfAborted();
    const element = current as HTMLElement;
    if (nativeExportImage(element) !== undefined) {
      blocks.push(element);
      if (blocks.length > MARKDOWN_EMBED_LIMITS.matches) return [];
    }
    current = walker.nextNode();
  }
  return blocks;
}

async function normalizeNativeDescriptions(
  candidates: Map<HTMLElement, StaticExportCandidate>,
  labels: Map<string, string>,
  normalizeLabel?: (label: string) => Promise<string>,
): Promise<void> {
  if (normalizeLabel === undefined) return;
  for (const [host, candidate] of candidates) {
    if (candidate.description === undefined) continue;
    const description = candidate.description;
    let normalized = labels.get(description);
    if (normalized === undefined) {
      normalized = await normalizeLabel(description);
      labels.set(description, normalized);
    }
    candidates.set(host, { ...candidate, description: normalized });
  }
}

/** Correlation fails closed when escaped literals are indistinguishable from real embeds. */
export async function correlateExportCandidates(
  blocks: readonly HTMLElement[],
  source: string,
  sourcePath: string,
  resolve: EmbedIntegrationPorts["resolveDocument"],
  normalizeLabel?: (label: string) => Promise<string>,
): Promise<StaticExportCandidate[]> {
  const candidates = correlateNativeExportCandidates({
    blocks,
    references: findMarkdownInkbookEmbeds(source),
    sourcePath,
    resolve,
  });
  await normalizeNativeDescriptions(candidates, new Map(), normalizeLabel);
  // Earlier print fragments can move later blocks; planning must follow the rendered order.
  return blocks.flatMap((host) => {
    const candidate = candidates.get(host);
    return candidate === undefined ? [] : [candidate];
  });
}
