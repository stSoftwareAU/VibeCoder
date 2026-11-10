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
 */ export function assertNever(value) {
  throw new Error(`Unreachable: unexpected value ${JSON.stringify(value)}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hc3NlcnRfbmV2ZXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBFeGhhdXN0aXZlbmVzcyBndWFyZCBmb3IgZGlzY3JpbWluYXRlZC11bmlvbiBzd2l0Y2hlcyAoSXNzdWUgIzIxNjgpLlxuICpcbiAqIENhbGwgZnJvbSB0aGUgYGRlZmF1bHRgIGJyYW5jaCBvZiBhIGBzd2l0Y2hgIG92ZXIgYSBkaXNjcmltaW5hdGVkLXVuaW9uXG4gKiB0YWcgc28gdGhhdCBhZGRpbmcgYSBuZXcgdmFyaWFudCBicmVha3MgdGhlIGNvbXBpbGUgcmF0aGVyIHRoYW4gc2lsZW50bHlcbiAqIGZhbGxpbmcgdGhyb3VnaC4gVGhlIGBuZXZlcmAgcGFyYW1ldGVyIGZvcmNlcyB0aGUgdHlwZS1jaGVja2VyIHRvIGZsYWdcbiAqIGFueSB1bmhhbmRsZWQgdmFyaWFudDsgYXQgcnVudGltZSB0aGUgaGVscGVyIHRocm93cyBpZiBhIHZhbHVlIG9mIHRoZVxuICogd3Jvbmcgc2hhcGUgZXZlciByZWFjaGVzIHRoZSBjYWxsIChlLmcuIEpTT04gZGVzZXJpYWxpc2VkIGZyb20gYW5cbiAqIHVudHJ1c3RlZCBzb3VyY2UpLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHRzXG4gKiB0eXBlIFNoYXBlID0geyBraW5kOiBcImNpcmNsZVwiIH0gfCB7IGtpbmQ6IFwic3F1YXJlXCIgfTtcbiAqIGZ1bmN0aW9uIGFyZWEoczogU2hhcGUpOiBudW1iZXIge1xuICogICBzd2l0Y2ggKHMua2luZCkge1xuICogICAgIGNhc2UgXCJjaXJjbGVcIjogcmV0dXJuIE1hdGguUEk7XG4gKiAgICAgY2FzZSBcInNxdWFyZVwiOiByZXR1cm4gMTtcbiAqICAgICBkZWZhdWx0OiByZXR1cm4gYXNzZXJ0TmV2ZXIocyk7XG4gKiAgIH1cbiAqIH1cbiAqIGBgYFxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0TmV2ZXIodmFsdWU6IG5ldmVyKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgRXJyb3IoYFVucmVhY2hhYmxlOiB1bmV4cGVjdGVkIHZhbHVlICR7SlNPTi5zdHJpbmdpZnkodmFsdWUpfWApO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXVCQyxHQUNELE9BQU8sU0FBUyxZQUFZLEtBQVk7RUFDdEMsTUFBTSxJQUFJLE1BQU0sQ0FBQyw4QkFBOEIsRUFBRSxLQUFLLFNBQVMsQ0FBQyxRQUFRO0FBQzFFIn0=
// denoCacheMetadata=9325443421666196777,11010684339340916876