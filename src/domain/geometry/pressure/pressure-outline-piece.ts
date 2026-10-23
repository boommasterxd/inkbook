import type { PressureDisk, PressureCapsule } from "./pressure-joins";

export type PressureOutlinePiece =
  | PressureDisk
  | {
      readonly kind: "strip";
      readonly capsule: PressureCapsule;
      readonly width: number;
    };
