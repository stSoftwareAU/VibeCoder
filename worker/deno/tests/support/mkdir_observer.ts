/**
 * Observing the mode a directory has at the instant it is created.
 *
 * `mkdir -p` applies the ambient umask, so a credential directory created that
 * way and narrowed by a following `chmod`/ACL call is world-readable and
 * world-executable for the window between the two — and every parent created
 * on the way keeps the loose mode permanently, because only the last two are
 * ever narrowed (Issue #1374).
 *
 * The mode a directory is *finally* left with cannot see that window, so the
 * suites that assert on it resolve `mkdir` to a shim recording the mode of
 * each path it was asked to create. `setup.sh` and `setup.ps1` are both driven
 * this way (Issue #1430), so the shim lives here rather than once per suite.
 *
 * Australian English spelling throughout (behaviour, colour, etc.)
 */

import { removeTempTree } from "./temp_tree.ts";

/**
 * A `mkdir` that runs the real one and records the mode of every path it was
 * given, one `<octal> <path>` line per directory, into `mkdir.log` beside
 * itself.
 *
 * Only the paths named on the command line are recorded — the intermediate
 * parents `-p` creates on the way are not, so a caller that cares about those
 * asserts on their surviving mode instead.
 */
export const MKDIR_OBSERVER = `#!/usr/bin/env bash
real=""
for candidate in /bin/mkdir /usr/bin/mkdir; do
    if [[ -x "$candidate" ]]; then
        real="$candidate"
        break
    fi
done
if [[ -z "$real" ]]; then
    echo "mkdir observer: no real mkdir found" >&2
    exit 127
fi
"$real" "$@" || exit $?
log="\${0%/*}/mkdir.log"
for arg in "$@"; do
    [[ -d "$arg" ]] || continue
    mode="$(stat -c '%a' "$arg" 2>/dev/null || stat -f '%Lp' "$arg" 2>/dev/null || echo '?')"
    printf '%s %s\\n' "$mode" "$arg" >> "$log"
done
`;

/** One directory as it existed the instant `mkdir` created it. */
export interface CreatedDir {
  mode: number;
  path: string;
}

/**
 * Run `fn` with a PATH whose `mkdir` is the observer above (and whose `gh`
 * reaches nothing), returning what `fn` returned alongside every directory
 * created during the run.
 *
 * @param fn - Given the stubbed PATH, runs the script under test
 * @returns What `fn` returned, and each directory's mode at creation
 */
export async function withMkdirObserver<T>(
  fn: (path: string) => Promise<T>,
): Promise<{ result: T; created: CreatedDir[] }> {
  const bin = await Deno.makeTempDir({ prefix: "vibe_mkdir_observer_" });
  try {
    await Deno.writeTextFile(`${bin}/gh`, "#!/usr/bin/env bash\nexit 1\n");
    await Deno.chmod(`${bin}/gh`, 0o755);
    await Deno.writeTextFile(`${bin}/mkdir`, MKDIR_OBSERVER);
    await Deno.chmod(`${bin}/mkdir`, 0o755);

    const result = await fn(`${bin}:/usr/bin:/bin`);

    const log = await Deno.readTextFile(`${bin}/mkdir.log`).catch(() => "");
    const created = log.split("\n").filter((line) => line.length > 0).map(
      (line) => {
        const [mode, ...rest] = line.split(" ");
        return { mode: parseInt(mode ?? "", 8), path: rest.join(" ") };
      },
    );
    return { result, created };
  } finally {
    await removeTempTree(bin);
  }
}

/** The observed directories that live under `root`, `root` itself included. */
export function under(created: CreatedDir[], root: string): CreatedDir[] {
  return created.filter((dir) =>
    dir.path === root || dir.path.startsWith(`${root}/`)
  );
}

/** Directories an observed run created with any group or world bit set. */
export function exposed(created: CreatedDir[]): string[] {
  return created
    .filter((dir) => (dir.mode & 0o077) !== 0)
    .map((dir) => `${dir.path} (${dir.mode.toString(8)})`);
}
