/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact policy revisions and path fixtures are contract values. */
import { describe, expect, it } from "vitest";

import {
  createSidecarStoragePolicyStore,
  DEFAULT_SIDECAR_STORAGE_POLICY_V1,
  parseSidecarStoragePolicyV1,
  resolveNewSidecarPathV1,
  serializeSidecarStoragePolicyV1,
  sidecarStoragePolicyToLayout,
} from "../../../src/application/persistence/storage-policy";
import {
  defaultSidecarStoragePolicyV1,
  normalizeVaultRelativePath,
  validateSidecarStoragePolicyV1,
  validateSidecarPathV1,
} from "../../../src/application/persistence/validation";
import { isValidVaultRelativePathV1 } from "../../../src/application/vault-path";
import type {
  PluginDataPortV1,
  SidecarStoragePolicyV1,
} from "../../../src/application/persistence/types";

const ROOT_POLICY: SidecarStoragePolicyV1 = {
  version: 1,
  mode: "vault-root",
  vaultRelativeRoot: "Annotations",
};

function dataPort(
  loaded: unknown,
  saveData: (value: unknown) => Promise<void> = async () => undefined,
): PluginDataPortV1 {
  return {
    loadData: async () => loaded,
    saveData,
  };
}

describe("Vault-relative storage paths", () => {
  it("normalizes through the host capability and rejects a changed result", () => {
    const calls: string[] = [];
    const normalizePath = (value: string): string => {
      calls.push(value);
      return value;
    };

    expect(
      normalizeVaultRelativePath("Notes/example.md", { normalizePath }),
    ).toBe("Notes/example.md");
    expect(calls).toEqual(["Notes/example.md"]);
    expect(() =>
      normalizeVaultRelativePath("Notes/example.md", {
        normalizePath: () => "../outside/example.md",
      }),
    ).toThrow();
    expect(() =>
      normalizeVaultRelativePath("Notes/example.md", {
        normalizePath: () => "/outside/example.md",
      }),
    ).toThrow();
    expect(() =>
      normalizeVaultRelativePath("Notes/example.md", {
        normalizePath: () => "Notes/example.md",
        isWithinVault: () => false,
      }),
    ).toThrow();
  });

  it.each([
    "/Notes/example.md",
    "C:/Notes/example.md",
    "C:Notes/example.md",
    "Notes/../example.md",
    "Notes/./example.md",
    "Notes//example.md",
    "Notes/",
    "Notes\\example.md",
    "Notes/\0example.md",
    ".hidden/example.md",
    "Notes/.hidden/example.md",
    ".obsidian/example.md",
    "",
  ])("rejects unsafe path %j", (path) => {
    expect(isValidVaultRelativePathV1(path)).toBe(false);
    expect(() => validateSidecarPathV1(path)).toThrow();
  });

  it("keeps policy and sidecar layout records distinct", () => {
    const policy = validateSidecarStoragePolicyV1(ROOT_POLICY);
    expect(policy).toEqual(ROOT_POLICY);
    expect(sidecarStoragePolicyToLayout(policy)).toEqual({
      kind: "vault-root",
      vaultRelativeRoot: "Annotations",
    });
    expect(
      sidecarStoragePolicyToLayout(DEFAULT_SIDECAR_STORAGE_POLICY_V1),
    ).toEqual({ kind: "adjacent" });
    expect(() =>
      validateSidecarStoragePolicyV1({ kind: "adjacent" }),
    ).toThrow();
  });

  it("mirrors the Markdown path only for a new Vault-root sidecar", () => {
    expect(
      resolveNewSidecarPathV1(
        defaultSidecarStoragePolicyV1(),
        "Notes/Example.md",
      ),
    ).toBe("Notes/Example.inkbook.json");
    expect(resolveNewSidecarPathV1(ROOT_POLICY, "Notes/Example.md")).toBe(
      "Annotations/Notes/Example.inkbook.json",
    );
    expect(resolveNewSidecarPathV1(ROOT_POLICY, "Other/Example.md")).toBe(
      "Annotations/Other/Example.inkbook.json",
    );
    expect(() =>
      resolveNewSidecarPathV1(ROOT_POLICY, "Notes/Example.txt"),
    ).toThrow();
  });
});

describe("Sidecar storage policy acknowledgement", () => {
  it("defaults to an immutable acknowledged adjacent snapshot", async () => {
    const saved: unknown[] = [];
    const store = await createSidecarStoragePolicyStore(
      dataPort(null, async (value) => {
        saved.push(value);
      }),
    );

    expect(store.snapshot).toEqual({
      version: 1,
      revision: 1,
      policy: { version: 1, mode: "adjacent" },
    });
    expect(store.canCreateSidecar).toBe(true);
    expect(Object.isFrozen(store.snapshot)).toBe(true);
    expect(Object.isFrozen(store.snapshot.policy)).toBe(true);
    expect(saved).toHaveLength(0);
  });

  it("publishes a replacement only after saveData acknowledgement", async () => {
    let release: (() => void) | undefined;
    const saving = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = await createSidecarStoragePolicyStore(
      dataPort(null, async () => saving),
    );
    const resultPromise = store.setPolicy(ROOT_POLICY, 1);
    await Promise.resolve();

    expect(store.snapshot.policy).toEqual({ version: 1, mode: "adjacent" });
    expect(store.state.sessionOnly?.policy).toEqual(ROOT_POLICY);
    expect(store.state.writeStatus).toBe("saving");
    expect(store.canCreateSidecar).toBe(false);

    release?.();
    await expect(resultPromise).resolves.toMatchObject({
      status: "acknowledged",
    });
    expect(store.snapshot.policy).toEqual(ROOT_POLICY);
    expect(store.snapshot.revision).toBe(2);
    expect(store.state.sessionOnly).toBeNull();
    expect(store.canCreateSidecar).toBe(true);
  });

  it("serializes queued policy races against the acknowledged revision", async () => {
    const releases: (() => void)[] = [];
    const saved: unknown[] = [];
    const store = await createSidecarStoragePolicyStore(
      dataPort(null, async (value) => {
        saved.push(value);
        await new Promise<void>((resolve) => releases.push(resolve));
      }),
    );

    const first = store.setPolicy(ROOT_POLICY, 1);
    const second = store.setPolicy(DEFAULT_SIDECAR_STORAGE_POLICY_V1, 2);
    await Promise.resolve();
    expect(saved).toHaveLength(1);
    releases.shift()?.();
    await expect(first).resolves.toMatchObject({ status: "acknowledged" });
    await Promise.resolve();
    expect(saved).toHaveLength(2);
    releases.shift()?.();
    await expect(second).resolves.toMatchObject({ status: "acknowledged" });
    expect(store.snapshot).toMatchObject({
      revision: 3,
      policy: DEFAULT_SIDECAR_STORAGE_POLICY_V1,
    });
  });
});

describe("Sidecar storage policy failures", () => {
  it("keeps a failed replacement session-only and retries without changing the old acknowledgement", async () => {
    let fail = true;
    const saved: unknown[] = [];
    const store = await createSidecarStoragePolicyStore(
      dataPort(
        {
          version: 1,
          revision: 1,
          policy: { version: 1, mode: "adjacent" },
        },
        async (value) => {
          saved.push(value);
          if (fail) throw new Error("simulated save failure");
        },
      ),
    );

    await expect(store.setPolicy(ROOT_POLICY, 1)).resolves.toMatchObject({
      status: "retry-required",
    });
    expect(store.snapshot.policy).toEqual({ version: 1, mode: "adjacent" });
    expect(store.state.sessionOnly?.policy).toEqual(ROOT_POLICY);
    expect(store.state.creationBlocked).toBe(true);
    expect(store.state.writeStatus).toBe("retry-required");
    await expect(store.setPolicy(ROOT_POLICY, 1)).resolves.toMatchObject({
      status: "retry-required",
    });

    expect(
      resolveNewSidecarPathV1(store.snapshot.policy, "Notes/example.md"),
    ).toBe("Notes/example.inkbook.json");

    fail = false;
    await expect(store.retry()).resolves.toMatchObject({
      status: "acknowledged",
    });
    expect(store.snapshot.policy).toEqual(ROOT_POLICY);
    expect(store.snapshot.revision).toBe(2);
    expect(store.state.sessionOnly).toBeNull();
    expect(store.canCreateSidecar).toBe(true);
    expect(saved).toHaveLength(2);
    expect(serializeSidecarStoragePolicyV1(store.snapshot)).toEqual(saved[1]);
    await expect(store.retry()).resolves.toMatchObject({
      status: "acknowledged",
    });
  });

  it("fails closed for stale or invalid replacements", async () => {
    const store = await createSidecarStoragePolicyStore(dataPort(null));
    await expect(store.setPolicy(ROOT_POLICY, 2)).resolves.toMatchObject({
      status: "stale-revision",
    });
    await expect(
      store.setPolicy(
        { version: 1, mode: "vault-root", vaultRelativeRoot: "../bad" },
        1,
      ),
    ).resolves.toMatchObject({ status: "invalid-policy" });
    expect(store.snapshot.revision).toBe(1);
    expect(store.state.sessionOnly).toBeNull();
  });
});

describe("Sidecar storage policy revision limits", () => {
  it("fails closed when the acknowledged SettingsRevision cannot advance", async () => {
    const saved: unknown[] = [];
    const store = await createSidecarStoragePolicyStore(
      dataPort(
        {
          version: 1,
          revision: Number.MAX_SAFE_INTEGER,
          policy: { version: 1, mode: "adjacent" },
        },
        async (value) => {
          saved.push(value);
        },
      ),
    );
    const priorSnapshot = store.snapshot;
    const priorState = store.state;

    await expect(
      store.setPolicy(ROOT_POLICY, Number.MAX_SAFE_INTEGER),
    ).resolves.toEqual({
      status: "revision-exhausted",
      state: priorState,
    });
    expect(store.snapshot).toBe(priorSnapshot);
    expect(store.state).toBe(priorState);
    expect(saved).toHaveLength(0);
    expect(store.canCreateSidecar).toBe(true);
  });

  it("retains safe defaults and blocks writes for future untrusted data", async () => {
    const saved: unknown[] = [];
    const future = await createSidecarStoragePolicyStore(
      dataPort(
        { version: 2, revision: 9, policy: { version: 2, mode: "adjacent" } },
        async (value) => {
          saved.push(value);
        },
      ),
    );
    expect(future.snapshot.policy).toEqual({ version: 1, mode: "adjacent" });
    expect(future.state.loadStatus).toBe("read-only-newer-version");
    expect(future.state.creationBlocked).toBe(true);
    await expect(future.setPolicy(ROOT_POLICY, 1)).resolves.toMatchObject({
      status: "blocked-newer-version",
    });
    await expect(future.retry()).resolves.toMatchObject({
      status: "blocked-newer-version",
    });
    expect(saved).toHaveLength(0);

    expect(parseSidecarStoragePolicyV1({ mode: "adjacent" }).status).toBe(
      "defaulted-invalid",
    );
    expect(
      parseSidecarStoragePolicyV1({
        version: 1,
        revision: 1,
        policy: { version: 2, mode: "adjacent" },
      }).status,
    ).toBe("read-only-newer-version");
  });
});

describe("Sidecar storage policy parsing", () => {
  it("loads direct and legacy-wrapped policy documents", () => {
    expect(parseSidecarStoragePolicyV1(ROOT_POLICY)).toMatchObject({
      status: "loaded",
      snapshot: { revision: 1, policy: ROOT_POLICY },
    });
    expect(
      parseSidecarStoragePolicyV1({
        version: 1,
        revision: 4,
        sidecarStoragePolicy: ROOT_POLICY,
      }),
    ).toMatchObject({
      status: "loaded",
      snapshot: { revision: 4, policy: ROOT_POLICY },
    });
  });

  it.each([
    null,
    [],
    "invalid",
    { version: "1", revision: 1, policy: ROOT_POLICY },
    { version: 0, revision: 1, policy: ROOT_POLICY },
    { version: 1, revision: 0, policy: ROOT_POLICY },
    { version: 1, revision: 1 },
  ])("defaults malformed policy data without publishing it: %#", (value) => {
    expect(parseSidecarStoragePolicyV1(value)).toMatchObject({
      status: "defaulted-invalid",
      snapshot: { policy: DEFAULT_SIDECAR_STORAGE_POLICY_V1 },
    });
  });

  it("defaults when plugin data loading rejects", async () => {
    const store = await createSidecarStoragePolicyStore({
      loadData: async () => {
        throw new Error("simulated load failure");
      },
      saveData: async () => undefined,
    });

    expect(store.state.loadStatus).toBe("defaulted-invalid");
    expect(store.snapshot.policy).toEqual(DEFAULT_SIDECAR_STORAGE_POLICY_V1);
  });

  it("rejects invalid snapshot revisions before serialization", () => {
    expect(() =>
      serializeSidecarStoragePolicyV1({
        version: 1,
        revision: 0 as never,
        policy: DEFAULT_SIDECAR_STORAGE_POLICY_V1,
      }),
    ).toThrow(RangeError);
  });
});
