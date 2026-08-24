import type { ExecutableSyntaxIterator } from "../../../src/obsidian/embeds";

export function executableSyntaxIn(text: string): ExecutableSyntaxIterator {
  const pattern = /!inkbook\[\[[^\]\n]+\]\]|!inkbook\[[^\]\n]*\]\([^)\n]+\)/gu;
  return (range, visit) => {
    for (const match of text.matchAll(pattern)) {
      const from = match.index;
      const to = from + match[0].length;
      if (from >= range.from && to <= range.to) visit({ from, to });
    }
    return true;
  };
}
