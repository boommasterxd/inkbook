import { Platform } from "obsidian";

/** Loads the real bundled font bytes through the desktop-only test boundary. */
export async function readBundledFont(name: string): Promise<Uint8Array<ArrayBuffer>> {
  if (Platform.isDesktop) {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(
      await readFile(new URL(`../../../src/persistence/fonts/assets/${name}`, import.meta.url)),
    );
  }
  throw new Error("Font fixtures require the desktop test runtime.");
}
