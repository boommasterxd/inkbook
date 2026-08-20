import { describe, expect, it, vi } from "vitest";

import {
  commandFailure,
  commandSuccess,
  parseRelocationId,
  type CommandResultV1,
  type NoteIdentityV1,
  type NoteSessionRegistryV1,
} from "../../../src/application/note-session";
import type { FileRelocationRecordV1 } from "../../../src/application/recovery";
import { RuntimeRelocationGateV1 } from "../../../src/adapters/obsidian/runtime-relocation-gate";
import type { RuntimePersistenceV1 } from "../../../src/adapters/obsidian/runtime-persistence";

const IDENTITY: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "Notes/page.md",
});
const FILE_ID = parseRelocationId("rel_00000000000000000000000000");
const PREFIX_ID = parseRelocationId("rel_00000000000000000000000001");

describe("RuntimeRelocationGateV1", () => {
  it("publishes relocating before work and readmits only at file terminal", async () => {
    const harness = gateHarness();

    await expect(
      harness.gate.activate(harness.owner, IDENTITY, FILE_ID),
    ).resolves.toBe(true);
    expect(harness.gate.isActive(harness.owner)).toBe(true);
    expect(harness.events).toEqual(["suspend", `publish:${FILE_ID}`]);

    await expect(
      harness.gate.finishFile(harness.owner, fileRecord(FILE_ID)),
    ).resolves.toEqual(commandSuccess(undefined));
    expect(harness.gate.isActive(harness.owner)).toBe(false);
    expect(harness.events).toEqual([
      "suspend",
      `publish:${FILE_ID}`,
      "readmit",
      "active:none",
      "publish:none",
    ]);
  });

  it("keeps the gate closed when status publication fails", async () => {
    const harness = gateHarness(true);

    await expect(
      harness.gate.activate(harness.owner, IDENTITY, FILE_ID),
    ).resolves.toBe(false);

    expect(harness.gate.isActive(harness.owner)).toBe(true);
    expect(harness.events).toEqual(["suspend", `publish:${FILE_ID}`]);
  });

  it("keeps prefix members blocked after their file terminal until prefix terminal", async () => {
    const harness = gateHarness();
    await harness.gate.activate(harness.owner, IDENTITY, PREFIX_ID);
    harness.gate.retainPrefix(PREFIX_ID, new Set([harness.owner]));

    await expect(
      harness.gate.finishFile(harness.owner, fileRecord(FILE_ID)),
    ).resolves.toEqual(commandSuccess(undefined));
    expect(harness.gate.isActive(harness.owner)).toBe(true);

    await expect(harness.gate.finishPrefix(PREFIX_ID)).resolves.toEqual(
      commandSuccess(undefined),
    );
    expect(harness.gate.isActive(harness.owner)).toBe(false);
  });
});

interface GateHarnessV1 {
  readonly events: string[];
  readonly gate: RuntimeRelocationGateV1;
  readonly owner: RuntimePersistenceV1;
}

function gateHarness(failPublication = false): GateHarnessV1 {
  const events: string[] = [];
  const owner = {
    setActiveRelocation: vi.fn((record: FileRelocationRecordV1 | null) => {
      events.push(`active:${record?.relocationId ?? "none"}`);
    }),
  } as unknown as RuntimePersistenceV1;
  const registry = {
    readmitOverlay: (): boolean => {
      events.push("readmit");
      return true;
    },
    suspendOverlay: (): boolean => {
      events.push("suspend");
      return true;
    },
  } as unknown as NoteSessionRegistryV1;
  const gate = new RuntimeRelocationGateV1({
    publish: async (_owner, relocationId): Promise<CommandResultV1<void>> => {
      events.push(`publish:${relocationId ?? "none"}`);
      return failPublication
        ? commandFailure("relocation-pending")
        : commandSuccess(undefined);
    },
    registry,
  });
  return { events, gate, owner };
}

function fileRecord(
  relocationId: FileRelocationRecordV1["relocationId"],
): FileRelocationRecordV1 {
  return { noteIdentity: IDENTITY, relocationId } as FileRelocationRecordV1;
}
