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
 */

/** Top-level `.claude/` subdirectories that hold session state. */
const SESSION_DIRECTORIES = new Set([
  "projects",
  "sessions",
  "todos",
  "history",
  "memory",
]);

/** Data extensions a resumed session needs — never executable or config. */
const SESSION_FILE_EXTENSIONS = new Set(["json", "jsonl", "txt"]);

/** Top-level session data files, e.g. `session.json`, `projects-42.jsonl`. */
const TOP_LEVEL_FILE =
  /^(session|sessions|projects|todos|history|memory)([-_][A-Za-z0-9._-]+)?\.(json|jsonl)$/;

/**
 * A path component safe to copy: no leading dot (excludes dotfiles, `.` and
 * `..`), no separators, no shell-significant characters.
 */
const SAFE_COMPONENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Decide whether an entry may cross the session store boundary.
 *
 * @param relativePath - Path relative to `.claude/`, using `/` separators
 * @param kind - Whether the entry is a file or a directory
 * @returns `true` only for allowlisted session state
 */
export function isAllowedSessionPath(
  relativePath: string,
  kind: "file" | "directory",
): boolean {
  const components = relativePath.split("/");
  if (components.some((c) => !SAFE_COMPONENT.test(c))) return false;

  const name = components[components.length - 1] ?? "";
  const root = components[0] ?? "";
  // Defence in depth: a settings file is never session state, at any depth.
  if (name.toLowerCase().startsWith("settings")) return false;

  if (components.length === 1) {
    return kind === "directory"
      ? SESSION_DIRECTORIES.has(name)
      : TOP_LEVEL_FILE.test(name);
  }

  if (!SESSION_DIRECTORIES.has(root)) return false;
  if (kind === "directory") return true;

  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return SESSION_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
