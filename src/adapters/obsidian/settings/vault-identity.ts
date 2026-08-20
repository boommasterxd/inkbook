import type { App } from "obsidian";

const VAULT_ID_KEY = "inkbook-vault-id-v1";
const VAULT_ID_PATTERN = /^[0-9a-f]{32}$/u;

interface VaultIdentityPortV1 {
  resolve(): string | null;
}

export class ObsidianVaultIdentityPortV1 implements VaultIdentityPortV1 {
  public constructor(private readonly app: App) {}

  public resolve(): string | null {
    try {
      const stored: unknown = this.app.loadLocalStorage(VAULT_ID_KEY);
      if (isVaultId(stored)) return stored;
      const created = createVaultId();
      if (created === null) return null;
      this.app.saveLocalStorage(VAULT_ID_KEY, created);
      const acknowledged: unknown = this.app.loadLocalStorage(VAULT_ID_KEY);
      return acknowledged === created ? created : null;
    } catch {
      return null;
    }
  }
}

export function recoveryDatabaseNameV1(vaultId: unknown): string | null {
  return isVaultId(vaultId) ? `inkbook-recovery-${vaultId}` : null;
}

function createVaultId(): string | null {
  const candidate = globalThis.crypto.randomUUID().replaceAll("-", "");
  return isVaultId(candidate) ? candidate : null;
}

function isVaultId(value: unknown): value is string {
  return typeof value === "string" && VAULT_ID_PATTERN.test(value);
}
