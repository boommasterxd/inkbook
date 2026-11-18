import type { Component, TFile, Vault } from "obsidian";
import { vi } from "vitest";
import {
  VaultFontLibrary,
  type LibraryFontFace,
} from "../../../src/obsidian/fonts/vault-font-library";
import { TestWorkScheduler } from "../persistence/work-scheduler";
import { readBundledFont as fontBytes } from "../persistence/font-assets";

export async function vaultFontLibraryFixture(name = "inter-400-normal.woff2") {
  const bytes = await fontBytes(name);
  let index: readonly LibraryFontFace[] = [];
  const data = new Map<string, ArrayBuffer>();
  const createBinary = vi.fn(async (path: string, content: ArrayBuffer) => {
    data.set(path, content.slice(0));
  });
  const getFileByPath = (path: string) =>
    data.has(path) ? ({ path, stat: { size: data.get(path)!.byteLength } } as TFile) : null;
  const readBinary = vi.fn(async (file: TFile) => data.get(file.path)!.slice(0));
  const vault = {
    getAbstractFileByPath: () => ({}),
    getFileByPath,
    createBinary,
    readBinary,
  } as unknown as Vault;
  let dispose: () => void = () => undefined;
  const owner = {
    register: (callback: () => void) => {
      dispose = callback;
    },
  } as unknown as Component;
  const sanitize = vi.fn(async () => undefined);
  const metadataWrite = vi.fn(async (faces: readonly LibraryFontFace[]) => {
    index = faces;
  });
  const library = new VaultFontLibrary({
    vault,
    owner,
    scheduler: new TestWorkScheduler(),
    metadata: {
      read: () => index,
      write: metadataWrite,
    },
    sanitize,
  });
  return {
    library,
    bytes,
    createBinary,
    readBinary,
    sanitize,
    data,
    metadataWrite,
    setIndex: (faces: readonly LibraryFontFace[]) => {
      index = faces;
    },
    dispose: () => dispose(),
  };
}
