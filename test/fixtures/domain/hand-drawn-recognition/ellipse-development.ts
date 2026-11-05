import { ellipseExample } from "./ellipse-traces";
import type { EllipseRecipe } from "./ellipse-traces";

const RECIPES: readonly EllipseRecipe[] = [
  { name: "right-start-lumpy-loop", wave: 3.1 },
  { name: "top-start-clockwise", phase: -Math.PI / 2, reverse: true, wave: 2.4 },
  { name: "oblique-start-slow-quadrants", phase: 0.69, uneven: true, wave: 2.9 },
  { name: "egg-shaped-sweep", egg: 8.5, wave: 2 },
  { name: "flattened-upper-right", flat: 0.075, wave: 2.2 },
  { name: "short-gap-before-meeting", phase: 1.8, gap: 0.012, wave: 2.8 },
  { name: "closure-passes-start", phase: 2.2, overrun: 0.027, wave: 2.6 },
  { name: "uneven-speed-tremor", uneven: true, wave: 7.3 },
  { name: "near-circle-wrist-loop", nearCircle: true, egg: 4.5, reverse: true, wave: 3.5 },
  { name: "tilted-lopsided-oval", angle: -0.62, egg: -6.5, wave: 2.5 },
  { name: "drifting-seam", drift: 6, phase: -0.9, wave: 2.7 },
  { name: "squeezed-reverse-return", reverse: true, flat: 0.06, egg: -5, uneven: true, wave: 3.4 },
];

export function ellipseDevelopmentExamples() {
  return RECIPES.map((recipe) => ellipseExample(recipe, "development"));
}
