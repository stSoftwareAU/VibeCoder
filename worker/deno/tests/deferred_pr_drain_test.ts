/**
 * The next cycle raises the PR a secondary rate limit refused, with no agent
 * run (Issue #1951).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type DeferredPrRecord,
  listDeferredPrs,
  recordDeferredPr,
} from "../lib/deferred_pr_store.ts";
import {
  drainDeferredPrs,
  MAX_DEFERRED_PR_AGE_SECONDS,
  MAX_DEFERRED_PR_ATTEMPTS,
} from "../lib/deferred_pr_drain.ts";
import type { Result } from "../types.ts";

const SECONDARY =
  "HTTP 403: You have exceeded a secondary rate limit and have been " +
  "temporarily blocked from content creation.";

function record(overrides: Partial<DeferredPrRecord> = {}): DeferredPrRecord {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 1951,
    branch: "issue-1951-secondary-limit",
    base: "main",
    title: "bug: defer the PR",
    body: "## Summary\n\nCloses #1951.\n",
    // Freshly parked unless a test says otherwise — the age bound is its own
    // test below.
    deferredAtEpoch: Math.floor(Date.now() / 1000),
    attempts: 4,
    lastError: SECONDARY,
    ...overrides,
  };
}

const noPr = (): Promise<Result<string>> =>
  Promise.resolve({ ok: false, error: new Error("no open PR") });

/**
 * A fake PAT-shaped fixture, assembled at run time so the literal never
 * appears in the source (the secret scanner flags a PAT-shaped literal even
 * in a redaction test).
 */
const FAKE_PAT = "ghp_" + "abcdefghij".repeat(4);

Deno.test("deferred drain - a parked PR is raised and the record dropped", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await recordDeferredPr(workDir, record());
    const created: DeferredPrRecord[] = [];
    const comments: string[] = [];

    const drained = await drainDeferredPrs({
      workDir,
      findOpenPr: noPr,
      createPr: (r) => {
        created.push(r);
        return Promise.resolve({
          ok: true,
          value: "https://github.com/stSoftwareAU/VibeCoder/pull/1970",
        });
      },
      comment: (_repo, _issue, body) => {
        comments.push(body);
        return Promise.resolve();
      },
    });

    assert(drained.ok);
    assertEquals(drained.value.raised, 1);
    assertEquals(created[0]?.branch, "issue-1951-secondary-limit");
    assertEquals(created[0]?.base, "main");
    assertEquals(await listDeferredPrs(workDir), []);
    assertStringIncludes(comments[0] ?? "", "pull/1970");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred drain - a PR already open drops the record without creating", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await recordDeferredPr(workDir, record());
    let creates = 0;
    const drained = await drainDeferredPrs({
      workDir,
      findOpenPr: () =>
        Promise.resolve({
          ok: true,
          value: "https://github.com/stSoftwareAU/VibeCoder/pull/1971",
        }),
      createPr: () => {
        creates++;
        return Promise.resolve({ ok: true, value: "never" });
      },
    });

    assert(drained.ok);
    assertEquals(drained.value.alreadyOpen, 1);
    assertEquals(creates, 0, "a PR that exists is never created twice");
    assertEquals(await listDeferredPrs(workDir), []);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred drain - a limit that is still on leaves the PR parked", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await recordDeferredPr(workDir, record({ attempts: 4 }));
    const drained = await drainDeferredPrs({
      workDir,
      findOpenPr: noPr,
      createPr: () =>
        Promise.resolve({ ok: false, error: new Error(SECONDARY) }),
    });

    assert(drained.ok);
    assertEquals(drained.value.pending, 1);
    const left = await listDeferredPrs(workDir);
    assertEquals(left.length, 1, "the work must not be forgotten");
    assertEquals(
      left[0]?.attempts,
      4,
      "the throttle holding does not count against the attempt cap",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred drain - another failure counts up and is retried next pass", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await recordDeferredPr(workDir, record({ attempts: 0 }));
    const drained = await drainDeferredPrs({
      workDir,
      findOpenPr: noPr,
      createPr: () =>
        Promise.resolve({
          ok: false,
          error: new Error("HTTP 502: bad gateway"),
        }),
    });

    assert(drained.ok);
    assertEquals(drained.value.pending, 1);
    const left = await listDeferredPrs(workDir);
    assertEquals(left[0]?.attempts, 1);
    assertStringIncludes(left[0]?.lastError ?? "", "502");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred drain - a hopeless PR is abandoned loudly at the attempt cap", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await recordDeferredPr(
      workDir,
      record({ attempts: MAX_DEFERRED_PR_ATTEMPTS - 1 }),
    );
    const errors: string[] = [];
    const comments: string[] = [];
    const drained = await drainDeferredPrs({
      workDir,
      findOpenPr: noPr,
      createPr: () =>
        Promise.resolve({
          ok: false,
          error: new Error("No commits between main and the branch"),
        }),
      comment: (_repo, _issue, body) => {
        comments.push(body);
        return Promise.resolve();
      },
      error: (m) => errors.push(m),
    });

    assert(drained.ok);
    assertEquals(drained.value.abandoned, 1);
    assertEquals(await listDeferredPrs(workDir), []);
    assert(
      errors.some((m) => m.includes("Abandoning a deferred PR")),
      `the give-up must be loud: ${errors.join(" | ")}`,
    );
    assertStringIncludes(comments[0] ?? "", "issue-1951-secondary-limit");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred drain - an empty work dir is a clean no-op", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const drained = await drainDeferredPrs({ workDir, findOpenPr: noPr });
    assert(drained.ok);
    assertEquals(drained.value, {
      raised: 0,
      alreadyOpen: 0,
      pending: 0,
      abandoned: 0,
    });
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred drain - a comment failure never loses the raised PR", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await recordDeferredPr(workDir, record());
    const warnings: string[] = [];
    const drained = await drainDeferredPrs({
      workDir,
      findOpenPr: noPr,
      createPr: () =>
        Promise.resolve({
          ok: true,
          value: "https://github.com/stSoftwareAU/VibeCoder/pull/1972",
        }),
      comment: () => Promise.reject(new Error("comment API down")),
      warn: (m) => warnings.push(m),
    });

    assert(drained.ok);
    assertEquals(drained.value.raised, 1);
    assert(warnings.some((m) => m.includes("Could not comment")));
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred drain - a PR parked too long is abandoned even while still throttled (Issue #1951)", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const now = 2_000_000_000;
    await recordDeferredPr(
      workDir,
      record({ deferredAtEpoch: now - MAX_DEFERRED_PR_AGE_SECONDS - 1 }),
    );
    const errors: string[] = [];
    const drained = await drainDeferredPrs({
      workDir,
      findOpenPr: noPr,
      createPr: () =>
        Promise.resolve({ ok: false, error: new Error(SECONDARY) }),
      nowSeconds: () => now,
      error: (m) => errors.push(m),
    });

    assert(drained.ok);
    assertEquals(
      drained.value.abandoned,
      1,
      "a throttle that never clears must not park a record for ever",
    );
    assertEquals(await listDeferredPrs(workDir), []);
    assert(
      errors.some((m) => m.includes("parked for more than")),
      errors.join(" | "),
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred drain - a lookup fault is reported, never read as 'no PR exists' (Issue #1951)", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await recordDeferredPr(workDir, record());
    const warnings: string[] = [];
    const drained = await drainDeferredPrs({
      workDir,
      findOpenPr: () =>
        Promise.resolve({
          ok: false,
          error: new Error("REST PR lookup failed: HTTP 500"),
        }),
      createPr: () =>
        Promise.resolve({
          ok: true,
          value: "https://github.com/stSoftwareAU/VibeCoder/pull/1973",
        }),
      warn: (m) => warnings.push(m),
    });

    assert(drained.ok);
    assertEquals(drained.value.raised, 1);
    assert(
      warnings.some((m) => m.includes("Deferred-PR lookup failed")),
      `the outage must be surfaced: ${warnings.join(" | ")}`,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("deferred drain - a token in the refusal never reaches the issue thread (Issue #1951)", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await recordDeferredPr(
      workDir,
      record({ attempts: MAX_DEFERRED_PR_ATTEMPTS - 1 }),
    );
    const comments: string[] = [];
    await drainDeferredPrs({
      workDir,
      findOpenPr: noPr,
      createPr: () =>
        Promise.resolve({
          ok: false,
          error: new Error(
            `failed: https://${FAKE_PAT}@github.com/o/r`,
          ),
        }),
      comment: (_repo, _issue, body) => {
        comments.push(body);
        return Promise.resolve();
      },
    });

    assertEquals(comments.length, 1);
    assertEquals(
      comments[0]?.includes(FAKE_PAT),
      false,
      `the token must be redacted: ${comments[0]}`,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
