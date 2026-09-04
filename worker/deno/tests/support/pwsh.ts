/**
 * Resolving PowerShell to an absolute path for the pwsh suites (Issue #971).
 *
 * Three suites drive the repository's own `.ps1` scripts and each carried its
 * own copy of "run `pwsh -Command 'exit 0'` and, if that worked, remember the
 * name". Remembering the *name* is the bug. `setup_ps1_test.ts` spawns its
 * interpreter with `clearEnv: true` and `PATH: "/usr/bin:/bin"`, deliberately,
 * so the script under test cannot reach `gh` or `claude`. On a host that keeps
 * PowerShell anywhere else — Homebrew puts it in `/opt/homebrew/bin` — the
 * probe succeeds against the developer's own `PATH` and every case then dies
 * with `NotFound: Failed to spawn 'pwsh'`.
 *
 * That reads as "the pwsh tests fail on this host", and it was counted that
 * way: sixteen of the eighteen failures Issue #971 set out to explain are this
 * one line. It is not a race and not a missing interpreter — PowerShell was
 * installed the whole time. It is a test resolving a binary against one `PATH`
 * and then spawning it against another. On the Linux CI runner, where
 * PowerShell is `/usr/bin/pwsh`, the sanitised `PATH` happens to contain it,
 * which is why CI never saw any of this.
 *
 * So the name is resolved against the caller's own `PATH` here, once, and the
 * absolute path is what the suites spawn. The sanitised `PATH` keeps its
 * purpose and a host that has PowerShell runs the suites wherever it keeps it.
 *
 * The resolution is deliberately **not** delegated to the interpreter itself.
 * Both `(Get-Process -Id $PID).Path` and `(Get-Command pwsh).Source` answer
 * with the real binary inside Homebrew's Cellar, and that binary cannot start
 * on its own: the `pwsh` on `PATH` is a shell script whose whole job is to
 * export `DOTNET_ROOT` before exec-ing it. Spawning what the interpreter calls
 * itself therefore trades a "not found" for `You must install .NET to run this
 * application`. The executable to spawn is the one `PATH` names, not the one
 * it points at.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/** Interpreters tried, in order, when a caller names none. */
const DEFAULT_CANDIDATES: readonly string[] = ["pwsh", "powershell"];

/**
 * The absolute path of a working PowerShell, or null when this host has none.
 *
 * `$env:VIBE_PWSH` is tried first, so a host that keeps PowerShell off `PATH`
 * can name it directly. Each candidate is started once to prove it runs, then
 * located on `PATH`; a candidate that runs but cannot be located is returned
 * under its bare name, which is what these suites did before — no worse, and
 * still correct wherever the spawn inherits the caller's `PATH`.
 *
 * @param candidates interpreter names to try after `VIBE_PWSH`.
 */
export async function resolvePowerShell(
  candidates: readonly string[] = DEFAULT_CANDIDATES,
): Promise<string | null> {
  for (const candidate of [Deno.env.get("VIBE_PWSH"), ...candidates]) {
    if (!candidate) continue;
    if (!await starts(candidate)) continue;
    return await locateOnPath(candidate) ?? candidate;
  }
  return null;
}

/** Whether `candidate` is a PowerShell that starts and exits cleanly. */
async function starts(candidate: string): Promise<boolean> {
  try {
    const output = await new Deno.Command(candidate, {
      args: ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      stdout: "null",
      stderr: "null",
      stdin: "null",
    }).output();
    return output.success;
  } catch {
    // Not installed under this name — the caller tries the next one.
    return false;
  }
}

/**
 * Where `PATH` says `name` lives, or null when no entry holds it.
 *
 * A candidate that already carries a separator is a path, not a name, and is
 * returned unchanged.
 */
async function locateOnPath(name: string): Promise<string | null> {
  if (name.includes("/") || name.includes("\\")) return name;
  const windows = Deno.build.os === "windows";
  const separator = windows ? ";" : ":";
  const directories = (Deno.env.get("PATH") ?? "").split(separator)
    .filter((directory) => directory.length > 0);
  // On Windows the executable is `pwsh.exe`, and which suffixes count is the
  // host's own setting rather than a fixed list.
  const suffixes = windows
    ? (Deno.env.get("PATHEXT") ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const path = `${directory}${windows ? "\\" : "/"}${name}${suffix}`;
      try {
        if ((await Deno.stat(path)).isFile) return path;
      } catch {
        // Not this entry.
      }
    }
  }
  return null;
}
