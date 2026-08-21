import { describe, expect, it, vi } from "vitest";

import type { ViewId } from "../../../src/application/note-session";
import type { RuntimePersistenceSourceV1 } from "../../../src/adapters/obsidian/runtime-persistence-source";
import { RuntimeViewAttachmentsV1 } from "../../../src/adapters/obsidian/runtime-source-attachments";

const VIEW_LIMIT = Number("32");

describe("RuntimeViewAttachmentsV1", () => {
  it("rejects an excess view and detaches only admitted views", () => {
    const attach = vi.fn();
    const detach = vi.fn();
    const attachments = new RuntimeViewAttachmentsV1();
    const admitted = Array.from(
      { length: VIEW_LIMIT },
      (_, index) => `view-${String(index + 1)}` as ViewId,
    );
    const first = admitted[0];
    if (first === undefined) throw new Error("Expected an admitted view.");
    const rejected = "view-33" as ViewId;

    for (const viewId of admitted)
      expect(attachments.attach(viewId)).toBe(true);
    expect(attachments.attach(first)).toBe(true);
    expect(attachments.attach(rejected)).toBe(false);
    expect(attachments.has(rejected)).toBe(false);

    attachments.bind({
      attach,
      detach,
    } as unknown as RuntimePersistenceSourceV1);
    expect(attach.mock.calls).toEqual(admitted.map((viewId) => [viewId]));

    attachments.detach(rejected);
    expect(detach).not.toHaveBeenCalled();
    attachments.detach(first);
    attachments.detach(first);
    expect(detach).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledWith(first);
    expect(attachments.has(first)).toBe(false);

    expect(attachments.attach(rejected)).toBe(true);
    expect(attachments.has(rejected)).toBe(true);
    expect(attach).toHaveBeenLastCalledWith(rejected);
  });
});
