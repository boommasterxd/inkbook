import { TFile } from "obsidian";

import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { createSnapshot } from "../../unit/persistence/serialization/fixtures";

export function createConfirmedOutputFixture() {
  const serialized = serializeInkbookDocument(createSnapshot());
  if (!serialized.ok) throw new Error("Invalid test snapshot");
  const File = TFile as unknown as new (path: string, size: number) => TFile;
  const file = new File("confirmed.svg", serialized.value.svg.length);
  const signature = `${String(file.stat.ctime)}:${String(file.stat.mtime)}:${String(file.stat.size)}`;
  return { file, serialized, signature };
}
