import { scanCanonicalRevisionPrefix } from "./revision-scan";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";

import { SaveError } from "./save-errors";

export interface PreparedOutput {
  readonly output: string;
  readonly outputHash: string;
  readonly revision: number;
  /** Actual UTF-8 bytes from the independently integrity-bound export adoption. */
  readonly totalBytes?: number;
}

/** Internal save input comes only from the owned canonical export adoption path. */
export function validatePreparedOutput(prepared: PreparedOutput): void {
  if (
    !/^[0-9a-f]{64}$/u.test(prepared.outputHash) ||
    prepared.output.length > FILE_SCHEMA_LIMITS.totalInputBytes ||
    (prepared.totalBytes !== undefined &&
      (!Number.isSafeInteger(prepared.totalBytes) ||
        prepared.totalBytes < prepared.output.length ||
        prepared.totalBytes > FILE_SCHEMA_LIMITS.totalInputBytes)) ||
    scanCanonicalRevisionPrefix(prepared.output) !== prepared.revision
  )
    throw new SaveError("read-back-mismatch");
}
