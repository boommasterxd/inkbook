import { describe, expect, it, vi } from "vitest";

import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import {
  documentFromSnapshot,
  emptySnapshot,
  operation,
  persistenceHarness,
  rectangle,
} from "./vault-session-fixtures";

describe("vault document static export preparation", () => {
  it("does not open or write documents without a dirty owned session", async () => {
    const { factory, process, session } = persistenceHarness();
    const create = vi.spyOn(factory, "create");
    await factory.prepareStaticExport("drawings/missing.svg");
    await factory.prepareStaticExport(operation().documentId);
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1");
    await factory.prepareStaticExport(operation().documentId);

    expect(process).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(factory.getDocumentModel("session-1")).toBe(model);
    session.dispose();
  });

  it("flushes only the matching document without changing its editor ownership", async () => {
    const { factory, content, process, session } = persistenceHarness();
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1")!;
    model.commitElement(rectangle());
    const unrelated = factory.create({ documentId: "drawings/other.svg", sessionId: "session-2" });
    const unrelatedFlush = vi.spyOn(unrelated, "flushForExport");

    await factory.prepareStaticExport(operation().documentId);

    expect(process).toHaveBeenCalledOnce();
    const parsed = await parseInkbookDocumentForTest(content());
    expect(parsed.ok && parsed.value.snapshot.elements).toEqual([rectangle()]);
    expect(session.getSnapshot()).toMatchObject({ dirty: false, revision: 8 });
    expect(factory.getDocumentModel("session-1")).toBe(model);
    expect(unrelatedFlush).not.toHaveBeenCalled();
    session.dispose();
    unrelated.dispose();
  });

  it("awaits an owned write and persists a newer committed revision before returning", async () => {
    const { factory, content, holdProcess, process, session } = persistenceHarness();
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1")!;
    model.commitElement(rectangle());
    const release = holdProcess();
    const firstExport = factory.prepareStaticExport(operation().documentId);
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
    model.commitPage({ ...model.page, activeBufferLines: 4 });
    const latestExport = factory.prepareStaticExport(operation().documentId);
    release();
    await Promise.all([firstExport, latestExport]);

    const parsed = await parseInkbookDocumentForTest(content());
    expect(parsed.ok && parsed.value.snapshot.revision).toBe(9);
    expect(parsed.ok && parsed.value.snapshot.page.activeBufferLines).toBe(4);
    expect(process).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().dirty).toBe(false);
    session.dispose();
  });
});

describe("vault document static export persistence failures", () => {
  it("rejects failed persistence so an export cannot silently consume stale output", async () => {
    const { factory, process, session } = persistenceHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")!.commitElement(rectangle());
    process.mockRejectedValueOnce(new Error("The vault write failed."));

    await expect(factory.prepareStaticExport(operation().documentId)).rejects.toThrow(
      "Could not persist the latest Inkbook document for export.",
    );

    expect(session.getSnapshot().dirty).toBe(true);
    session.dispose();
  });

  it("rejects conflicting vault content without overwriting it", async () => {
    const { factory, content, process, replaceExternal, session } = persistenceHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")!.commitElement(rectangle());
    const external = documentFromSnapshot({ ...emptySnapshot(), revision: 12 });
    replaceExternal(external);

    await expect(factory.prepareStaticExport(operation().documentId)).rejects.toThrow();

    expect(content()).toBe(external.svg);
    expect(process).not.toHaveBeenCalled();
    expect(session.getSnapshot().dirty).toBe(true);
    session.dispose();
  });

  it("retries persisted-output verification after an uncertain write without writing again", async () => {
    const { factory, process, session } = persistenceHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")!.commitElement(rectangle());
    const write = process.getMockImplementation()!;
    process.mockImplementationOnce(async (...args) => {
      await write(...args);
      throw new Error("The vault write acknowledgment was lost.");
    });

    await expect(factory.prepareStaticExport(operation().documentId)).rejects.toThrow();
    await factory.prepareStaticExport(operation().documentId);

    expect(process).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({ dirty: false, revision: 8 });
    session.dispose();
  });
});
