import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, TFile, type Vault } from "obsidian";
import { ObsidianInkbookDocumentRecognition } from "../../../src/obsidian/embeds/document-recognition";
import { createLivePreviewExtension } from "../../../src/obsidian/embeds/live-preview";
import { PresentationOperationFeedback } from "../../../src/obsidian/embeds/presentation-operation-feedback";
import { FakePresentationElement } from "../../fixtures/obsidian/presentation-dom";
import type { EmbedIntegrationPorts } from "../../../src/obsidian/embeds/presentation-port";
import { configureTestEditorState } from "../../adapters/obsidian/plugin";
import { describe, expect, it } from "vitest";
import { timingBudget } from "../timing-budget";

import { LivePreviewEntrances } from "../../../src/obsidian/embeds/live-preview-entrances";
import { MARKDOWN_EMBED_LIMITS } from "../../../src/obsidian/embeds/markdown-embed";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";

const capacity = MARKDOWN_EMBED_LIMITS.matches;
const spacing = 40;
const tokenLength = 30;
const documentLength = (capacity + 1) * spacing;
const sourcePath = "note.md";
const documentId = "handwriting.svg";

function retainedEntrances() {
  const entrances = new LivePreviewEntrances(sourcePath);
  const tokens = Array.from({ length: capacity }, (_, index) => {
    const from = (index + 1) * spacing;
    const token = entrances.stateFor(from, from + tokenLength, documentId);
    token.presented = index % 2 === 0;
    if (!token.presented) token.initialHeight = 48;
    return token;
  });
  return { entrances, tokens };
}

describe("Live Preview retained entrance performance", () => {
  it("maps a leading text insertion and retains ready and pending occurrences within the frame budget", async ({
    annotate,
  }) => {
    const { entrances, tokens } = retainedEntrances();
    const changes = ChangeSet.of({ from: 0, insert: "x" }, documentLength);
    const durations: number[] = [];
    let mismatches = 0;
    for (let sample = -100; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
      const started = performance.now();
      const mapped = entrances.update(changes, sourcePath);
      for (let index = 0; index < capacity; index += 1) {
        const from = (index + 1) * spacing + 1;
        if (mapped.stateFor(from, from + tokenLength, documentId) !== tokens[index])
          mismatches += 1;
      }
      if (sample >= 0) durations.push(performance.now() - started);
    }
    expect(mismatches).toBe(0);
    const p99 = interactionP99(durations);
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    await annotate(
      `Leading insertion with ${String(capacity)} retained entrances p99=${p99.toFixed(3)} ms`,
      "performance",
    );
  });

  it("releases the full removed range within the frame budget and makes capacity reusable", async ({
    annotate,
  }) => {
    const { entrances, tokens } = retainedEntrances();
    const changes = ChangeSet.of({ from: 0, to: documentLength }, documentLength);
    const durations: number[] = [];
    let cleared = entrances;
    for (let sample = -100; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
      const started = performance.now();
      cleared = entrances.update(changes, sourcePath);
      if (sample >= 0) durations.push(performance.now() - started);
    }
    for (let index = 0; index < capacity; index += 1) {
      const from = (index + 1) * spacing;
      const fresh = cleared.stateFor(from, from + tokenLength, documentId);
      expect(fresh).not.toBe(tokens[index]);
      expect(fresh.presented).toBe(false);
      expect(cleared.stateFor(from, from + tokenLength, documentId)).toBe(fresh);
    }
    const p99 = interactionP99(durations);
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    await annotate(
      `Full removal of ${String(capacity)} retained entrances p99=${p99.toFixed(3)} ms`,
      "performance",
    );
  });
});

it("retains maximum-capacity pending decorations on unchanged host transactions within the frame budget", async ({
  annotate,
}) => {
  let resolutions = 0;
  const ports = {
    documents: { cached: () => undefined },
    resolveDocument: () => {
      resolutions += 1;
      return { documentId, resourceUrl: "app://handwriting.svg" };
    },
  } as unknown as EmbedIntegrationPorts;
  configureTestEditorState({ file: { path: sourcePath }, livePreview: true });
  let state = EditorState.create({
    doc: Array.from({ length: capacity }, () => "!inkbook[[handwriting.svg]]").join("\n\n"),
    extensions: [editorInfoField, editorLivePreviewField, createLivePreviewExtension(ports)],
  });
  const initial = state.facet(EditorView.decorations)[0];
  const durations: number[] = [];
  for (let sample = -100; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
    const started = performance.now();
    state = state.update({}).state;
    if (sample >= 0) durations.push(performance.now() - started);
  }
  expect(state.facet(EditorView.decorations)[0]).toBe(initial);
  expect(resolutions).toBe(capacity);
  const p99 = interactionP99(durations);
  expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
  await annotate(
    `Unchanged context with ${String(capacity)} pending embeds p99=${p99.toFixed(3)} ms`,
    "performance",
  );
});

it("hands off overdue loading feedback synchronously within the frame budget", async ({
  annotate,
}) => {
  const root = new FakePresentationElement();
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  let scheduledWork = 0;
  Object.assign(ownerWindow, {
    performance: { now: () => 1000 },
    requestAnimationFrame: () => ++scheduledWork,
    setTimeout: () => ++scheduledWork,
  });
  const feedback = new PresentationOperationFeedback(root as unknown as HTMLElement);
  const durations: number[] = [];
  let invalidIndicators = 0;
  let retainedIndicators = 0;
  for (let sample = -100; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
    const started = performance.now();
    const operation = feedback.begin("loading", 0);
    const indicators = root.getElementsByClassName("inkbook-operation-feedback");
    const indicator = indicators.item(0);
    if (
      indicators.length !== 1 ||
      indicator?.style.insetBlockStart !== "50px" ||
      indicator.style.insetInlineStart !== "300px"
    ) {
      invalidIndicators += 1;
    }
    operation.finish();
    if (sample >= 0) durations.push(performance.now() - started);
    retainedIndicators += root.children.length;
  }
  feedback.dispose();
  expect(invalidIndicators).toBe(0);
  expect(retainedIndicators).toBe(0);
  expect(scheduledWork).toBe(0);
  const p99 = interactionP99(durations);
  expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
  await annotate(`Overdue loading feedback handoff p99=${p99.toFixed(3)} ms`, "performance");
});

it("positions detached loading feedback after attachment within the frame budget", async ({
  annotate,
}) => {
  const root = new FakePresentationElement();
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let timers = 0;
  Object.assign(ownerWindow, {
    performance: { now: () => 1000 },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (handle: number) => frames.delete(handle),
    setTimeout: () => ++timers,
  });
  const durations: number[] = [];
  let invalidPositions = 0;
  let retainedResources = 0;
  for (let sample = -100; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
    root.isConnected = false;
    const feedback = new PresentationOperationFeedback(root as unknown as HTMLElement);
    const started = performance.now();
    feedback.begin("loading", 0);
    const indicators = root.getElementsByClassName("inkbook-operation-feedback");
    const indicator = indicators.item(0);
    if (
      indicators.length !== 1 ||
      indicator?.classNames.has("inkbook-feedback-unmeasured") !== true ||
      frames.size !== 1
    ) {
      invalidPositions += 1;
    }
    root.isConnected = true;
    for (const [handle, callback] of frames) {
      frames.delete(handle);
      callback(0);
    }
    if (
      indicator?.style.insetBlockStart !== "50px" ||
      indicator.style.insetInlineStart !== "300px"
    ) {
      invalidPositions += 1;
    }
    feedback.dispose();
    if (sample >= 0) durations.push(performance.now() - started);
    retainedResources += root.children.length + frames.size;
  }
  expect(invalidPositions).toBe(0);
  expect(retainedResources).toBe(0);
  expect(timers).toBe(0);
  const p99 = interactionP99(durations);
  expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
  await annotate(`Detached loading feedback attachment p99=${p99.toFixed(3)} ms`, "performance");
});

it("admits and completes recognition with bounded cache eviction within the frame budget", async ({
  annotate,
}) => {
  const File = TFile as unknown as new (path: string, size: number) => TFile;
  const files = Array.from(
    { length: INTERACTION_REFRESH_PROFILE.sampleCount + 300 },
    (_, index) => new File(`${String(index)}.svg`, 10),
  );
  const byPath = new Map(files.map((file) => [file.path, file]));
  const recognition = new ObsidianInkbookDocumentRecognition({
    getFileByPath: (path: string) => byPath.get(path) ?? null,
    cachedRead: async () => "invalid",
  } as unknown as Vault);
  const durations: number[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const started = performance.now();
    await recognition.recognize(files[index]!.path);
    if (index >= 300) durations.push(performance.now() - started);
  }
  expect(files.filter((file) => recognition.cached(file.path) !== undefined)).toHaveLength(256);
  recognition.dispose();
  const p99 = interactionP99(durations);
  expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
  await annotate(
    `Recognition admission and cache eviction p99=${p99.toFixed(3)} ms`,
    "performance",
  );
});
