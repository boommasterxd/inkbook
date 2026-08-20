import { describe, expect, it } from "vitest";

import {
  ANNOTATION_MARKER_KEY,
  applySidecarMarker,
  removeSidecarMarker,
  SIDECAR_LOCATOR_KEY,
  SidecarMarkerWriter,
} from "../../../../src/adapters/obsidian/vault-sidecar/marker";
import { fakeFile, FakeFrontMatterHost } from "./support";

describe("sidecar YAML marker", () => {
  it("changes only the two owned keys and preserves foreign frontmatter", async () => {
    const host = new FakeFrontMatterHost({
      aliases: ["Course"],
      cssclasses: "wide",
      [ANNOTATION_MARKER_KEY]: false,
      [SIDECAR_LOCATOR_KEY]: "Old.inkbook.json",
    });
    const writer = new SidecarMarkerWriter(host);
    await expect(
      writer.set(fakeFile("Notes/A.md"), "Notes/A.inkbook.json"),
    ).resolves.toEqual({ kind: "acknowledged" });
    expect(host.frontmatter).toEqual({
      aliases: ["Course"],
      cssclasses: "wide",
      [ANNOTATION_MARKER_KEY]: true,
      [SIDECAR_LOCATOR_KEY]: "Notes/A.inkbook.json",
    });
  });

  it("exposes synchronous callbacks with no host access and removes only owned keys", () => {
    const source = { foreign: 1 };
    expect(applySidecarMarker(source, "A.inkbook.json")).toBeUndefined();
    expect(source).toEqual({
      foreign: 1,
      [ANNOTATION_MARKER_KEY]: true,
      [SIDECAR_LOCATOR_KEY]: "A.inkbook.json",
    });
    expect(removeSidecarMarker(source)).toBeUndefined();
    expect(source).toEqual({ foreign: 1 });
  });

  it("fails without changing unrelated values when the host rejects", async () => {
    const failure = new Error("Invalid YAML");
    const host = new FakeFrontMatterHost({ foreign: "value" });
    host.rejectWith = failure;
    const writer = new SidecarMarkerWriter(host);
    await expect(
      writer.set(fakeFile("A.md"), "A.inkbook.json"),
    ).resolves.toEqual({ kind: "failed", error: failure });
    expect(host.frontmatter).toEqual({ foreign: "value" });
  });

  it("compare-and-sets the locator through the synchronous marker callback", async () => {
    const host = new FakeFrontMatterHost({
      foreign: "preserved",
      [ANNOTATION_MARKER_KEY]: true,
      [SIDECAR_LOCATOR_KEY]: "A.inkbook.json",
    });
    const writer = new SidecarMarkerWriter(host);
    await expect(
      writer.compareAndSetLocator(
        fakeFile("A.md"),
        "A.inkbook.json",
        "Archive/A.inkbook.json",
      ),
    ).resolves.toEqual({ kind: "acknowledged" });
    expect(host.frontmatter).toEqual({
      foreign: "preserved",
      [ANNOTATION_MARKER_KEY]: true,
      [SIDECAR_LOCATOR_KEY]: "Archive/A.inkbook.json",
    });
  });

  it("rejects a stale marker locator without mutating any key", async () => {
    const initial = {
      foreign: "preserved",
      [ANNOTATION_MARKER_KEY]: true,
      [SIDECAR_LOCATOR_KEY]: "External.inkbook.json",
    };
    const host = new FakeFrontMatterHost(initial);
    await expect(
      new SidecarMarkerWriter(host).compareAndSetLocator(
        fakeFile("A.md"),
        "A.inkbook.json",
        "Archive/A.inkbook.json",
      ),
    ).resolves.toEqual({ kind: "conflict" });
    expect(host.frontmatter).toEqual(initial);
  });
});

describe("legacy sidecar YAML marker adoption", () => {
  it("adopts a locator only while the exact legacy marker remains", async () => {
    const host = new FakeFrontMatterHost({
      foreign: "preserved",
      [ANNOTATION_MARKER_KEY]: true,
    });
    await expect(
      new SidecarMarkerWriter(host).adoptLegacyLocator(
        fakeFile("A.md"),
        "A.inkbook.json",
      ),
    ).resolves.toEqual({ kind: "acknowledged" });
    expect(host.frontmatter).toEqual({
      foreign: "preserved",
      [ANNOTATION_MARKER_KEY]: true,
      [SIDECAR_LOCATOR_KEY]: "A.inkbook.json",
    });
  });

  it("does not overwrite a locator added during legacy discovery", async () => {
    const initial = {
      [ANNOTATION_MARKER_KEY]: true,
      [SIDECAR_LOCATOR_KEY]: "External.inkbook.json",
    };
    const host = new FakeFrontMatterHost(initial);
    await expect(
      new SidecarMarkerWriter(host).adoptLegacyLocator(
        fakeFile("A.md"),
        "A.inkbook.json",
      ),
    ).resolves.toEqual({ kind: "conflict" });
    expect(host.frontmatter).toEqual(initial);
  });
});

describe("sidecar YAML marker lifecycle", () => {
  it("honors cancellation and idempotent disposal before host mutation", async () => {
    const host = new FakeFrontMatterHost({ foreign: true });
    const writer = new SidecarMarkerWriter(host);
    const controller = new AbortController();
    controller.abort();
    await expect(
      writer.set(fakeFile("A.md"), "A.inkbook.json", controller.signal),
    ).resolves.toEqual({ kind: "cancelled" });
    writer.dispose();
    writer.dispose();
    await expect(writer.remove(fakeFile("A.md"))).resolves.toEqual({
      kind: "cancelled",
    });
    expect(host.calls).toBe(0);
  });
});
