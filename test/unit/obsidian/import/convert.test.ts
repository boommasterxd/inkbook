import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInkImportConverter } from "../../../../src/obsidian/import/convert";
import type { DocumentRuntimePort } from "../../../../src/persistence/worker/runtime/types";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/document-runtime";

const { createRuntime } = vi.hoisted(() => ({ createRuntime: vi.fn() }));
vi.mock("../../../../src/persistence/worker/runtime/worker-factory", () => ({
  createDocumentRuntime: createRuntime,
}));

const INPUT =
  '<svg xmlns="http://www.w3.org/2000/svg"><metadata><ink file-type="inkWriting"/><ink-canvas version="0.5.0">{"version":1,"strokes":[],"gridEnabled":false,"writingLineHeight":100}</ink-canvas></metadata></svg>';

function converter() {
  return createInkImportConverter({
    ownerWindow: {} as Window,
    workScheduler: new TestWorkScheduler(),
    frameIntervalMilliseconds: () => 1000 / 120,
    createId: () => "test",
    timestamp: () => 1000,
  });
}

describe("Ink import conversion ownership", () => {
  beforeEach(() => {
    createRuntime.mockReset();
  });

  it("uses canonical fallback validation when the worker is unavailable", async () => {
    createRuntime.mockRejectedValue(new Error("Worker unavailable"));
    const result = await converter()(INPUT, { legacyWriting: false });
    expect(result.svg).toContain('data-inkbook-version="1"');
    expect(result.svg).toContain('data-inkbook-revision="0"');
    expect(result.warningCodes).toEqual([]);
    await expect(converter()("invalid input", { legacyWriting: false })).rejects.toThrow(
      "import-invalid-source",
    );
  });

  it("terminates a failed executor before retrying through the fallback", async () => {
    const terminate = vi.fn();
    createRuntime.mockResolvedValue({
      execute: () => Promise.reject(new Error("Worker failed")),
      terminate,
    });
    const result = await converter()(INPUT, { legacyWriting: false });
    expect(result.svg).toContain('data-inkbook-version="1"');
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("reports unsupported source content without repeating the conversion", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ type: "runtime-failure", code: "import-unsupported-content" });
    const terminate = vi.fn();
    createRuntime.mockResolvedValue({ execute, terminate });
    await expect(converter()(INPUT, { legacyWriting: false })).rejects.toThrow(
      "import-unsupported-content",
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("verifies successful worker output and retains transcript information as a warning", async () => {
    const runtime = new DocumentWorkerRuntime({ sessionId: "ink-import-test", workerEpoch: 1 });
    const terminate = vi.spyOn(runtime, "terminate");
    createRuntime.mockResolvedValue(runtime);
    const result = await converter()(
      INPUT.replace("</metadata>", "<transcript>Original text</transcript></metadata>"),
      { legacyWriting: false },
    );
    expect(result.svg).toContain('data-inkbook-version="1"');
    expect(result.warnings).toContain(
      "The source transcript remains in the original file and import backup.",
    );
    expect(result.warningCodes).toContain("transcriptKept");
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("terminates the actual worker on cancellation and does not start fallback work", async () => {
    const controller = new AbortController();
    const terminate = vi.fn();
    const execute = vi.fn(async () => {
      controller.abort();
      throw new Error("Worker terminated");
    });
    createRuntime.mockResolvedValue({ execute, terminate } satisfies Pick<
      DocumentRuntimePort,
      "execute" | "terminate"
    >);
    await expect(
      converter()(INPUT, { legacyWriting: false, signal: controller.signal }),
    ).rejects.toThrow();
    expect(terminate).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledOnce();
  });

  it("does not publish output that fails the canonical readback verification", async () => {
    const runtime = new DocumentWorkerRuntime({ sessionId: "ink-import-test", workerEpoch: 1 });
    const execute = runtime.execute.bind(runtime);
    vi.spyOn(runtime, "execute").mockImplementation((request) =>
      request.type === "verify-output"
        ? Promise.resolve({
            identity: request.identity,
            type: "verify-output-success",
            persisted: { type: "unreadable" },
          })
        : execute(request),
    );
    const terminate = vi.spyOn(runtime, "terminate");
    createRuntime.mockResolvedValue(runtime);
    await expect(converter()(INPUT, { legacyWriting: false })).rejects.toThrow(
      "verification failed",
    );
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });
});
