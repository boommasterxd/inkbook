import type { Plugin } from "obsidian";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { FontResourceV2 } from "../../domain/schema/types";
import type { FontFaceRequest } from "../../persistence/fonts/font-resources";
import { matchFontFace } from "../../domain/text/font-face-matching";
import type { InkbookSettingsStore } from "../settings/storage";
import { sanitizeImportedFont, VaultFontLibrary, type LibraryFontFace } from "./vault-font-library";
import { fontLibraryChoices } from "./font-library-families";

export interface PluginFontLibrary {
  readonly library: VaultFontLibrary;
  match(request: FontFaceRequest): LibraryFontFace | undefined;
  resolve(
    request: FontFaceRequest,
    signal?: AbortSignal,
    scheduler?: WorkScheduler,
  ): Promise<FontResourceV2 | undefined>;
  choices(): readonly { label: string; value: string }[];
}

/** The plugin owns metadata writes; vault binaries never enter plugin settings. */
export function createPluginFontLibrary(
  plugin: Plugin,
  settings: InkbookSettingsStore,
  scheduler: () => WorkScheduler,
): PluginFontLibrary {
  let index = settings.getVaultSettings().fontLibrary;
  plugin.register(
    settings.subscribeVaultSettings((current) => {
      index = current.fontLibrary;
    }),
  );
  const library = new VaultFontLibrary({
    vault: plugin.app.vault,
    owner: plugin,
    scheduler,
    metadata: {
      read: () => index,
      write: (faces) =>
        settings.updateVaultSettings((current) => ({
          ...current,
          fontLibrary: faces.map((face) => structuredClone(face)),
        })),
    },
    sanitize: (bytes, descriptor) => {
      const ownerWindow = plugin.app.workspace.containerEl.ownerDocument.defaultView;
      if (ownerWindow === null) throw new Error("Font import requires an owning window.");
      return sanitizeImportedFont(
        bytes,
        descriptor,
        (family, buffer, descriptors) => new ownerWindow.FontFace(family, buffer, descriptors),
      );
    },
  });
  return {
    library,
    match: (request) => matchFontFace(library.list(), request),
    resolve: async (request, signal, schedulerOverride) => {
      signal?.throwIfAborted();
      const face = matchFontFace(library.list(), request);
      if (face === undefined) return undefined;
      const resource = await library.resource(face, signal, schedulerOverride);
      signal?.throwIfAborted();
      return resource;
    },
    choices: () => fontLibraryChoices(library.list()),
  };
}
