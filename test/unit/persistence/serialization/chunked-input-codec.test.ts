import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { describe, expect, it } from "vitest";

import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/public";
import { jsonContainerBudget } from "../../../../src/domain/schema/validation-internals";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/chunked-input-codec";
import { ChunkedInputCancelledError } from "../../../../src/persistence/serialization/chunked-input-types";
import {
  CURRENT_METADATA_REWRITES,
  rewriteDocumentMetadata,
} from "../../../fixtures/persistence/metadata-rewrite";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import {
  appendMetadataProperty,
  createAllElementSnapshot,
  createSnapshot,
  wideMetadataArrayProperty,
} from "./fixtures";

async function expectChunkedInputToMatchSynchronous(
  input: string,
  options: ConstructorParameters<typeof ChunkedInkbookInputParser>[0] = {},
): Promise<void> {
  const bytes = new TextEncoder().encode(input);
  const parser = new ChunkedInkbookInputParser(options);
  await parser.write(bytes);

  expect(await parser.finish()).toEqual(await parseInkbookDocumentForTest(bytes));
}

async function expectSnapshotMetadataPrefixAccepted(
  parser: ChunkedInkbookInputParser,
): Promise<number> {
  const serialized = serializeInkbookDocument(createSnapshot());
  expect(serialized.ok).toBe(true);
  if (!serialized.ok) throw new Error("Snapshot serialization failed.");
  const metadataTag = serialized.value.svg.indexOf("<metadata");
  const metadataStart = serialized.value.svg.indexOf(">", metadataTag) + 1;
  const prefix = new TextEncoder().encode(serialized.value.svg.slice(0, metadataStart));

  expect((await parser.write(prefix)).ok).toBe(true);
  return prefix.byteLength;
}

describe("chunked Inkbook input", () => {
  it("matches the synchronous codec across byte boundaries", async () => {
    const serialized = serializeInkbookDocument(createAllElementSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const bytes = new TextEncoder().encode(serialized.value.svg);
    const parser = new ChunkedInkbookInputParser({ inputSliceBytes: 37, pathBatchSize: 2 });

    for (let offset = 0; offset < bytes.length; offset += 23) {
      expect((await parser.write(bytes.subarray(offset, offset + 23))).ok).toBe(true);
    }

    expect(await parser.finish()).toEqual(await parseInkbookDocumentForTest(bytes));
    expect(parser.maximumRetainedStaticInputCharacters).toBeLessThanOrEqual(47);
  });

  it("checkpoints input slices, explicit pauses, path batches, and snapshot elements", async () => {
    const serialized = serializeInkbookDocument(createAllElementSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    let checkpoints = 0;
    const parser = new ChunkedInkbookInputParser({
      checkpoint: () => {
        checkpoints += 1;
        return Promise.resolve();
      },
      inputSliceBytes: 1024,
      pathBatchSize: 1,
    });
    const bytes = new TextEncoder().encode(serialized.value.svg);

    await parser.write(bytes);
    const afterInput = checkpoints;
    await parser.pauseForInput();
    expect(checkpoints).toBe(afterInput + 1);
    const result = await parser.finish();

    expect(result.ok).toBe(true);
    expect(afterInput).toBeGreaterThan(Math.ceil(bytes.byteLength / 1024));
    expect(checkpoints).toBeGreaterThan(afterInput);
  });

  it("returns the same structured failures as the synchronous pipeline", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const inputs = [
      serialized.value.svg.replace('data-inkbook-revision="7"', 'data-inkbook-revision="8"'),
      serialized.value.svg.replace('"format":"inkbook"', '"format":'),
      serialized.value.svg.replace("</svg>", "<script/></svg>"),
      serialized.value.svg.replace("M0 0L2048.6", "M1 0L2048.6"),
    ];

    for (const input of inputs) {
      const bytes = new TextEncoder().encode(input);
      const parser = new ChunkedInkbookInputParser();
      await parser.write(bytes);
      expect(await parser.finish()).toEqual(await parseInkbookDocumentForTest(bytes));
    }
  });

  it("matches synchronous migration of a canonical version zero document", async () => {
    const serialized = serializeInkbookDocument(createAllElementSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const versionZero = toVersionZeroDocument(serialized.value.svg);

    await expectChunkedInputToMatchSynchronous(versionZero, {
      inputSliceBytes: versionZero.length + 1,
      pathBatchSize: 256,
    });
  });
});

describe("chunked Inkbook metadata boundaries", () => {
  it.each(CURRENT_METADATA_REWRITES)(
    "matches synchronous rejection of noncanonical or unbound metadata as $expectedCode",
    async ({ expectedCode, mutate, updateHash }) => {
      const serialized = serializeInkbookDocument(createSnapshot());
      expect(serialized.ok).toBe(true);
      if (!serialized.ok) return;
      const input = rewriteDocumentMetadata(serialized.value.svg, mutate, updateHash);

      await expectChunkedInputToMatchSynchronous(input, { inputSliceBytes: 31 });
      expect(await parseInkbookDocumentForTest(input)).toMatchObject({
        error: { code: expectedCode },
        ok: false,
      });
    },
  );

  it("accepts exactly 60 MiB of metadata and rejects the next byte while streaming", async () => {
    const parser = new ChunkedInkbookInputParser();
    const chunk = new Uint8Array(256 * 1024).fill(0x20);
    const prefixBytes = await expectSnapshotMetadataPrefixAccepted(parser);

    for (let written = 0; written < FILE_SCHEMA_LIMITS.metadataBytes; written += chunk.length) {
      expect((await parser.write(chunk)).ok).toBe(true);
    }

    const overLimit = await parser.write(new Uint8Array([0x20]));
    expect(overLimit).toMatchObject({ error: { code: "invalid-svg" }, ok: false });
    expect(parser.bytesReceived).toBe(prefixBytes + FILE_SCHEMA_LIMITS.metadataBytes + 1);
    expect(await parser.finish()).toEqual(overLimit);
  }, 30_000);

  it("decodes allowed XML entities split across every byte boundary", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const input = appendMetadataProperty(serialized.value.svg, '"escapedXml":"&lt;&amp;&gt;"');

    await expectChunkedInputToMatchSynchronous(input, { inputSliceBytes: 1 });
  });

  it("matches native container-width enforcement at the limit and limit plus one", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const maximumEntries = jsonContainerBudget(FILE_SCHEMA_LIMITS);

    for (const entries of [maximumEntries, maximumEntries + 1]) {
      const input = appendMetadataProperty(
        serialized.value.svg,
        wideMetadataArrayProperty(entries),
      );

      await expectChunkedInputToMatchSynchronous(input, { inputSliceBytes: 1024 });
    }
  });

  it("bounds scratch while parsing escape-dense document metadata", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const input = appendMetadataProperty(
      serialized.value.svg,
      `"escapeDense":"${"\\n".repeat(256 * 1024)}"`,
    );

    let checkpoints = 0;
    const parser = new ChunkedInkbookInputParser({
      checkpoint: () => {
        checkpoints += 1;
        return Promise.resolve();
      },
      inputSliceBytes: 1024,
    });

    await parser.write(new TextEncoder().encode(input));

    expect(await parser.finish()).toMatchObject({
      error: {
        code: "snapshot-invalid",
        validationError: { code: "unknown-property", path: "$.escapeDense" },
      },
      ok: false,
    });
    expect(checkpoints).toBeGreaterThan(256);
  });
});

describe("chunked Inkbook input boundaries", () => {
  it("prioritizes the file-size limit exactly like the synchronous codec", async () => {
    const bytes = new Uint8Array(FILE_SCHEMA_LIMITS.totalInputBytes + 1);
    bytes[0] = 0xff;
    const parser = new ChunkedInkbookInputParser();

    const result = await parser.write(bytes);

    expect(result).toEqual(await parseInkbookDocumentForTest(bytes));
    expect(parser.bytesReceived).toBe(0);
  });

  it("detects malformed and truncated UTF-8 across chunks", async () => {
    const malformed = new ChunkedInkbookInputParser();
    expect((await malformed.write(new Uint8Array([0xc3]))).ok).toBe(true);
    expect(await malformed.write(new Uint8Array([0x28]))).toMatchObject({
      error: { code: "invalid-utf8" },
      ok: false,
    });

    const truncated = new ChunkedInkbookInputParser();
    expect((await truncated.write(new Uint8Array([0xc3]))).ok).toBe(true);
    expect(await truncated.finish()).toMatchObject({
      error: { code: "invalid-utf8" },
      ok: false,
    });
  });

  it("cancels deterministically before work and after a checkpoint", async () => {
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort("caller detail must not escape");
    const first = new ChunkedInkbookInputParser({ signal: alreadyCancelled.signal });
    await expect(first.write(new Uint8Array())).rejects.toEqual(
      expect.objectContaining({ code: "input-cancelled", name: "ChunkedInputCancelledError" }),
    );

    const duringCheckpoint = new AbortController();
    const second = new ChunkedInkbookInputParser({
      checkpoint: () => {
        duringCheckpoint.abort(new Error("different caller detail"));
        return Promise.resolve();
      },
      inputSliceBytes: 1,
      signal: duringCheckpoint.signal,
    });
    await expect(second.write(new Uint8Array([0x20]))).rejects.toBeInstanceOf(
      ChunkedInputCancelledError,
    );
  });

  it("cancels between bounded metadata slices even with an oversized input slice budget", async () => {
    const metadata = new TextEncoder().encode(" ".repeat(64 * 1024));
    const controller = new AbortController();
    let cancellationArmed = false;
    let checkpoints = 0;
    const parser = new ChunkedInkbookInputParser({
      checkpoint: () => {
        if (cancellationArmed) {
          checkpoints += 1;
          if (checkpoints === 1) controller.abort();
        }
        return Promise.resolve();
      },
      inputSliceBytes: metadata.byteLength + 1,
      signal: controller.signal,
    });

    await expectSnapshotMetadataPrefixAccepted(parser);
    cancellationArmed = true;
    await expect(parser.write(metadata)).rejects.toBeInstanceOf(ChunkedInputCancelledError);
  });
});

describe("chunked migration cancellation", () => {
  it("honors cancellation at the migration checkpoint", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const versionZero = toVersionZeroDocument(serialized.value.svg);
    const controller = new AbortController();
    const parser = new ChunkedInkbookInputParser({
      checkpoint: () => Promise.resolve(),
      inputSliceBytes: versionZero.length + 1,
      onValidatedSnapshot: () => controller.abort(),
      pathBatchSize: 256,
      signal: controller.signal,
    });

    await expect(parser.write(new TextEncoder().encode(versionZero))).rejects.toBeInstanceOf(
      ChunkedInputCancelledError,
    );
  });
});

describe("chunked Inkbook scheduling boundaries", () => {
  it("does not misclassify scheduler failures as malformed UTF-8", async () => {
    const schedulerFailure = new Error("scheduler failed");
    const parser = new ChunkedInkbookInputParser({
      checkpoint: () => Promise.reject(schedulerFailure),
      inputSliceBytes: 1,
    });

    await expect(parser.write(new Uint8Array([0x20]))).rejects.toBe(schedulerFailure);
  });

  it("rejects invalid scheduling budgets", () => {
    expect(() => new ChunkedInkbookInputParser({ inputSliceBytes: 0 })).toThrow(RangeError);
    expect(() => new ChunkedInkbookInputParser({ pathBatchSize: 0 })).toThrow(RangeError);
  });
});

function toVersionZeroDocument(svg: string): string {
  return svg
    .replace('data-inkbook-version="1"', 'data-inkbook-version="0"')
    .replace(/ data-inkbook-snapshot-sha256="[0-9a-f]{64}"/u, "")
    .replace('"version":1', '"version":0');
}
