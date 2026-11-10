/**
 * NUL-framed verdict encoding shared by the agent-side guard shims.
 *
 * A guard child hands its wrapper both a verdict marker and the argv to run,
 * and a redacted body or commit message may contain newlines, quotes and
 * backslashes that must survive byte-for-byte. A NUL cannot occur inside a
 * process argument, so it is the one separator the bash wrapper can split on
 * with no encoding step of its own (`read -r -d ''`).
 *
 * Extracted so the `gh` guard (Issue #3938) and the `git` guard (Issue #1284)
 * share one framing rather than two copies that can drift apart.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /**
 * Frame a verdict marker and the arguments that follow it for a shim.
 *
 * @param fields - The marker first, then each argument to run.
 * @returns The exact bytes to write to stdout.
 */ export function encodeNulFields(fields) {
  return fields.map((field)=>`${field}\0`).join("");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ndWFyZF9maWVsZF9lbmNvZGluZy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE5VTC1mcmFtZWQgdmVyZGljdCBlbmNvZGluZyBzaGFyZWQgYnkgdGhlIGFnZW50LXNpZGUgZ3VhcmQgc2hpbXMuXG4gKlxuICogQSBndWFyZCBjaGlsZCBoYW5kcyBpdHMgd3JhcHBlciBib3RoIGEgdmVyZGljdCBtYXJrZXIgYW5kIHRoZSBhcmd2IHRvIHJ1bixcbiAqIGFuZCBhIHJlZGFjdGVkIGJvZHkgb3IgY29tbWl0IG1lc3NhZ2UgbWF5IGNvbnRhaW4gbmV3bGluZXMsIHF1b3RlcyBhbmRcbiAqIGJhY2tzbGFzaGVzIHRoYXQgbXVzdCBzdXJ2aXZlIGJ5dGUtZm9yLWJ5dGUuIEEgTlVMIGNhbm5vdCBvY2N1ciBpbnNpZGUgYVxuICogcHJvY2VzcyBhcmd1bWVudCwgc28gaXQgaXMgdGhlIG9uZSBzZXBhcmF0b3IgdGhlIGJhc2ggd3JhcHBlciBjYW4gc3BsaXQgb25cbiAqIHdpdGggbm8gZW5jb2Rpbmcgc3RlcCBvZiBpdHMgb3duIChgcmVhZCAtciAtZCAnJ2ApLlxuICpcbiAqIEV4dHJhY3RlZCBzbyB0aGUgYGdoYCBndWFyZCAoSXNzdWUgIzM5MzgpIGFuZCB0aGUgYGdpdGAgZ3VhcmQgKElzc3VlICMxMjg0KVxuICogc2hhcmUgb25lIGZyYW1pbmcgcmF0aGVyIHRoYW4gdHdvIGNvcGllcyB0aGF0IGNhbiBkcmlmdCBhcGFydC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG4vKipcbiAqIEZyYW1lIGEgdmVyZGljdCBtYXJrZXIgYW5kIHRoZSBhcmd1bWVudHMgdGhhdCBmb2xsb3cgaXQgZm9yIGEgc2hpbS5cbiAqXG4gKiBAcGFyYW0gZmllbGRzIC0gVGhlIG1hcmtlciBmaXJzdCwgdGhlbiBlYWNoIGFyZ3VtZW50IHRvIHJ1bi5cbiAqIEByZXR1cm5zIFRoZSBleGFjdCBieXRlcyB0byB3cml0ZSB0byBzdGRvdXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbmNvZGVOdWxGaWVsZHMoZmllbGRzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBmaWVsZHMubWFwKChmaWVsZCkgPT4gYCR7ZmllbGR9XFwwYCkuam9pbihcIlwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7OztDQWFDLEdBRUQ7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsZ0JBQWdCLE1BQXlCO0VBQ3ZELE9BQU8sT0FBTyxHQUFHLENBQUMsQ0FBQyxRQUFVLEdBQUcsTUFBTSxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUM7QUFDbEQifQ==
// denoCacheMetadata=2404505202735982620,1268600798679815871