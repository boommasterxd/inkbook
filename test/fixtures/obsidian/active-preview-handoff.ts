import { expect } from "vitest";

import type { WorkScheduler } from "../../../src/domain/scheduling/work-scheduler";
import { ActiveScenePreviewHandoff } from "../../../src/obsidian/embeds/active-scene-handoff";
import type { PresentationAttachment } from "../../../src/obsidian/embeds/presentation-port";

/** Prepare the locked surface, then complete the active scene's reduced-motion handoff. */
export async function createDetachedPreviewHandoff(
  attachment: PresentationAttachment,
  workScheduler: WorkScheduler,
) {
  const preview = attachment.preview;
  if (preview === undefined) throw new Error("The attachment has no locked preview.");
  await attachment.ensurePreviewReady?.();
  const handoff = new ActiveScenePreviewHandoff({
    ...attachment,
    container: attachment.root,
    motion: "reduced",
    preview,
    workScheduler,
  });
  handoff.ready();
  expect(preview.hidden).toBe(true);
  expect(preview.isConnected).toBe(false);
  return { handoff, preview };
}
