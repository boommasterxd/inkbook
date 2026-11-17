import { createEmbeddedModuleWindow } from "./embedded-module-window";
import { PortableMathModuleLoader } from "../../../src/obsidian/text/portable-math-loader";

/** Importer adapter runs the canonical local engine after the real decoder/URL boundary. */
export function createPortableMathLoader(): PortableMathModuleLoader {
  return new PortableMathModuleLoader(
    async () => import("../../../src/obsidian/text/portable-math-entry"),
    createEmbeddedModuleWindow("math-import-realm").window,
  );
}
