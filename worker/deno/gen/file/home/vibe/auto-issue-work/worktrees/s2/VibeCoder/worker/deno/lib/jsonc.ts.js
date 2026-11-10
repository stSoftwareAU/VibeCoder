/**
 * JSONC support — `deno.jsonc` and friends may carry `//` and `/* … *\/`
 * comments and trailing commas, which `JSON.parse` refuses.
 *
 * Extracted from `orphan_deps_scanner.ts` (which re-exports it, so its
 * callers are unchanged) so a module that only needs to read a manifest does
 * not pull in the whole scanner's dependency graph (Issue #974).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /**
 * Strip `//` line comments, `/* … *\/` block comments, and trailing commas
 * from a JSONC document, preserving string literals (so `"https://…"` and a
 * `//` inside a string are not mistaken for a comment). Returns plain JSON.
 *
 * Pure — no I/O.
 */ export function stripJsonc(text) {
  let out = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  for(let i = 0; i < text.length; i++){
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      // Skip to end of line.
      while(i < text.length && text[i] !== "\n")i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while(i < text.length && !(text[i] === "*" && text[i + 1] === "/"))i++;
      i++; // lands on the closing '/'
      continue;
    }
    out += ch;
  }
  // Drop trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9qc29uYy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEpTT05DIHN1cHBvcnQg4oCUIGBkZW5vLmpzb25jYCBhbmQgZnJpZW5kcyBtYXkgY2FycnkgYC8vYCBhbmQgYC8qIOKApiAqXFwvYFxuICogY29tbWVudHMgYW5kIHRyYWlsaW5nIGNvbW1hcywgd2hpY2ggYEpTT04ucGFyc2VgIHJlZnVzZXMuXG4gKlxuICogRXh0cmFjdGVkIGZyb20gYG9ycGhhbl9kZXBzX3NjYW5uZXIudHNgICh3aGljaCByZS1leHBvcnRzIGl0LCBzbyBpdHNcbiAqIGNhbGxlcnMgYXJlIHVuY2hhbmdlZCkgc28gYSBtb2R1bGUgdGhhdCBvbmx5IG5lZWRzIHRvIHJlYWQgYSBtYW5pZmVzdCBkb2VzXG4gKiBub3QgcHVsbCBpbiB0aGUgd2hvbGUgc2Nhbm5lcidzIGRlcGVuZGVuY3kgZ3JhcGggKElzc3VlICM5NzQpLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbi8qKlxuICogU3RyaXAgYC8vYCBsaW5lIGNvbW1lbnRzLCBgLyog4oCmICpcXC9gIGJsb2NrIGNvbW1lbnRzLCBhbmQgdHJhaWxpbmcgY29tbWFzXG4gKiBmcm9tIGEgSlNPTkMgZG9jdW1lbnQsIHByZXNlcnZpbmcgc3RyaW5nIGxpdGVyYWxzIChzbyBgXCJodHRwczovL+KAplwiYCBhbmQgYVxuICogYC8vYCBpbnNpZGUgYSBzdHJpbmcgYXJlIG5vdCBtaXN0YWtlbiBmb3IgYSBjb21tZW50KS4gUmV0dXJucyBwbGFpbiBKU09OLlxuICpcbiAqIFB1cmUg4oCUIG5vIEkvTy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0cmlwSnNvbmModGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IG91dCA9IFwiXCI7XG4gIGxldCBpblN0cmluZyA9IGZhbHNlO1xuICBsZXQgc3RyaW5nUXVvdGUgPSBcIlwiO1xuICBsZXQgZXNjYXBlZCA9IGZhbHNlO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHRleHQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBjaCA9IHRleHRbaV0gYXMgc3RyaW5nO1xuICAgIGNvbnN0IG5leHQgPSB0ZXh0W2kgKyAxXTtcbiAgICBpZiAoaW5TdHJpbmcpIHtcbiAgICAgIG91dCArPSBjaDtcbiAgICAgIGlmIChlc2NhcGVkKSB7XG4gICAgICAgIGVzY2FwZWQgPSBmYWxzZTtcbiAgICAgIH0gZWxzZSBpZiAoY2ggPT09IFwiXFxcXFwiKSB7XG4gICAgICAgIGVzY2FwZWQgPSB0cnVlO1xuICAgICAgfSBlbHNlIGlmIChjaCA9PT0gc3RyaW5nUXVvdGUpIHtcbiAgICAgICAgaW5TdHJpbmcgPSBmYWxzZTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY2ggPT09ICdcIicgfHwgY2ggPT09IFwiJ1wiKSB7XG4gICAgICBpblN0cmluZyA9IHRydWU7XG4gICAgICBzdHJpbmdRdW90ZSA9IGNoO1xuICAgICAgb3V0ICs9IGNoO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaCA9PT0gXCIvXCIgJiYgbmV4dCA9PT0gXCIvXCIpIHtcbiAgICAgIC8vIFNraXAgdG8gZW5kIG9mIGxpbmUuXG4gICAgICB3aGlsZSAoaSA8IHRleHQubGVuZ3RoICYmIHRleHRbaV0gIT09IFwiXFxuXCIpIGkrKztcbiAgICAgIG91dCArPSBcIlxcblwiO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaCA9PT0gXCIvXCIgJiYgbmV4dCA9PT0gXCIqXCIpIHtcbiAgICAgIGkgKz0gMjtcbiAgICAgIHdoaWxlIChpIDwgdGV4dC5sZW5ndGggJiYgISh0ZXh0W2ldID09PSBcIipcIiAmJiB0ZXh0W2kgKyAxXSA9PT0gXCIvXCIpKSBpKys7XG4gICAgICBpKys7IC8vIGxhbmRzIG9uIHRoZSBjbG9zaW5nICcvJ1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIG91dCArPSBjaDtcbiAgfVxuICAvLyBEcm9wIHRyYWlsaW5nIGNvbW1hcyBiZWZvcmUgfSBvciBdLlxuICByZXR1cm4gb3V0LnJlcGxhY2UoLywoXFxzKlt9XFxdXSkvZywgXCIkMVwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7O0NBU0MsR0FFRDs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsV0FBVyxJQUFZO0VBQ3JDLElBQUksTUFBTTtFQUNWLElBQUksV0FBVztFQUNmLElBQUksY0FBYztFQUNsQixJQUFJLFVBQVU7RUFDZCxJQUFLLElBQUksSUFBSSxHQUFHLElBQUksS0FBSyxNQUFNLEVBQUUsSUFBSztJQUNwQyxNQUFNLEtBQUssSUFBSSxDQUFDLEVBQUU7SUFDbEIsTUFBTSxPQUFPLElBQUksQ0FBQyxJQUFJLEVBQUU7SUFDeEIsSUFBSSxVQUFVO01BQ1osT0FBTztNQUNQLElBQUksU0FBUztRQUNYLFVBQVU7TUFDWixPQUFPLElBQUksT0FBTyxNQUFNO1FBQ3RCLFVBQVU7TUFDWixPQUFPLElBQUksT0FBTyxhQUFhO1FBQzdCLFdBQVc7TUFDYjtNQUNBO0lBQ0Y7SUFDQSxJQUFJLE9BQU8sT0FBTyxPQUFPLEtBQUs7TUFDNUIsV0FBVztNQUNYLGNBQWM7TUFDZCxPQUFPO01BQ1A7SUFDRjtJQUNBLElBQUksT0FBTyxPQUFPLFNBQVMsS0FBSztNQUM5Qix1QkFBdUI7TUFDdkIsTUFBTyxJQUFJLEtBQUssTUFBTSxJQUFJLElBQUksQ0FBQyxFQUFFLEtBQUssS0FBTTtNQUM1QyxPQUFPO01BQ1A7SUFDRjtJQUNBLElBQUksT0FBTyxPQUFPLFNBQVMsS0FBSztNQUM5QixLQUFLO01BQ0wsTUFBTyxJQUFJLEtBQUssTUFBTSxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxLQUFLLE9BQU8sSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLEdBQUcsRUFBRztNQUNyRSxLQUFLLDJCQUEyQjtNQUNoQztJQUNGO0lBQ0EsT0FBTztFQUNUO0VBQ0Esc0NBQXNDO0VBQ3RDLE9BQU8sSUFBSSxPQUFPLENBQUMsZ0JBQWdCO0FBQ3JDIn0=
// denoCacheMetadata=11772336868053199444,3890582764587952812