import type { MarkdownInkbookEmbed } from "../markdown-embed";
import type {
  EmbedIntegrationPorts,
  ResolvedInkbookDocument,
} from "../presentation/presentation-port";

export interface StaticExportCandidate {
  readonly host: HTMLElement;
  readonly resolved: ResolvedInkbookDocument;
  readonly description?: string;
  readonly width?: number;
}

/** Accept only a complete semantic image block, without depending on host CSS classes. */
export function nativeExportImage(host: HTMLElement): HTMLImageElement | undefined {
  if (host.localName !== "p" || host.closest("code, pre") !== null) return;
  let current: Element = host;
  while (current.localName === "p" || current.localName === "span") {
    if (current.children.length !== 1) return;
    if ([...current.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim()))
      return;
    const child = current.firstElementChild;
    if (child === null) return;
    current = child;
  }
  return current.localName === "img" ? (current as HTMLImageElement) : undefined;
}

interface NativeExportCorrelation {
  readonly blocks: readonly HTMLElement[];
  readonly references: readonly MarkdownInkbookEmbed[];
  readonly sourcePath: string;
  readonly resolve: EmbedIntegrationPorts["resolveDocument"];
}

function imageSignature(documentId: string, label: string, width?: number): string {
  return JSON.stringify([documentId, label, width ?? null]);
}

function imageWidth(image: HTMLImageElement): number | undefined | false {
  if (image.hasAttribute("height")) return false;
  const value = image.getAttribute("width");
  if (value === null) return undefined;
  const width = Number(value);
  return /^\d+$/u.test(value) && Number.isSafeInteger(width) && width > 0 ? width : false;
}

function sourceImageText(embed: MarkdownInkbookEmbed): string {
  if (embed.description !== undefined) return embed.description;
  return embed.markdown.startsWith("![[") || embed.width !== undefined ? embed.linkpath : "";
}

function sourceImageLabel(label: string, wiki: boolean): string {
  if (wiki) return label;
  const escaped = label.replace(/\\([!-/:-@[-`{-~])/gu, "$1");
  if (!escaped.includes("&")) return escaped;
  // Native image alt text decodes HTML references after Markdown punctuation,
  // without interpreting author markup or loading resources.
  return (
    new DOMParser().parseFromString(escaped.replaceAll("<", "&lt;"), "text/html").body
      .textContent ?? ""
  ).trim();
}

function nativeSourceReferences(options: NativeExportCorrelation) {
  const resources = new Map<string, ResolvedInkbookDocument | false>();
  const expected = new Map<string, Array<Omit<StaticExportCandidate, "host">>>();
  const labels = new Map<string, string>();
  for (const embed of options.references) {
    const resolved = options.resolve(embed.linkpath, options.sourcePath);
    if (resolved === undefined) continue;
    const url = resolved.resourceUrl;
    const existing = resources.get(url);
    resources.set(
      url,
      existing === undefined || (existing !== false && existing.documentId === resolved.documentId)
        ? resolved
        : false,
    );
    const wiki = embed.markdown.startsWith("![[");
    const sourceLabel = sourceImageText(embed);
    const labelKey = JSON.stringify([wiki, sourceLabel]);
    let label = labels.get(labelKey);
    if (label === undefined) {
      label = sourceImageLabel(sourceLabel, wiki);
      labels.set(labelKey, label);
    }
    const key = imageSignature(resolved.documentId, label, embed.width);
    const entries = expected.get(key) ?? [];
    entries.push({
      resolved,
      ...(embed.description === undefined ? {} : { description: embed.description }),
      ...(embed.width === undefined ? {} : { width: embed.width }),
    });
    expected.set(key, entries);
  }
  return { resources, expected };
}

/** Source and rendered multiplicities must agree before any native image can be replaced. */
export function correlateNativeExportCandidates(
  options: NativeExportCorrelation,
): Map<HTMLElement, StaticExportCandidate> {
  const { resources, expected } = nativeSourceReferences(options);
  const rendered = new Map<string, HTMLElement[]>();
  for (const host of options.blocks) {
    const image = nativeExportImage(host);
    if (image === undefined) continue;
    const resolved = resources.get(image.getAttribute("src") ?? "");
    if (resolved === undefined || resolved === false) continue;
    const width = imageWidth(image);
    if (width === false) continue;
    const label = image.getAttribute("alt")?.trim() ?? "";
    const key = imageSignature(resolved.documentId, label, width);
    const entries = rendered.get(key) ?? [];
    entries.push(host);
    rendered.set(key, entries);
  }
  const candidates = new Map<HTMLElement, StaticExportCandidate>();
  for (const [key, hosts] of rendered) {
    const references = expected.get(key);
    if (references === undefined || references.length !== hosts.length) continue;
    hosts.forEach((host, index) => {
      const reference = references[index];
      if (reference !== undefined) candidates.set(host, { host, ...reference });
    });
  }
  return candidates;
}
