import { lineExample } from "./line-traces";
import type { LineRecipe } from "./line-traces";

const RECIPES: readonly LineRecipe[] = [
  {
    name: "diagonal-hesitant-launch",
    line: "straight",
    waypoints: [
      [0, 0],
      [7, -2],
      [15, 1],
      [88, -1],
      [171, 2],
      [250, 0],
    ],
    angle: -0.57,
    wave: 2.6,
  },
  {
    name: "vertical-speed-change",
    line: "straight",
    waypoints: [
      [0, 0],
      [41, 1],
      [82, -2],
      [198, 2],
      [250, 0],
    ],
    angle: 1.44,
    uneven: true,
    wave: 2,
  },
  { name: "shallow-upward-bow", line: "straight", control: [113, -9], wave: 2.1, angle: 0.37 },
  {
    name: "shallow-downward-bow",
    line: "straight",
    control: [145, 11],
    wave: 2.5,
    reverse: true,
    angle: -0.83,
  },
  {
    name: "shaky-oblique-rulerless",
    line: "straight",
    waypoints: [
      [0, 0],
      [39, 6.5],
      [79, -5],
      [129, 7],
      [191, -5.2],
      [250, 1],
    ],
    wave: 4.9,
    angle: 2.21,
  },
  {
    name: "brief-endpoint-correction",
    line: "straight",
    waypoints: [
      [0, 0],
      [85, -1],
      [184, 1.5],
      [244, 0],
      [250, -2],
      [246, 0],
    ],
    wave: 1.5,
    angle: 0.94,
  },
  { name: "deliberate-gentle-quadratic", line: "curved", control: [124, -76], wave: 2.5 },
  {
    name: "asymmetric-early-bend",
    line: "curved",
    control: [48, 144],
    uneven: true,
    wave: 2.9,
    angle: -0.39,
  },
  {
    name: "asymmetric-late-bend",
    line: "curved",
    control: [207, -132],
    reverse: true,
    wave: 2.1,
    angle: 0.68,
  },
  {
    name: "near-semicircle-single-sweep",
    line: "curved",
    arc: 2.94,
    wave: 2.8,
    uneven: true,
    angle: -0.21,
  },
  { name: "reverse-wide-arc", line: "curved", arc: 2.48, reverse: true, wave: 3.2, angle: 1.13 },
  {
    name: "curve-with-launch-tremor",
    line: "curved",
    control: [99, 104],
    endpoint: 8,
    wave: 3.4,
    uneven: true,
    angle: -1.04,
  },
];

export function lineDevelopmentExamples() {
  return RECIPES.map((recipe) => lineExample(recipe, "development"));
}
