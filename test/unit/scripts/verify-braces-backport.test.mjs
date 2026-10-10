import { describe, expect, it, vi } from "vitest";

import { verifyBracesBackport } from "../../../scripts/verify-braces-backport.mjs";

const manifest = {
  overrides: { "braces@3.0.3": "npm:@dieub/braces-depth-guard@3.0.3-pn.3" },
};
const advisories = {
  braces: [
    {
      url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
      title:
        "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
      severity: "high",
      vulnerable_versions: "<=3.0.3",
    },
  ],
};

describe("temporary braces backport retirement", () => {
  it("accepts the reviewed backport while upstream is unchanged", async () => {
    const readVersions = vi.fn().mockResolvedValue(["1.0.0", "3.0.3", "4.0.0-beta.0"]);
    const readAdvisories = vi.fn().mockResolvedValue(advisories);
    await verifyBracesBackport(() => manifest, readVersions, readAdvisories);
    expect(readVersions).toHaveBeenCalledOnce();
    expect(readAdvisories).toHaveBeenCalledOnce();
  });

  it.each(["3.0.4", "3.1.0", "4.0.0"])(
    "requires review of official %s regardless of tag",
    async (version) => {
      await expect(
        verifyBracesBackport(
          () => manifest,
          () => ["3.0.3", version],
          vi.fn(),
        ),
      ).rejects.toThrow("remove the temporary braces override");
    },
  );

  it.each([undefined, null, {}, "", [], ["3.0.3", "invalid"], ["3.0.4-beta.0"]])(
    "rejects malformed metadata %j",
    async (versions) => {
      await expect(
        verifyBracesBackport(
          () => manifest,
          () => versions,
          vi.fn(),
        ),
      ).rejects.toThrow("Cannot verify");
    },
  );

  it("fails closed when the release registry is unavailable", async () => {
    await expect(
      verifyBracesBackport(
        () => manifest,
        () => Promise.reject(new Error("Registry unavailable")),
        vi.fn(),
      ),
    ).rejects.toThrow("Registry unavailable");
  });

  it.each([
    { "braces@3.0.3": "another-package" },
    { braces: manifest.overrides["braces@3.0.3"] },
    { "braces@^3.0.3": manifest.overrides["braces@3.0.3"] },
    { micromatch: { braces: manifest.overrides["braces@3.0.3"] } },
  ])("does not bypass retirement after changing the override: %j", async (overrides) => {
    const readVersions = vi.fn();
    await expect(
      verifyBracesBackport(() => ({ overrides }), readVersions, vi.fn()),
    ).rejects.toThrow("backport changed");
    expect(readVersions).not.toHaveBeenCalled();
  });

  it("fails closed when the advisory registry is unavailable", async () => {
    await expect(
      verifyBracesBackport(
        () => manifest,
        () => ["3.0.3"],
        () => Promise.reject(new Error("Advisory unavailable")),
      ),
    ).rejects.toThrow("Advisory unavailable");
  });

  it("stops querying both registries after the override is removed", async () => {
    const readVersions = vi.fn();
    const readAdvisories = vi.fn();
    await verifyBracesBackport(() => ({}), readVersions, readAdvisories);
    expect(readVersions).not.toHaveBeenCalled();
    expect(readAdvisories).not.toHaveBeenCalled();
  });
});
