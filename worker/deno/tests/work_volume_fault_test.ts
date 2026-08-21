/**
 * Tests for work-volume I/O fault detection (Issue #229).
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  __resetWorkVolumeFault,
  findIoFaultLine,
  noteGitOutputForVolumeFault,
  workVolumeFault,
} from "../lib/work_volume_fault.ts";

Deno.test("findIoFaultLine - recognises the filesystem-level failures git reports", () => {
  assertEquals(
    findIoFaultLine(
      "fatal: cannot open '.git/objects/ab': Structure needs cleaning\n",
    ),
    "fatal: cannot open '.git/objects/ab': Structure needs cleaning",
  );
  assertEquals(
    findIoFaultLine("error: unable to write file x: Input/output error"),
    "error: unable to write file x: Input/output error",
  );
  assertEquals(
    findIoFaultLine("error: could not lock config: Read-only file system"),
    "error: could not lock config: Read-only file system",
  );
  assertEquals(findIoFaultLine("fatal: not a git repository"), null);
  assertEquals(findIoFaultLine(""), null);
});

Deno.test("noteGitOutputForVolumeFault - records the first fault once and keeps it", () => {
  __resetWorkVolumeFault();
  try {
    assertEquals(workVolumeFault(), null);
    assertEquals(
      noteGitOutputForVolumeFault(["status"], "fatal: unrelated failure"),
      null,
    );
    assertEquals(workVolumeFault(), null);
    const first = noteGitOutputForVolumeFault(
      ["fetch", "--prune"],
      "fatal: Structure needs cleaning",
      "",
      () => 1000,
    );
    assertEquals(first?.command, "git fetch --prune");
    assertEquals(first?.at, 1000);
    // A later fault does not replace the first.
    noteGitOutputForVolumeFault(["push"], "Input/output error", "", () => 2000);
    assertEquals(workVolumeFault()?.at, 1000);
  } finally {
    __resetWorkVolumeFault();
  }
});
