import type { InkSnapshotV1 } from "../../../domain/schema/public";
import type { SafeSvgPrelude } from "../../documents/safe-svg-validator";
import {
  bindSnapshotFontResourcesSteps,
  textFontBindingMode,
} from "../../fonts/bound-font-resources";
import { consumeSerializationSteps } from "../output/serialization-model-preparation";
import { matchesFontStylesheetSteps, snapshotTextResources } from "../output/text-fonts";
import { codecFailure } from "../codec-failure";
import type { DocumentCodecResult } from "../types";

interface BoundSnapshot {
  readonly snapshot: InkSnapshotV1;
  readonly requiresCanonicalRewrite: boolean;
}

/** Keep legacy presentation comparison separate from the bound model published after validation. */
export async function prepareValidatedTextFontBindings(
  snapshot: InkSnapshotV1,
  prelude: SafeSvgPrelude,
  checkpoint: () => Promise<void> | undefined,
): Promise<DocumentCodecResult<BoundSnapshot>> {
  try {
    const mode = textFontBindingMode(snapshot);
    if (mode === "mixed")
      return codecFailure("snapshot-invalid", "Text font bindings must be complete.");
    const fonts =
      mode === "legacy"
        ? (snapshot.fontResources ?? [])
        : (snapshotTextResources(snapshot).fontResources ?? []);
    const supplied = prelude.fontStylesheet ?? "";
    const matches = await consumeSerializationSteps(
      matchesFontStylesheetSteps(supplied, fonts, mode === "legacy"),
      { checkpoint },
    );
    let requiresCanonicalRewrite = mode === "legacy";
    if (!matches) {
      if (
        mode !== "none" ||
        !(await consumeSerializationSteps(matchesFontStylesheetSteps(supplied, fonts, true), {
          checkpoint,
        }))
      )
        return codecFailure(
          "static-path-mismatch",
          "Embedded font styles do not match the snapshot.",
        );
      requiresCanonicalRewrite = true;
    }
    const bound = await consumeSerializationSteps(bindSnapshotFontResourcesSteps(snapshot), {
      checkpoint,
    });
    return {
      ok: true,
      value: {
        snapshot: bound,
        requiresCanonicalRewrite: requiresCanonicalRewrite || bound !== snapshot,
      },
    };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return codecFailure("snapshot-invalid", "A required text font resource is unavailable.");
  }
}
