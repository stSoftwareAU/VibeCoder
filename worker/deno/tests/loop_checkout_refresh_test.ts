/**
 * Both supervisors must refresh their own checkout every cycle (Issue #1401).
 *
 * `loop.sh` ends each cycle with a `git pull`, so a host it supervises picks
 * up every merged fix — including a fix for whatever is breaking it. `run.ps1`
 * updates the checkout too (`worker-checkout-update`), but only once a cycle
 * reaches that step: a run that dies earlier — no `deno` on PATH, an
 * unreadable configuration, a refused run mode — never gets there, and a
 * `loop.ps1` with no refresh of its own then runs the same frozen revision
 * for ever. The host looks healthy while it does it, which is why this
 * survived until it was found by hand.
 *
 * The check reads the two supervisors' **executable** lines, so a `git pull`
 * written in a comment cannot stand in for one that runs. It never spawns
 * either script — the behavioural half belongs to the loop parity suite,
 * filed separately.
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
 * Indices of the lines on which a supervisor refreshes its own checkout.
 *
 * @param source - The supervisor's full source text
 * @param dialect - Language the supervisor is written in
 * @returns Zero-based line indices of every executable `git pull`
 */
function checkoutRefreshLines(
  source: string,
  dialect: LauncherDialect,
): number[] {
  const found: number[] = [];
  executableLines(source, dialect).forEach((line, index) => {
    // A literal scan rather than a regex: the source is untrusted only in the
    // sense that it is large, and there is nothing here worth a backtracking
    // surface.
    const pull = line.indexOf("git pull");
    if (pull === -1) return;
    const before = pull === 0 ? "" : line[pull - 1];
    if (before === undefined || /[\w./-]/.test(before)) return; // `mygit pull`
    found.push(index);
  });
  return found;
}

/** Index of the last executable line containing `needle`, or -1. */
function lastExecutableLine(
  source: string,
  dialect: LauncherDialect,
  needle: string,
): number {
  return executableLines(source, dialect).reduce(
    (last, line, index) => (line.includes(needle) ? index : last),
    -1,
  );
}

const LOOP_SH = await Deno.readTextFile(`${REPO_ROOT}/loop.sh`);
const LOOP_PS1 = await Deno.readTextFile(`${REPO_ROOT}/loop.ps1`);

// ---------------------------------------------------------------------------
// The reader itself, against sources whose contents are known
// ---------------------------------------------------------------------------

Deno.test("checkoutRefreshLines - finds the refresh in a bash supervisor", () => {
  assertEquals(
    checkoutRefreshLines(
      ["while true; do", "  ./run.sh", "  if git pull; then :; fi", "done"]
        .join("\n"),
      "bash",
    ),
    [2],
  );
});

Deno.test("checkoutRefreshLines - finds the refresh in a PowerShell supervisor", () => {
  assertEquals(
    checkoutRefreshLines(
      ["while ($true) {", "    & ./run.ps1", "    & git pull", "}"].join("\n"),
      "powershell",
    ),
    [2],
  );
});

Deno.test("checkoutRefreshLines - a refresh described in a comment is not one", () => {
  assertEquals(
    checkoutRefreshLines(
      ["# The cycle ends with git pull.", "./run.sh"].join("\n"),
      "bash",
    ),
    [],
  );
  assertEquals(
    checkoutRefreshLines(
      ["<#", "  The cycle ends with git pull.", "#>", "& ./run.ps1"].join("\n"),
      "powershell",
    ),
    [],
  );
});

Deno.test("checkoutRefreshLines - a longer command ending in git is not a refresh", () => {
  assertEquals(
    checkoutRefreshLines("hub-git pull\n/usr/bin/git pull", "bash"),
    [],
  );
});

// ---------------------------------------------------------------------------
// The two supervisors as they actually stand
// ---------------------------------------------------------------------------

Deno.test("loop.sh refreshes the worker checkout every cycle", () => {
  assert(
    checkoutRefreshLines(LOOP_SH, "bash").length > 0,
    "loop.sh must end its cycle by pulling the checkout",
  );
});

Deno.test("loop.ps1 refreshes the worker checkout every cycle (Issue #1401)", () => {
  assert(
    checkoutRefreshLines(LOOP_PS1, "powershell").length > 0,
    "loop.ps1 never updates its checkout, so a Windows host it supervises " +
      "runs the revision it was started with for ever — every merged fix, " +
      "security fixes included, never reaches it (Issue #1401)",
  );
});

Deno.test("loop.ps1 refreshes at the same point in the cycle as loop.sh", () => {
  // Both supervisors pull *after* the backoff sleep, so the next cycle starts
  // on the newest revision the host can reach.
  const sleepLine = lastExecutableLine(LOOP_PS1, "powershell", "Start-Sleep");
  assert(sleepLine >= 0, "loop.ps1 must sleep between cycles");

  const refreshes = checkoutRefreshLines(LOOP_PS1, "powershell");
  assert(
    refreshes.some((line) => line > sleepLine),
    `loop.ps1 must pull after its inter-cycle sleep (sleep at line ` +
      `${sleepLine + 1}, pulls at ${refreshes.map((l) => l + 1).join(", ")})`,
  );
});
