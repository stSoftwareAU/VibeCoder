/**
 * Both supervisors must ask the worker where the logs go (Issues #873, #1402).
 *
 * Issue #873 moved the default log directory off `$HOME/logs` and onto the
 * platform's own location, resolved in one place — `lib/log_dir.ts`, reached
 * through `mod.ts log-dir` — so the launchers, the supervisors and the
 * container mount cannot disagree about it. `loop.sh` has asked since; PR
 * #1197 found `run.ps1` still spelling the old literal in two places, one of
 * which split an excerpt's header from its body.
 *
 * `loop.ps1` was never examined at that time and carried no resolution at
 * all: it wrote nothing of its own anywhere, so a supervised Windows host had
 * no launch log where an operator — or the escalation the recorder files —
 * would look for one. Both locations being writable is why it hid.
 *
 * The check reads each supervisor's **executable** lines, so a `log-dir`
 * written in a comment cannot stand in for one that runs. It never spawns
 * either script: PowerShell is not installed on every host, and the
 * behavioural half belongs to the pwsh suites that CI's `Validate Scripts`
 * runner owns.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  executableLines,
  type LauncherDialect,
} from "../lib/launcher_source.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/**
 * Indices of the lines on which a supervisor asks the worker for the log
 * directory.
 *
 * The match is on `log-dir` as a whole argument: `--build-log-dir` and
 * `$BuildLogDir` name something else, and a supervisor that resolved only
 * those would still be the defect this suite pins.
 *
 * @param source - The supervisor's full source text
 * @param dialect - Language the supervisor is written in
 * @returns Zero-based line indices of every executable `log-dir` resolution
 */
function logDirResolutionLines(
  source: string,
  dialect: LauncherDialect,
): number[] {
  const found: number[] = [];
  executableLines(source, dialect).forEach((line, index) => {
    // A literal scan rather than a regex over the whole line: the source is
    // untrusted only in that it is large, and there is nothing here worth a
    // backtracking surface.
    let from = 0;
    for (;;) {
      const at = line.indexOf("log-dir", from);
      if (at === -1) return;
      from = at + 1;
      const before = at === 0 ? "" : line[at - 1]!;
      const after = line[at + "log-dir".length] ?? "";
      if (/[\w-]/.test(before)) continue; // `--build-log-dir`
      if (/[\w-]/.test(after)) continue; // `log-directory`
      found.push(index);
      return;
    }
  });
  return found;
}

/** Index of the first executable line containing `needle`, or -1. */
function firstExecutableLine(
  source: string,
  dialect: LauncherDialect,
  needle: string,
): number {
  return executableLines(source, dialect).findIndex((line) =>
    line.includes(needle)
  );
}

const LOOP_SH = await Deno.readTextFile(`${REPO_ROOT}/loop.sh`);
const LOOP_PS1 = await Deno.readTextFile(`${REPO_ROOT}/loop.ps1`);

// ---------------------------------------------------------------------------
// The reader itself, against sources whose contents are known
// ---------------------------------------------------------------------------

Deno.test("logDirResolutionLines - finds the resolution in a bash supervisor", () => {
  assertEquals(
    logDirResolutionLines(
      ['DIR="$("${DENO}" run "${MOD}" log-dir)"', 'mkdir -p "${DIR}"'].join(
        "\n",
      ),
      "bash",
    ),
    [0],
  );
});

Deno.test("logDirResolutionLines - finds the resolution in a PowerShell supervisor", () => {
  assertEquals(
    logDirResolutionLines(
      ['$dir = & $Deno run $WorkerMod "log-dir"', "$launch = $dir"].join("\n"),
      "powershell",
    ),
    [0],
  );
});

Deno.test("logDirResolutionLines - a resolution described in a comment is not one", () => {
  assertEquals(
    logDirResolutionLines(
      ["# The directory comes from mod.ts log-dir.", "./run.sh"].join("\n"),
      "bash",
    ),
    [],
  );
  assertEquals(
    logDirResolutionLines(
      ["<#", "  The directory comes from mod.ts log-dir.", "#>", "& ./run.ps1"]
        .join("\n"),
      "powershell",
    ),
    [],
  );
});

Deno.test("logDirResolutionLines - a longer flag ending in log-dir is not one", () => {
  assertEquals(
    logDirResolutionLines(
      ["--build-log-dir /tmp", "echo log-directory"].join("\n"),
      "bash",
    ),
    [],
  );
});

// ---------------------------------------------------------------------------
// The two supervisors as they actually stand
// ---------------------------------------------------------------------------

Deno.test("loop.sh resolves the log directory through the worker", () => {
  assert(
    logDirResolutionLines(LOOP_SH, "bash").length > 0,
    "loop.sh must ask `mod.ts log-dir` where its launch logs go",
  );
});

Deno.test("loop.ps1 resolves the log directory through the worker (Issue #1402)", () => {
  assert(
    logDirResolutionLines(LOOP_PS1, "powershell").length > 0,
    "loop.ps1 never asks `mod.ts log-dir` where the logs go, so a supervised " +
      "Windows host writes its launch logs somewhere the worker, run.ps1 and " +
      "the operator do not look — the Issue #873 defect PR #1197 fixed in " +
      "run.ps1, still present here (Issue #1402)",
  );
});

Deno.test("loop.ps1 resolves the log directory once, before its first cycle", () => {
  // loop.sh resolves at startup, not per cycle: the directory does not move
  // while the supervisor runs, and a resolution inside the loop would spawn
  // deno on every iteration.
  const loopStart = firstExecutableLine(
    LOOP_PS1,
    "powershell",
    "while ($true)",
  );
  assert(loopStart >= 0, "loop.ps1 must have a supervision loop");

  const resolutions = logDirResolutionLines(LOOP_PS1, "powershell");
  assert(
    resolutions.every((line) => line < loopStart),
    `loop.ps1 must resolve the log directory before its loop (loop at line ` +
      `${loopStart + 1}, resolutions at ${
        resolutions.map((l) => l + 1).join(", ")
      })`,
  );
});

Deno.test("loop.ps1 writes each cycle's launch log into the resolved directory (Issue #1402)", () => {
  const lines = executableLines(LOOP_PS1, "powershell");
  const named = lines.filter((line) =>
    line.includes("launch-") && line.includes("$LoopLogDir")
  );
  assert(
    named.length > 0,
    "loop.ps1 must name its per-cycle launch log under the resolved " +
      "directory — a directory it resolves and never writes to is the same " +
      "silence with more code (Issue #1402)",
  );
});

Deno.test("loop.ps1 falls back to the pre-#873 default loudly, never silently", () => {
  const lines = executableLines(LOOP_PS1, "powershell");
  const notice = lines.findIndex((line) =>
    line.includes("cannot resolve the log directory")
  );
  assert(
    notice >= 0,
    "loop.ps1 must say so when the resolver cannot answer — loop.sh:159 " +
      "does, and a supervisor that must never exit still says what it did",
  );
  const nearby = lines.slice(Math.max(0, notice - 2), notice + 3).join("\n");
  assert(
    nearby.includes("[Console]::Error"),
    "the fallback notice must reach stderr, not stdout: an operator reading " +
      "the console must see that the directory is not the configured one",
  );
});
