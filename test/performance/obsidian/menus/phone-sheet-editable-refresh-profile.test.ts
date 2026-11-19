// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { Platform } from "obsidian";
import { expect, it, onTestFinished, vi } from "vitest";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  createPhoneSheetEditableFixture,
  observeSheetOcclusion,
} from "../../../fixtures/obsidian/phone-sheet-editable";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";

it("bounds focused-field reads across viewport retargets and performs one final correction", async () => {
  const { frameDurationMs, sampleCount } = INTERACTION_REFRESH_PROFILE;
  installObsidianDomHelpers();
  Platform.isPhone = true;
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Platform.isPhone = false;
    document.body.replaceChildren();
  });
  const fixture = createPhoneSheetEditableFixture(false, "full");
  onTestFinished(() => {
    try {
      fixture.session.close("immediate");
    } finally {
      fixture.restore();
    }
  });
  const occlusionRead = observeSheetOcclusion(fixture);
  for (let frame = 0; frame < sampleCount; frame += 1) {
    fixture.viewport.height = frame % 2 === 0 ? 300 : 400;
    for (let event = 0; event < 3; event += 1) fixture.viewport.dispatchEvent(new Event("resize"));
    expect(fixture.frames.pendingCount).toBe(1);
    fixture.frames.runNext(frame * frameDurationMs);
    await fixture.advanceMotion(frameDurationMs, frameDurationMs);
  }
  expect(fixture.inputReadCount).toBe(sampleCount);
  expect(fixture.scrollReadCount).toBe(sampleCount);
  await fixture.advanceMotion(300, frameDurationMs);
  expect(fixture.frames.pendingCount).toBe(1);
  occlusionRead.mockReturnValue(new DOMRect(0, 180, 360, 270));
  fixture.frames.runNext(sampleCount * frameDurationMs + 300);
  expect(fixture.inputReadCount).toBe(sampleCount + 1);
  expect(fixture.scrollReadCount).toBe(sampleCount + 1);
  expect(occlusionRead).toHaveBeenCalledTimes(sampleCount + 1);
  expect(fixture.session.occlusionTop).toBe(180);
  expect(fixture.frames.pendingCount).toBe(0);
  fixture.session.close("immediate");
  await fixture.advanceMotion(300, frameDurationMs);
  expect(fixture.frames.pendingCount).toBe(0);
  expect(fixture.inputReadCount).toBe(sampleCount + 1);
});
