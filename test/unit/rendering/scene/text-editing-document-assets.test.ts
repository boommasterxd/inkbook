// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  loadedEditorFace,
  textEditorAssetsFixture,
} from "../../../fixtures/rendering/text-editor-assets";

function mountPendingAssets(t: ReturnType<typeof textEditorAssetsFixture>) {
  let release!: (faces: FontFace[]) => void;
  t.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const assets = t.mount();
  return { release, assets };
}

it("awaits only actual loaded canonical faces before native editing and reuses each font load", async () => {
  const first = loadedEditorFace();
  const unloaded = loadedEditorFace(1, "unloaded");
  const host = { ...first, family: "Host font" };
  const t = textEditorAssetsFixture([first, unloaded, host]);
  const { release, assets } = mountPendingAssets(t);
  let ready = false;
  void assets.ready.then(() => {
    ready = true;
  });
  expect(t.target.head.querySelector("#inkbook-fonts")?.textContent).toBe(t.stylesheet());
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(t.load).toHaveBeenCalledExactlyOnceWith(`normal 400 24px ${first.family}`);
  release([first]);
  await assets.ready;
  await assets.prepare();
  expect(t.load).toHaveBeenCalledOnce();
  t.fonts.delete(unloaded);
  t.fonts.add(loadedEditorFace(1));
  await assets.prepare();
  expect(t.load).toHaveBeenCalledTimes(2);
  t.replaceStylesheet();
  await assets.prepare();
  expect(t.load).toHaveBeenCalledTimes(4);
  assets.dispose();
  assets.dispose();
  expect(t.target.head.querySelector("#inkbook-fonts")).toBeNull();
  expect(t.releaseTheme).toHaveBeenCalledOnce();
});

it("releases a cancelled pending document before a late native font result and rejects missing faces", async () => {
  const t = textEditorAssetsFixture([loadedEditorFace()]);
  const { release, assets } = mountPendingAssets(t);
  assets.dispose();
  await expect(assets.ready).rejects.toMatchObject({ name: "AbortError" });
  release([loadedEditorFace()]);
  expect(t.target.head.querySelector("#inkbook-fonts")).toBeNull();
  expect(t.releaseTheme).toHaveBeenCalledOnce();
  const missing = textEditorAssetsFixture([loadedEditorFace()]);
  missing.load.mockResolvedValueOnce([]);
  const failed = missing.mount();
  await expect(failed.ready).rejects.toThrow("font face is unavailable");
  failed.dispose();
});
