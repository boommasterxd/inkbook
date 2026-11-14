import type { TextStyleV2 } from "../schema/types";

export interface FontFaceDescriptor {
  readonly family: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly weightRange?: readonly [number, number];
}

export function textFontFaceRequest(
  style: Pick<TextStyleV2, "fontFamily" | "bold" | "italic">,
): Omit<FontFaceDescriptor, "weightRange"> {
  return {
    family: style.fontFamily,
    weight: style.bold ? 700 : 400,
    style: style.italic ? "italic" : "normal",
  };
}

export function allowsFontSynthesis(family: string): boolean {
  return family === "caveat" || /^custom-[a-f0-9]{64}$/.test(family);
}

export function fontFacesOverlap(left: FontFaceDescriptor, right: FontFaceDescriptor): boolean {
  if (left.family !== right.family || left.style !== right.style) return false;
  const [minimum, maximum] = left.weightRange ?? [left.weight, left.weight];
  const [otherMinimum, otherMaximum] = right.weightRange ?? [right.weight, right.weight];
  return minimum <= otherMaximum && maximum >= otherMinimum;
}

/** Mirrors CSS family matching: style first, then weight, without relabeling the file. */
export function matchFontFace<T extends FontFaceDescriptor>(
  faces: readonly T[],
  request: Omit<FontFaceDescriptor, "weightRange">,
  allowFallback = allowsFontSynthesis(request.family),
): T | undefined {
  const family = faces.filter((face) => face.family === request.family);
  const exactStyle = family.filter((face) => face.style === request.style);
  const candidates = exactStyle.length > 0 ? exactStyle : allowFallback ? family : [];
  let best: { face: T; group: number; distance: number } | undefined;
  for (const face of candidates) {
    const [minimum, maximum] = face.weightRange ?? [face.weight, face.weight];
    if (minimum <= request.weight && maximum >= request.weight) return face;
    if (!allowFallback) continue;
    const weight = maximum < request.weight ? maximum : minimum;
    const group = weightGroup(request.weight, weight);
    const distance = Math.abs(request.weight - weight);
    if (
      best === undefined ||
      group < best.group ||
      (group === best.group && distance < best.distance)
    ) {
      best = { face, group, distance };
    }
  }
  return best?.face;
}

function weightGroup(request: number, available: number): number {
  if (request < 400) return available < request ? 0 : 1;
  if (request > 500) return available > request ? 0 : 1;
  if (available >= request && available <= 500) return 0;
  return available < request ? 1 : 2;
}
