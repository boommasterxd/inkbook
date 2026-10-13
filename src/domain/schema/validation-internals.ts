import {
  isCanonicalGeometryNumber,
  isCanonicalRotation,
  isCanonicalUnitIntervalNumber,
  isLowercaseUuidV4,
  isRgbaColor,
} from "./canonical";
import { MAX_JSON_DEPTH, type SchemaLimits } from "./constants";
import type {
  ValidationError,
  ValidationErrorCode,
  ValidationStatistics,
} from "./validation-types";
import type { StrokeSampleExtrema } from "./stroke-sample-extrema";
import { isCapturedJsonSampleArray } from "../elements/runtime-sample-copy-producer";

class ValidationFailure extends Error {
  readonly validationError: ValidationError;

  constructor(validationError: ValidationError) {
    super(validationError.message);
    this.name = "ValidationFailure";
    this.validationError = validationError;
  }
}

export interface ValidationContext {
  allowRuntimeStrokeBuffers?: boolean;
  parsedProof?: {
    consumeDecodedStrokeSamples(samples: object): StrokeSampleExtrema | undefined;
  };
  limits: Readonly<SchemaLimits>;
  statistics: ValidationStatistics;
}

export function createStatistics(): ValidationStatistics {
  return {
    connectedEndpoints: 0,
    elements: 0,
    maximumDepth: 0,
    spatialIndexCellMemberships: 0,
    spatialIndexOverflowElements: 0,
    strokePoints: 0,
    strokes: 0,
  };
}

export function fail(code: ValidationErrorCode, path: string, message: string): never {
  throw new ValidationFailure({ code, path, message });
}

export function assertJsonTree(
  value: unknown,
  maximumNodes = Number.MAX_SAFE_INTEGER,
  maximumContainerEntries = maximumNodes,
): number {
  const steps = assertJsonTreeSteps(value, maximumNodes, 2048, false, maximumContainerEntries);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export function* assertJsonTreeSteps(
  value: unknown,
  maximumNodes = Number.MAX_SAFE_INTEGER,
  nodesPerStep = 2048,
  allowRuntimeStrokeBuffers = false,
  maximumContainerEntries = maximumNodes,
): Generator<void, number> {
  const state = { maximumDepth: 1, nodes: 0 };
  yield* visitJsonValue(value, 1, "$", {
    allowRuntimeStrokeBuffers,
    maximumContainerEntries,
    maximumNodes,
    nodesPerStep,
    state,
  });
  return state.maximumDepth;
}

export function jsonNodeBudget(limits: Readonly<SchemaLimits>): number {
  return limits.strokePoints * 3 + limits.elements * 64 + 1024;
}

export function jsonContainerBudget(limits: Readonly<SchemaLimits>): number {
  return Math.max(limits.elements, limits.pointsPerStroke * 3, 64);
}

interface JsonWalkOptions {
  readonly allowRuntimeStrokeBuffers: boolean;
  readonly maximumContainerEntries: number;
  readonly maximumNodes: number;
  readonly nodesPerStep: number;
  readonly state: { maximumDepth: number; nodes: number };
}

function* visitJsonValue(
  value: unknown,
  depth: number,
  path: string,
  options: JsonWalkOptions,
): Generator<void, void> {
  options.state.nodes += 1;
  if (options.state.nodes > options.maximumNodes) {
    fail("json-node-limit-exceeded", path, "JSON value count exceeds the validation budget.");
  }
  if (options.state.nodes % options.nodesPerStep === 0) yield;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid-number", path, "Numbers must be finite.");
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value !== "object") {
    fail("invalid-json-value", path, "The value is not valid JSON data.");
  }
  if (depth > MAX_JSON_DEPTH) {
    fail("maximum-depth-exceeded", path, `JSON nesting must not exceed ${MAX_JSON_DEPTH} levels.`);
  }
  options.state.maximumDepth = Math.max(options.state.maximumDepth, depth);
  if (options.allowRuntimeStrokeBuffers && value instanceof Float64Array) return;
  if (Array.isArray(value)) {
    if (isCapturedJsonSampleArray(value)) {
      assertContainerWidth(value.length, path, options.maximumContainerEntries);
      const remainingNodes = options.maximumNodes - options.state.nodes;
      if (value.length > remainingNodes) {
        fail(
          "json-node-limit-exceeded",
          `${path}[${Math.floor(remainingNodes)}]`,
          "JSON value count exceeds the validation budget.",
        );
      }
      options.state.nodes += value.length;
      return;
    }
    yield* visitArrayValues(value, depth, path, options);
  } else {
    yield* visitRecordValues(value, depth, path, options);
  }
}

function* visitArrayValues(
  value: unknown[],
  depth: number,
  path: string,
  options: JsonWalkOptions,
): Generator<void, void> {
  assertContainerWidth(value.length, path, options.maximumContainerEntries);
  let enumerableEntries = 0;
  // eslint-disable-next-line @typescript-eslint/no-for-in-array -- A bounded for-in walk avoids allocating a hostile wide key array.
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    enumerableEntries += 1;
    if (enumerableEntries > options.maximumContainerEntries || !isArrayIndex(key, value.length)) {
      fail("invalid-json-value", path, "Arrays must contain indexed values only.");
    }
    if (enumerableEntries % options.nodesPerStep === 0) yield;
  }
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail("invalid-json-value", `${path}[${index}]`, "Sparse arrays are invalid.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      fail(
        "invalid-json-value",
        `${path}[${index}]`,
        "Array entries must be enumerable data values.",
      );
    }
    if ((value.length - index) % options.nodesPerStep === 0) yield;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!;
    yield* visitJsonValue(descriptor.value, depth + 1, `${path}[${index}]`, options);
  }
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function* visitRecordValues(
  value: object,
  depth: number,
  path: string,
  options: JsonWalkOptions,
): Generator<void, void> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid-json-value", path, "Objects must use a plain JSON object prototype.");
  }
  let entries = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    entries += 1;
    assertContainerWidth(entries, path, options.maximumContainerEntries);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      fail("invalid-json-value", `${path}.${key}`, "Properties must be enumerable data values.");
    }
    yield* visitJsonValue(descriptor.value, depth + 1, `${path}.${key}`, options);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail("invalid-json-value", path, "Objects must not contain symbol properties.");
  }
}

function assertContainerWidth(length: number, path: string, maximum: number): void {
  if (length > maximum) {
    fail("json-node-limit-exceeded", path, "JSON container exceeds the validation budget.");
  }
}

export type UnknownRecord = Record<string, unknown>;

export function assertRecord(value: unknown, path: string): asserts value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-type", path, "Expected an object.");
  }
}

export function assertExactKeys(value: UnknownRecord, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail("unknown-property", `${path}.${key}`, "Unknown property.");
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key))
      fail("missing-property", `${path}.${key}`, "Required property missing.");
  }
}

export function assertLiteral<T extends string | number | boolean | null>(
  value: unknown,
  expected: T,
  path: string,
): asserts value is T {
  if (value !== expected) fail("invalid-literal", path, `Expected ${String(expected)}.`);
}

export function assertOneOf<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): asserts value is T {
  if (!allowed.some((item) => item === value)) {
    fail("invalid-literal", path, "Value is not part of the supported enumeration.");
  }
}

export function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") fail("invalid-type", path, "Expected a boolean.");
}

export function assertSafeInteger(
  value: unknown,
  minimum: number,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail("invalid-number", path, "Expected a safe integer in the supported range.");
  }
}

export function assertIntegerRange(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    fail("invalid-range", path, `Expected an integer from ${minimum} through ${maximum}.`);
  }
}

export function assertGeometryNumber(
  value: unknown,
  path: string,
  absoluteLimit: number,
): asserts value is number {
  if (!isCanonicalGeometryNumber(value)) {
    fail("invalid-number", path, "Expected finite canonical geometry with at most three decimals.");
  }
  if (Math.abs(value) > absoluteLimit) {
    fail("invalid-range", path, `Absolute geometry must not exceed ${absoluteLimit}.`);
  }
}

export function assertUnitInterval(value: unknown, path: string): asserts value is number {
  if (!isCanonicalUnitIntervalNumber(value)) {
    fail("invalid-range", path, "Expected a canonical number from 0 through 1.");
  }
}

export function assertRotation(value: unknown, path: string): asserts value is number {
  if (!isCanonicalRotation(value)) {
    fail("invalid-range", path, "Expected canonical rotation in the range [-180, 180).");
  }
}

export function assertUuid(value: unknown, path: string): asserts value is string {
  if (!isLowercaseUuidV4(value)) fail("invalid-uuid", path, "Expected a lowercase UUID v4.");
}

export function assertRgba(value: unknown, path: string): asserts value is `#${string}` {
  if (!isRgbaColor(value)) fail("invalid-color", path, "Expected an uppercase #RRGGBBAA color.");
}

export function toValidationError(error: unknown): ValidationError {
  if (error instanceof ValidationFailure) return error.validationError;
  return {
    code: "invalid-json-value",
    path: "$",
    message: "Input could not be inspected as plain JSON data.",
  };
}
