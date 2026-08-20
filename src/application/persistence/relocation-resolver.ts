import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1, RelocationId } from "../note-session/types";
import { isNormalizedVaultPath, isNormalizedVaultPrefix } from "../recovery";

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
const NO_PREFIX_LENGTH = -1;
const STATE_OVERHEAD_BYTES = 64;
const TRANSITION_OVERHEAD_BYTES = 16;
const UTF8_ONE_BYTE_MAX = 0x7f;
const UTF8_TWO_BYTE_MAX = 0x7ff;
const UTF8_THREE_BYTE_MAX = 0xffff;
const UTF8_TWO_BYTES = 2;
const UTF8_THREE_BYTES = 3;
const UTF8_FOUR_BYTES = 4;

export const RELOCATION_LIMITS_V1 = Object.freeze({
  maxPrefixRules: 128,
  maxResolverBytes: MEBIBYTE,
  maxResolverHops: 32,
  maxResolverStates: 4096,
  maxResolverTransitions: 8192,
  maxPrefixBatchRecords: 512,
  maxPrefixPlanMembers: 4096,
});

export interface PrefixRelocationRuleV1 {
  readonly relocationId: RelocationId;
  readonly priorPrefix: string;
  readonly replacementPrefix: string;
  readonly generation: number;
}

export interface RelocatedPathResolutionV1 {
  readonly path: string;
  readonly relocationIds: readonly RelocationId[];
  readonly visitedStates: number;
  readonly traversedTransitions: number;
}

type RelocatedStorageRootV1 =
  | Readonly<{
      kind: "not-affected";
      vaultRelativeRoot: string;
    }>
  | Readonly<{
      kind: "replacement";
      vaultRelativeRoot: string;
    }>;

interface ResolverState {
  readonly path: string;
  readonly generation: number;
  readonly hops: number;
  readonly predecessor: string | null;
  readonly rule: PrefixRelocationRuleV1 | null;
}

export function resolveRelocatedPath(
  sourcePath: string,
  targetPath: string,
  rules: readonly PrefixRelocationRuleV1[],
): CommandResultV1<RelocatedPathResolutionV1> {
  if (!validResolverInput(sourcePath, targetPath, rules)) {
    return commandFailure("invalid-command");
  }
  const start = resolverState(sourcePath, 0, 0, null, null);
  const states = new Map<string, ResolverState>([[stateKey(start), start]]);
  const queue: ResolverState[] = [start];
  const counters = { bytes: stateBytes(start), transitions: 0 };
  for (const current of queue) {
    if (current.path === targetPath) {
      return commandSuccess(resolution(current, states, counters));
    }
    const expanded = expandState(current, rules, states, queue, counters);
    if (!expanded.ok) return expanded;
  }
  return commandFailure("sidecar-conflict");
}

export function deriveRelocatedStorageRootV1(request: {
  readonly currentRoot: string;
  readonly priorPrefix: string;
  readonly replacementPrefix: string;
}): CommandResultV1<RelocatedStorageRootV1> {
  const { currentRoot, priorPrefix, replacementPrefix } = request;
  if (
    !isNormalizedVaultPath(currentRoot) ||
    !isNormalizedVaultPath(priorPrefix) ||
    !isNormalizedVaultPath(replacementPrefix) ||
    priorPrefix === replacementPrefix
  ) {
    return commandFailure("invalid-command");
  }
  const affected = matchesPrefix(currentRoot, priorPrefix);
  if (affected && matchesPrefix(currentRoot, replacementPrefix)) {
    return commandFailure("sidecar-conflict");
  }
  if (!affected) {
    return commandSuccess(
      Object.freeze({
        kind: "not-affected",
        vaultRelativeRoot: currentRoot,
      }),
    );
  }
  const vaultRelativeRoot = replaceMatchedPrefix(
    currentRoot,
    priorPrefix,
    replacementPrefix,
  );
  return isNormalizedVaultPath(vaultRelativeRoot)
    ? commandSuccess(Object.freeze({ kind: "replacement", vaultRelativeRoot }))
    : commandFailure("invalid-command");
}

function expandState(
  current: ResolverState,
  rules: readonly PrefixRelocationRuleV1[],
  states: Map<string, ResolverState>,
  queue: ResolverState[],
  counters: { bytes: number; transitions: number },
): CommandResultV1<void> {
  if (current.hops >= RELOCATION_LIMITS_V1.maxResolverHops) {
    const hasMore = rules.some(
      (rule) =>
        rule.generation > current.generation &&
        matchesPrefix(current.path, rule.priorPrefix),
    );
    return hasMore
      ? commandFailure("resource-limit")
      : commandSuccess(undefined);
  }
  const applicable = applicableRules(current, rules);
  if (!applicable.ok) return applicable;
  for (const rule of applicable.value) {
    counters.transitions += 1;
    if (counters.transitions > RELOCATION_LIMITS_V1.maxResolverTransitions) {
      return commandFailure("resource-limit");
    }
    const admitted = admitResolverState(current, rule, states, queue, counters);
    if (!admitted.ok) return admitted;
  }
  return commandSuccess(undefined);
}

function applicableRules(
  state: ResolverState,
  rules: readonly PrefixRelocationRuleV1[],
): CommandResultV1<readonly PrefixRelocationRuleV1[]> {
  const matches = rules.filter(
    (rule) =>
      rule.generation > state.generation &&
      matchesPrefix(state.path, rule.priorPrefix),
  );
  const longestByGeneration = new Map<number, number>();
  for (const rule of matches) {
    const prior = longestByGeneration.get(rule.generation) ?? NO_PREFIX_LENGTH;
    longestByGeneration.set(
      rule.generation,
      Math.max(prior, rule.priorPrefix.length),
    );
  }
  const selected = matches.filter(
    (rule) =>
      longestByGeneration.get(rule.generation) === rule.priorPrefix.length,
  );
  if (hasAmbiguousRule(selected, state.path)) {
    return commandFailure("sidecar-conflict");
  }
  selected.sort(compareRules);
  return commandSuccess(selected);
}

function admitResolverState(
  prior: ResolverState,
  rule: PrefixRelocationRuleV1,
  states: Map<string, ResolverState>,
  queue: ResolverState[],
  counters: { bytes: number; transitions: number },
): CommandResultV1<void> {
  const path = replacePrefix(prior.path, rule);
  if (!isNormalizedVaultPath(path)) return commandFailure("sidecar-conflict");
  const state = resolverState(
    path,
    rule.generation,
    prior.hops + 1,
    stateKey(prior),
    rule,
  );
  const key = stateKey(state);
  if (states.has(key)) return commandSuccess(undefined);
  counters.bytes += stateBytes(state) + TRANSITION_OVERHEAD_BYTES;
  if (
    states.size >= RELOCATION_LIMITS_V1.maxResolverStates ||
    counters.bytes > RELOCATION_LIMITS_V1.maxResolverBytes
  ) {
    return commandFailure("resource-limit");
  }
  states.set(key, state);
  queue.push(state);
  return commandSuccess(undefined);
}

function resolution(
  terminal: ResolverState,
  states: ReadonlyMap<string, ResolverState>,
  counters: { readonly transitions: number },
): RelocatedPathResolutionV1 {
  const ids: RelocationId[] = [];
  let current: ResolverState | undefined = terminal;
  while (current !== undefined && current.predecessor !== null) {
    if (current.rule !== null) ids.push(current.rule.relocationId);
    current = states.get(current.predecessor);
  }
  ids.reverse();
  return Object.freeze({
    path: terminal.path,
    relocationIds: Object.freeze(ids),
    traversedTransitions: counters.transitions,
    visitedStates: states.size,
  });
}

function validResolverInput(
  sourcePath: string,
  targetPath: string,
  rules: readonly PrefixRelocationRuleV1[],
): boolean {
  return (
    isNormalizedVaultPath(sourcePath) &&
    isNormalizedVaultPath(targetPath) &&
    rules.length <= RELOCATION_LIMITS_V1.maxPrefixRules &&
    rules.every(validRule)
  );
}

function validRule(rule: PrefixRelocationRuleV1): boolean {
  return (
    Number.isSafeInteger(rule.generation) &&
    rule.generation > 0 &&
    isNormalizedVaultPrefix(rule.priorPrefix) &&
    isNormalizedVaultPrefix(rule.replacementPrefix) &&
    rule.priorPrefix !== rule.replacementPrefix
  );
}

function hasAmbiguousRule(
  rules: readonly PrefixRelocationRuleV1[],
  path: string,
): boolean {
  const replacements = new Map<string, string>();
  for (const rule of rules) {
    const key = `${String(rule.generation)}\0${rule.priorPrefix}`;
    const replacement = replacePrefix(path, rule);
    const prior = replacements.get(key);
    if (prior !== undefined && prior !== replacement) return true;
    replacements.set(key, replacement);
  }
  return false;
}

function compareRules(
  left: PrefixRelocationRuleV1,
  right: PrefixRelocationRuleV1,
): number {
  return (
    left.generation - right.generation ||
    right.priorPrefix.length - left.priorPrefix.length ||
    left.relocationId.localeCompare(right.relocationId)
  );
}

function matchesPrefix(path: string, prefix: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

function replacePrefix(path: string, rule: PrefixRelocationRuleV1): string {
  return replaceMatchedPrefix(path, rule.priorPrefix, rule.replacementPrefix);
}

function replaceMatchedPrefix(
  path: string,
  priorPrefix: string,
  replacementPrefix: string,
): string {
  let suffix = path;
  if (priorPrefix !== "") {
    const separatorLength = path === priorPrefix ? 0 : 1;
    suffix = path.slice(priorPrefix.length + separatorLength);
  }
  if (replacementPrefix === "") return suffix;
  return suffix === "" ? replacementPrefix : `${replacementPrefix}/${suffix}`;
}

function resolverState(
  path: string,
  generation: number,
  hops: number,
  predecessor: string | null,
  rule: PrefixRelocationRuleV1 | null,
): ResolverState {
  return { generation, hops, path, predecessor, rule };
}

function stateKey(state: Pick<ResolverState, "generation" | "path">): string {
  return `${String(state.generation)}\0${state.path}`;
}

function stateBytes(state: ResolverState): number {
  return (
    utf8Bytes(state.path) +
    utf8Bytes(state.predecessor ?? "") +
    STATE_OVERHEAD_BYTES
  );
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += utf8CodePointBytes(codePoint);
  }
  return bytes;
}

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= UTF8_ONE_BYTE_MAX) return 1;
  if (codePoint <= UTF8_TWO_BYTE_MAX) return UTF8_TWO_BYTES;
  return codePoint <= UTF8_THREE_BYTE_MAX ? UTF8_THREE_BYTES : UTF8_FOUR_BYTES;
}
