/**
 * Tests for babysitter_attempt_audit.ts (Issue #4658).
 *
 * These drive `journalBabysitterAttempt` against a real temp journal, read the
 * entry back through the production `auditFilePath`/`loadEntries` helpers, and
 * feed it through the collector's own `prActionsFromAuditJournal` and
 * `recoveryBlockersFor`. They assert on what the collector measures, not on
 * how the hook is wired.
 *
 * Every gating and identity value is injected through a fixed map (Issue #963),
 * so a test never sets a variable on the process (Issue #880).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type BabysitterAttempt,
  journalBabysitterAttempt,
} from "../lib/babysitter_attempt_audit.ts";
import type { AuditHookOptions } from "../lib/audit_hook.ts";
import {
  _resetAuditCaches,
  auditFilePath,
  loadEntries,
} from "../lib/audit_journal.ts";
import type { AuditEntry } from "../lib/audit_entry.ts";
import {
  prActionsFromAuditJournal,
  type PrCompletionRecord,
  type TrustedPrAction,
} from "../lib/pr_completion_report.ts";
import { recoveryBlockersFor } from "../lib/pr_completion_snapshot.ts";
import { envFrom } from "./support/env_lookup.ts";

const REPO = "owner/repo";
const PR = 7;
const HEAD = "c".repeat(40);
const WORKER_ID = "test-attempt-worker";
const RUN_ID = "run-attempt-1";
const REFUSED = "[SECURITY] [AUDIT_JOURNAL_REFUSED] babysitter-attempt: ";

/**
 * Run `fn` with a fresh temp audit directory.
 *
 * The enabled case names the directory through `VIBE_AUDIT_DIR`. The two
 * negative cases still hand over the directory as `baseDir`, so a gate that
 * wrongly lets a write through would land a file there and fail the test,
 * rather than writing silently to the per-account shared temp root.
 */
async function withJournal(
  fn: (dir: string, opts: AuditHookOptions) => Promise<void>,
  spec: { disabled?: boolean; noAuditDir?: boolean } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const env = envFrom({
    ...(spec.noAuditDir ? {} : { VIBE_AUDIT_DIR: dir }),
    ...(spec.disabled ? { VIBE_AUDIT_DISABLED: "1" } : {}),
    WORKER_UNIQUE_ID: WORKER_ID,
    VIBE_RUN_ID: RUN_ID,
  });
  _resetAuditCaches();
  const negative = spec.disabled || spec.noAuditDir;
  try {
    await fn(dir, negative ? { env, baseDir: dir } : { env });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Read the journal back through the production path. */
async function readJournal(opts: AuditHookOptions): Promise<AuditEntry[]> {
  const loaded = await loadEntries(auditFilePath({ env: opts.env }));
  assert(loaded.ok, "journal should exist after an attempt");
  if (!loaded.ok) return [];
  return loaded.value;
}

/** Names of everything directly inside `dir`. */
async function fileNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

/** Capture `console.error` lines for the duration of `fn`. */
async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return logged;
}

function minutesAfter(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function prRecord(extra: Partial<PrCompletionRecord> = {}): PrCompletionRecord {
  return {
    repo: REPO,
    number: PR,
    createdAt: "2026-11-01T00:00:00Z",
    baseRef: "main",
    defaultBranch: "main",
    headRef: "feature",
    headSha: HEAD,
    state: "merged",
    mergedAt: "2026-11-06T23:59:59Z",
    actionsComplete: true,
    ...extra,
  };
}

function confirmedRepair(timestamp: string): TrustedPrAction {
  return {
    actionId: "confirmed-repair",
    runId: RUN_ID,
    component: "babysitter",
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    kind: "repair",
    timestamp,
    outcome: "confirmed",
    actor: "fleet",
    verified: true,
  };
}

const ATTEMPT: BabysitterAttempt = { repo: REPO, prNumber: PR, headSha: HEAD };

Deno.test("babysitter attempt - journals a failed, verified babysitter repair at its head", async () => {
  await withJournal(async (_dir, opts) => {
    await journalBabysitterAttempt(ATTEMPT, opts);
    const entries = await readJournal(opts);
    assertEquals(entries.length, 1);
    const entry = entries[0]!;
    assertEquals(entry.verb, "babysitter-attempt");
    assertEquals(entry.component, "babysitter");
    assertEquals(entry.actionKind, "repair");
    assertEquals(entry.outcome, "error");
    assertEquals(entry.repo, REPO);
    assertEquals(entry.prNumber, PR);
    assertEquals(entry.headSha, HEAD);
    assertEquals(entry.target, String(PR));
    assertEquals(entry.runId, RUN_ID);
    assertEquals(entry.caller, "worker/deno/commands/fleet_pr_babysitter.ts");

    const [action] = prActionsFromAuditJournal(entries, true);
    assertEquals(action?.kind, "repair");
    assertEquals(action?.outcome, "failed");
    assertEquals(action?.verified, true);
    assertEquals(action?.actor, "fleet");
  });
});

Deno.test("babysitter attempt - the collector measures the wait until the next confirmed repair", async () => {
  await withJournal(async (_dir, opts) => {
    await journalBabysitterAttempt(ATTEMPT, opts);
    const [entry] = await readJournal(opts);
    const started = entry!.timestamp;
    const confirmedAt = minutesAfter(started, 90);
    const mergedAt = minutesAfter(started, 180);
    const record = prRecord({ mergedAt });
    const failed = prActionsFromAuditJournal([entry!], true);

    assertEquals(
      recoveryBlockersFor(record, [...failed, confirmedRepair(confirmedAt)]),
      [{
        repo: REPO,
        prNumber: PR,
        blocker: "repair-recovery",
        startedAt: started,
        endedAt: confirmedAt,
      }],
    );
  });
});

Deno.test("babysitter attempt - with no later repair the wait ends at the PR end cap", async () => {
  await withJournal(async (_dir, opts) => {
    await journalBabysitterAttempt(ATTEMPT, opts);
    const [entry] = await readJournal(opts);
    const started = entry!.timestamp;
    const mergedAt = minutesAfter(started, 180);
    const failed = prActionsFromAuditJournal([entry!], true);

    assertEquals(
      recoveryBlockersFor(prRecord({ mergedAt }), failed),
      [{
        repo: REPO,
        prNumber: PR,
        blocker: "repair-recovery",
        startedAt: started,
        endedAt: mergedAt,
      }],
    );
  });
});

Deno.test("babysitter attempt - an unverified journal chain stays unverified and measures nothing", async () => {
  await withJournal(async (_dir, opts) => {
    await journalBabysitterAttempt(ATTEMPT, opts);
    const entries = await readJournal(opts);
    const [action] = prActionsFromAuditJournal(entries, false);
    assertEquals(action?.verified, false);
    assertEquals(action?.actor, "unknown");
    assertEquals(
      recoveryBlockersFor(
        prRecord(),
        prActionsFromAuditJournal(entries, false),
      ),
      [],
    );
  });
});

Deno.test("babysitter attempt - a disabled journal writes nothing", async () => {
  await withJournal(async (dir, opts) => {
    await journalBabysitterAttempt(ATTEMPT, opts);
    assertEquals(await fileNames(dir), []);
  }, { disabled: true });
});

Deno.test("babysitter attempt - with no audit directory configured it writes nothing", async () => {
  await withJournal(async (dir, opts) => {
    await journalBabysitterAttempt(ATTEMPT, opts);
    assertEquals(await fileNames(dir), []);
  }, { noAuditDir: true });
});

Deno.test("babysitter attempt - invalid repo, PR number or head is refused and writes nothing", async () => {
  const refused: BabysitterAttempt[] = [
    { repo: "owner", prNumber: PR, headSha: HEAD },
    { repo: "owner/repo/extra", prNumber: PR, headSha: HEAD },
    { repo: "owner/re po", prNumber: PR, headSha: HEAD },
    { repo: REPO, prNumber: 0, headSha: HEAD },
    { repo: REPO, prNumber: -3, headSha: HEAD },
    { repo: REPO, prNumber: 1.5, headSha: HEAD },
    { repo: REPO, prNumber: Number.NaN, headSha: HEAD },
    { repo: REPO, prNumber: PR, headSha: "d".repeat(39) },
    { repo: REPO, prNumber: PR, headSha: "g".repeat(40) },
    { repo: REPO, prNumber: PR, headSha: "" },
  ];
  await withJournal(async (dir, opts) => {
    const logged = await captureErrors(async () => {
      for (const attempt of refused) {
        await journalBabysitterAttempt(attempt, opts);
      }
    });
    assertEquals(logged.length, refused.length);
    assert(logged.every((line) => line.startsWith(REFUSED)));
    assertEquals(await fileNames(dir), []);
  });
});

Deno.test("babysitter attempt - a valid attempt after a refused one still journals once", async () => {
  await withJournal(async (_dir, opts) => {
    await captureErrors(() =>
      journalBabysitterAttempt({ ...ATTEMPT, prNumber: 0 }, opts)
    );
    await journalBabysitterAttempt(ATTEMPT, opts);
    const entries = await readJournal(opts);
    assertEquals(entries.map((entry) => entry.prNumber), [PR]);
  });
});

Deno.test("babysitter attempt - a non-string repo or head that stringifies to a valid one is refused", async () => {
  // `RegExp.test` coerces its argument, so a one-element array of a valid
  // value would pass the pattern alone; only the `typeof` guard refuses it.
  const refused = [
    { repo: [REPO], prNumber: PR, headSha: HEAD },
    { repo: REPO, prNumber: PR, headSha: [HEAD] },
  ] as unknown as BabysitterAttempt[];
  await withJournal(async (dir, opts) => {
    const logged = await captureErrors(async () => {
      for (const attempt of refused) {
        await journalBabysitterAttempt(attempt, opts);
      }
    });
    assertEquals(logged.length, refused.length);
    assert(logged.every((line) => line.startsWith(REFUSED)));
    assertEquals(await fileNames(dir), []);
  });
});

Deno.test("babysitter attempt - a successful append logs nothing", async () => {
  await withJournal(async (_dir, opts) => {
    const logged = await captureErrors(() =>
      journalBabysitterAttempt(ATTEMPT, opts)
    );
    assertEquals(logged, []);
  });
});

Deno.test("babysitter attempt - a refused append is logged loud and never throws", async () => {
  await withJournal(async (dir, opts) => {
    // A journal directory beneath a regular file can never be created.
    const blocker = `${dir}/not-a-directory`;
    await Deno.writeTextFile(blocker, "x");
    const logged = await captureErrors(() =>
      journalBabysitterAttempt(ATTEMPT, { ...opts, baseDir: `${blocker}/sub` })
    );
    assertEquals(logged.length, 1);
    assert(logged[0]!.startsWith(REFUSED));
    assertEquals(await fileNames(dir), ["not-a-directory"]);
  });
});

Deno.test("babysitter attempt - an unexpected error is logged with its message, and a non-Error thrown value as text", async () => {
  await withJournal(async (_dir, opts) => {
    const throwing = (thrown: unknown): AuditHookOptions => ({
      ...opts,
      get runId(): string {
        throw thrown;
      },
    });
    const logged = await captureErrors(async () => {
      await journalBabysitterAttempt(ATTEMPT, throwing(new Error("boom")));
      await journalBabysitterAttempt(ATTEMPT, throwing("plain text"));
    });
    assertEquals(logged, [`${REFUSED}boom`, `${REFUSED}plain text`]);
  });
});
