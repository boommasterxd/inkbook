import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { findMarkdownInkbookEmbeds, MARKDOWN_EMBED_LIMITS } from "../markdown-embed";
import type {
  EmbedIntegrationPorts,
  ResolvedInkbookDocument,
} from "../presentation/presentation-port";

export interface StaticExportCandidate {
  readonly host: HTMLElement;
  readonly resolved: ResolvedInkbookDocument;
  readonly description?: string;
}

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
    if (element.localName === "p" && element.textContent?.trimStart().startsWith("!inkbook")) {
      blocks.push(element);
      if (blocks.length > MARKDOWN_EMBED_LIMITS.matches) return [];
    }
    current = walker.nextNode();
  }
  return blocks;
}

function blockTarget(
  host: HTMLElement,
  sourcePath: string,
  resolve: EmbedIntegrationPorts["resolveDocument"],
  expectedIds: ReadonlySet<string>,
): { readonly resolved: ResolvedInkbookDocument; readonly label: string } | undefined {
  if (host.closest("code, pre") !== null || host.children.length !== 1) return;
  const link = host.children.item(0);
  if (link?.localName !== "a") return;
  const before = link.previousSibling;
  if (before?.nodeType !== 3 || before.textContent?.trim() !== "!inkbook") return;
  if (before.previousSibling !== null || link.nextSibling !== null) return;
  const href = link.getAttribute("href");
  if (href === null) return;
  const resolved = resolveExportTarget(href, sourcePath, resolve, expectedIds);
  return resolved === undefined ? undefined : { resolved, label: link.textContent?.trim() ?? "" };
}

function resolveExportTarget(
  href: string,
  sourcePath: string,
  resolve: EmbedIntegrationPorts["resolveDocument"],
  expectedIds: ReadonlySet<string>,
): ResolvedInkbookDocument | undefined {
  // Both Obsidian Wiki links and Markdown links expose a normal href here.
  const encoded = `!inkbook[link](<${href}>)`;
  const reference = findMarkdownInkbookEmbeds(encoded)[0];
  const targets = new Map<string, ResolvedInkbookDocument>();
  // Wiki paths preserve percent signs; Markdown destinations decode them once.
  for (const path of new Set([href.split("#", 1)[0] ?? "", reference?.linkpath ?? ""])) {
    const resolved = path ? resolve(path, sourcePath) : undefined;
    if (resolved !== undefined && expectedIds.has(resolved.documentId))
      targets.set(resolved.documentId, resolved);
  }
  return targets.size === 1 ? targets.values().next().value : undefined;
}

function referenceLabel(markdown: string): string {
  if (markdown.startsWith("!inkbook[[")) {
    const target = markdown.slice(10, -2);
    const alias = target.indexOf("|");
    return (alias < 0 ? target : target.slice(alias + 1)).trim();
  }
  return markdown.slice(9, markdown.indexOf("](")).trim();
}

function signature(documentId: string, label: string): string {
  return JSON.stringify([documentId, label]);
}

/** Correlation fails closed when escaped literals are indistinguishable from real embeds. */
export async function correlateExportCandidates(
  blocks: readonly HTMLElement[],
  source: string,
  sourcePath: string,
  resolve: EmbedIntegrationPorts["resolveDocument"],
  normalizeLabel?: (label: string) => Promise<string>,
): Promise<StaticExportCandidate[]> {
  const sourceReferences = findMarkdownInkbookEmbeds(source).map((embed) => ({
    embed,
    resolved: resolve(embed.linkpath, sourcePath),
  }));
  const expectedIds = new Set(
    sourceReferences.flatMap(({ resolved }) =>
      resolved === undefined ? [] : [resolved.documentId],
    ),
  );
  const rendered = new Map<string, StaticExportCandidate[]>();
  for (const host of blocks) {
    const target = blockTarget(host, sourcePath, resolve, expectedIds);
    if (target === undefined) continue;
    const key = signature(target.resolved.documentId, target.label);
    const entries = rendered.get(key) ?? [];
    entries.push({ host, resolved: target.resolved });
    rendered.set(key, entries);
  }
  const references = new Map<string, Array<{ readonly description?: string }>>();
  const normalizedLabels = new Map<string, string>();
  for (const { embed, resolved } of sourceReferences) {
    if (resolved === undefined) continue;
    let label = referenceLabel(embed.markdown);
    if (!embed.markdown.startsWith("!inkbook[[") && normalizeLabel !== undefined) {
      let normalized = normalizedLabels.get(label);
      if (normalized === undefined) {
        normalized = await normalizeLabel(label);
        normalizedLabels.set(label, normalized);
      }
      label = normalized;
    }
    const key = signature(resolved.documentId, label);
    const entries = references.get(key) ?? [];
    entries.push(embed.description === undefined ? {} : { description: label });
    references.set(key, entries);
  }
  const candidates = new Map<HTMLElement, StaticExportCandidate>();
  for (const [id, entries] of rendered) {
    const expected = references.get(id);
    if (expected === undefined || entries.length !== expected.length) continue;
    entries.forEach((entry, index) => {
      const description = expected[index]?.description;
      candidates.set(entry.host, {
        ...entry,
        ...(description === undefined ? {} : { description }),
      });
    });
  }
  // Earlier print fragments can move later blocks; planning must follow the rendered order.
  return blocks.flatMap((host) => {
    const candidate = candidates.get(host);
    return candidate === undefined ? [] : [candidate];
  });
}
