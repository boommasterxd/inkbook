import type { InkSnapshotV1 } from "../../../domain/schema/public";
import type { SafeSvgPrelude } from "../../documents/safe-svg-validator";
import type { SafeStaticProof } from "./safe-static-proof";
import { StreamingSafeStaticValidator } from "./streaming-safe-static";
import { StreamingStaticIntegrityMatcher } from "./streaming-static-integrity";
import type { DocumentCodecResult } from "../types";
import { inputFailure } from "./chunked-input-utils";
import { consumeSerializationSteps } from "../output/serialization-model-preparation";

export type InputStaticMatcher = StreamingSafeStaticValidator | StreamingStaticIntegrityMatcher;

/** Select the static check only after envelope identity and metadata binding have succeeded. */
export function createInputStaticMatcher(options: {
  readonly checkpoint: () => Promise<void> | undefined;
  readonly prelude: SafeSvgPrelude;
  readonly proof: SafeStaticProof | undefined;
  readonly snapshot: InkSnapshotV1;
  readonly validation: "canonical" | "safe";
}): InputStaticMatcher | null {
  if (options.proof !== undefined) return null;
  const { prelude } = options;
  return options.validation === "safe"
    ? new StreamingSafeStaticValidator(
        options.checkpoint,
        prelude.version,
        prelude.imageResources ?? [],
        prelude.autoPaintServers,
      )
    : new StreamingStaticIntegrityMatcher(
        options.snapshot,
        prelude.lockedHeight,
        prelude.autoPaintDefinitions,
      );
}

export async function finishInputStaticMatcher(
  matcher: InputStaticMatcher | null,
  proof: SafeStaticProof | undefined,
  checkpoint: () => Promise<void> | undefined,
): Promise<DocumentCodecResult<undefined>> {
  if (proof !== undefined) return { ok: true, value: undefined };
  if (matcher === null || !matcher.finish())
    return inputFailure("invalid-svg", "Document does not satisfy the safe SVG envelope.");
  if (
    matcher instanceof StreamingStaticIntegrityMatcher &&
    !(await consumeSerializationSteps(matcher.validateRegistrySteps(), { checkpoint }))
  )
    return inputFailure(
      "static-path-mismatch",
      "Shared contrast paints do not match the snapshot.",
    );
  return { ok: true, value: undefined };
}
