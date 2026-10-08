/** Fits bounded cumulative screen positions at strictly increasing sample times. */
export function estimateTouchPanVelocity(
  positions: Float64Array,
  times: Float64Array,
  start: number,
  count: number,
): number | undefined {
  if (count < 2) return undefined;
  const last = (start + count - 1) % times.length;
  const endpoint = times[last]!;
  const duration = endpoint - times[start]!;
  const origin = positions[start]!;
  let time = 0;
  let squaredTime = 0;
  let cubedTime = 0;
  let fourthTime = 0;
  let position = 0;
  let timePosition = 0;
  let squaredTimePosition = 0;
  for (let offset = 0; offset < count; offset += 1) {
    const index = (start + offset) % times.length;
    const x = (times[index]! - endpoint) / duration;
    const y = positions[index]! - origin;
    const square = x * x;
    time += x;
    squaredTime += square;
    cubedTime += square * x;
    fourthTime += square * square;
    position += y;
    timePosition += x * y;
    squaredTimePosition += square * y;
  }
  const variance = squaredTime - (time * time) / count;
  const covariance = cubedTime - (time * squaredTime) / count;
  const squaredVariance = fourthTime - (squaredTime * squaredTime) / count;
  const positionCovariance = timePosition - (time * position) / count;
  const squaredPositionCovariance = squaredTimePosition - (squaredTime * position) / count;
  const determinant = variance * squaredVariance - covariance * covariance;
  // Normalize time to [-1, 0] and fall back when the quadratic fit is ill-conditioned.
  const slope =
    count >= 3 && determinant > variance * squaredVariance * 1e-10
      ? (positionCovariance * squaredVariance - squaredPositionCovariance * covariance) /
        determinant
      : positionCovariance / variance;
  const velocity = (slope * 1_000) / duration;
  return Number.isFinite(velocity) ? velocity : undefined;
}
