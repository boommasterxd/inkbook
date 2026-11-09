import type { InkImportPorts } from "./types";
import { countMarkdownFileReferences } from "../embeds/markdown-file-references";

const MAX_REFERENCE_BYTES = 64 * 1024 * 1024;
const MAX_REFERENCE_FILE_BYTES = 8 * 1024 * 1024;

function decodedReferenceText(text: string): string {
  return text
    .replace(/(?:%[\da-f]{2})+/giu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    })
    .replace(
      /&#(?:(\d+)|x([\da-f]+));/giu,
      (entity, decimal: string | undefined, hex: string | undefined) => {
        const code = Number.parseInt(decimal ?? hex ?? "", decimal === undefined ? 16 : 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      },
    )
    .replace(/\\([ !"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/gu, "$1")
    .toLowerCase();
}

/** Conservative fresh scan: even a plain-text mention protects an original. */
export async function inkImportReferenceState(
  ports: Pick<InkImportPorts, "listFiles" | "read" | "workScheduler" | "resolveLink">,
  path: string,
  signal?: AbortSignal,
): Promise<"referenced" | "unreferenced" | "unknown"> {
  const basename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  let bytes = 0;
  for (const file of ports.listFiles()) {
    signal?.throwIfAborted();
    if (file.path.startsWith("inkbook-imports/") || !/\.(?:md|canvas|base)$/iu.test(file.path))
      continue;
    bytes += file.size;
    if (file.size > MAX_REFERENCE_FILE_BYTES || bytes > MAX_REFERENCE_BYTES) return "unknown";
    let text: string;
    try {
      text = await ports.read(file.path);
    } catch {
      return "unknown";
    }
    bytes += Math.max(0, text.length * 4 - file.size);
    if (text.length > MAX_REFERENCE_FILE_BYTES || bytes > MAX_REFERENCE_BYTES) return "unknown";
    if (decodedReferenceText(text).includes(basename)) return "referenced";
    try {
      const count = countMarkdownFileReferences(text, {
        sourcePath: file.path,
        targetPath: path,
        resolveLinkTarget: (link, sourcePath) => {
          const resolved = ports.resolveLink(link, sourcePath);
          return resolved === undefined ? null : { path: resolved };
        },
      });
      if (count.references > 0) return "referenced";
      if (!count.complete) return "unknown";
    } catch {
      return "unknown";
    }
    // Escaped JSON/YAML or HTML references cannot be disproved by a lexical scan.
    if (/\\u[\da-f]{4}|&[a-z]+;/iu.test(text)) return "unknown";
    const pending = ports.workScheduler.checkpoint(signal);
    if (pending !== undefined) await pending;
  }
  return "unreferenced";
}
