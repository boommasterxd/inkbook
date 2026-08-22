import { Notice } from "obsidian";

import type { ActiveInkbookScene } from "./active-scene";

interface SceneMount {
  disposeScheme: (() => void) | undefined;
  scene: ActiveInkbookScene | undefined;
}

export function observeActiveSceneReadiness(options: {
  readonly isCurrent: () => boolean;
  readonly mounted: SceneMount;
  readonly onFailure: () => void;
  readonly onReady: () => void;
  readonly scene: ActiveInkbookScene;
}): void {
  void options.scene.ready
    .then((ready) => {
      if (ready && options.isCurrent()) options.onReady();
    })
    .catch(() => {
      if (!options.isCurrent()) return;
      options.mounted.disposeScheme?.();
      options.mounted.disposeScheme = undefined;
      options.scene.dispose();
      options.mounted.scene = undefined;
      options.onFailure();
      new Notice(
        "Inkbook could not load the editor interface. The static preview remains available; check content security settings or update Obsidian, then select the embed to retry.",
      );
    });
}
