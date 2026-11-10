/**
 * The one environment-lookup seam for the worker (Issue #956).
 *
 * A module that reads `Deno.env.get` directly can only be tested by mutating
 * the process environment, and a mutated process environment races every
 * other test running at that moment — which is what keeps the quality gate's
 * `deno test` stage serial and 18x slower than it needs to be (Issue #880,
 * plan in #944). Taking the lookup as a parameter removes the mutation: the
 * test hands the module a fixed map and asserts on what it does with it.
 *
 * Two identical spellings of this type already existed — `EnvLookup` in
 * `credential_preflight.ts` and the `EnvReader` the credential preflight used —
 * so this module holds the canonical one and both re-export from here.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */ /**
 * Reads one environment variable by name.
 *
 * Returns `undefined` when the variable is absent, exactly as
 * `Deno.env.get` does, so {@link processEnvLookup} is a drop-in default.
 */ /**
 * The real process environment as an {@link EnvLookup}.
 *
 * This is the default for every injected `env` parameter, so production
 * callers pass nothing and behave exactly as they did when the module read
 * `Deno.env.get` itself.
 */ export const processEnvLookup = (name)=>Deno.env.get(name);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9lbnZfbG9va3VwLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGhlIG9uZSBlbnZpcm9ubWVudC1sb29rdXAgc2VhbSBmb3IgdGhlIHdvcmtlciAoSXNzdWUgIzk1NikuXG4gKlxuICogQSBtb2R1bGUgdGhhdCByZWFkcyBgRGVuby5lbnYuZ2V0YCBkaXJlY3RseSBjYW4gb25seSBiZSB0ZXN0ZWQgYnkgbXV0YXRpbmdcbiAqIHRoZSBwcm9jZXNzIGVudmlyb25tZW50LCBhbmQgYSBtdXRhdGVkIHByb2Nlc3MgZW52aXJvbm1lbnQgcmFjZXMgZXZlcnlcbiAqIG90aGVyIHRlc3QgcnVubmluZyBhdCB0aGF0IG1vbWVudCDigJQgd2hpY2ggaXMgd2hhdCBrZWVwcyB0aGUgcXVhbGl0eSBnYXRlJ3NcbiAqIGBkZW5vIHRlc3RgIHN0YWdlIHNlcmlhbCBhbmQgMTh4IHNsb3dlciB0aGFuIGl0IG5lZWRzIHRvIGJlIChJc3N1ZSAjODgwLFxuICogcGxhbiBpbiAjOTQ0KS4gVGFraW5nIHRoZSBsb29rdXAgYXMgYSBwYXJhbWV0ZXIgcmVtb3ZlcyB0aGUgbXV0YXRpb246IHRoZVxuICogdGVzdCBoYW5kcyB0aGUgbW9kdWxlIGEgZml4ZWQgbWFwIGFuZCBhc3NlcnRzIG9uIHdoYXQgaXQgZG9lcyB3aXRoIGl0LlxuICpcbiAqIFR3byBpZGVudGljYWwgc3BlbGxpbmdzIG9mIHRoaXMgdHlwZSBhbHJlYWR5IGV4aXN0ZWQg4oCUIGBFbnZMb29rdXBgIGluXG4gKiBgY3JlZGVudGlhbF9wcmVmbGlnaHQudHNgIGFuZCB0aGUgYEVudlJlYWRlcmAgdGhlIGNyZWRlbnRpYWwgcHJlZmxpZ2h0IHVzZWQg4oCUXG4gKiBzbyB0aGlzIG1vZHVsZSBob2xkcyB0aGUgY2Fub25pY2FsIG9uZSBhbmQgYm90aCByZS1leHBvcnQgZnJvbSBoZXJlLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG4vKipcbiAqIFJlYWRzIG9uZSBlbnZpcm9ubWVudCB2YXJpYWJsZSBieSBuYW1lLlxuICpcbiAqIFJldHVybnMgYHVuZGVmaW5lZGAgd2hlbiB0aGUgdmFyaWFibGUgaXMgYWJzZW50LCBleGFjdGx5IGFzXG4gKiBgRGVuby5lbnYuZ2V0YCBkb2VzLCBzbyB7QGxpbmsgcHJvY2Vzc0Vudkxvb2t1cH0gaXMgYSBkcm9wLWluIGRlZmF1bHQuXG4gKi9cbmV4cG9ydCB0eXBlIEVudkxvb2t1cCA9IChuYW1lOiBzdHJpbmcpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcblxuLyoqXG4gKiBUaGUgcmVhbCBwcm9jZXNzIGVudmlyb25tZW50IGFzIGFuIHtAbGluayBFbnZMb29rdXB9LlxuICpcbiAqIFRoaXMgaXMgdGhlIGRlZmF1bHQgZm9yIGV2ZXJ5IGluamVjdGVkIGBlbnZgIHBhcmFtZXRlciwgc28gcHJvZHVjdGlvblxuICogY2FsbGVycyBwYXNzIG5vdGhpbmcgYW5kIGJlaGF2ZSBleGFjdGx5IGFzIHRoZXkgZGlkIHdoZW4gdGhlIG1vZHVsZSByZWFkXG4gKiBgRGVuby5lbnYuZ2V0YCBpdHNlbGYuXG4gKi9cbmV4cG9ydCBjb25zdCBwcm9jZXNzRW52TG9va3VwOiBFbnZMb29rdXAgPSAobmFtZSkgPT4gRGVuby5lbnYuZ2V0KG5hbWUpO1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Q0FlQyxHQUVEOzs7OztDQUtDLEdBR0Q7Ozs7OztDQU1DLEdBQ0QsT0FBTyxNQUFNLG1CQUE4QixDQUFDLE9BQVMsS0FBSyxHQUFHLENBQUMsR0FBRyxDQUFDLE1BQU0ifQ==
// denoCacheMetadata=16147216998366302120,17488525236937403456