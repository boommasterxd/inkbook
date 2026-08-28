import type { PageV1 } from "../../src/domain/schema/public";

export const EVERY_BACKGROUND: readonly PageV1["background"][] = [
  { type: "none" },
  ...([25, 33.333333333333336, 50, 100] as const).flatMap((spacing) => [
    { spacing, type: "lines" as const },
    { spacing, type: "dots" as const },
    { spacing, type: "squares" as const },
  ]),
];
