import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import * as canonical from "../../../../src/persistence/serialization/canonical-snapshot";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

let snapshotSvg: string;
let allElementSvg: string;

beforeAll(() => {
  snapshotSvg = serializeFixture(createSnapshot());
  allElementSvg = serializeFixture(createAllElementSnapshot());
});

function serializeFixture(snapshot: ReturnType<typeof createSnapshot>): string {
  const serialized = serializeInkbookDocument(snapshot);
  expect(serialized.ok).toBe(true);
  if (!serialized.ok) throw new Error("Snapshot serialization failed.");
  return serialized.value.svg;
}

async function expectChunkedInputToMatchSynchronous(
  input: string,
  options: ConstructorParameters<typeof ChunkedInkbookInputParser>[0] = {},
): Promise<Awaited<ReturnType<typeof parseInkbookDocumentForTest>>> {
  const bytes = new TextEncoder().encode(input);
  const parser = new ChunkedInkbookInputParser(options);
  await parser.write(bytes);

  const result = await parser.finish();
  expect(logicalStrokePoints(result)).toEqual(await parseInkbookDocumentForTest(bytes));
  return result;
}

function logicalStrokePoints(
  result: Awaited<ReturnType<typeof parseInkbookDocumentForTest>>,
): Awaited<ReturnType<typeof parseInkbookDocumentForTest>> {
  if (!result.ok) return result;
  return {
    ...result,
    value: {
      ...result.value,
      snapshot: {
        ...result.value.snapshot,
        elements: result.value.snapshot.elements.map((element) =>
          element.kind === "stroke" ? { ...element, points: Array.from(element.points) } : element,
        ),
      },
    },
  };
}

async function expectSnapshotMetadataPrefixAccepted(
  parser: ChunkedInkbookInputParser,
): Promise<number> {
  const svg = snapshotSvg;
  const metadataTag = svg.indexOf("<metadata");
  const metadataStart = svg.indexOf(">", metadataTag) + 1;
  const prefix = new TextEncoder().encode(svg.slice(0, metadataStart));

  expect((await parser.write(prefix)).ok).toBe(true);
  return prefix.byteLength;
}

describe("chunked Inkbook input", () => {
  it("matches the synchronous codec across byte boundaries", async () => {
    const svg = allElementSvg;
    const bytes = new TextEncoder().encode(svg);
    const parser = new ChunkedInkbookInputParser({ inputSliceBytes: 37, pathBatchSize: 2 });

    for (let offset = 0; offset < bytes.length; offset += 23) {
      expect((await parser.write(bytes.subarray(offset, offset + 23))).ok).toBe(true);
    }

    const parsed = await parser.finish();
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const stroke = parsed.value.snapshot.elements.find((element) => element.kind === "stroke");
      expect(stroke?.kind === "stroke" && stroke.points).toBeInstanceOf(Float64Array);
    }
    expect(logicalStrokePoints(parsed)).toEqual(await parseInkbookDocumentForTest(bytes));
    expect(parser.maximumRetainedStaticInputCharacters).toBeLessThanOrEqual(47);
  });

  it("checkpoints input slices, explicit pauses, path batches, and snapshot elements", async () => {
    const svg = allElementSvg;
    let checkpoints = 0;
    const parser = new ChunkedInkbookInputParser({
      checkpoint: () => {
        checkpoints += 1;
        return Promise.resolve();
      },
      inputSliceBytes: 1024,
      pathBatchSize: 1,
    });
    const bytes = new TextEncoder().encode(svg);

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
    const svg = snapshotSvg;
    const inputs = [
      svg.replace('data-inkbook-revision="7"', 'data-inkbook-revision="8"'),
      svg.replace('"format":"inkbook"', '"format":'),
      svg.replace("</svg>", "<script/></svg>"),
      svg.replace("M0 0L2048.6", "M1 0L2048.6"),
    ];

    for (const input of inputs) {
      const bytes = new TextEncoder().encode(input);
      const parser = new ChunkedInkbookInputParser();
      await parser.write(bytes);
      expect(await parser.finish()).toEqual(await parseInkbookDocumentForTest(bytes));
    }
  });

  it("matches synchronous migration of a canonical version zero document", async () => {
    const svg = allElementSvg;
    const versionZero = toVersionZeroDocument(svg);

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
      const svg = snapshotSvg;
      const input = rewriteDocumentMetadata(svg, mutate, updateHash);

      const result = await expectChunkedInputToMatchSynchronous(input, { inputSliceBytes: 31 });
      expect(result).toMatchObject({
        error: { code: expectedCode },
        ok: false,
      });
    },
  );

  it.each(CURRENT_METADATA_REWRITES.map((entry, index) => ({ ...entry, accepted: index === 0 })))(
    "safe unlock keeps metadata binding and duplicate-key rejection without canonicalizing points",
    async ({ mutate, updateHash, accepted, expectedCode }) => {
      const input = rewriteDocumentMetadata(snapshotSvg, mutate, updateHash);
      const parser = new ChunkedInkbookInputParser({ staticValidation: "safe" });
      const canonicalize = vi.spyOn(canonical, "canonicalElement");
      try {
        await parser.write(new TextEncoder().encode(input));
        const result = await parser.finish();
        expect(result.ok).toBe(accepted);
        if (!accepted) expect(result).toMatchObject({ error: { code: expectedCode } });
        expect(canonicalize).not.toHaveBeenCalled();
      } finally {
        canonicalize.mockRestore();
      }
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
    const svg = snapshotSvg;
    const input = appendMetadataProperty(svg, '"escapedXml":"&lt;&amp;&gt;"');

    await expectChunkedInputToMatchSynchronous(input, { inputSliceBytes: 1 });
  });

  it("matches native container-width enforcement at the limit and limit plus one", async () => {
    const svg = snapshotSvg;
    const maximumEntries = jsonContainerBudget(FILE_SCHEMA_LIMITS);

    for (const entries of [maximumEntries, maximumEntries + 1]) {
      const input = appendMetadataProperty(svg, wideMetadataArrayProperty(entries));

      await expectChunkedInputToMatchSynchronous(input, { inputSliceBytes: 1024 });
    }
  });

  it("bounds scratch while parsing escape-dense document metadata", async () => {
    const svg = snapshotSvg;
    const input = appendMetadataProperty(svg, `"escapeDense":"${"\\n".repeat(256 * 1024)}"`);

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
    const svg = snapshotSvg;
    const versionZero = toVersionZeroDocument(svg);
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
  it.each([1024, 256 * 1024])(
    "rejects a prefix above 64 KiB with %i-byte slices",
    async (inputSliceBytes) => {
      const parser = new ChunkedInkbookInputParser({ inputSliceBytes });
      const oversized = new TextEncoder().encode(" ".repeat(64 * 1024 + 1));

      expect(await parser.write(oversized)).toMatchObject({
        ok: false,
        error: {
          code: "invalid-svg",
          message: "Document SVG prefix exceeds its bounded envelope.",
        },
      });
    },
  );

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
