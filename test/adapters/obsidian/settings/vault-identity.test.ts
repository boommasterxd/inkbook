import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  ObsidianVaultIdentityPortV1,
  recoveryDatabaseNameV1,
} from "../../../../src/adapters/obsidian/settings";

const VAULT_ID = "0123456789abcdef0123456789abcdef";

describe("Vault-local recovery identity", () => {
  it("reuses an acknowledged bounded identity", () => {
    const loadLocalStorage = vi.fn(() => VAULT_ID);
    const saveLocalStorage = vi.fn();
    const port = new ObsidianVaultIdentityPortV1({
      loadLocalStorage,
      saveLocalStorage,
    } as unknown as App);

    expect(port.resolve()).toBe(VAULT_ID);
    expect(port.resolve()).toBe(VAULT_ID);
    expect(saveLocalStorage).not.toHaveBeenCalled();
    expect(recoveryDatabaseNameV1(VAULT_ID)).toBe(
      `inkbook-recovery-${VAULT_ID}`,
    );
  });

  it("creates one Vault-local identity and requires synchronous readback", () => {
    let stored: unknown = null;
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "01234567-89ab-cdef-0123-456789abcdef",
    );
    const saveLocalStorage = vi.fn((_key: string, value: unknown) => {
      stored = value;
    });
    const port = new ObsidianVaultIdentityPortV1({
      loadLocalStorage: vi.fn(() => stored),
      saveLocalStorage,
    } as unknown as App);

    expect(port.resolve()).toBe(VAULT_ID);
    expect(port.resolve()).toBe(VAULT_ID);
    expect(saveLocalStorage).toHaveBeenCalledOnce();
  });

  it("fails closed for invalid or unacknowledged identities", () => {
    expect(recoveryDatabaseNameV1("../other-vault")).toBeNull();
    expect(
      new ObsidianVaultIdentityPortV1({
        loadLocalStorage: vi.fn(() => "invalid"),
        saveLocalStorage: vi.fn(() => {
          throw new Error("simulated write failure");
        }),
      } as unknown as App).resolve(),
    ).toBeNull();
  });
});
