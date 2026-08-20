/**
 * Tests for gh_guard_cli.ts — the entry point the agent-side `gh` shim runs
 * once per `gh` invocation (Issue #3643).
 *
 * The shim trusts a positive verdict marker on stdout, never a bare exit code,
 * so these tests assert the marker/exit-code pair for each outcome: allowed,
 * refused, and malformed invocation (which must fail closed).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  encodeGuardStdout,
  GH_GUARD_ALLOW_MARKER,
  GH_GUARD_REFUSE_MARKER,
  runGhGuardCli,
} from "../lib/gh_guard_cli.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

/** A realistic GitHub token shape used by the redaction assertions (#3938). */
const GH_TOKEN_SAMPLE = `ghp_${"a1B2c3D4e5".repeat(4)}`;

Deno.test("gh-guard-cli - emits the allow marker for a permitted write", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    "stSoftwareAU/VibeCoder",
    "--",
    "issue",
    "comment",
    "1",
    "-R",
    "stSoftwareAU/VibeCoder",
    "--body",
    "hi",
  ]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout, GH_GUARD_ALLOW_MARKER);
  assertEquals(result.stderr, "");
});

Deno.test("gh-guard-cli - emits the refuse marker and a reason for a blocked write", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    "stSoftwareAU/VibeCoder",
    "--",
    "issue",
    "comment",
    "1",
    "-R",
    "other/repo",
    "--body",
    "leak",
  ]);
  assertEquals(result.exitCode, 1);
  assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
  assertStringIncludes(result.stderr, "[SECURITY] [WRITE_REPO_BLOCKED]");
});

// ---------------------------------------------------------------------------
// Issue #3938 — the guard is the agent's only chokepoint, so it redacts too
// ---------------------------------------------------------------------------

Deno.test("gh-guard-cli - returns the allowed argv with the body redacted", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    "stSoftwareAU/VibeCoder",
    "--",
    "issue",
    "comment",
    "1",
    "--body",
    `here it is: ${GH_TOKEN_SAMPLE}`,
  ]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout, GH_GUARD_ALLOW_MARKER);
  assertEquals(result.ghArgs, [
    "issue",
    "comment",
    "1",
    "--body",
    `here it is: ${REDACTION_PLACEHOLDER}`,
  ]);
  // The masking is announced, never silent.
  assertStringIncludes(result.stderr, "GH_BODY_REDACTED");
});

Deno.test("gh-guard-cli - returns a clean command's argv unchanged and silently", () => {
  const argv = ["issue", "comment", "1", "--body", "hello world"];
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    "stSoftwareAU/VibeCoder",
    "--",
    ...argv,
  ]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.ghArgs, argv);
  assertEquals(result.stderr, "");
});

Deno.test("gh-guard-cli - redacts a secret carried in a body file", () => {
  const result = runGhGuardCli(
    [
      "--active",
      "--allow-repo",
      "stSoftwareAU/VibeCoder",
      "--",
      "issue",
      "comment",
      "1",
      "--body-file",
      "/tmp/body.md",
    ],
    () => `token ${GH_TOKEN_SAMPLE}`,
  );
  assertEquals(result.exitCode, 0);
  assertEquals(result.ghArgs, [
    "issue",
    "comment",
    "1",
    "--body",
    `token ${REDACTION_PLACEHOLDER}`,
  ]);
});

Deno.test("gh-guard-cli - refuses a body it cannot scan for secrets", () => {
  const result = runGhGuardCli(
    [
      "--active",
      "--allow-repo",
      "stSoftwareAU/VibeCoder",
      "--",
      "issue",
      "comment",
      "1",
      "--body-file",
      "/tmp/gone.md",
    ],
    () => {
      throw new Error("no such file");
    },
  );
  assertEquals(result.exitCode, 1);
  assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
  assertEquals(result.ghArgs, undefined);
  assertStringIncludes(result.stderr, "GH_BODY_UNREDACTABLE");
});

Deno.test("gh-guard-cli - frames the verdict and the argv as NUL-terminated fields", () => {
  assertEquals(
    encodeGuardStdout({
      exitCode: 0,
      stdout: GH_GUARD_ALLOW_MARKER,
      stderr: "",
      ghArgs: ["issue", "comment", "a b"],
    }),
    `${GH_GUARD_ALLOW_MARKER}\0issue\0comment\0a b\0`,
  );
  // A refusal carries the marker alone — there is no argv to run.
  assertEquals(
    encodeGuardStdout({
      exitCode: 1,
      stdout: GH_GUARD_REFUSE_MARKER,
      stderr: "no",
    }),
    `${GH_GUARD_REFUSE_MARKER}\0`,
  );
});

Deno.test("gh-guard-cli - fails closed on a malformed invocation", () => {
  for (
    const argv of [
      ["issue", "comment", "1"], // no `--` separator
      ["--allow-repo"], // flag with no value
      ["--bogus", "--", "issue", "comment", "1"],
    ]
  ) {
    const result = runGhGuardCli(argv);
    assertEquals(result.exitCode, 2, `expected exit 2 for ${argv}`);
    assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
    assertStringIncludes(result.stderr, "GH_GUARD_ERROR");
  }
});

// ---------------------------------------------------------------------------
// Issue #91 — end-to-end: the CLI wires `denoBodyFileReader` into the decision
// so a `gh api --input <file>` body is read from disk and scanned. These use a
// real temp file (not the default reader override) to prove the wiring: if the
// reader were never injected, the reserved-label body below would slip through
// as GH_BODY_UNREADABLE instead of being named.
// ---------------------------------------------------------------------------

Deno.test("gh-guard-cli #91 - refuses a reserved label carried by a real --input file", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, '{"labels":["top-priority"]}');
    const result = runGhGuardCli([
      "--active",
      "--allow-repo",
      "stSoftwareAU/VibeCoder",
      "--",
      "api",
      "repos/stSoftwareAU/VibeCoder/issues/1/labels",
      "--input",
      path,
    ]);
    assertEquals(result.exitCode, 1);
    assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
    assertStringIncludes(result.stderr, "[SECURITY] [WORKER_LABEL_REFUSED]");
    assertStringIncludes(result.stderr, "top-priority");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("gh-guard-cli #91 - allows a clean --input file on the allowlisted repo", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, '{"labels":["confidence:high","security"]}');
    const result = runGhGuardCli([
      "--active",
      "--allow-repo",
      "stSoftwareAU/VibeCoder",
      "--",
      "api",
      "repos/stSoftwareAU/VibeCoder/issues/1/labels",
      "--input",
      path,
    ]);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, GH_GUARD_ALLOW_MARKER);
    assertEquals(result.stderr, "");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("gh-guard-cli #91 - fails closed when the --input path does not exist", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    "stSoftwareAU/VibeCoder",
    "--",
    "api",
    "repos/stSoftwareAU/VibeCoder/issues/1/labels",
    "--input",
    "/tmp/does-not-exist-91.json",
  ]);
  assertEquals(result.exitCode, 1);
  assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
  assertStringIncludes(result.stderr, "[SECURITY] [GH_BODY_UNREADABLE]");
});

// ---------------------------------------------------------------------------
// Issue #92 — end-to-end: `gh api …/comments --input <file>` through the guard.
// The default reader + writer are wired, so a secret in the JSON body is masked
// into a fresh temp file the executed argv points at — the agent's file and the
// secret never reach GitHub.
// ---------------------------------------------------------------------------

Deno.test("gh-guard-cli #92 - masks a secret in a real --input body, pointing --input at the redacted copy", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({ body: `token ${GH_TOKEN_SAMPLE}` }),
    );
    const result = runGhGuardCli([
      "--active",
      "--allow-repo",
      "stSoftwareAU/VibeCoder",
      "--",
      "api",
      "repos/stSoftwareAU/VibeCoder/issues/1/comments",
      "--input",
      path,
    ]);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, GH_GUARD_ALLOW_MARKER);
    assertStringIncludes(result.stderr, "[GH_BODY_REDACTED]");
    const inputIdx = (result.ghArgs ?? []).indexOf("--input");
    const materialised = (result.ghArgs ?? [])[inputIdx + 1] ?? "";
    // A fresh path, not the agent's file.
    assertEquals(materialised === path, false);
    const sent = await Deno.readTextFile(materialised);
    assertStringIncludes(sent, REDACTION_PLACEHOLDER);
    assertEquals(sent.includes(GH_TOKEN_SAMPLE), false);
    // The agent's own file is left untouched.
    assertStringIncludes(await Deno.readTextFile(path), GH_TOKEN_SAMPLE);
    await Deno.remove(materialised);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("gh-guard-cli #92 - refuses a JSON body that passes the label scan but hides a secret outside its body field", async () => {
  // The label guard (#91) allows this — no reserved label — so redaction is
  // reached, and it fails closed on the secret it cannot place structurally.
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({ body: "clean", title: `t ${GH_TOKEN_SAMPLE}` }),
    );
    const result = runGhGuardCli([
      "--active",
      "--allow-repo",
      "stSoftwareAU/VibeCoder",
      "--",
      "api",
      "repos/stSoftwareAU/VibeCoder/issues",
      "--input",
      path,
    ]);
    assertEquals(result.exitCode, 1);
    assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
    assertStringIncludes(result.stderr, "[GH_BODY_UNREDACTABLE]");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("gh-guard-cli #92 - the label guard refuses a non-JSON --input body first (GH_BODY_UNREADABLE)", async () => {
  // A non-JSON body never reaches redaction: the #91 label scan cannot
  // understand its shape, so the guard refuses it at the earlier check.
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, `raw leak ${GH_TOKEN_SAMPLE}`);
    const result = runGhGuardCli([
      "--active",
      "--allow-repo",
      "stSoftwareAU/VibeCoder",
      "--",
      "api",
      "repos/stSoftwareAU/VibeCoder/issues/1/comments",
      "--input",
      path,
    ]);
    assertEquals(result.exitCode, 1);
    assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
    assertStringIncludes(result.stderr, "[GH_BODY_UNREADABLE]");
  } finally {
    await Deno.remove(path);
  }
});

// ---------------------------------------------------------------------------
// Issue #11 (SEC-b17ab4cc0e2a) / #94 — the two remaining argv shapes, pinned at
// the CLI seam the shim actually invokes.
//
// `-F 'labels[]=@file'` is the field-path twin of `--input`: `gh` expands the
// leading `@` by reading that file, so the label names never reach the argv and
// the classifier surfaces no `bodyFilePath` for the guard to scan — the
// fail-closed backstop is what must refuse it. A read is the counterpart: the
// guard refuses reserved-label *mutations*, not every command that mentions
// `--input`. The end-to-end forms of both live in `gh_guard_shim_test.ts`.
// ---------------------------------------------------------------------------

Deno.test("gh-guard-cli #11 - refuses a label set hidden behind -F 'labels[]=@file'", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    "stSoftwareAU/VibeCoder",
    "--",
    "api",
    "repos/stSoftwareAU/VibeCoder/issues/123/labels",
    "-F",
    "labels[]=@/tmp/labels-94.txt",
  ]);
  assertEquals(result.exitCode, 1);
  assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
  assertEquals(result.ghArgs, undefined);
  assertStringIncludes(result.stderr, "[SECURITY] [GH_BODY_UNREADABLE]");
});

Deno.test("gh-guard-cli #11 - allows an -X GET read that supplies --input", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, '{"per_page":100}');
    const argv = [
      "api",
      "repos/stSoftwareAU/VibeCoder/issues/123/labels",
      "-X",
      "GET",
      "--input",
      path,
    ];
    const result = runGhGuardCli([
      "--active",
      "--allow-repo",
      "stSoftwareAU/VibeCoder",
      "--",
      ...argv,
    ]);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, GH_GUARD_ALLOW_MARKER);
    assertEquals(result.ghArgs, argv);
    assertEquals(result.stderr, "");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("gh-guard-cli #11 - an -X GET --input - read is refused by the secret-redaction control, not the label guard", () => {
  // Boundary case: the reserved-label guard treats this as a read and allows
  // it; the refusal comes from the older stdin-body rule (Issue #3938), which
  // cannot scan a body it never sees. Pinned so the two controls stay
  // distinguishable — a read refused as a labelled write flips this marker.
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    "stSoftwareAU/VibeCoder",
    "--",
    "api",
    "repos/stSoftwareAU/VibeCoder/issues/123/labels",
    "-X",
    "GET",
    "--input",
    "-",
  ]);
  assertEquals(result.exitCode, 1);
  assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
  assertStringIncludes(result.stderr, "[SECURITY] [GH_BODY_UNREDACTABLE]");
  assertEquals(result.stderr.includes("WORKER_LABEL_REFUSED"), false);
});
