import { describe, expect, it } from "vitest";

import type { NoteIdentityV1 } from "../../../src/application/note-session";
import {
  createHostHistoryHarness,
  historyDelivery,
  HOST_HISTORY_EDITOR_A,
  HOST_HISTORY_NOTE,
  HOST_HISTORY_PANE_A,
  prepareHostHistory,
} from "./recovery-fixture";

const RENAMED_NOTE: NoteIdentityV1 = Object.freeze({
  ...HOST_HISTORY_NOTE,
  vaultRelativeMarkdownPath: "Archive/history.md",
});

describe("Host history note identity rekey", () => {
  it("updates current authority while retaining old actionable envelope identity", async () => {
    const harness = createHostHistoryHarness();
    const prepared = await prepareHostHistory(
      harness.coordinator,
      HOST_HISTORY_PANE_A,
      1,
      0,
    );

    expect(
      harness.coordinator.rekeyNoteIdentity(HOST_HISTORY_NOTE, RENAMED_NOTE),
    ).toBe(true);
    expect(harness.coordinator.snapshot().noteIdentity).toEqual(RENAMED_NOTE);
    expect(harness.coordinator.snapshot().entries[0]?.noteIdentity).toEqual(
      HOST_HISTORY_NOTE,
    );
    await expect(
      harness.coordinator.deliverInSessionTurn(
        HOST_HISTORY_EDITOR_A,
        HOST_HISTORY_PANE_A,
        historyDelivery(prepared.envelope, 1),
      ),
    ).resolves.toMatchObject({ kind: "accepted" });
  });

  it("rejects stale rekeys and restores mixed historical identities safely", async () => {
    const harness = createHostHistoryHarness();
    const prepared = await prepareHostHistory(
      harness.coordinator,
      HOST_HISTORY_PANE_A,
      1,
      0,
    );
    expect(
      harness.coordinator.rekeyNoteIdentity(HOST_HISTORY_NOTE, RENAMED_NOTE),
    ).toBe(true);
    await harness.coordinator.deliverInSessionTurn(
      HOST_HISTORY_EDITOR_A,
      HOST_HISTORY_PANE_A,
      historyDelivery(prepared.envelope, 1),
    );

    expect(
      harness.coordinator.rekeyNoteIdentity(HOST_HISTORY_NOTE, RENAMED_NOTE),
    ).toBe(false);
    const restored = createHostHistoryHarness({
      noteIdentity: RENAMED_NOTE,
      restore: {
        hostEffectsMayBeReachable: true,
        snapshot: harness.coordinator.snapshot(),
      },
    });
    expect(restored.coordinator.snapshot().lease.kind).toBe("owned");
  });
});
