/**
 * Exhaustiveness guard for discriminated-union switches (Issue #2168).
 *
 * Call from the `default` branch of a `switch` over a discriminated-union
 * tag so that adding a new variant breaks the compile rather than silently
 * falling through. The `never` parameter forces the type-checker to flag
 * any unhandled variant; at runtime the helper throws if a value of the
 * wrong shape ever reaches the call (e.g. JSON deserialised from an
 * untrusted source).
 *
 * Australian English throughout (behaviour, organisation).
 *
 * @example
 * ```ts
 * type Shape = { kind: "circle" } | { kind: "square" };
 * function area(s: Shape): number {
 *   switch (s.kind) {
 *     case "circle": return Math.PI;
 *     case "square": return 1;
 *     default: return assertNever(s);
 *   }
 * }
 * ```
 */
export function assertNever(value: never): never {
  throw new Error(`Unreachable: unexpected value ${JSON.stringify(value)}`);
}
