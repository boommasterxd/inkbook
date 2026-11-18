import { vi } from "vitest";
import type { FontResourceV2 } from "../../../src/domain/schema/public";
import type { SvgSceneRenderer } from "../../../src/rendering/scene/index";
import {
  ActiveTextPreparation,
  type TextFontLibraryPort,
} from "../../../src/obsidian/embeds/active-editor/text-preparation";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-session/document-model-port";
import { immediateWorkScheduler } from "./immediate-work-scheduler";

export function textPreparationFixture(
  checkpoint?: () => undefined,
  library?: TextFontLibraryPort,
) {
  const font: FontResourceV2 = {
    family: "inter",
    style: "normal",
    weight: 400,
    id: "a".repeat(64),
    data: "AA==",
    mimeType: "font/woff2",
  };
  const load = vi.fn(async () => []);
  const renderer = {
    textDocument: { fonts: { load } },
    setTextFonts: vi.fn(),
  } as unknown as SvgSceneRenderer;
  let resources = [font];
  const ensure = vi.fn((additional: readonly FontResourceV2[]) => {
    resources = [...resources, ...additional];
  });
  const model = {
    get fontResources() {
      return resources;
    },
    ensureFontResources: ensure,
  } as unknown as EditableDocumentModel;
  const prepare = new ActiveTextPreparation({
    model,
    renderer,
    ...(library ? { library } : {}),
    scheduler: {
      ...immediateWorkScheduler(),
      ...(checkpoint ? { checkpoint } : {}),
    },
  });
  return { prepare, load, renderer, ensure };
}
