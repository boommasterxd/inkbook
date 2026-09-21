import { inspectTrustedSvgOutput } from "../scheduling/trusted-svg-output";

import { SaveError } from "./save-errors";

export interface PreparedOutput {
  readonly output: string;
  readonly outputHash: string;
  readonly revision: number;
}

export async function validatePreparedOutput(
  prepared: PreparedOutput,
  waitForBackground?: () => Promise<void>,
  sliceBudgetMs?: () => number,
): Promise<void> {
  try {
    const trusted = await inspectTrustedSvgOutput(prepared.output, prepared.outputHash, {
      ...(sliceBudgetMs ? { sliceBudgetMs } : {}),
      ...(waitForBackground ? { waitForBackground } : {}),
    });
    if (trusted.revision !== prepared.revision) throw new SaveError("read-back-mismatch");
  } catch (error) {
    if (error instanceof SaveError) throw error;
    throw new SaveError("read-back-mismatch");
  }
}
