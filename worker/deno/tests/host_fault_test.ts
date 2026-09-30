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
  parseHostFaultMarker,
} from "../lib/host_fault.ts";
import {
  markIssueAsFailed,
  markIssueAsFailedOnce,
} from "../lib/label_failure.ts";

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

Deno.test("label_failure - markIssueAsFailed marks a host fault in the comment", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "failed\n",
    });

    const result = await markIssueAsFailed({
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

Deno.test("label_failure - markIssueAsFailed keeps the marker last after a workerFooter", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "failed\n",
    });

    await markIssueAsFailed({
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
