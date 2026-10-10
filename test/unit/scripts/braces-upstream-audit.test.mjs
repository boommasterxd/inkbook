import { EventEmitter } from "node:events";
import { request } from "node:https";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readBracesAdvisories,
  verifyBracesAdvisories,
  verifyBracesArtifact,
} from "../../../scripts/braces-upstream-audit.mjs";

vi.mock("node:https", () => ({ request: vi.fn() }));
afterEach(() => vi.clearAllMocks());

const artifact = {
  name: "@dieub/braces-depth-guard",
  version: "3.0.3-pn.3",
  integrity:
    "sha512-QY+Uq4s42STyIMPoRkBuUZfYyvz0uZuwuUburLwMx5N+lWqnHHaBxcKPtgKVKjTyFnS1q4ivKu9Wxi4VG7FE9Q==",
};

const known = {
  url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  title: "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
  severity: "high",
  vulnerable_versions: "<=3.0.3",
};

describe("braces HTTPS transport", () => {
  it("writes the bounded advisory request through Node HTTPS", async () => {
    const pending = new EventEmitter();
    pending.end = vi.fn();
    vi.mocked(request).mockImplementation((_url, _options, respond) => {
      const body = Readable.from([Buffer.from(JSON.stringify({ braces: [known] }))]);
      body.statusCode = 200;
      respond(body);
      return pending;
    });
    await expect(readBracesAdvisories("https://registry.npmjs.org/")).resolves.toEqual({
      braces: [known],
    });
    expect(pending.end).toHaveBeenCalledWith(JSON.stringify({ braces: ["3.0.3"] }));
  });

  it("destroys unsuccessful HTTPS responses", async () => {
    const body = { statusCode: 503, destroy: vi.fn() };
    vi.mocked(request).mockImplementation((_url, _options, respond) => {
      respond(body);
      return Object.assign(new EventEmitter(), { end: vi.fn() });
    });
    await expect(readBracesAdvisories("https://registry.npmjs.org/")).rejects.toThrow(
      "Cannot read",
    );
    expect(body.destroy).toHaveBeenCalledOnce();
  });

  it("propagates HTTPS transport errors", async () => {
    const pending = new EventEmitter();
    pending.end = () => pending.emit("error", new Error("Connection failed"));
    vi.mocked(request).mockReturnValue(pending);
    await expect(readBracesAdvisories("https://registry.npmjs.org/")).rejects.toThrow(
      "Connection failed",
    );
  });
});

describe("original braces advisory monitoring", () => {
  it("requires the exact reviewed artifact before recognizing its fix", () => {
    expect(() => verifyBracesArtifact({ packages: { backport: artifact } })).not.toThrow();
  });

  it.each([
    {},
    { packages: {} },
    { packages: { backport: { ...artifact, version: "3.0.3-pn.4" } } },
    { packages: { backport: { ...artifact, integrity: "different bytes" } } },
    { packages: { first: artifact, second: artifact } },
  ])("rejects missing, changed, or duplicated backport artifacts", (lockfile) => {
    expect(() => verifyBracesArtifact(lockfile)).toThrow("artifact changed");
  });
  it("recognizes only the exact advisory fixed by the reviewed backport", () => {
    expect(() => verifyBracesAdvisories({ braces: [known] })).not.toThrow();
    expect(() =>
      verifyBracesAdvisories({ braces: [known, { ...known, url: "new-advisory" }] }),
    ).toThrow("Unreviewed");
  });

  it.each([
    { url: "another-advisory" },
    { title: "Changed attack" },
    { severity: "critical" },
    { vulnerable_versions: "*" },
  ])("rejects a new or changed upstream advisory: %j", (change) => {
    expect(() => verifyBracesAdvisories({ braces: [{ ...known, ...change }] })).toThrow(
      "Unreviewed",
    );
  });

  it.each([undefined, null, {}, { braces: [] }, { braces: {} }, { braces: [null] }])(
    "fails closed on malformed or missing advisory data %j",
    (response) => {
      expect(() => verifyBracesAdvisories(response)).toThrow();
    },
  );

  it("requests upstream advisories independently of the fork identity", async () => {
    const fetchRegistry = vi
      .fn()
      .mockResolvedValue({ ok: true, body: [Buffer.from(JSON.stringify({ braces: [known] }))] });
    const result = await readBracesAdvisories("https://registry.npmjs.org/", fetchRegistry);
    expect(result).toEqual({ braces: [known] });
    expect(fetchRegistry).toHaveBeenCalledWith(
      new URL("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ braces: ["3.0.3"] }) }),
    );
  });

  it.each([
    { ok: false },
    { ok: true },
    { ok: true, body: [Buffer.from("not json")] },
    { ok: true, body: [Buffer.alloc(65537)] },
  ])("rejects failed, malformed, and oversized registry responses", async (response) => {
    await expect(
      readBracesAdvisories("https://registry.npmjs.org/", () => response),
    ).rejects.toThrow();
  });

  it("rejects insecure registries and propagates network failures", async () => {
    const fetchRegistry = vi.fn().mockRejectedValue(new Error("Network unavailable"));
    await expect(readBracesAdvisories("http://registry.invalid/", fetchRegistry)).rejects.toThrow(
      "HTTPS",
    );
    expect(fetchRegistry).not.toHaveBeenCalled();
    await expect(
      readBracesAdvisories("https://registry.npmjs.org/", fetchRegistry),
    ).rejects.toThrow("Network unavailable");
  });
});
