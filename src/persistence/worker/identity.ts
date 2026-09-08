const assertSafeCounter = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
};

const nextSafeCounter = (value: number, name: string): number => {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} reached Number.MAX_SAFE_INTEGER.`);
  }

  return value + 1;
};

export { assertSafeCounter, nextSafeCounter };
