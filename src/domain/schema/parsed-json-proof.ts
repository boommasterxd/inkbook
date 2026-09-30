import { MAX_JSON_DEPTH, type SchemaLimits } from "./constants";
import { jsonContainerBudget, jsonNodeBudget } from "./validation-internals";

export interface ParsedJsonStatistics {
  readonly finiteNumbers: boolean;
  readonly maximumContainerEntries: number;
  readonly maximumDepth: number;
  readonly nodes: number;
}

/** One-use proof from an internal bounded parser that exclusively owns its JSON tree. */
export class ParsedJsonProof {
  #consumed = false;

  private constructor(
    private readonly value: unknown,
    private readonly statistics: ParsedJsonStatistics,
  ) {}

  /** Internal parser mint; its root remains exclusively owned until semantic validation. */
  public static fromParser(value: unknown, statistics: ParsedJsonStatistics): ParsedJsonProof {
    return new ParsedJsonProof(value, Object.freeze({ ...statistics }));
  }

  public consume(value: unknown, limits: Readonly<SchemaLimits>): number | undefined {
    if (this.#consumed || value !== this.value) return undefined;
    this.#consumed = true;
    const { finiteNumbers, maximumContainerEntries, maximumDepth, nodes } = this.statistics;
    if (
      !finiteNumbers ||
      !Number.isSafeInteger(nodes) ||
      nodes < 1 ||
      nodes > jsonNodeBudget(limits) ||
      !Number.isSafeInteger(maximumDepth) ||
      maximumDepth < 1 ||
      maximumDepth > MAX_JSON_DEPTH ||
      !Number.isSafeInteger(maximumContainerEntries) ||
      maximumContainerEntries < 0 ||
      maximumContainerEntries > jsonContainerBudget(limits)
    )
      return undefined;
    return maximumDepth;
  }
}
