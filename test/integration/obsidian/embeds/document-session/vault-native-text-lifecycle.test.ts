// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { inputLifecycleCoordinator } from "./vault-input-lifecycle-fixtures";
import { loadBuiltinFont } from "../../../../../src/persistence/fonts/builtin-fonts";
import { mountActiveTextSession } from "../../../../fixtures/obsidian/active-text-session";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import { textElement } from "../../../../unit/domain/schema/fixtures";
import { emptySnapshot, persistenceHarness } from "./vault-session-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function nativeSession() {
  const font = await loadBuiltinFont("inter", 400, "normal", immediateWorkScheduler());
  const element = textElement();
  element.style.fontFamily = "inter";
  const harness = persistenceHarness({
    ...emptySnapshot(),
    version: 2,
    fontResources: [font],
    elements: [element],
  });
  let state: ReturnType<typeof mountActiveTextSession> | undefined;
  const release = vi.fn(() => state?.session.dispose());
  const { coordinator, target } = inputLifecycleCoordinator(harness, release);
  await coordinator.requestActivation(target).outcome;
  state = mountActiveTextSession({ element, model: harness.session.documentModel! });
  await state.session.edit(element.id);
  return { harness, state, coordinator, target, release };
}

it.each(["detach", "lock", "unload"] as const)(
  "persists the final native CodeMirror batch before %s disposes its owner",
  async (action) => {
    const h = await nativeSession();
    try {
      h.state.input().dispatch({ changes: { from: 5, insert: " latest" } });
      if (action === "detach") h.coordinator.detachAttachment(h.target);
      else if (action === "lock") h.coordinator.requestLockCurrent();
      else {
        const draining = h.harness.factory.prepareForUnload();
        h.coordinator.dispose({ preparePersistence: true });
        await draining;
      }
      await vi.waitFor(() =>
        expect(h.harness.factory.getDocumentModel("session-1")).toBeUndefined(),
      );
      const parsed = await parseInkbookDocumentForTest(h.harness.content());
      expect(parsed.ok && parsed.value.snapshot.elements[0]).toMatchObject({
        kind: "text",
        source: "Hello latest",
      });
      expect(h.release).toHaveBeenCalledOnce();
      expect(h.state.error).not.toHaveBeenCalled();
    } finally {
      h.state.session.dispose();
      h.coordinator.dispose();
      h.harness.session.dispose();
    }
  },
);

it("retains failed native input after detach and saves it when recovery retries", async () => {
  const h = await nativeSession();
  try {
    h.state.prepare.mockRejectedValueOnce(new Error("Font layout failed"));
    h.state.input().dispatch({ changes: { from: 5, insert: " retained" } });
    h.coordinator.detachAttachment(h.target);
    await vi.waitFor(() =>
      expect(h.coordinator.getSnapshot().current?.phase).toBe("headless-recovery"),
    );
    expect(h.state.input().state.doc.toString()).toBe("Hello retained");
    expect(h.release).not.toHaveBeenCalled();
    expect(h.harness.process).not.toHaveBeenCalled();
    expect(h.coordinator.retryRecovery()).toBe(true);
    await vi.waitFor(() => expect(h.harness.factory.getDocumentModel("session-1")).toBeUndefined());
    const parsed = await parseInkbookDocumentForTest(h.harness.content());
    expect(parsed.ok && parsed.value.snapshot.elements[0]).toMatchObject({
      source: "Hello retained",
    });
    expect(h.release).toHaveBeenCalledOnce();
  } finally {
    h.state.session.dispose();
    h.coordinator.dispose();
    h.harness.session.dispose();
  }
});
