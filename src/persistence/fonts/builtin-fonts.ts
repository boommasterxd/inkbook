import type { FontResourceV2 } from "../../domain/schema/types";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { createFontResource, decodeFontResource } from "./font-resources";
import inter400normal from "./assets/inter-400-normal.woff2?inline";
import inter400italic from "./assets/inter-400-italic.woff2?inline";
import inter700normal from "./assets/inter-700-normal.woff2?inline";
import inter700italic from "./assets/inter-700-italic.woff2?inline";
import interLicense from "./assets/inter-OFL.txt?raw";
import sourceserif400normal from "./assets/source-serif-400-normal.woff2?inline";
import sourceserif400italic from "./assets/source-serif-400-italic.woff2?inline";
import sourceserif700normal from "./assets/source-serif-700-normal.woff2?inline";
import sourceserif700italic from "./assets/source-serif-700-italic.woff2?inline";
import sourceserifLicense from "./assets/source-serif-OFL.txt?raw";
import jetbrainsmono400normal from "./assets/jetbrains-mono-400-normal.woff2?inline";
import jetbrainsmono400italic from "./assets/jetbrains-mono-400-italic.woff2?inline";
import jetbrainsmono700normal from "./assets/jetbrains-mono-700-normal.woff2?inline";
import jetbrainsmono700italic from "./assets/jetbrains-mono-700-italic.woff2?inline";
import jetbrainsmonoLicense from "./assets/jetbrains-mono-OFL.txt?raw";
import caveat from "./assets/caveat-variable.ttf?inline";
import caveatLicense from "./assets/caveat-OFL.txt?raw";

export const BUILTIN_FONT_FAMILIES = ["inter", "source-serif", "caveat", "jetbrains-mono"] as const;

const FACES = [
  {
    family: "inter",
    weight: 400,
    style: "normal" as const,
    data: inter400normal,
    mimeType: "font/woff2" as const,
    license: interLicense,
  },
  {
    family: "inter",
    weight: 400,
    style: "italic" as const,
    data: inter400italic,
    mimeType: "font/woff2" as const,
    license: interLicense,
  },
  {
    family: "inter",
    weight: 700,
    style: "normal" as const,
    data: inter700normal,
    mimeType: "font/woff2" as const,
    license: interLicense,
  },
  {
    family: "inter",
    weight: 700,
    style: "italic" as const,
    data: inter700italic,
    mimeType: "font/woff2" as const,
    license: interLicense,
  },
  {
    family: "source-serif",
    weight: 400,
    style: "normal" as const,
    data: sourceserif400normal,
    mimeType: "font/woff2" as const,
    license: sourceserifLicense,
  },
  {
    family: "source-serif",
    weight: 400,
    style: "italic" as const,
    data: sourceserif400italic,
    mimeType: "font/woff2" as const,
    license: sourceserifLicense,
  },
  {
    family: "source-serif",
    weight: 700,
    style: "normal" as const,
    data: sourceserif700normal,
    mimeType: "font/woff2" as const,
    license: sourceserifLicense,
  },
  {
    family: "source-serif",
    weight: 700,
    style: "italic" as const,
    data: sourceserif700italic,
    mimeType: "font/woff2" as const,
    license: sourceserifLicense,
  },
  {
    family: "jetbrains-mono",
    weight: 400,
    style: "normal" as const,
    data: jetbrainsmono400normal,
    mimeType: "font/woff2" as const,
    license: jetbrainsmonoLicense,
  },
  {
    family: "jetbrains-mono",
    weight: 400,
    style: "italic" as const,
    data: jetbrainsmono400italic,
    mimeType: "font/woff2" as const,
    license: jetbrainsmonoLicense,
  },
  {
    family: "jetbrains-mono",
    weight: 700,
    style: "normal" as const,
    data: jetbrainsmono700normal,
    mimeType: "font/woff2" as const,
    license: jetbrainsmonoLicense,
  },
  {
    family: "jetbrains-mono",
    weight: 700,
    style: "italic" as const,
    data: jetbrainsmono700italic,
    mimeType: "font/woff2" as const,
    license: jetbrainsmonoLicense,
  },
  {
    family: "caveat",
    weightRange: [400, 700] as [number, number],
    weight: 400,
    style: "normal" as const,
    data: caveat,
    mimeType: "font/ttf" as const,
    license: caveatLicense,
  },
];

/** Decode and hash only the requested built-in face. Callers retain resources per document. */
export async function loadBuiltinFont(
  family: string,
  weight: number,
  style: "normal" | "italic",
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<FontResourceV2> {
  const face = FACES.find(
    (candidate) =>
      candidate.family === family &&
      (candidate.weight === weight ||
        (candidate.family === "caveat" && weight >= 400 && weight <= 700)) &&
      candidate.style === (family === "caveat" ? "normal" : style),
  );
  if (face === undefined) throw new RangeError("Unknown built-in font face.");
  const bytes = await decodeFontResource(
    {
      data: face.data.startsWith("data:") ? face.data.slice(face.data.indexOf(",") + 1) : face.data,
    },
    scheduler,
    signal,
  );
  return createFontResource(
    bytes,
    {
      family: face.family,
      weight: face.weight,
      style: face.style,
      ...("weightRange" in face ? { weightRange: face.weightRange } : {}),
      license: face.license,
    },
    scheduler,
    signal,
  );
}
