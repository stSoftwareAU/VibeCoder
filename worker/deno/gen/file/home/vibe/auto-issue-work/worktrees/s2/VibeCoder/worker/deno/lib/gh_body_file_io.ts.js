/**
 * Filesystem side of `gh` body redaction (Issue #1254).
 *
 * `gh_body_redaction.ts` stays a pure function of its inputs — it performs no
 * `Deno` calls — so every chokepoint that wants file bodies scanned has to
 * hand it a reader and a writer. There are two such chokepoints: the agent's
 * guard child (`gh_guard_cli.ts`) and the worker's spawn chokepoint
 * (`gh_spawn.ts`). They had drifted apart, with only the agent path supplying
 * a reader, so a worker `--body-file` body was published unscanned. This
 * module is the one implementation both now share.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /** Production body-file reader — throws when the path cannot be read. */ export const denoBodyFileReader = (path)=>Deno.readTextFileSync(path);
/**
 * Production writer for a masked `--input` body (Issue #92): a fresh file the
 * redacted JSON lands in, so the caller's own file is never rewritten.
 *
 * The file is created **inside a directory the caller names** (Issue #1364).
 * It used to be a bare `Deno.makeTempFileSync()`, which put it in TMPDIR with
 * nothing owning it: at the agent's guard the copy must outlive the process —
 * the `gh` child reads it after the guard has exited — so the guard cannot
 * delete it, and no one else knew it existed. Writing into a directory the
 * caller owns gives every masked copy an owner on both chokepoints.
 *
 * There is deliberately no unowned variant to reach for. `spawnGh` shares this
 * writer (Issue #1254), and an unowned temp file there would have leaked a
 * `gh-input-*.json` per masked body for the life of the host.
 *
 * @param dir - Directory the masked copy is created in; the caller owns its
 *   lifetime.
 * @returns A writer that returns the path of the file it wrote.
 */ export function bodyFileWriterIn(dir) {
  return (content)=>{
    const path = Deno.makeTempFileSync({
      dir,
      prefix: "gh-input-",
      suffix: ".json"
    });
    Deno.writeTextFileSync(path, content);
    return path;
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9ib2R5X2ZpbGVfaW8udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBGaWxlc3lzdGVtIHNpZGUgb2YgYGdoYCBib2R5IHJlZGFjdGlvbiAoSXNzdWUgIzEyNTQpLlxuICpcbiAqIGBnaF9ib2R5X3JlZGFjdGlvbi50c2Agc3RheXMgYSBwdXJlIGZ1bmN0aW9uIG9mIGl0cyBpbnB1dHMg4oCUIGl0IHBlcmZvcm1zIG5vXG4gKiBgRGVub2AgY2FsbHMg4oCUIHNvIGV2ZXJ5IGNob2tlcG9pbnQgdGhhdCB3YW50cyBmaWxlIGJvZGllcyBzY2FubmVkIGhhcyB0b1xuICogaGFuZCBpdCBhIHJlYWRlciBhbmQgYSB3cml0ZXIuIFRoZXJlIGFyZSB0d28gc3VjaCBjaG9rZXBvaW50czogdGhlIGFnZW50J3NcbiAqIGd1YXJkIGNoaWxkIChgZ2hfZ3VhcmRfY2xpLnRzYCkgYW5kIHRoZSB3b3JrZXIncyBzcGF3biBjaG9rZXBvaW50XG4gKiAoYGdoX3NwYXduLnRzYCkuIFRoZXkgaGFkIGRyaWZ0ZWQgYXBhcnQsIHdpdGggb25seSB0aGUgYWdlbnQgcGF0aCBzdXBwbHlpbmdcbiAqIGEgcmVhZGVyLCBzbyBhIHdvcmtlciBgLS1ib2R5LWZpbGVgIGJvZHkgd2FzIHB1Ymxpc2hlZCB1bnNjYW5uZWQuIFRoaXNcbiAqIG1vZHVsZSBpcyB0aGUgb25lIGltcGxlbWVudGF0aW9uIGJvdGggbm93IHNoYXJlLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgQm9keUZpbGVSZWFkZXIsIEJvZHlGaWxlV3JpdGVyIH0gZnJvbSBcIi4vZ2hfYm9keV9yZWRhY3Rpb24udHNcIjtcblxuLyoqIFByb2R1Y3Rpb24gYm9keS1maWxlIHJlYWRlciDigJQgdGhyb3dzIHdoZW4gdGhlIHBhdGggY2Fubm90IGJlIHJlYWQuICovXG5leHBvcnQgY29uc3QgZGVub0JvZHlGaWxlUmVhZGVyOiBCb2R5RmlsZVJlYWRlciA9IChwYXRoKSA9PlxuICBEZW5vLnJlYWRUZXh0RmlsZVN5bmMocGF0aCk7XG5cbi8qKlxuICogUHJvZHVjdGlvbiB3cml0ZXIgZm9yIGEgbWFza2VkIGAtLWlucHV0YCBib2R5IChJc3N1ZSAjOTIpOiBhIGZyZXNoIGZpbGUgdGhlXG4gKiByZWRhY3RlZCBKU09OIGxhbmRzIGluLCBzbyB0aGUgY2FsbGVyJ3Mgb3duIGZpbGUgaXMgbmV2ZXIgcmV3cml0dGVuLlxuICpcbiAqIFRoZSBmaWxlIGlzIGNyZWF0ZWQgKippbnNpZGUgYSBkaXJlY3RvcnkgdGhlIGNhbGxlciBuYW1lcyoqIChJc3N1ZSAjMTM2NCkuXG4gKiBJdCB1c2VkIHRvIGJlIGEgYmFyZSBgRGVuby5tYWtlVGVtcEZpbGVTeW5jKClgLCB3aGljaCBwdXQgaXQgaW4gVE1QRElSIHdpdGhcbiAqIG5vdGhpbmcgb3duaW5nIGl0OiBhdCB0aGUgYWdlbnQncyBndWFyZCB0aGUgY29weSBtdXN0IG91dGxpdmUgdGhlIHByb2Nlc3Mg4oCUXG4gKiB0aGUgYGdoYCBjaGlsZCByZWFkcyBpdCBhZnRlciB0aGUgZ3VhcmQgaGFzIGV4aXRlZCDigJQgc28gdGhlIGd1YXJkIGNhbm5vdFxuICogZGVsZXRlIGl0LCBhbmQgbm8gb25lIGVsc2Uga25ldyBpdCBleGlzdGVkLiBXcml0aW5nIGludG8gYSBkaXJlY3RvcnkgdGhlXG4gKiBjYWxsZXIgb3ducyBnaXZlcyBldmVyeSBtYXNrZWQgY29weSBhbiBvd25lciBvbiBib3RoIGNob2tlcG9pbnRzLlxuICpcbiAqIFRoZXJlIGlzIGRlbGliZXJhdGVseSBubyB1bm93bmVkIHZhcmlhbnQgdG8gcmVhY2ggZm9yLiBgc3Bhd25HaGAgc2hhcmVzIHRoaXNcbiAqIHdyaXRlciAoSXNzdWUgIzEyNTQpLCBhbmQgYW4gdW5vd25lZCB0ZW1wIGZpbGUgdGhlcmUgd291bGQgaGF2ZSBsZWFrZWQgYVxuICogYGdoLWlucHV0LSouanNvbmAgcGVyIG1hc2tlZCBib2R5IGZvciB0aGUgbGlmZSBvZiB0aGUgaG9zdC5cbiAqXG4gKiBAcGFyYW0gZGlyIC0gRGlyZWN0b3J5IHRoZSBtYXNrZWQgY29weSBpcyBjcmVhdGVkIGluOyB0aGUgY2FsbGVyIG93bnMgaXRzXG4gKiAgIGxpZmV0aW1lLlxuICogQHJldHVybnMgQSB3cml0ZXIgdGhhdCByZXR1cm5zIHRoZSBwYXRoIG9mIHRoZSBmaWxlIGl0IHdyb3RlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYm9keUZpbGVXcml0ZXJJbihkaXI6IHN0cmluZyk6IEJvZHlGaWxlV3JpdGVyIHtcbiAgcmV0dXJuIChjb250ZW50KSA9PiB7XG4gICAgY29uc3QgcGF0aCA9IERlbm8ubWFrZVRlbXBGaWxlU3luYyh7XG4gICAgICBkaXIsXG4gICAgICBwcmVmaXg6IFwiZ2gtaW5wdXQtXCIsXG4gICAgICBzdWZmaXg6IFwiLmpzb25cIixcbiAgICB9KTtcbiAgICBEZW5vLndyaXRlVGV4dEZpbGVTeW5jKHBhdGgsIGNvbnRlbnQpO1xuICAgIHJldHVybiBwYXRoO1xuICB9O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUlELHVFQUF1RSxHQUN2RSxPQUFPLE1BQU0scUJBQXFDLENBQUMsT0FDakQsS0FBSyxnQkFBZ0IsQ0FBQyxNQUFNO0FBRTlCOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrQkMsR0FDRCxPQUFPLFNBQVMsaUJBQWlCLEdBQVc7RUFDMUMsT0FBTyxDQUFDO0lBQ04sTUFBTSxPQUFPLEtBQUssZ0JBQWdCLENBQUM7TUFDakM7TUFDQSxRQUFRO01BQ1IsUUFBUTtJQUNWO0lBQ0EsS0FBSyxpQkFBaUIsQ0FBQyxNQUFNO0lBQzdCLE9BQU87RUFDVDtBQUNGIn0=
// denoCacheMetadata=14404405580757905714,16769165346548985491