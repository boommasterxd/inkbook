import { vi } from "vitest";

import { ChunkedSha256 } from "../../../src/persistence/serialization/chunked-output-sha256";
import type { FallbackSliceProbe } from "./fallback-slice-probe";

/** Counts each decoding/encoding/hash pass, including repeated processing of the same bytes. */
export function observeFallbackBytes(probe: FallbackSliceProbe): () => void {
  // Each original method is invoked below with the intercepted receiver via .call().
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored receiver is supplied with .call().
  const encode = TextEncoder.prototype.encode;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored receiver is supplied with .call().
  const encodeInto = TextEncoder.prototype.encodeInto;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored receiver is supplied with .call().
  const update = ChunkedSha256.prototype.update;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored receiver is supplied with .call().
  const decode = TextDecoder.prototype.decode;
  const decodeSpy = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
    this: TextDecoder,
    input,
    options,
  ) {
    probe.recordBytes(input?.byteLength ?? 0);
    return decode.call(this, input, options);
  });
  const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (
    this: TextEncoder,
    input,
  ) {
    const output = encode.call(this, input);
    probe.recordBytes(output.byteLength);
    return output;
  });
  const intoSpy = vi.spyOn(TextEncoder.prototype, "encodeInto").mockImplementation(function (
    this: TextEncoder,
    input,
    output,
  ) {
    const result = encodeInto.call(this, input, output);
    probe.recordBytes(result.written);
    return result;
  });
  const hashSpy = vi.spyOn(ChunkedSha256.prototype, "update").mockImplementation(function (
    this: ChunkedSha256,
    input,
  ) {
    probe.recordBytes(input.byteLength);
    update.call(this, input);
  });
  return () => {
    decodeSpy.mockRestore();
    encodeSpy.mockRestore();
    intoSpy.mockRestore();
    hashSpy.mockRestore();
  };
}
