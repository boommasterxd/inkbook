import type { InkSnapshotV1 } from "../../../domain/schema/public";
import { snapshotTextLayoutRuns } from "../../fonts/bound-font-resources";
import type { SafeStaticProof } from "./safe-static-proof";
import { StreamingStaticIntegrityMatcher } from "./streaming-static-integrity";
import { StreamingSafeStaticValidator } from "./streaming-safe-static";
import { consumeSerializationSteps } from "../output/serialization-model-preparation";

/** Stored zero advances deliberately omit SVG adjustment; only missing positive advances migrate. */
export async function requiresTextLengthRewrite(
  snapshot: InkSnapshotV1,
  matcher: StreamingStaticIntegrityMatcher | StreamingSafeStaticValidator | null,
  proof: SafeStaticProof | undefined,
  checkpoint: () => Promise<void> | undefined,
): Promise<boolean> {
  if (snapshot.version === 1) return false;
  if (matcher instanceof StreamingStaticIntegrityMatcher) return matcher.requiresCanonicalRewrite;
  const count =
    proof?.unadjustedTextRuns ??
    (matcher instanceof StreamingSafeStaticValidator ? matcher.unadjustedTextRuns : undefined);
  if (count === 0) return false;
  return consumeSerializationSteps(expectedZeroAdvanceSteps(snapshot, count), { checkpoint });
}

function* expectedZeroAdvanceSteps(
  snapshot: InkSnapshotV1,
  unadjusted: number | undefined,
): Generator<void, boolean> {
  let zeroAdvances = 0;
  let positiveAdvance = false;
  for (const run of snapshotTextLayoutRuns(snapshot)) {
    if (run.text.length > 0) {
      if (run.width === 0) zeroAdvances++;
      else positiveAdvance = true;
    }
    yield;
  }
  return unadjusted === undefined ? positiveAdvance : unadjusted > zeroAdvances;
}
