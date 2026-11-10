/**
 * Which files a repo's own `deno fmt --check` / `deno lint` would check
 * (PR #3584 review).
 *
 * Explicit CLI paths replace a config's `fmt.include` / `lint.include` — only
 * `exclude` still applies — so the pre-push gate (`pre_push_gate.ts`) must
 * drop out-of-scope files itself rather than hand them to deno, or it would
 * refuse a push over formatting the repo's CI never enforces.
 *
 * Supported: `include` / `exclude` entries as file paths, directory paths
 * (with or without a trailing `/`) and globs (`*`, `**`, `?`, `{a,b}`), and
 * `!`-negated `exclude` entries (the last matching entry wins). `node_modules`
 * and `.git` are always out of scope, as in deno. `.` segments are dropped, so
 * an entry of `.` or `./` names the whole config directory, as deno reads it.
 * An `include` list holding an entry this module cannot compile (empty,
 * oversized, an unbalanced brace, or a `..` segment it cannot resolve) is
 * ignored, leaving the file in scope.
 *
 * Australian English spelling throughout.
 */ import { stripJsonc } from "./jsonc.ts";
const MAX_PATTERN_LENGTH = 256;
function stringList(value) {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v)=>typeof v === "string");
}
function toolScope(value) {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value;
  return {
    include: stringList(raw.include),
    exclude: stringList(raw.exclude)
  };
}
/**
 * Read the scope slice out of a deno.json(c) document. Returns null when the
 * text does not parse, so the caller can stay unfiltered (deno itself will
 * then report the broken config) rather than guess a scope.
 */ export function parseDenoScope(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch  {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const raw = parsed;
  return {
    exclude: stringList(raw.exclude),
    fmt: toolScope(raw.fmt),
    lint: toolScope(raw.lint)
  };
}
/**
 * Normalise a config entry to a config-relative path pattern: empty and `.`
 * segments are dropped, so `.`, `./` and `./src/./lib` read as deno reads
 * them, and `""` (after a non-empty entry) means the whole config directory.
 * Null for an empty entry and for one with a `..` segment, which would reach
 * outside the directory this matcher works in.
 */ function normaliseEntry(entry) {
  if (entry === "") return null;
  const segments = entry.split("/").filter((seg)=>seg !== "" && seg !== ".");
  if (segments.includes("..")) return null;
  return segments.join("/");
}
/** Normalise a changed file's path to a config-relative path. */ function normalisePattern(entry) {
  return entry.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
}
const MAX_BRACE_ALTERNATIVES = 64;
/**
 * Expand `{a,b}` groups (nesting allowed) into plain wildcard patterns; null
 * on an unbalanced brace or more than {@link MAX_BRACE_ALTERNATIVES} results.
 */ function expandBraces(pattern) {
  const open = pattern.indexOf("{");
  if (open === -1) return [
    pattern
  ];
  let depth = 0;
  let close = -1;
  const cuts = [];
  for(let i = open; i < pattern.length; i++){
    const ch = pattern[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (ch === "," && depth === 1) cuts.push(i);
  }
  if (close === -1) return null;
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const bounds = [
    open,
    ...cuts,
    close
  ];
  const out = [];
  for(let i = 0; i + 1 < bounds.length; i++){
    const alt = pattern.slice(bounds[i] + 1, bounds[i + 1]);
    const expanded = expandBraces(`${head}${alt}${tail}`);
    if (expanded === null) return null;
    out.push(...expanded);
    if (out.length > MAX_BRACE_ALTERNATIVES) return null;
  }
  return out;
}
/** Match `text` against a `*` / `?` wildcard pattern in O(pattern × text). */ function wildcardMatch(pattern, text) {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while(t < text.length){
    const pc = pattern[p];
    if (pc === "*") {
      starP = p++;
      starT = t;
    } else if (pc === "?" || pc !== undefined && pc === text[t]) {
      p++;
      t++;
    } else if (starP !== -1) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while(pattern[p] === "*")p++;
  return p === pattern.length;
}
/**
 * Compile one path/glob entry into a matcher over `/`-separated paths; null
 * when it is empty, oversized, malformed or reaches outside the config
 * directory. A `**` segment matches any number
 * of path segments, matched by a memoised walk so a hostile pattern costs
 * O(pattern segments × path segments), never exponential time.
 */ function compile(entry) {
  const pattern = normaliseEntry(entry);
  if (pattern === null || pattern.length > MAX_PATTERN_LENGTH) return null;
  // The config directory itself: every path under it.
  if (pattern === "") return ()=>true;
  const segments = [];
  for (const raw of pattern.split("/")){
    if (raw === "**") {
      if (segments[segments.length - 1] !== "**") segments.push("**");
      continue;
    }
    const alternatives = expandBraces(raw);
    if (alternatives === null) return null;
    segments.push(alternatives);
  }
  return (path)=>{
    const parts = path.split("/");
    const memo = new Map();
    const walk = (si, pi)=>{
      const key = si * (parts.length + 1) + pi;
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      let result;
      const seg = segments[si];
      if (seg === undefined) {
        result = pi === parts.length;
      } else if (seg === "**") {
        result = walk(si + 1, pi) || pi < parts.length && walk(si, pi + 1);
      } else {
        const part = parts[pi];
        result = part !== undefined && seg.some((alt)=>wildcardMatch(alt, part)) && walk(si + 1, pi + 1);
      }
      memo.set(key, result);
      return result;
    };
    return walk(0, 0);
  };
}
/** The path itself and each ancestor directory, shortest first. */ function pathAndAncestors(path) {
  const parts = path.split("/");
  const out = [];
  for(let i = 1; i <= parts.length; i++)out.push(parts.slice(0, i).join("/"));
  return out;
}
/** Whether `path` or any directory above it matches the entry. */ function matchesEntry(path, entry) {
  const matches = compile(entry);
  if (matches === null) return false;
  return pathAndAncestors(path).some(matches);
}
/** Last matching entry wins; a `!` entry re-includes. */ function excluded(path, entries) {
  let result = false;
  for (const entry of entries ?? []){
    if (entry.startsWith("!")) {
      if (matchesEntry(path, entry.slice(1))) result = false;
    } else if (matchesEntry(path, entry)) {
      result = true;
    }
  }
  return result;
}
/**
 * Whether the repo's own `deno <tool>` run, at the config's directory, would
 * check `relPath` (a `/`-separated path relative to that directory).
 */ export function inDenoScope(relPath, config, tool) {
  const path = normalisePattern(relPath);
  if (pathAndAncestors(path).some((p)=>/(^|\/)(node_modules|\.git)$/.test(p))) {
    return false;
  }
  const scope = config[tool];
  const includes = scope?.include;
  // An include we cannot compile is not guessed at: the file stays in scope
  // and deno itself judges it, so a push is never waved through on a guess.
  if (includes !== undefined && includes.length > 0 && includes.every((entry)=>compile(entry) !== null) && !includes.some((entry)=>matchesEntry(path, entry))) {
    return false;
  }
  return !excluded(path, config.exclude) && !excluded(path, scope?.exclude);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kZW5vX3Njb3BlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogV2hpY2ggZmlsZXMgYSByZXBvJ3Mgb3duIGBkZW5vIGZtdCAtLWNoZWNrYCAvIGBkZW5vIGxpbnRgIHdvdWxkIGNoZWNrXG4gKiAoUFIgIzM1ODQgcmV2aWV3KS5cbiAqXG4gKiBFeHBsaWNpdCBDTEkgcGF0aHMgcmVwbGFjZSBhIGNvbmZpZydzIGBmbXQuaW5jbHVkZWAgLyBgbGludC5pbmNsdWRlYCDigJQgb25seVxuICogYGV4Y2x1ZGVgIHN0aWxsIGFwcGxpZXMg4oCUIHNvIHRoZSBwcmUtcHVzaCBnYXRlIChgcHJlX3B1c2hfZ2F0ZS50c2ApIG11c3RcbiAqIGRyb3Agb3V0LW9mLXNjb3BlIGZpbGVzIGl0c2VsZiByYXRoZXIgdGhhbiBoYW5kIHRoZW0gdG8gZGVubywgb3IgaXQgd291bGRcbiAqIHJlZnVzZSBhIHB1c2ggb3ZlciBmb3JtYXR0aW5nIHRoZSByZXBvJ3MgQ0kgbmV2ZXIgZW5mb3JjZXMuXG4gKlxuICogU3VwcG9ydGVkOiBgaW5jbHVkZWAgLyBgZXhjbHVkZWAgZW50cmllcyBhcyBmaWxlIHBhdGhzLCBkaXJlY3RvcnkgcGF0aHNcbiAqICh3aXRoIG9yIHdpdGhvdXQgYSB0cmFpbGluZyBgL2ApIGFuZCBnbG9icyAoYCpgLCBgKipgLCBgP2AsIGB7YSxifWApLCBhbmRcbiAqIGAhYC1uZWdhdGVkIGBleGNsdWRlYCBlbnRyaWVzICh0aGUgbGFzdCBtYXRjaGluZyBlbnRyeSB3aW5zKS4gYG5vZGVfbW9kdWxlc2BcbiAqIGFuZCBgLmdpdGAgYXJlIGFsd2F5cyBvdXQgb2Ygc2NvcGUsIGFzIGluIGRlbm8uIGAuYCBzZWdtZW50cyBhcmUgZHJvcHBlZCwgc29cbiAqIGFuIGVudHJ5IG9mIGAuYCBvciBgLi9gIG5hbWVzIHRoZSB3aG9sZSBjb25maWcgZGlyZWN0b3J5LCBhcyBkZW5vIHJlYWRzIGl0LlxuICogQW4gYGluY2x1ZGVgIGxpc3QgaG9sZGluZyBhbiBlbnRyeSB0aGlzIG1vZHVsZSBjYW5ub3QgY29tcGlsZSAoZW1wdHksXG4gKiBvdmVyc2l6ZWQsIGFuIHVuYmFsYW5jZWQgYnJhY2UsIG9yIGEgYC4uYCBzZWdtZW50IGl0IGNhbm5vdCByZXNvbHZlKSBpc1xuICogaWdub3JlZCwgbGVhdmluZyB0aGUgZmlsZSBpbiBzY29wZS5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdGhyb3VnaG91dC5cbiAqL1xuXG5pbXBvcnQgeyBzdHJpcEpzb25jIH0gZnJvbSBcIi4vanNvbmMudHNcIjtcblxuLyoqIE9uZSB0b29sJ3MgKGBmbXRgIG9yIGBsaW50YCkgaW5jbHVkZS9leGNsdWRlIGxpc3RzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBEZW5vVG9vbFNjb3BlIHtcbiAgaW5jbHVkZT86IHN0cmluZ1tdO1xuICBleGNsdWRlPzogc3RyaW5nW107XG59XG5cbi8qKiBUaGUgc2NvcGUtcmVsZXZhbnQgc2xpY2Ugb2YgYSBgZGVuby5qc29uYCAvIGBkZW5vLmpzb25jYC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRGVub1Njb3BlQ29uZmlnIHtcbiAgZXhjbHVkZT86IHN0cmluZ1tdO1xuICBmbXQ/OiBEZW5vVG9vbFNjb3BlO1xuICBsaW50PzogRGVub1Rvb2xTY29wZTtcbn1cblxuZXhwb3J0IHR5cGUgRGVub1Njb3BlVG9vbCA9IFwiZm10XCIgfCBcImxpbnRcIjtcblxuY29uc3QgTUFYX1BBVFRFUk5fTEVOR1RIID0gMjU2O1xuXG5mdW5jdGlvbiBzdHJpbmdMaXN0KHZhbHVlOiB1bmtub3duKTogc3RyaW5nW10gfCB1bmRlZmluZWQge1xuICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gdmFsdWUuZmlsdGVyKCh2KTogdiBpcyBzdHJpbmcgPT4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIpO1xufVxuXG5mdW5jdGlvbiB0b29sU2NvcGUodmFsdWU6IHVua25vd24pOiBEZW5vVG9vbFNjb3BlIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIiB8fCB2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgcmF3ID0gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHJldHVybiB7IGluY2x1ZGU6IHN0cmluZ0xpc3QocmF3LmluY2x1ZGUpLCBleGNsdWRlOiBzdHJpbmdMaXN0KHJhdy5leGNsdWRlKSB9O1xufVxuXG4vKipcbiAqIFJlYWQgdGhlIHNjb3BlIHNsaWNlIG91dCBvZiBhIGRlbm8uanNvbihjKSBkb2N1bWVudC4gUmV0dXJucyBudWxsIHdoZW4gdGhlXG4gKiB0ZXh0IGRvZXMgbm90IHBhcnNlLCBzbyB0aGUgY2FsbGVyIGNhbiBzdGF5IHVuZmlsdGVyZWQgKGRlbm8gaXRzZWxmIHdpbGxcbiAqIHRoZW4gcmVwb3J0IHRoZSBicm9rZW4gY29uZmlnKSByYXRoZXIgdGhhbiBndWVzcyBhIHNjb3BlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VEZW5vU2NvcGUodGV4dDogc3RyaW5nKTogRGVub1Njb3BlQ29uZmlnIHwgbnVsbCB7XG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShzdHJpcEpzb25jKHRleHQpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKHR5cGVvZiBwYXJzZWQgIT09IFwib2JqZWN0XCIgfHwgcGFyc2VkID09PSBudWxsIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGNvbnN0IHJhdyA9IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgcmV0dXJuIHtcbiAgICBleGNsdWRlOiBzdHJpbmdMaXN0KHJhdy5leGNsdWRlKSxcbiAgICBmbXQ6IHRvb2xTY29wZShyYXcuZm10KSxcbiAgICBsaW50OiB0b29sU2NvcGUocmF3LmxpbnQpLFxuICB9O1xufVxuXG4vKipcbiAqIE5vcm1hbGlzZSBhIGNvbmZpZyBlbnRyeSB0byBhIGNvbmZpZy1yZWxhdGl2ZSBwYXRoIHBhdHRlcm46IGVtcHR5IGFuZCBgLmBcbiAqIHNlZ21lbnRzIGFyZSBkcm9wcGVkLCBzbyBgLmAsIGAuL2AgYW5kIGAuL3NyYy8uL2xpYmAgcmVhZCBhcyBkZW5vIHJlYWRzXG4gKiB0aGVtLCBhbmQgYFwiXCJgIChhZnRlciBhIG5vbi1lbXB0eSBlbnRyeSkgbWVhbnMgdGhlIHdob2xlIGNvbmZpZyBkaXJlY3RvcnkuXG4gKiBOdWxsIGZvciBhbiBlbXB0eSBlbnRyeSBhbmQgZm9yIG9uZSB3aXRoIGEgYC4uYCBzZWdtZW50LCB3aGljaCB3b3VsZCByZWFjaFxuICogb3V0c2lkZSB0aGUgZGlyZWN0b3J5IHRoaXMgbWF0Y2hlciB3b3JrcyBpbi5cbiAqL1xuZnVuY3Rpb24gbm9ybWFsaXNlRW50cnkoZW50cnk6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoZW50cnkgPT09IFwiXCIpIHJldHVybiBudWxsO1xuICBjb25zdCBzZWdtZW50cyA9IGVudHJ5LnNwbGl0KFwiL1wiKS5maWx0ZXIoKHNlZykgPT4gc2VnICE9PSBcIlwiICYmIHNlZyAhPT0gXCIuXCIpO1xuICBpZiAoc2VnbWVudHMuaW5jbHVkZXMoXCIuLlwiKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBzZWdtZW50cy5qb2luKFwiL1wiKTtcbn1cblxuLyoqIE5vcm1hbGlzZSBhIGNoYW5nZWQgZmlsZSdzIHBhdGggdG8gYSBjb25maWctcmVsYXRpdmUgcGF0aC4gKi9cbmZ1bmN0aW9uIG5vcm1hbGlzZVBhdHRlcm4oZW50cnk6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBlbnRyeS5yZXBsYWNlKC9eKD86XFwuXFwvKSsvLCBcIlwiKS5yZXBsYWNlKC9eXFwvKy8sIFwiXCIpLnJlcGxhY2UoXG4gICAgL1xcLyskLyxcbiAgICBcIlwiLFxuICApO1xufVxuXG5jb25zdCBNQVhfQlJBQ0VfQUxURVJOQVRJVkVTID0gNjQ7XG5cbi8qKlxuICogRXhwYW5kIGB7YSxifWAgZ3JvdXBzIChuZXN0aW5nIGFsbG93ZWQpIGludG8gcGxhaW4gd2lsZGNhcmQgcGF0dGVybnM7IG51bGxcbiAqIG9uIGFuIHVuYmFsYW5jZWQgYnJhY2Ugb3IgbW9yZSB0aGFuIHtAbGluayBNQVhfQlJBQ0VfQUxURVJOQVRJVkVTfSByZXN1bHRzLlxuICovXG5mdW5jdGlvbiBleHBhbmRCcmFjZXMocGF0dGVybjogc3RyaW5nKTogc3RyaW5nW10gfCBudWxsIHtcbiAgY29uc3Qgb3BlbiA9IHBhdHRlcm4uaW5kZXhPZihcIntcIik7XG4gIGlmIChvcGVuID09PSAtMSkgcmV0dXJuIFtwYXR0ZXJuXTtcbiAgbGV0IGRlcHRoID0gMDtcbiAgbGV0IGNsb3NlID0gLTE7XG4gIGNvbnN0IGN1dHM6IG51bWJlcltdID0gW107XG4gIGZvciAobGV0IGkgPSBvcGVuOyBpIDwgcGF0dGVybi5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGNoID0gcGF0dGVybltpXTtcbiAgICBpZiAoY2ggPT09IFwie1wiKSBkZXB0aCsrO1xuICAgIGVsc2UgaWYgKGNoID09PSBcIn1cIikge1xuICAgICAgZGVwdGgtLTtcbiAgICAgIGlmIChkZXB0aCA9PT0gMCkge1xuICAgICAgICBjbG9zZSA9IGk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoY2ggPT09IFwiLFwiICYmIGRlcHRoID09PSAxKSBjdXRzLnB1c2goaSk7XG4gIH1cbiAgaWYgKGNsb3NlID09PSAtMSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGhlYWQgPSBwYXR0ZXJuLnNsaWNlKDAsIG9wZW4pO1xuICBjb25zdCB0YWlsID0gcGF0dGVybi5zbGljZShjbG9zZSArIDEpO1xuICBjb25zdCBib3VuZHMgPSBbb3BlbiwgLi4uY3V0cywgY2xvc2VdO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAobGV0IGkgPSAwOyBpICsgMSA8IGJvdW5kcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGFsdCA9IHBhdHRlcm4uc2xpY2UoKGJvdW5kc1tpXSBhcyBudW1iZXIpICsgMSwgYm91bmRzW2kgKyAxXSk7XG4gICAgY29uc3QgZXhwYW5kZWQgPSBleHBhbmRCcmFjZXMoYCR7aGVhZH0ke2FsdH0ke3RhaWx9YCk7XG4gICAgaWYgKGV4cGFuZGVkID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgICBvdXQucHVzaCguLi5leHBhbmRlZCk7XG4gICAgaWYgKG91dC5sZW5ndGggPiBNQVhfQlJBQ0VfQUxURVJOQVRJVkVTKSByZXR1cm4gbnVsbDtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKiogTWF0Y2ggYHRleHRgIGFnYWluc3QgYSBgKmAgLyBgP2Agd2lsZGNhcmQgcGF0dGVybiBpbiBPKHBhdHRlcm4gw5cgdGV4dCkuICovXG5mdW5jdGlvbiB3aWxkY2FyZE1hdGNoKHBhdHRlcm46IHN0cmluZywgdGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGxldCBwID0gMDtcbiAgbGV0IHQgPSAwO1xuICBsZXQgc3RhclAgPSAtMTtcbiAgbGV0IHN0YXJUID0gMDtcbiAgd2hpbGUgKHQgPCB0ZXh0Lmxlbmd0aCkge1xuICAgIGNvbnN0IHBjID0gcGF0dGVybltwXTtcbiAgICBpZiAocGMgPT09IFwiKlwiKSB7XG4gICAgICBzdGFyUCA9IHArKztcbiAgICAgIHN0YXJUID0gdDtcbiAgICB9IGVsc2UgaWYgKHBjID09PSBcIj9cIiB8fCAocGMgIT09IHVuZGVmaW5lZCAmJiBwYyA9PT0gdGV4dFt0XSkpIHtcbiAgICAgIHArKztcbiAgICAgIHQrKztcbiAgICB9IGVsc2UgaWYgKHN0YXJQICE9PSAtMSkge1xuICAgICAgcCA9IHN0YXJQICsgMTtcbiAgICAgIHQgPSArK3N0YXJUO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG4gIHdoaWxlIChwYXR0ZXJuW3BdID09PSBcIipcIikgcCsrO1xuICByZXR1cm4gcCA9PT0gcGF0dGVybi5sZW5ndGg7XG59XG5cbnR5cGUgU2VnbWVudCA9IHN0cmluZ1tdIHwgXCIqKlwiO1xuXG4vKipcbiAqIENvbXBpbGUgb25lIHBhdGgvZ2xvYiBlbnRyeSBpbnRvIGEgbWF0Y2hlciBvdmVyIGAvYC1zZXBhcmF0ZWQgcGF0aHM7IG51bGxcbiAqIHdoZW4gaXQgaXMgZW1wdHksIG92ZXJzaXplZCwgbWFsZm9ybWVkIG9yIHJlYWNoZXMgb3V0c2lkZSB0aGUgY29uZmlnXG4gKiBkaXJlY3RvcnkuIEEgYCoqYCBzZWdtZW50IG1hdGNoZXMgYW55IG51bWJlclxuICogb2YgcGF0aCBzZWdtZW50cywgbWF0Y2hlZCBieSBhIG1lbW9pc2VkIHdhbGsgc28gYSBob3N0aWxlIHBhdHRlcm4gY29zdHNcbiAqIE8ocGF0dGVybiBzZWdtZW50cyDDlyBwYXRoIHNlZ21lbnRzKSwgbmV2ZXIgZXhwb25lbnRpYWwgdGltZS5cbiAqL1xuZnVuY3Rpb24gY29tcGlsZShlbnRyeTogc3RyaW5nKTogKChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW4pIHwgbnVsbCB7XG4gIGNvbnN0IHBhdHRlcm4gPSBub3JtYWxpc2VFbnRyeShlbnRyeSk7XG4gIGlmIChwYXR0ZXJuID09PSBudWxsIHx8IHBhdHRlcm4ubGVuZ3RoID4gTUFYX1BBVFRFUk5fTEVOR1RIKSByZXR1cm4gbnVsbDtcbiAgLy8gVGhlIGNvbmZpZyBkaXJlY3RvcnkgaXRzZWxmOiBldmVyeSBwYXRoIHVuZGVyIGl0LlxuICBpZiAocGF0dGVybiA9PT0gXCJcIikgcmV0dXJuICgpID0+IHRydWU7XG4gIGNvbnN0IHNlZ21lbnRzOiBTZWdtZW50W10gPSBbXTtcbiAgZm9yIChjb25zdCByYXcgb2YgcGF0dGVybi5zcGxpdChcIi9cIikpIHtcbiAgICBpZiAocmF3ID09PSBcIioqXCIpIHtcbiAgICAgIGlmIChzZWdtZW50c1tzZWdtZW50cy5sZW5ndGggLSAxXSAhPT0gXCIqKlwiKSBzZWdtZW50cy5wdXNoKFwiKipcIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgYWx0ZXJuYXRpdmVzID0gZXhwYW5kQnJhY2VzKHJhdyk7XG4gICAgaWYgKGFsdGVybmF0aXZlcyA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gICAgc2VnbWVudHMucHVzaChhbHRlcm5hdGl2ZXMpO1xuICB9XG4gIHJldHVybiAocGF0aCkgPT4ge1xuICAgIGNvbnN0IHBhcnRzID0gcGF0aC5zcGxpdChcIi9cIik7XG4gICAgY29uc3QgbWVtbyA9IG5ldyBNYXA8bnVtYmVyLCBib29sZWFuPigpO1xuICAgIGNvbnN0IHdhbGsgPSAoc2k6IG51bWJlciwgcGk6IG51bWJlcik6IGJvb2xlYW4gPT4ge1xuICAgICAgY29uc3Qga2V5ID0gc2kgKiAocGFydHMubGVuZ3RoICsgMSkgKyBwaTtcbiAgICAgIGNvbnN0IGNhY2hlZCA9IG1lbW8uZ2V0KGtleSk7XG4gICAgICBpZiAoY2FjaGVkICE9PSB1bmRlZmluZWQpIHJldHVybiBjYWNoZWQ7XG4gICAgICBsZXQgcmVzdWx0OiBib29sZWFuO1xuICAgICAgY29uc3Qgc2VnID0gc2VnbWVudHNbc2ldO1xuICAgICAgaWYgKHNlZyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJlc3VsdCA9IHBpID09PSBwYXJ0cy5sZW5ndGg7XG4gICAgICB9IGVsc2UgaWYgKHNlZyA9PT0gXCIqKlwiKSB7XG4gICAgICAgIHJlc3VsdCA9IHdhbGsoc2kgKyAxLCBwaSkgfHwgKHBpIDwgcGFydHMubGVuZ3RoICYmIHdhbGsoc2ksIHBpICsgMSkpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgcGFydCA9IHBhcnRzW3BpXTtcbiAgICAgICAgcmVzdWx0ID0gcGFydCAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgICAgc2VnLnNvbWUoKGFsdCkgPT4gd2lsZGNhcmRNYXRjaChhbHQsIHBhcnQpKSAmJiB3YWxrKHNpICsgMSwgcGkgKyAxKTtcbiAgICAgIH1cbiAgICAgIG1lbW8uc2V0KGtleSwgcmVzdWx0KTtcbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfTtcbiAgICByZXR1cm4gd2FsaygwLCAwKTtcbiAgfTtcbn1cblxuLyoqIFRoZSBwYXRoIGl0c2VsZiBhbmQgZWFjaCBhbmNlc3RvciBkaXJlY3RvcnksIHNob3J0ZXN0IGZpcnN0LiAqL1xuZnVuY3Rpb24gcGF0aEFuZEFuY2VzdG9ycyhwYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHBhcnRzID0gcGF0aC5zcGxpdChcIi9cIik7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IDE7IGkgPD0gcGFydHMubGVuZ3RoOyBpKyspIG91dC5wdXNoKHBhcnRzLnNsaWNlKDAsIGkpLmpvaW4oXCIvXCIpKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFdoZXRoZXIgYHBhdGhgIG9yIGFueSBkaXJlY3RvcnkgYWJvdmUgaXQgbWF0Y2hlcyB0aGUgZW50cnkuICovXG5mdW5jdGlvbiBtYXRjaGVzRW50cnkocGF0aDogc3RyaW5nLCBlbnRyeTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG1hdGNoZXMgPSBjb21waWxlKGVudHJ5KTtcbiAgaWYgKG1hdGNoZXMgPT09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHBhdGhBbmRBbmNlc3RvcnMocGF0aCkuc29tZShtYXRjaGVzKTtcbn1cblxuLyoqIExhc3QgbWF0Y2hpbmcgZW50cnkgd2luczsgYSBgIWAgZW50cnkgcmUtaW5jbHVkZXMuICovXG5mdW5jdGlvbiBleGNsdWRlZChwYXRoOiBzdHJpbmcsIGVudHJpZXM6IHJlYWRvbmx5IHN0cmluZ1tdIHwgdW5kZWZpbmVkKSB7XG4gIGxldCByZXN1bHQgPSBmYWxzZTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzID8/IFtdKSB7XG4gICAgaWYgKGVudHJ5LnN0YXJ0c1dpdGgoXCIhXCIpKSB7XG4gICAgICBpZiAobWF0Y2hlc0VudHJ5KHBhdGgsIGVudHJ5LnNsaWNlKDEpKSkgcmVzdWx0ID0gZmFsc2U7XG4gICAgfSBlbHNlIGlmIChtYXRjaGVzRW50cnkocGF0aCwgZW50cnkpKSB7XG4gICAgICByZXN1bHQgPSB0cnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIFdoZXRoZXIgdGhlIHJlcG8ncyBvd24gYGRlbm8gPHRvb2w+YCBydW4sIGF0IHRoZSBjb25maWcncyBkaXJlY3RvcnksIHdvdWxkXG4gKiBjaGVjayBgcmVsUGF0aGAgKGEgYC9gLXNlcGFyYXRlZCBwYXRoIHJlbGF0aXZlIHRvIHRoYXQgZGlyZWN0b3J5KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluRGVub1Njb3BlKFxuICByZWxQYXRoOiBzdHJpbmcsXG4gIGNvbmZpZzogRGVub1Njb3BlQ29uZmlnLFxuICB0b29sOiBEZW5vU2NvcGVUb29sLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IHBhdGggPSBub3JtYWxpc2VQYXR0ZXJuKHJlbFBhdGgpO1xuICBpZiAoXG4gICAgcGF0aEFuZEFuY2VzdG9ycyhwYXRoKS5zb21lKChwKSA9PiAvKF58XFwvKShub2RlX21vZHVsZXN8XFwuZ2l0KSQvLnRlc3QocCkpXG4gICkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBjb25zdCBzY29wZSA9IGNvbmZpZ1t0b29sXTtcbiAgY29uc3QgaW5jbHVkZXMgPSBzY29wZT8uaW5jbHVkZTtcbiAgLy8gQW4gaW5jbHVkZSB3ZSBjYW5ub3QgY29tcGlsZSBpcyBub3QgZ3Vlc3NlZCBhdDogdGhlIGZpbGUgc3RheXMgaW4gc2NvcGVcbiAgLy8gYW5kIGRlbm8gaXRzZWxmIGp1ZGdlcyBpdCwgc28gYSBwdXNoIGlzIG5ldmVyIHdhdmVkIHRocm91Z2ggb24gYSBndWVzcy5cbiAgaWYgKFxuICAgIGluY2x1ZGVzICE9PSB1bmRlZmluZWQgJiYgaW5jbHVkZXMubGVuZ3RoID4gMCAmJlxuICAgIGluY2x1ZGVzLmV2ZXJ5KChlbnRyeSkgPT4gY29tcGlsZShlbnRyeSkgIT09IG51bGwpICYmXG4gICAgIWluY2x1ZGVzLnNvbWUoKGVudHJ5KSA9PiBtYXRjaGVzRW50cnkocGF0aCwgZW50cnkpKVxuICApIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuICFleGNsdWRlZChwYXRoLCBjb25maWcuZXhjbHVkZSkgJiYgIWV4Y2x1ZGVkKHBhdGgsIHNjb3BlPy5leGNsdWRlKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW1CQyxHQUVELFNBQVMsVUFBVSxRQUFRLGFBQWE7QUFpQnhDLE1BQU0scUJBQXFCO0FBRTNCLFNBQVMsV0FBVyxLQUFjO0VBQ2hDLElBQUksQ0FBQyxNQUFNLE9BQU8sQ0FBQyxRQUFRLE9BQU87RUFDbEMsT0FBTyxNQUFNLE1BQU0sQ0FBQyxDQUFDLElBQW1CLE9BQU8sTUFBTTtBQUN2RDtBQUVBLFNBQVMsVUFBVSxLQUFjO0VBQy9CLElBQUksT0FBTyxVQUFVLFlBQVksVUFBVSxNQUFNLE9BQU87RUFDeEQsTUFBTSxNQUFNO0VBQ1osT0FBTztJQUFFLFNBQVMsV0FBVyxJQUFJLE9BQU87SUFBRyxTQUFTLFdBQVcsSUFBSSxPQUFPO0VBQUU7QUFDOUU7QUFFQTs7OztDQUlDLEdBQ0QsT0FBTyxTQUFTLGVBQWUsSUFBWTtFQUN6QyxJQUFJO0VBQ0osSUFBSTtJQUNGLFNBQVMsS0FBSyxLQUFLLENBQUMsV0FBVztFQUNqQyxFQUFFLE9BQU07SUFDTixPQUFPO0VBQ1Q7RUFDQSxJQUFJLE9BQU8sV0FBVyxZQUFZLFdBQVcsUUFBUSxNQUFNLE9BQU8sQ0FBQyxTQUFTO0lBQzFFLE9BQU87RUFDVDtFQUNBLE1BQU0sTUFBTTtFQUNaLE9BQU87SUFDTCxTQUFTLFdBQVcsSUFBSSxPQUFPO0lBQy9CLEtBQUssVUFBVSxJQUFJLEdBQUc7SUFDdEIsTUFBTSxVQUFVLElBQUksSUFBSTtFQUMx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
// denoCacheMetadata=12578082307470423304,8703774839760958214