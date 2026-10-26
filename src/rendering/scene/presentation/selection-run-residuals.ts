import type { MountedSceneElement } from "../content/mounted-element";
import { updatePreviewTransform } from "../content/mounted-element";
import type { MutableSceneInstrumentation } from "../types";
import type { ProgressivePreviewTransform } from "./progressive-preview-request";

type Matrix = NonNullable<ProgressivePreviewTransform["matrix"]>;
export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];
// Reserve all three six-coefficient slots, including shared/identity aliases.
// Composed base and committed matrices can be independently owned by one member.
const RESIDUAL_MEMBER_BYTES = 112 + 3 * 6 * 8;

interface Residual {
  base: string | null;
  active: string | null;
  committed: string | null;
  committedVersion: number | undefined;
  version: number;
  width: number | null;
  baseMatrix: Matrix | undefined;
  activeMatrix: Matrix | undefined;
  committedMatrix: Matrix | undefined;
}

/** Composes existing per-element feedback around the known retained group basis.
 * SVG feedback strings remain opaque; only the owned numeric group matrix is inverted. */
export class SelectionRunResiduals {
  #members = new Map<MountedSceneElement, Residual>();
  #bytes = 0;
  public retainBase(entry: MountedSceneElement): void {
    if (this.#members.has(entry)) return;
    this.registerMember(entry, entry.previewTransformVersion, entry.previewStrokeWidthScale);
  }

  private registerMember(
    entry: MountedSceneElement,
    version: number,
    width: number | null,
  ): Residual {
    const member: Residual = {
      base: entry.appliedPreviewTransform,
      active: null,
      committed: null,
      committedVersion: undefined,
      version,
      width,
      baseMatrix:
        entry.appliedPreviewTransform === null ? IDENTITY_MATRIX : entry.appliedPreviewMatrix,
      activeMatrix: IDENTITY_MATRIX,
      committedMatrix: IDENTITY_MATRIX,
    };
    this.#members.set(entry, member);
    this.#bytes += RESIDUAL_MEMBER_BYTES + entry.id.length * 2 + payload(member);
    return member;
  }

  public set(
    entry: MountedSceneElement,
    transform: string | null,
    version: number,
    width: number | null,
    matrix?: Matrix,
  ): void {
    let member = this.#members.get(entry);
    if (member === undefined) {
      if (transform === null) return;
      member = this.registerMember(entry, version, width);
    }
    const previous = payload(member);
    member.active = transform;
    member.activeMatrix = transform === null ? IDENTITY_MATRIX : matrix;
    member.version = version;
    member.width = width;
    this.#bytes += payload(member) - previous;
  }

  /** Runs in the already existing immutable delta visit, never in a release walk. */
  public capture(entry: MountedSceneElement, geometryVersion: number | undefined): void {
    const member = this.#members.get(entry);
    if (member === undefined || geometryVersion === undefined || member.active === null) return;
    const previous = payload(member);
    const composed =
      member.activeMatrix === undefined || member.committedMatrix === undefined
        ? undefined
        : composeMatrices(member.activeMatrix, member.committedMatrix);
    member.committedMatrix = composed?.every(Number.isFinite) ? composed : undefined;
    member.committed =
      member.committedMatrix === undefined
        ? join(member.active, member.committed)
        : matrixString(member.committedMatrix);
    member.active = null;
    member.activeMatrix = IDENTITY_MATRIX;
    member.committedVersion = geometryVersion;
    this.#bytes += payload(member) - previous;
  }

  /** A canonical publication changes the local geometry, not its world feedback. */
  public canonical(entry: MountedSceneElement, geometryVersion: number): void {
    const member = this.#members.get(entry);
    if (member === undefined) return;
    const previous = payload(member);
    member.base = null;
    member.baseMatrix = IDENTITY_MATRIX;
    if (member.committedVersion === geometryVersion) {
      member.committed = null;
      member.committedMatrix = IDENTITY_MATRIX;
      member.committedVersion = undefined;
    }
    this.#bytes += payload(member) - previous;
  }
  /** Transfers the same old geometry between two known invertible physical parents. */
  public reparent(
    entry: MountedSceneElement,
    previousParent: Matrix,
    nextParent: Matrix,
    zoom: number,
  ): void {
    this.retainBase(entry);
    const member = this.#members.get(entry)!;
    const inverse = inverseMatrix(nextParent);
    if (inverse === undefined) throw new Error("Run parents must remain invertible.");
    const previous = payload(member);
    const transfer = composeMatrices(inverse, previousParent);
    member.baseMatrix =
      member.baseMatrix === undefined ? undefined : composeMatrices(transfer, member.baseMatrix);
    member.base =
      member.baseMatrix === undefined
        ? join(matrixString(transfer), member.base)
        : matrixString(member.baseMatrix);
    member.width = zoom;
    this.#bytes += payload(member) - previous;
  }

  public write(
    entry: MountedSceneElement,
    parent: Matrix,
    instrumentation: MutableSceneInstrumentation,
  ): boolean {
    const member = this.#members.get(entry);
    if (member === undefined) return false;
    const desired = join(member.active, member.committed);
    let local = member.base;
    let localMatrix = member.baseMatrix;
    if (desired !== null) {
      const inverse = inverseMatrix(parent);
      if (inverse === undefined) return false;
      local = join(matrixString(inverse), desired, matrixString(parent), member.base);
      if (
        member.activeMatrix !== undefined &&
        member.committedMatrix !== undefined &&
        member.baseMatrix !== undefined
      ) {
        localMatrix = composeMatrices(
          inverse,
          composeMatrices(
            member.activeMatrix,
            composeMatrices(member.committedMatrix, composeMatrices(parent, member.baseMatrix)),
          ),
        );
        if (localMatrix.every(Number.isFinite)) local = matrixString(localMatrix);
        else localMatrix = undefined;
      } else localMatrix = undefined;
    }
    updatePreviewTransform(
      entry,
      local,
      member.version,
      member.width,
      instrumentation,
      localMatrix,
    );
    if (desired === null && member.base === null) this.release(entry);
    return true;
  }

  public release(entry: MountedSceneElement): void {
    const member = this.#members.get(entry);
    if (member !== undefined)
      this.#bytes -= RESIDUAL_MEMBER_BYTES + entry.id.length * 2 + payload(member);
    this.#members.delete(entry);
  }
  public discard(): void {
    this.#members = new Map();
    this.#bytes = 0;
  }
  public memoryUsage(): number {
    return 64 + this.#bytes;
  }
  public get size(): number {
    return this.#members.size;
  }
}
function payload(member: Residual): number {
  return (
    2 *
    ((member.base?.length ?? 0) + (member.active?.length ?? 0) + (member.committed?.length ?? 0))
  );
}

export function composeMatrices(left: Matrix, right: Matrix = IDENTITY_MATRIX): Matrix {
  const [a, b, c, d, e, f] = left,
    [g, h, i, j, k, l] = right;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}
export function inverseMatrix(matrix: Matrix): Matrix | undefined {
  const [a, b, c, d, e, f] = matrix,
    determinant = a * d - b * c;
  if (determinant === 0 || !Number.isFinite(1 / determinant)) return undefined;
  const result: Matrix = [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
  return result.every(Number.isFinite) ? result : undefined;
}
export function matrixString(matrix: Matrix): string {
  return `matrix(${matrix.join(" ")})`;
}
function join(...items: readonly (string | null | undefined)[]): string | null {
  return items.filter(Boolean).join(" ") || null;
}
