/**
 * Allowlist policy for Claude session persistence (Issue #3663).
 *
 * `.claude/` sits inside the working tree the Claude CLI runs in, so the
 * model can write anything there — including `settings.json`, whose `hooks`
 * entries are shell commands the CLI executes. Persisting that directory
 * wholesale gave model-authored content a cross-run execution foothold that
 * never appears in a pull request diff.
 *
 * Only transcript/session *data* crosses the store boundary. Everything else
 * — settings, hooks, agents, commands, skills, scripts — is dropped on both
 * the save and the restore leg, so a store poisoned by an earlier run is also
 * neutralised on the way back in.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /** Top-level `.claude/` subdirectories that hold session state. */ const SESSION_DIRECTORIES = new Set([
  "projects",
  "sessions",
  "todos",
  "history",
  "memory"
]);
/** Data extensions a resumed session needs — never executable or config. */ const SESSION_FILE_EXTENSIONS = new Set([
  "json",
  "jsonl",
  "txt"
]);
/** Top-level session data files, e.g. `session.json`, `projects-42.jsonl`. */ const TOP_LEVEL_FILE = /^(session|sessions|projects|todos|history|memory)([-_][A-Za-z0-9._-]+)?\.(json|jsonl)$/;
/**
 * A path component safe to copy: no leading dot (excludes dotfiles, `.` and
 * `..`), no separators, no shell-significant characters.
 */ const SAFE_COMPONENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/**
 * Decide whether an entry may cross the session store boundary.
 *
 * @param relativePath - Path relative to `.claude/`, using `/` separators
 * @param kind - Whether the entry is a file or a directory
 * @returns `true` only for allowlisted session state
 */ export function isAllowedSessionPath(relativePath, kind) {
  const components = relativePath.split("/");
  if (components.some((c)=>!SAFE_COMPONENT.test(c))) return false;
  const name = components[components.length - 1] ?? "";
  const root = components[0] ?? "";
  // Defence in depth: a settings file is never session state, at any depth.
  if (name.toLowerCase().startsWith("settings")) return false;
  if (components.length === 1) {
    return kind === "directory" ? SESSION_DIRECTORIES.has(name) : TOP_LEVEL_FILE.test(name);
  }
  if (!SESSION_DIRECTORIES.has(root)) return false;
  if (kind === "directory") return true;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return SESSION_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zZXNzaW9uX2ZpbGVfcG9saWN5LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQWxsb3dsaXN0IHBvbGljeSBmb3IgQ2xhdWRlIHNlc3Npb24gcGVyc2lzdGVuY2UgKElzc3VlICMzNjYzKS5cbiAqXG4gKiBgLmNsYXVkZS9gIHNpdHMgaW5zaWRlIHRoZSB3b3JraW5nIHRyZWUgdGhlIENsYXVkZSBDTEkgcnVucyBpbiwgc28gdGhlXG4gKiBtb2RlbCBjYW4gd3JpdGUgYW55dGhpbmcgdGhlcmUg4oCUIGluY2x1ZGluZyBgc2V0dGluZ3MuanNvbmAsIHdob3NlIGBob29rc2BcbiAqIGVudHJpZXMgYXJlIHNoZWxsIGNvbW1hbmRzIHRoZSBDTEkgZXhlY3V0ZXMuIFBlcnNpc3RpbmcgdGhhdCBkaXJlY3RvcnlcbiAqIHdob2xlc2FsZSBnYXZlIG1vZGVsLWF1dGhvcmVkIGNvbnRlbnQgYSBjcm9zcy1ydW4gZXhlY3V0aW9uIGZvb3Rob2xkIHRoYXRcbiAqIG5ldmVyIGFwcGVhcnMgaW4gYSBwdWxsIHJlcXVlc3QgZGlmZi5cbiAqXG4gKiBPbmx5IHRyYW5zY3JpcHQvc2Vzc2lvbiAqZGF0YSogY3Jvc3NlcyB0aGUgc3RvcmUgYm91bmRhcnkuIEV2ZXJ5dGhpbmcgZWxzZVxuICog4oCUIHNldHRpbmdzLCBob29rcywgYWdlbnRzLCBjb21tYW5kcywgc2tpbGxzLCBzY3JpcHRzIOKAlCBpcyBkcm9wcGVkIG9uIGJvdGhcbiAqIHRoZSBzYXZlIGFuZCB0aGUgcmVzdG9yZSBsZWcsIHNvIGEgc3RvcmUgcG9pc29uZWQgYnkgYW4gZWFybGllciBydW4gaXMgYWxzb1xuICogbmV1dHJhbGlzZWQgb24gdGhlIHdheSBiYWNrIGluLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbi8qKiBUb3AtbGV2ZWwgYC5jbGF1ZGUvYCBzdWJkaXJlY3RvcmllcyB0aGF0IGhvbGQgc2Vzc2lvbiBzdGF0ZS4gKi9cbmNvbnN0IFNFU1NJT05fRElSRUNUT1JJRVMgPSBuZXcgU2V0KFtcbiAgXCJwcm9qZWN0c1wiLFxuICBcInNlc3Npb25zXCIsXG4gIFwidG9kb3NcIixcbiAgXCJoaXN0b3J5XCIsXG4gIFwibWVtb3J5XCIsXG5dKTtcblxuLyoqIERhdGEgZXh0ZW5zaW9ucyBhIHJlc3VtZWQgc2Vzc2lvbiBuZWVkcyDigJQgbmV2ZXIgZXhlY3V0YWJsZSBvciBjb25maWcuICovXG5jb25zdCBTRVNTSU9OX0ZJTEVfRVhURU5TSU9OUyA9IG5ldyBTZXQoW1wianNvblwiLCBcImpzb25sXCIsIFwidHh0XCJdKTtcblxuLyoqIFRvcC1sZXZlbCBzZXNzaW9uIGRhdGEgZmlsZXMsIGUuZy4gYHNlc3Npb24uanNvbmAsIGBwcm9qZWN0cy00Mi5qc29ubGAuICovXG5jb25zdCBUT1BfTEVWRUxfRklMRSA9XG4gIC9eKHNlc3Npb258c2Vzc2lvbnN8cHJvamVjdHN8dG9kb3N8aGlzdG9yeXxtZW1vcnkpKFstX11bQS1aYS16MC05Ll8tXSspP1xcLihqc29ufGpzb25sKSQvO1xuXG4vKipcbiAqIEEgcGF0aCBjb21wb25lbnQgc2FmZSB0byBjb3B5OiBubyBsZWFkaW5nIGRvdCAoZXhjbHVkZXMgZG90ZmlsZXMsIGAuYCBhbmRcbiAqIGAuLmApLCBubyBzZXBhcmF0b3JzLCBubyBzaGVsbC1zaWduaWZpY2FudCBjaGFyYWN0ZXJzLlxuICovXG5jb25zdCBTQUZFX0NPTVBPTkVOVCA9IC9eW0EtWmEtejAtOV8tXVtBLVphLXowLTkuXy1dKiQvO1xuXG4vKipcbiAqIERlY2lkZSB3aGV0aGVyIGFuIGVudHJ5IG1heSBjcm9zcyB0aGUgc2Vzc2lvbiBzdG9yZSBib3VuZGFyeS5cbiAqXG4gKiBAcGFyYW0gcmVsYXRpdmVQYXRoIC0gUGF0aCByZWxhdGl2ZSB0byBgLmNsYXVkZS9gLCB1c2luZyBgL2Agc2VwYXJhdG9yc1xuICogQHBhcmFtIGtpbmQgLSBXaGV0aGVyIHRoZSBlbnRyeSBpcyBhIGZpbGUgb3IgYSBkaXJlY3RvcnlcbiAqIEByZXR1cm5zIGB0cnVlYCBvbmx5IGZvciBhbGxvd2xpc3RlZCBzZXNzaW9uIHN0YXRlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0FsbG93ZWRTZXNzaW9uUGF0aChcbiAgcmVsYXRpdmVQYXRoOiBzdHJpbmcsXG4gIGtpbmQ6IFwiZmlsZVwiIHwgXCJkaXJlY3RvcnlcIixcbik6IGJvb2xlYW4ge1xuICBjb25zdCBjb21wb25lbnRzID0gcmVsYXRpdmVQYXRoLnNwbGl0KFwiL1wiKTtcbiAgaWYgKGNvbXBvbmVudHMuc29tZSgoYykgPT4gIVNBRkVfQ09NUE9ORU5ULnRlc3QoYykpKSByZXR1cm4gZmFsc2U7XG5cbiAgY29uc3QgbmFtZSA9IGNvbXBvbmVudHNbY29tcG9uZW50cy5sZW5ndGggLSAxXSA/PyBcIlwiO1xuICBjb25zdCByb290ID0gY29tcG9uZW50c1swXSA/PyBcIlwiO1xuICAvLyBEZWZlbmNlIGluIGRlcHRoOiBhIHNldHRpbmdzIGZpbGUgaXMgbmV2ZXIgc2Vzc2lvbiBzdGF0ZSwgYXQgYW55IGRlcHRoLlxuICBpZiAobmFtZS50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoXCJzZXR0aW5nc1wiKSkgcmV0dXJuIGZhbHNlO1xuXG4gIGlmIChjb21wb25lbnRzLmxlbmd0aCA9PT0gMSkge1xuICAgIHJldHVybiBraW5kID09PSBcImRpcmVjdG9yeVwiXG4gICAgICA/IFNFU1NJT05fRElSRUNUT1JJRVMuaGFzKG5hbWUpXG4gICAgICA6IFRPUF9MRVZFTF9GSUxFLnRlc3QobmFtZSk7XG4gIH1cblxuICBpZiAoIVNFU1NJT05fRElSRUNUT1JJRVMuaGFzKHJvb3QpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChraW5kID09PSBcImRpcmVjdG9yeVwiKSByZXR1cm4gdHJ1ZTtcblxuICBjb25zdCBkb3QgPSBuYW1lLmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgaWYgKGRvdCA8PSAwKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBTRVNTSU9OX0ZJTEVfRVhURU5TSU9OUy5oYXMobmFtZS5zbGljZShkb3QgKyAxKS50b0xvd2VyQ2FzZSgpKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FFRCxpRUFBaUUsR0FDakUsTUFBTSxzQkFBc0IsSUFBSSxJQUFJO0VBQ2xDO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7Q0FDRDtBQUVELDBFQUEwRSxHQUMxRSxNQUFNLDBCQUEwQixJQUFJLElBQUk7RUFBQztFQUFRO0VBQVM7Q0FBTTtBQUVoRSw0RUFBNEUsR0FDNUUsTUFBTSxpQkFDSjtBQUVGOzs7Q0FHQyxHQUNELE1BQU0saUJBQWlCO0FBRXZCOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUyxxQkFDZCxZQUFvQixFQUNwQixJQUEwQjtFQUUxQixNQUFNLGFBQWEsYUFBYSxLQUFLLENBQUM7RUFDdEMsSUFBSSxXQUFXLElBQUksQ0FBQyxDQUFDLElBQU0sQ0FBQyxlQUFlLElBQUksQ0FBQyxLQUFLLE9BQU87RUFFNUQsTUFBTSxPQUFPLFVBQVUsQ0FBQyxXQUFXLE1BQU0sR0FBRyxFQUFFLElBQUk7RUFDbEQsTUFBTSxPQUFPLFVBQVUsQ0FBQyxFQUFFLElBQUk7RUFDOUIsMEVBQTBFO0VBQzFFLElBQUksS0FBSyxXQUFXLEdBQUcsVUFBVSxDQUFDLGFBQWEsT0FBTztFQUV0RCxJQUFJLFdBQVcsTUFBTSxLQUFLLEdBQUc7SUFDM0IsT0FBTyxTQUFTLGNBQ1osb0JBQW9CLEdBQUcsQ0FBQyxRQUN4QixlQUFlLElBQUksQ0FBQztFQUMxQjtFQUVBLElBQUksQ0FBQyxvQkFBb0IsR0FBRyxDQUFDLE9BQU8sT0FBTztFQUMzQyxJQUFJLFNBQVMsYUFBYSxPQUFPO0VBRWpDLE1BQU0sTUFBTSxLQUFLLFdBQVcsQ0FBQztFQUM3QixJQUFJLE9BQU8sR0FBRyxPQUFPO0VBQ3JCLE9BQU8sd0JBQXdCLEdBQUcsQ0FBQyxLQUFLLEtBQUssQ0FBQyxNQUFNLEdBQUcsV0FBVztBQUNwRSJ9
// denoCacheMetadata=16763974615424132171,5669368271273241123