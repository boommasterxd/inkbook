import { serializeSvgNumber as number } from "../../documents/svg-number";

/** Canonical ink transforms contain only pivot rotations and translations. */
export function inverseAutoPaintTransform(transform: string): string {
  const inverse: string[] = [];
  for (const match of transform.matchAll(/(rotate|translate)\(([^)]+)\)/gu)) {
    const values = match[2]!.split(" ").map(Number);
    const first = values[0]!;
    inverse.unshift(
      match[1] === "rotate"
        ? `rotate(${number(-first)} ${number(values[1]!)} ${number(values[2]!)})`
        : `translate(${number(-first)} ${number(-values[1]!)})`,
    );
  }
  return inverse.join(" ");
}
