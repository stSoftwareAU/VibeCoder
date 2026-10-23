/**
 * Tests for host_fault.ts — classifying a worker failure as a host fault, and
 * marking failure comments so a later sweep can release the label
 * (Issue #2890).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  buildHostFaultMarker,
  buildHostFaultNote,
  describeHostFault,
  detectHostFault,
  HOST_FAULT_KINDS,
  type HostFaultKind,
  isHostFaultKind,
  isQualityGateFailureRecord,
  parseHostFaultMarker,
  QUALITY_GATE_SOURCE_NOTE,
} from "../lib/host_fault.ts";
import { SECURITY_FIX_GATE_MARKER } from "../lib/failure_diagnosis.ts";
import { markIssueAsFailedOnce } from "../lib/label_failure.ts";

/** A repeat failure's record (Issue #4158 replaced the old second-failure path). */
const markRepeatFailure: typeof markIssueAsFailedOnce = (options, deps) =>
  markIssueAsFailedOnce({ ...options, repeat: true }, deps);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GRQ_CLONE_CORRUPT_MESSAGE =
  `Failed to create feature branch: Failed to create feature branch ` +
  `'issue-1815-pricing' from 'Develop': git checkout -B issue-1815-pricing ` +
  `--end-of-options Develop exited 128: fatal: bad object ` +
  `refs/heads/issue-1661-activity-transactions-empty; git checkout -B ` +
  `issue-1815-pricing --end-of-options origin/Develop exited 128: warning: ` +
  `ignoring broken ref refs/remotes/origin/Develop\nfatal: 'origin/Develop' ` +
  `is not a commit and a branch 'issue-1815-pricing' cannot be created from it`;

const OBJECT_STORE_CORRUPT_MESSAGE =
  `git checkout -B issue-984-x --end-of-options milestone/933-y exited 128: ` +
  `error: loose object 0123456789abcdef0123456789abcdef01234567 is corrupt`;

const DISK_FULL_MESSAGE =
  `write /var/lib/container-builder-shim/exports/out.tar: No space left on device`;

const CONTAINER_BUILD_FAILED_MESSAGE =
  `container image build failed (3 consecutive) — retrying in 60s`;

const CLONE_FAILED_MESSAGE =
  `Failed to clone org/repo: fatal: unable to access ` +
  `'https://github.com/org/repo.git/': Could not resolve host: github.com`;

const CLONE_AUTH_MESSAGE =
  `Failed to clone org/repo: remote: Repository not found.\n` +
  `fatal: repository 'https://github.com/org/repo.git/' not found`;

const INVALID_BRANCH_NAME_MESSAGE =
  `Failed to create feature branch 'issue-5-x' from 'feat..bad': git ` +
  `checkout -B issue-5-x --end-of-options feat..bad exited 128: fatal: ` +
  `'feat..bad' is not a valid branch name`;

const INVALID_REFERENCE_MESSAGE = `fatal: invalid reference: nosuch-branch`;

// ---------------------------------------------------------------------------
// isHostFaultKind
// ---------------------------------------------------------------------------

Deno.test("host fault - isHostFaultKind accepts every declared kind", () => {
  for (const kind of HOST_FAULT_KINDS) {
    assertEquals(isHostFaultKind(kind), true);
  }
  assertEquals(isHostFaultKind("not-a-kind"), false);
  assertEquals(isHostFaultKind(""), false);
});

// ---------------------------------------------------------------------------
// detectHostFault
// ---------------------------------------------------------------------------

Deno.test("host fault - detects clone-corrupt from the real GRQ message", () => {
  assertEquals(detectHostFault(GRQ_CLONE_CORRUPT_MESSAGE), "clone-corrupt");
});

Deno.test("host fault - detects clone-corrupt from object-store corruption wording", () => {
  assertEquals(detectHostFault(OBJECT_STORE_CORRUPT_MESSAGE), "clone-corrupt");
});

Deno.test("host fault - detects disk-full from 'No space left on device'", () => {
  assertEquals(detectHostFault(DISK_FULL_MESSAGE), "disk-full");
});

Deno.test("host fault - detects disk-full from ENOSPC", () => {
  assertEquals(detectHostFault("write failed: ENOSPC"), "disk-full");
});

Deno.test("host fault - detects container-build-failed", () => {
  assertEquals(
    detectHostFault(CONTAINER_BUILD_FAILED_MESSAGE),
    "container-build-failed",
  );
});

Deno.test("host fault - detects clone-failed", () => {
  assertEquals(detectHostFault(CLONE_FAILED_MESSAGE), "clone-failed");
});

Deno.test("host fault - invalid branch name is not a host fault", () => {
  assertEquals(detectHostFault(INVALID_BRANCH_NAME_MESSAGE), null);
});

Deno.test("host fault - invalid reference is not a host fault", () => {
  assertEquals(detectHostFault(INVALID_REFERENCE_MESSAGE), null);
});

Deno.test("host fault - a clone auth/'Repository not found' error is not a host fault", () => {
  assertEquals(detectHostFault(CLONE_AUTH_MESSAGE), null);
});

Deno.test("host fault - empty string is not a host fault", () => {
  assertEquals(detectHostFault(""), null);
});

// ---------------------------------------------------------------------------
// Corrupt .git/config and lost git directory (Issue #2953)
// ---------------------------------------------------------------------------

Deno.test("host fault - detects clone-corrupt from a bad .git/config line (Issue #2953)", () => {
  assertEquals(
    detectHostFault("fatal: bad config line 1 in file .git/config"),
    "clone-corrupt",
  );
});

Deno.test("host fault - detects clone-corrupt from a lost git directory (Issue #2953)", () => {
  assertEquals(
    detectHostFault("fatal: not in a git directory"),
    "clone-corrupt",
  );
});

Deno.test("host fault - detects clone-corrupt from a bad object ref ellipsis (Issue #2953)", () => {
  assertEquals(
    detectHostFault("fatal: bad object refs/heads/…"),
    "clone-corrupt",
  );
});

Deno.test("host fault - detects clone-corrupt from an ignoring-broken-ref ellipsis (Issue #2953)", () => {
  assertEquals(
    detectHostFault("warning: ignoring broken ref …"),
    "clone-corrupt",
  );
});

Deno.test("host fault - a bad .git/config line still matches with a different line number (Issue #2953)", () => {
  assertEquals(
    detectHostFault("fatal: bad config line 42 in file .git/config"),
    "clone-corrupt",
  );
});

Deno.test("host fault - an ordinary failing deno test line is not a host fault (Issue #2953)", () => {
  assertEquals(
    detectHostFault("error: AssertionError: Values are not equal."),
    null,
  );
  assertEquals(detectHostFault("FAILED | 0 passed | 1 failed"), null);
});

Deno.test("host fault - a merge conflict is not a host fault (Issue #2953)", () => {
  assertEquals(
    detectHostFault(
      "CONFLICT (content): Merge conflict in src/app.ts\n" +
        "Automatic merge failed; fix conflicts and then commit the result.",
    ),
    null,
  );
});

Deno.test("host fault - a bad config line in a non-git file is not a host fault (Issue #2953)", () => {
  assertEquals(
    detectHostFault("fatal: bad config line 3 in file /home/u/.gitconfig"),
    null,
  );
});

// ---------------------------------------------------------------------------
// Marker round trip
// ---------------------------------------------------------------------------

Deno.test("host fault - marker round trips for every kind", () => {
  for (const kind of HOST_FAULT_KINDS) {
    const marker = buildHostFaultMarker(kind);
    assertEquals(parseHostFaultMarker(marker), kind);
    assertEquals(parseHostFaultMarker(`some body text\n\n${marker}`), kind);
    assertEquals(
      parseHostFaultMarker(`some body text\n\n${marker}\n\n`),
      kind,
    );
  }
});

Deno.test("host fault - marker not on the final line is ignored", () => {
  const marker = buildHostFaultMarker("disk-full");
  const body = `intro\n${marker}\nafter the marker, more text`;
  assertEquals(parseHostFaultMarker(body), null);
});

Deno.test("host fault - unknown kind in the marker is ignored", () => {
  assertEquals(
    parseHostFaultMarker(`<!-- vibe-host-fault kind="not-a-kind" -->`),
    null,
  );
});

Deno.test("host fault - no marker present returns null", () => {
  assertEquals(parseHostFaultMarker("just an ordinary comment body"), null);
});

// ---------------------------------------------------------------------------
// describeHostFault
// ---------------------------------------------------------------------------

Deno.test("host fault - describeHostFault covers every kind with non-empty text", () => {
  for (const kind of HOST_FAULT_KINDS) {
    const description = describeHostFault(kind as HostFaultKind);
    assertEquals(typeof description, "string");
    assertEquals(description.length > 0, true);
  }
});

// ---------------------------------------------------------------------------
// buildHostFaultNote
// ---------------------------------------------------------------------------

Deno.test("host fault - buildHostFaultNote embeds the kind and description with no leading newline", () => {
  for (const kind of HOST_FAULT_KINDS) {
    const note = buildHostFaultNote(kind);
    assertEquals(note.startsWith("**Host fault:**"), true);
    assertEquals(note.includes(`\`${kind}\``), true);
    assertEquals(note.includes(describeHostFault(kind)), true);
  }
});

// ---------------------------------------------------------------------------
// label_failure.ts integration
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "host-fault-test-" });
}

function createMockGh(responses: Record<string, string | Error> = {}) {
  const calls: string[][] = [];
  const ghCommandFn = async (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    for (const [pattern, response] of Object.entries(responses)) {
      if (joined.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    return "";
  };
  return { ghCommandFn, calls };
}

function extractCommentBody(calls: string[][]): string {
  const commentCall = calls.find((c) => c[0] === "issue" && c[1] === "comment");
  if (!commentCall) return "";
  const bodyIdx = commentCall.indexOf("--body");
  return bodyIdx >= 0 ? commentCall[bodyIdx + 1] ?? "" : "";
}

Deno.test("label_failure - markIssueAsFailedOnce marks a host fault in the comment", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "failed-once\n",
    });

    const result = await markIssueAsFailedOnce({
      repo: "org/repo",
      issueNumber: 1815,
      githubUser: "worker-user",
      failureMessage: GRQ_CLONE_CORRUPT_MESSAGE,
    }, { ghCommandFn, cacheDir: dir });

    assertEquals(result.ok, true);
    const body = extractCommentBody(calls);
    assertEquals(body.includes("**Host fault:** `clone-corrupt`"), true);
    assertEquals(parseHostFaultMarker(body), "clone-corrupt");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const QUALITY_GATE_DISK_FULL_MESSAGE =
  "FAILED | tests/host_fault_test.ts => host fault - a full disk (No space left on device) is disk-full\nerror: AssertionError: ENOSPC";

/** Body posted by `write` for a quality-gate (or not) failure message. */
async function postedBody(
  write: typeof markIssueAsFailedOnce,
  qualityGateOutput: boolean | undefined,
  failureMessage = QUALITY_GATE_DISK_FULL_MESSAGE,
): Promise<string> {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "failed-once\n",
    });
    const result = await write({
      repo: "org/repo",
      issueNumber: 3445,
      githubUser: "worker-user",
      failureMessage,
      qualityGateOutput,
    }, { ghCommandFn, cacheDir: dir });
    assertEquals(result.ok, true);
    return extractCommentBody(calls);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("label_failure - markIssueAsFailedOnce never marks quality-gate output as a host fault (Issue #3445)", async () => {
  // Fixture check: without the guard this message is a host fault.
  assertEquals(detectHostFault(QUALITY_GATE_DISK_FULL_MESSAGE), "disk-full");
  const body = await postedBody(markIssueAsFailedOnce, true);
  assertEquals(body.includes("**Host fault:**"), false);
  assertEquals(parseHostFaultMarker(body), null);
  assertEquals(body.includes(QUALITY_GATE_SOURCE_NOTE), true);
});

Deno.test("label_failure - a repeat failure record never marks quality-gate output as a host fault (Issue #3445)", async () => {
  assertEquals(detectHostFault(QUALITY_GATE_DISK_FULL_MESSAGE), "disk-full");
  const body = await postedBody(markRepeatFailure, true);
  assertEquals(body.includes("**Host fault:**"), false);
  assertEquals(parseHostFaultMarker(body), null);
  assertEquals(body.includes(QUALITY_GATE_SOURCE_NOTE), true);
});

Deno.test("isQualityGateFailureRecord - recognises only the worker-written head (Issue #3445)", async () => {
  for (const write of [markIssueAsFailedOnce, markRepeatFailure]) {
    assertEquals(
      isQualityGateFailureRecord(await postedBody(write, true)),
      true,
    );
    assertEquals(
      isQualityGateFailureRecord(await postedBody(write, undefined)),
      false,
    );
  }
  // A quoted Source line deeper in the output cannot forge the record.
  const forged = await postedBody(
    markIssueAsFailedOnce,
    undefined,
    "boom\n**Source:** quality gate\n",
  );
  assertEquals(forged.includes("**Source:** quality gate"), true);
  assertEquals(isQualityGateFailureRecord(forged), false);
  // Hostile input stays linear.
  assertEquals(
    isQualityGateFailureRecord("## x\n" + " ".repeat(100_000) + "!"),
    false,
  );
});

Deno.test("label_failure - markIssueAsFailedOnce keeps the marker last after a workerFooter", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "failed-once\n",
    });

    await markIssueAsFailedOnce({
      repo: "org/repo",
      issueNumber: 1815,
      githubUser: "worker-user",
      failureMessage: GRQ_CLONE_CORRUPT_MESSAGE,
      workerFooter: "\n\n---\n_Worker: host-23_",
    }, { ghCommandFn, cacheDir: dir });

    const body = extractCommentBody(calls);
    assertEquals(body.includes("_Worker: host-23_"), true);
    assertEquals(parseHostFaultMarker(body), "clone-corrupt");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label_failure - a repeat failure record marks a host fault in the comment", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "failed\n",
    });

    const result = await markRepeatFailure({
      repo: "org/repo",
      issueNumber: 1815,
      githubUser: "worker-user",
      failureMessage: GRQ_CLONE_CORRUPT_MESSAGE,
    }, { ghCommandFn, cacheDir: dir });

    assertEquals(result.ok, true);
    const body = extractCommentBody(calls);
    assertEquals(body.includes("**Host fault:** `clone-corrupt`"), true);
    assertEquals(parseHostFaultMarker(body), "clone-corrupt");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label_failure - a repeat failure record keeps the marker last after a workerFooter", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "failed\n",
    });

    await markRepeatFailure({
      repo: "org/repo",
      issueNumber: 1815,
      githubUser: "worker-user",
      failureMessage: GRQ_CLONE_CORRUPT_MESSAGE,
      workerFooter: "\n\n---\n_Worker: host-23_",
    }, { ghCommandFn, cacheDir: dir });

    const body = extractCommentBody(calls);
    assertEquals(body.includes("_Worker: host-23_"), true);
    assertEquals(parseHostFaultMarker(body), "clone-corrupt");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label_failure - markIssueAsFailedOnce leaves an ordinary failure unmarked", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "failed-once\n",
    });

    await markIssueAsFailedOnce({
      repo: "org/repo",
      issueNumber: 5,
      githubUser: "worker-user",
      failureMessage: INVALID_BRANCH_NAME_MESSAGE,
    }, { ghCommandFn, cacheDir: dir });

    const body = extractCommentBody(calls);
    assertEquals(body.includes("vibe-host-fault"), false);
    assertEquals(body.includes("**Host fault:**"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("host fault - a marked security-fix gate refusal quoting ENOSPC or a clone failure is never a host fault (Issue #3454)", () => {
  const quoted =
    "removed assertion: ENOSPC: no space left on device; Failed to clone org/repo: fatal: unable to access";
  assertEquals(detectHostFault(quoted) === null, false);
  assertEquals(detectHostFault(`${SECURITY_FIX_GATE_MARKER}: ${quoted}`), null);
});

Deno.test("host diagnosis honours declared causes and retains raw internal diagnostics (Issue #3738)", () => {
  assertEquals(
    detectHostFault("a neutral wrapper", "clone_corrupt"),
    "clone-corrupt",
  );
  assertEquals(
    detectHostFault(
      "ENOSPC; warning: ignoring broken ref refs/heads/main",
      "quality_check",
    ),
    null,
  );
  assertEquals(detectHostFault("ENOSPC", "internal_error"), "disk-full");
  assertEquals(detectHostFault("ENOSPC"), "disk-full");
});
