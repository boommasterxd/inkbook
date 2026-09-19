import { vi } from "vitest";

import type { InkSnapshotV1 } from "../../../src/domain/schema/public";
import * as canonical from "../../../src/persistence/serialization/canonical-snapshot";
import { ChunkedSha256 } from "../../../src/persistence/serialization/chunked-output-sha256";

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/u;

export interface IntegrityWork {
  canonicalElements: number;
  elementReads: number;
  encodedBytes: number;
  hashedBytes: number;
}

/** Observe real canonicalization, UTF-8 encoding, and hash input, including repeated passes. */
export function observeIntegrityWork(snapshot: InkSnapshotV1) {
  let work: IntegrityWork = emptyWork();
  const canonicalElement = canonical.canonicalElement;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The original receiver is restored with .call().
  const encode = TextEncoder.prototype.encode;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The original receiver is restored with .call().
  const update = ChunkedSha256.prototype.update;
  const canonicalSpy = vi.spyOn(canonical, "canonicalElement").mockImplementation((...args) => {
    work.canonicalElements += 1;
    return canonicalElement(...args);
  });
  const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (
    this: TextEncoder,
    input,
  ) {
    const bytes = encode.call(this, input);
    work.encodedBytes += bytes.byteLength;
    return bytes;
  });
  const hashSpy = vi.spyOn(ChunkedSha256.prototype, "update").mockImplementation(function (
    this: ChunkedSha256,
    input,
  ) {
    work.hashedBytes += input.byteLength;
    update.call(this, input);
  });
  return {
    snapshot: {
      ...snapshot,
      elements: new Proxy(snapshot.elements, {
        get(target, property, receiver) {
          if (typeof property === "string" && ARRAY_INDEX.test(property)) {
            work.elementReads += 1;
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    },
    take(): IntegrityWork {
      const result = work;
      work = emptyWork();
      return result;
    },
    restore(): void {
      canonicalSpy.mockRestore();
      encodeSpy.mockRestore();
      hashSpy.mockRestore();
    },
  };
}

function emptyWork(): IntegrityWork {
  return { canonicalElements: 0, elementReads: 0, encodedBytes: 0, hashedBytes: 0 };
}
