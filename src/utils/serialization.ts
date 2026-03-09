export function serializeBigInt<T>(input: T): T {
  if (typeof input === 'bigint') {
    return Number(input) as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => serializeBigInt(item)) as T;
  }

  if (input && typeof input === 'object') {
    if (input instanceof Date) return input;

    // Handle Prisma Decimal objects (have s, e, d keys and toNumber method)
    if ('toNumber' in input && typeof (input as any).toNumber === 'function') {
      return (input as any).toNumber() as T;
    }
    // Also handle Decimal-like objects with {s, e, d} shape
    if ('d' in input && 'e' in input && 's' in input && Object.keys(input).length === 3) {
      return Number(String(input)) as T;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      result[key] = serializeBigInt(value);
    }
    return result as T;
  }

  return input;
}
