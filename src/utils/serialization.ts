export function serializeBigInt<T>(input: T): T {
  if (typeof input === 'bigint') {
    return Number(input) as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => serializeBigInt(item)) as T;
  }

  if (input && typeof input === 'object') {
    if (input instanceof Date) return input;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      result[key] = serializeBigInt(value);
    }
    return result as T;
  }

  return input;
}
