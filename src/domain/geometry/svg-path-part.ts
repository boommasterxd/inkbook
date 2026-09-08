export interface SvgPathPart {
  readonly d: string;
  readonly paint: "fill" | "fill-and-stroke" | "stroke";
}
