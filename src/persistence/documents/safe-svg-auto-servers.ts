import { hasExactAttributes, parseOpeningTag, skipWhitespace } from "./svg-tag";
import { parseSafeAutoServer } from "./safe-svg-auto-patterns";
import type { SafeAutoPaintServer } from "./safe-svg-auto-paint";
import type { SafeAutoVisitor } from "./safe-svg-auto-definitions";

/** A document registry contains bounded, content-addressed base servers, never aliases. */
export function* parseSafeAutoPaintDefinitionsSteps(
  input: string,
  start: number,
  options: {
    readonly exhausted?: (() => boolean) | undefined;
    readonly visitor?: SafeAutoVisitor | undefined;
  } = {},
): Generator<void, { next: number; servers: ReadonlyMap<string, SafeAutoPaintServer> } | null> {
  const defs = parseOpeningTag(input, start);
  if (
    defs?.name !== "defs" ||
    defs.selfClosing ||
    !hasExactAttributes(defs.attributes, { id: "inkbook-auto-paints" })
  )
    return null;
  options.visitor?.open(defs);
  let cursor = skipWhitespace(input, defs.next);
  const servers = new Map<string, SafeAutoPaintServer>();
  while (!input.startsWith("</defs>", cursor)) {
    if (servers.size >= 60_004) return null;
    const parsed = parseSafeAutoServer(input, cursor, options.visitor);
    if (parsed === null || servers.has(parsed.server.id)) return null;
    servers.set(parsed.server.id, parsed.server);
    cursor = skipWhitespace(input, parsed.next);
    if (options.exhausted?.() ?? true) yield;
  }
  options.visitor?.close();
  return { servers, next: cursor + 7 };
}
