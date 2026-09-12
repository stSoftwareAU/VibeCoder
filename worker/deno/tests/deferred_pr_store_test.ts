/**
 * Parking a PR GitHub's secondary rate limit refused, and reading it back
 * (Issue #1951).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  clearDeferredPr,
  deferredPrDir,
  deferredPrPath,
  type DeferredPrRecord,
  formatPrPendingComment,
  isDeferredPrRecord,
  listDeferredPrs,
  PR_PENDING_MARKER,
  recordDeferredPr,
} from "../lib/deferred_pr_store.ts";

function record(overrides: Partial<DeferredPrRecord> = {}): DeferredPrRecord {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 1951,
    branch: "issue-1951-secondary-limit",
    base: "milestone/completed-work-is-not-a-failure",
    title: "bug: defer the PR instead of failing the run",
    body: "## Summary\n\nCloses #1951.\n",
    deferredAtEpoch: 1_700_000_000,
    attempts: 4,
    lastError: "secondary rate limit",
    ...overrides,
  };
}

/**
 * A fake PAT-shaped fixture, assembled at run time so the literal never
 * appears in the source (the secret scanner flags a PAT-shaped literal even
 * in a redaction test).
 */
const FAKE_PAT = "ghp_" + "abcdefghij".repeat(4);

Deno.test("deferred PR - a record round-trips through the store", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const stored = await recordDeferredPr(workDir, record());
    assert(stored.ok, stored.ok ? "" : stored.error.message);

    const listed = await listDeferredPrs(workDir);
    assertEquals(listed.length, 1);
    assertEquals(listed[0]?.branch, "issue-1951-secondary-limit");
    assertEquals(listed[0]?.attempts, 4);
    assertStringIncludes(listed[0]?.body ?? "", "Closes #1951");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred PR - a second deferral of one issue replaces the first", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await recordDeferredPr(workDir, record({ attempts: 1 }));
    await recordDeferredPr(workDir, record({ attempts: 2 }));
    const listed = await listDeferredPrs(workDir);
    assertEquals(listed.length, 1);
    assertEquals(listed[0]?.attempts, 2);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred PR - records come back oldest deferral first", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await recordDeferredPr(
      workDir,
      record({ issueNumber: 2, deferredAtEpoch: 200 }),
    );
    await recordDeferredPr(
      workDir,
      record({ issueNumber: 1, deferredAtEpoch: 100 }),
    );
    const listed = await listDeferredPrs(workDir);
    assertEquals(listed.map((r) => r.issueNumber), [1, 2]);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred PR - a repo slug cannot escape the store directory", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const bad = deferredPrPath(workDir, "../../etc/passwd", 1);
    assertEquals(bad.ok, false);

    const stored = await recordDeferredPr(
      workDir,
      record({ repo: "../../etc/passwd" }),
    );
    assertEquals(stored.ok, false);
    assertEquals(await listDeferredPrs(workDir), []);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred PR - an incomplete record is refused, not half-written", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const stored = await recordDeferredPr(
      workDir,
      record({ branch: "  " }),
    );
    assertEquals(stored.ok, false);
    assertEquals(await listDeferredPrs(workDir), []);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred PR - a malformed file is reported, not silently skipped", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(deferredPrDir(workDir), { recursive: true });
    await Deno.writeTextFile(
      `${deferredPrDir(workDir)}/broken.json`,
      "{ not json",
    );
    await recordDeferredPr(workDir, record());

    const problems: string[] = [];
    const listed = await listDeferredPrs(workDir, (p) => problems.push(p));
    assertEquals(listed.length, 1, "the good record still drains");
    assertEquals(problems.length, 1, problems.join(" | "));
    assertStringIncludes(problems[0] ?? "", "broken.json");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred PR - clearing is idempotent and removes the record", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await recordDeferredPr(workDir, record());
    const first = await clearDeferredPr(
      workDir,
      "stSoftwareAU/VibeCoder",
      1951,
    );
    assert(first.ok);
    const again = await clearDeferredPr(
      workDir,
      "stSoftwareAU/VibeCoder",
      1951,
    );
    assert(again.ok, "clearing a record that is already gone is not an error");
    assertEquals(await listDeferredPrs(workDir), []);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred PR - the pending note names the branch and carries the marker", () => {
  const body = formatPrPendingComment(record());
  assertStringIncludes(body, PR_PENDING_MARKER);
  assertStringIncludes(body, "PR pending");
  assertStringIncludes(body, "issue-1951-secondary-limit");
  assertStringIncludes(body, "milestone/completed-work-is-not-a-failure");
});

Deno.test("deferred PR - the record guard rejects junk", () => {
  assertEquals(isDeferredPrRecord(null), false);
  assertEquals(isDeferredPrRecord({}), false);
  assertEquals(isDeferredPrRecord({ ...record(), issueNumber: 0 }), false);
  assertEquals(isDeferredPrRecord({ ...record(), body: 42 }), false);
  assertEquals(isDeferredPrRecord(record()), true);
});

Deno.test("deferred PR - a token in the refusal never reaches the pending note (Issue #1951)", () => {
  const body = formatPrPendingComment(record({
    lastError: `HTTP 403 from https://${FAKE_PAT}@github.com/o/r`,
  }));
  assertEquals(
    body.includes(FAKE_PAT),
    false,
    body,
  );
  assertStringIncludes(body, "PR pending");
});
