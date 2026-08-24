import { describe, expect, it, vi } from "vitest";

import type { WorkspaceEditorCoordinator } from "../../../../src/editor/session/workspace-editor-coordinator";
import { createHeadlessRecoveryActions } from "../../../../src/obsidian/embeds/workspace-recovery-actions";

describe("workspace recovery actions", () => {
  it("routes every headless recovery decision through the coordinator", async () => {
    const resolveRecovery = vi.fn(async (_action: string, _options?: unknown) => ({
      confirmed: true,
    }));
    const retryRecovery = vi.fn(() => true);
    const coordinator = { resolveRecovery, retryRecovery } as unknown as WorkspaceEditorCoordinator;
    const reportSavedPath = vi.fn();
    const actions = createHeadlessRecoveryActions(coordinator, reportSavedPath);

    expect(actions.retry()).toBe(true);
    expect(await actions.reloadExternal()).toBe(true);
    expect(await actions.saveLocalCopy()).toBe(true);
    expect(resolveRecovery.mock.calls[0]?.[0]).toBe("reload-external");
    expect(resolveRecovery.mock.calls[1]?.[0]).toBe("save-local-copy");
    expect(resolveRecovery.mock.calls[1]?.[1]).toEqual({ reportSavedPath });
  });
});
