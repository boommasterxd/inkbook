import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as paths from "../../../../../src/domain/geometry/element-path";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/document-codec";
import { DocumentModelRuntime } from "../../../../../src/persistence/worker/runtime/document-model";
import { createAllElementSnapshot } from "../../serialization/fixtures";
import { rewriteDocumentMetadata } from "../../../../fixtures/persistence/metadata-rewrite";

let svg: string;
beforeAll(() => {
  const source = serializeInkbookDocument(createAllElementSnapshot());
  if (!source.ok) throw new Error(source.error.code);
  svg = source.value.svg;
});
afterEach(() => vi.restoreAllMocks());

describe("snapshot-authoritative unlock", () => {
  it("performs no canonical geometry construction on cold unlock or reopen", async () => {
    const build = vi.spyOn(paths, "buildElementPathParts");
    const cold = await new DocumentModelRuntime().unlock(svg);
    const warm = await new DocumentModelRuntime().unlock(svg + "\n");
    expect(cold.snapshot).toEqual(warm.snapshot);
    expect(cold.snapshot.elements.length).toBeGreaterThan(0);
    expect(build).not.toHaveBeenCalled();
  });

  it("accepts safe divergent presentation only for unlock, never as a canonical output proof", async () => {
    const divergent = svg.replace(/ d="[^"]*"/u, ' d="M 0 0 L 1 1"');
    const model = new DocumentModelRuntime();
    const unlocked = await model.unlock(divergent);
    expect(unlocked.snapshot.elements).toHaveLength(createAllElementSnapshot().elements.length);
    expect(unlocked.requiresCanonicalRewrite).toBe(false);
    expect(await model.verifyOutput(divergent)).toBeNull();
    expect(await model.verifyOutput(svg)).not.toBeNull();
  });

  it.each([
    (input: string) => input.replace("</svg>", "<script/></svg>"),
    (input: string) => input + '<image href="https://example.invalid/a"/>',
    (input: string) => input.replace("<path ", '<path onload="alert(1)" '),
    (input: string) =>
      rewriteDocumentMetadata(input, (text) => text.replace('"version":1', '"version":99'), true),
    (input: string) =>
      rewriteDocumentMetadata(
        input,
        (text) => text.replace('"activeBufferLines":3', '"activeBufferLines":4'),
        false,
      ),
  ])(
    "rejects unsafe presentation or invalid metadata without adopting the model",
    async (mutate) => {
      const model = new DocumentModelRuntime();
      await expect(model.unlock(mutate(svg))).rejects.toThrow();
      expect(model.modelRevision).toBeNull();
    },
  );

  it("rejects cancellation after validated metadata without publishing a completed model", async () => {
    const model = new DocumentModelRuntime();
    const abort = new AbortController();
    await expect(
      model.unlock(
        svg,
        {
          signal: abort.signal,
          checkpoint: async () => undefined,
        },
        () => abort.abort(),
      ),
    ).rejects.toThrow();
    expect(model.modelRevision).toBeNull();
  });
});
