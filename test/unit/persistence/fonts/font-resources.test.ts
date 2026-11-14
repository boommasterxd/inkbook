import { loadBuiltinFont } from "../../../../src/persistence/fonts/builtin-fonts";
import { Platform } from "obsidian";
import { describe, expect, it } from "vitest";
import { inspectFont } from "../../../../src/persistence/fonts/font-validation";
import {
  createFontResource,
  decodeFontResource,
  selectFontResources,
  validateFontResource,
} from "../../../../src/persistence/fonts/font-resources";
import { FONT_LIMITS } from "../../../../src/persistence/fonts/font-container";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

const root = new URL("../../../../src/persistence/fonts/assets/", import.meta.url);
const scheduler = new TestWorkScheduler();

async function fixture(name = "inter-400-normal.woff2"): Promise<Uint8Array<ArrayBuffer>> {
  if (Platform.isDesktop) {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(new URL(name, root)));
  }
  throw new Error("Asset fixtures require desktop test runtime.");
}

describe("font admission and portable resources", () => {
  it("admits every bundled full upstream face, including variable TrueType", async () => {
    const manifest = JSON.parse(new TextDecoder().decode(await fixture("provenance.json"))) as {
      file: string;
      sha256: string;
    }[];
    for (const entry of manifest) {
      const bytes = await fixture(entry.file);
      const resource = await createFontResource(
        bytes,
        { family: "inter", weight: 400, style: "normal" },
        scheduler,
      );
      expect(resource.id).toBe(entry.sha256);
      expect(inspectFont(bytes).tables).toBeGreaterThan(5);
      expect(await decodeFontResource(resource, scheduler)).toEqual(bytes);
    }
  });

  it("loads bundled font assets through the native asset pipeline and shares Caveat variable weights", async () => {
    const regular = await loadBuiltinFont("inter", 400, "normal", scheduler);
    expect(regular.id).toBe("e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085");
    const caveat = await loadBuiltinFont("caveat", 700, "italic", scheduler);
    expect(caveat.weightRange).toEqual([400, 700]);
    expect(caveat.weight).toBe(400);
    expect(caveat.style).toBe("normal");
    expect(caveat.license).toContain("SIL OPEN FONT LICENSE");
  });

  it("rejects truncated containers and oversized decoded WOFF2 tables", async () => {
    const bytes = await fixture();
    expect(() => inspectFont(bytes.subarray(0, bytes.length - 1))).toThrow();
    new DataView(bytes.buffer).setUint32(16, FONT_LIMITS.decodedBytes + 1);
    expect(() => inspectFont(bytes)).toThrow();
    expect(() => inspectFont(new Uint8Array(64))).toThrow();
  });

  it("binds identity to content and rejects corrupt resources", async () => {
    const resource = await createFontResource(
      await fixture(),
      { family: "inter", weight: 400, style: "normal" },
      scheduler,
    );
    await expect(validateFontResource(resource, scheduler)).resolves.toBeUndefined();
    await expect(
      validateFontResource({ ...resource, id: "0".repeat(64) }, scheduler),
    ).rejects.toThrow("identity");
    await expect(
      validateFontResource({ ...resource, data: "AAAA?===" }, scheduler),
    ).rejects.toThrow();
  });

  it("selects only used faces, shares variable weights and restricts synthetic italic", async () => {
    const inter = await createFontResource(
      await fixture(),
      { family: "inter", weight: 400, style: "normal" },
      scheduler,
    );
    const caveat = await createFontResource(
      await fixture("caveat-variable.ttf"),
      { family: "caveat", weight: 400, weightRange: [400, 700], style: "normal" },
      scheduler,
    );
    expect(
      selectFontResources(
        [inter, caveat],
        [
          { family: "caveat", weight: 400, style: "normal" },
          { family: "caveat", weight: 700, style: "italic" },
        ],
      ),
    ).toEqual([caveat]);
    expect(() =>
      selectFontResources([inter], [{ family: "inter", weight: 400, style: "italic" }]),
    ).toThrow("unavailable");
  });

  it("honors cancellation at the shared scheduling boundary", async () => {
    const controller = new AbortController();
    let admitted = 0;
    const bounded = new TestWorkScheduler({
      checkpoint: () => {
        admitted += 1;
        controller.abort();
      },
    });
    await expect(
      createFontResource(
        await fixture(),
        { family: "inter", weight: 400, style: "normal" },
        bounded,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(admitted).toBe(1);
  });
});
