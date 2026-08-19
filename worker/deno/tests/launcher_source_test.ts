/**
 * Tests for launcher_source.ts — native-branch gating (Issue #4147).
 *
 * The launch contract permits a native execution path only inside an explicit
 * native branch, so everything rests on this scan answering one question
 * correctly per line: is this line inside a branch whose condition names the
 * `native` mode? These tests pin that answer for both dialects, including the
 * cases that decide whether a real fault is reported — `else` is not the
 * native branch, a closed branch stops gating, and a comment neither gates nor
 * executes.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  executableLines,
  mentionsNativeMode,
  nativeBranchGatedLines,
} from "../lib/launcher_source.ts";

// ---------------------------------------------------------------------------
// Naming the mode
// ---------------------------------------------------------------------------

Deno.test("mentionsNativeMode - recognises the mode however it is quoted", () => {
  for (
    const condition of [
      'if [[ "${RUN_MODE}" == "native" ]]; then',
      "if [ $RUN_MODE = native ]; then",
      "native)",
      '($RunMode -eq "native")',
      "native",
      // Seatbelt mode is native execution under a profile (Issue #4300).
      'if [[ "${RUN_MODE}" == "seatbelt" ]]; then',
      "seatbelt)",
    ]
  ) {
    assertEquals(mentionsNativeMode(condition), true, condition);
  }
});

Deno.test("mentionsNativeMode - is not fooled by words that merely contain it", () => {
  for (
    const condition of [
      "$NativeHelper",
      "alternative",
      "nativity",
      "renative",
      "seatbelted",
      "$SeatbeltHelper",
      'if [[ "${RUN_MODE}" == "container" ]]; then',
      "",
    ]
  ) {
    assertEquals(mentionsNativeMode(condition), false, condition);
  }
});

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

Deno.test("executableLines - strips bash comments but keeps parameter expansion", () => {
  assertEquals(
    executableLines(
      [
        "# native mode lives here",
        'echo "${PATH#/usr}" # trailing note',
        "run_it",
      ].join("\n"),
      "bash",
    ),
    ["", 'echo "${PATH#/usr}" ', "run_it"],
  );
});

Deno.test("executableLines - strips PowerShell line and block comments", () => {
  assertEquals(
    executableLines(
      [
        "<#",
        ".SYNOPSIS",
        "    A block comment mentioning native { braces }",
        "#>",
        "$RunMode = 'container' # trailing note",
      ].join("\n"),
      "powershell",
    ),
    ["", "", "", "", "$RunMode = 'container' "],
  );
});

// ---------------------------------------------------------------------------
// Bash gating
// ---------------------------------------------------------------------------

Deno.test("nativeBranchGatedLines - gates a bash native branch and nothing else", () => {
  const source = [
    "launch_container", // 0 — before the branch
    'if [[ "${RUN_MODE}" == "native" ]]; then', // 1 — the opener
    "  exec run_natively", // 2 — gated
    "else", // 3
    "  launch_container", // 4 — the default path, never gated
    "fi", // 5
    "after_everything", // 6
  ].join("\n");

  assertEquals(
    nativeBranchGatedLines(source, "bash"),
    [false, true, true, false, false, false, false],
  );
});

Deno.test("nativeBranchGatedLines - gates a bash case arm by its pattern", () => {
  const source = [
    'case "${RUN_MODE}" in', // 0
    "  native)", // 1
    "    exec run_natively", // 2 — gated
    "    ;;", // 3
    "  container)", // 4
    "    launch_container", // 5 — not gated
    "    ;;", // 6
    "esac", // 7
    "done_here", // 8
  ].join("\n");

  assertEquals(
    nativeBranchGatedLines(source, "bash"),
    [false, true, true, true, false, false, false, false, false],
  );
});

Deno.test("nativeBranchGatedLines - a bash comment neither gates nor is gated", () => {
  const source = [
    "# native execution is described here", // 0
    "exec run_natively", // 1 — really ungated
  ].join("\n");

  assertEquals(nativeBranchGatedLines(source, "bash"), [false, false]);
});

Deno.test("nativeBranchGatedLines - handles a one-line bash native branch", () => {
  const source = [
    'if [[ "${RUN_MODE}" == "native" ]]; then exec run_natively; fi', // 0
    "launch_container", // 1 — the branch closed on the line above
  ].join("\n");

  assertEquals(nativeBranchGatedLines(source, "bash"), [true, false]);
});

// ---------------------------------------------------------------------------
// PowerShell gating
// ---------------------------------------------------------------------------

Deno.test("nativeBranchGatedLines - gates a PowerShell native brace block", () => {
  const source = [
    "Start-Container", // 0
    'if ($RunMode -eq "native") {', // 1
    "    Start-Native", // 2 — gated
    "} else {", // 3
    "    Start-Container", // 4 — not gated
    "}", // 5
    "Write-Host done", // 6
  ].join("\n");

  assertEquals(
    nativeBranchGatedLines(source, "powershell"),
    [false, true, true, false, false, false, false],
  );
});

Deno.test("nativeBranchGatedLines - reads a PowerShell condition above its brace", () => {
  const source = [
    'if ($RunMode -eq "native")', // 0
    "{", // 1
    "    Start-Native", // 2 — gated
    "}", // 3
    "Start-Container", // 4
  ].join("\n");

  assertEquals(
    nativeBranchGatedLines(source, "powershell"),
    [false, true, true, false, false],
  );
});

Deno.test("nativeBranchGatedLines - a PowerShell switch arm gates its own body", () => {
  const source = [
    "switch ($RunMode) {", // 0
    '    "native" {', // 1
    "        Start-Native", // 2 — gated
    "    }", // 3
    '    "container" {', // 4
    "        Start-Container", // 5 — not gated
    "    }", // 6
    "}", // 7
  ].join("\n");

  assertEquals(
    nativeBranchGatedLines(source, "powershell"),
    [false, true, true, false, false, false, false, false],
  );
});
