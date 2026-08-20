const ZERO_BIGINT = 0n;
const ONE_BIGINT = 1n;
const BINARY_RADIX = 2;

export const ORDER_KEY_BIT_LIMIT_V1 = 4_096;

export interface OrderKeyV1 {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function interpolateOrderKeysV1(
  predecessor: OrderKeyV1 | null,
  successor: OrderKeyV1 | null,
  count: number,
): readonly OrderKeyV1[] | null {
  const divisor = BigInt(count + 1);
  const lower =
    predecessor ??
    Object.freeze({
      numerator:
        (successor?.numerator ?? ZERO_BIGINT) -
        divisor * (successor?.denominator ?? ONE_BIGINT),
      denominator: successor?.denominator ?? ONE_BIGINT,
    });
  const upper =
    successor ??
    Object.freeze({
      numerator: lower.numerator + divisor * lower.denominator,
      denominator: lower.denominator,
    });
  const denominator = lower.denominator * upper.denominator * divisor;
  const difference =
    upper.numerator * lower.denominator - lower.numerator * upper.denominator;
  const keys = Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const step = BigInt(index + 1);
      return Object.freeze({
        numerator:
          lower.numerator * upper.denominator * divisor + difference * step,
        denominator,
      });
    }),
  );
  return keys.some(
    ({ numerator, denominator: candidateDenominator }) =>
      numerator.toString(BINARY_RADIX).length > ORDER_KEY_BIT_LIMIT_V1 ||
      candidateDenominator.toString(BINARY_RADIX).length >
        ORDER_KEY_BIT_LIMIT_V1,
  )
    ? null
    : keys;
}
