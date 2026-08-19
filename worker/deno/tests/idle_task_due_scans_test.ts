/**
 * Tests for the cached overdue-pair lookup (Issue #4009).
 *
 * Drives `loadDueScans` against a stubbed `gh` runner so the freshness read,
 * the cadence computation and the cost-control cache are exercised together
 * without touching the network. The suite pins:
 *
 *   - the join itself — a stale (repo, template) pair surfaces as due;
 *   - the `>= 7 days` inclusive boundary end-to-end, so the two 168 h-cooldown
 *     templates can still satisfy their own weekly floor;
 *   - the cost contract — one `gh issue list` per repo per TTL window, and no
 *     per-wrapper `gh issue view` at all;
 *   - fail-open on an unreadable repo history.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import {
  DUE_SCAN_CACHE_TTL_MS,
  loadDueScans,
  resetDueScanCache,
} from "../lib/idle_task_due_scans.ts";
import { buildAttributionFooter } from "../lib/idle_task_attribution.ts";

const REPO = "org/alpha";
const NOW = new Date("2026-06-15T00:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** ISO timestamp `days` before {@link NOW}. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

interface Wrapper {
  number: number;
  template: string;
  model?: string;
  closedAt: string;
}

/**
 * gh stub serving one closed-wrapper history per repo. Records every call so
 * the tests can assert the exact `gh` cost.
 */
function makeGh(history: Record<string, Wrapper[]>, opts: {
  failRepos?: readonly string[];
} = {}) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const repoIndex = args.indexOf("--repo");
    const repo = repoIndex >= 0 ? args[repoIndex + 1] ?? "" : "";
    if (opts.failRepos?.includes(repo)) {
      return Promise.reject(new Error(`gh exploded for ${repo}`));
    }
    if (args[0] === "issue" && args[1] === "list") {
      const rows = (history[repo] ?? []).map((w) => ({
        number: w.number,
        title: `wrapper ${w.number}`,
        body: buildAttributionFooter({
          template: w.template,
          runId: "vibe-test",
          ...(w.model !== undefined ? { model: w.model } : {}),
        }),
        closedAt: w.closedAt,
      }));
      return Promise.resolve(JSON.stringify(rows));
    }
    return Promise.resolve("[]");
  };
  return { fn, calls };
}

function listCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === "issue" && c[1] === "list");
}

function viewCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === "issue" && c[1] === "view");
}

Deno.test("loadDueScans - a stale sonnet scan surfaces as an overdue pair", async () => {
  resetDueScanCache();
  const gh = makeGh({
    [REPO]: [
      {
        number: 1,
        template: "security-scan",
        model: "sonnet",
        closedAt: daysAgo(9),
      },
      {
        number: 2,
        template: "supply-chain-readiness",
        model: "fable",
        closedAt: daysAgo(1),
      },
      {
        number: 3,
        template: "github-actions-audit",
        model: "fable",
        closedAt: daysAgo(2),
      },
    ],
  });

  const due = await loadDueScans({
    repos: [REPO],
    now: NOW,
    ghCommandFn: gh.fn,
    warn: () => {},
  });

  assertEquals(due.length, 1);
  assertEquals(due[0]?.repo, REPO);
  assertEquals(due[0]?.template, "security-scan");
  assertEquals(
    due[0]?.tier,
    "fable",
    "no fable scan on record → the month is owed",
  );
});

Deno.test(
  "loadDueScans - a 168h-cooldown template is due at exactly 7.0 days (inclusive boundary)",
  async () => {
    resetDueScanCache();
    // A fresh fable scan discharges the month, so only the weekly window is in
    // play — the exact case the 7-day cooldown on `supply-chain-readiness` and
    // `github-actions-audit` must not be able to block.
    const gh = makeGh({
      [REPO]: [
        {
          number: 1,
          template: "supply-chain-readiness",
          model: "fable",
          closedAt: daysAgo(7),
        },
      ],
    });

    const due = await loadDueScans({
      repos: [REPO],
      now: NOW,
      ghCommandFn: gh.fn,
      warn: () => {},
    });

    const supplyChain = due.find((d) =>
      d.template === "supply-chain-readiness"
    );
    assert(
      supplyChain !== undefined,
      "a scan exactly 7.0 days old must read as due, else the 168h cooldown starves the weekly floor",
    );
    assertEquals(supplyChain?.tier, "sonnet");
    assertEquals(supplyChain?.overdueDays, 0);
  },
);

Deno.test("loadDueScans - repeated ticks inside the TTL cost one gh list per repo", async () => {
  resetDueScanCache();
  const repos = ["org/alpha", "org/beta", "org/gamma"];
  const gh = makeGh({
    "org/alpha": [
      {
        number: 1,
        template: "security-scan",
        model: "sonnet",
        closedAt: daysAgo(9),
      },
    ],
  });

  for (let tick = 0; tick < 5; tick++) {
    // The clock advances a minute per tick — well inside the 6 h TTL.
    const now = new Date(NOW.getTime() + tick * 60_000);
    const due = await loadDueScans({
      repos,
      now,
      ghCommandFn: gh.fn,
      warn: () => {},
    });
    assertEquals(due.length > 0, true, "the due list is served on every tick");
  }

  assertEquals(
    listCalls(gh.calls).length,
    repos.length,
    "five ticks must cost one history read per repo, not five",
  );
  assertEquals(
    viewCalls(gh.calls).length,
    0,
    "cadence needs dates only — no per-wrapper closing-comment read",
  );
});

Deno.test("loadDueScans - the history is re-read once the TTL expires", async () => {
  resetDueScanCache();
  const gh = makeGh({
    [REPO]: [
      {
        number: 1,
        template: "security-scan",
        model: "sonnet",
        closedAt: daysAgo(9),
      },
    ],
  });

  await loadDueScans({
    repos: [REPO],
    now: NOW,
    ghCommandFn: gh.fn,
    warn: () => {},
  });
  await loadDueScans({
    repos: [REPO],
    now: new Date(NOW.getTime() + DUE_SCAN_CACHE_TTL_MS),
    ghCommandFn: gh.fn,
    warn: () => {},
  });

  assertEquals(listCalls(gh.calls).length, 2);
});

Deno.test("loadDueScans - a changed repo set bypasses the cached reading", async () => {
  resetDueScanCache();
  const gh = makeGh({
    "org/alpha": [
      {
        number: 1,
        template: "security-scan",
        model: "sonnet",
        closedAt: daysAgo(9),
      },
    ],
  });

  await loadDueScans({
    repos: ["org/alpha"],
    now: NOW,
    ghCommandFn: gh.fn,
    warn: () => {},
  });
  await loadDueScans({
    repos: ["org/alpha", "org/beta"],
    now: NOW,
    ghCommandFn: gh.fn,
    warn: () => {},
  });

  assertEquals(
    listCalls(gh.calls).length,
    3,
    "one call for the first set, two for the second",
  );
});

Deno.test("loadDueScans - an unreadable repo history is fail-open and warns", async () => {
  resetDueScanCache();
  const gh = makeGh({
    "org/beta": [
      {
        number: 1,
        template: "security-scan",
        model: "sonnet",
        closedAt: daysAgo(9),
      },
    ],
  }, { failRepos: ["org/alpha"] });
  const warnings: string[] = [];

  const due = await loadDueScans({
    repos: ["org/alpha", "org/beta"],
    now: NOW,
    ghCommandFn: gh.fn,
    warn: (m) => warnings.push(m),
  });

  assertEquals(
    due.every((d) => d.repo === "org/beta"),
    true,
    "the unreadable repo contributes no due pairs",
  );
  assert(
    warnings.some((w) => w.includes("history_read_failed")),
    "the degraded read must be surfaced, never silently reconciled as fresh",
  );
});

Deno.test("loadDueScans - a never-run repo is due at the monthly tier", async () => {
  resetDueScanCache();
  const gh = makeGh({});

  const due = await loadDueScans({
    repos: [REPO],
    now: NOW,
    ghCommandFn: gh.fn,
    warn: () => {},
  });

  assertEquals(due.length, 3, "all three important templates are owed a scan");
  assertEquals(due.every((d) => d.tier === "fable"), true);
});
