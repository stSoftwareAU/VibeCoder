/**
 * Tests for the close-notifier chokepoint hook (Issue #181).
 *
 * A close the worker itself performs must (a) mark the issue as finished for
 * the rest of the run and (b) drop the scan-cache entries that still describe
 * it as open — otherwise the 600 s issue-list TTL re-offers a closed issue to
 * the very next pool entry.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  closeInvalidatedCacheKeys,
  issueNumberFromCloseArgs,
  noteGhIssueClose,
} from "../lib/issue_close_notifier.ts";
import { ProcessedIssueRegistry } from "../lib/processed_issue_registry.ts";

/** A cache in a throwaway directory, pre-seeded with the close-sensitive keys. */
async function seededCache(
  repo: string,
  issueNumber: number,
): Promise<{ cache: IssueCache; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-close-notifier-" });
  const cache = new IssueCache(dir);
  for (const key of closeInvalidatedCacheKeys(issueNumber)) {
    await cache.write(repo, key, [{ number: issueNumber }]);
  }
  return { cache, dir };
}

Deno.test("close notifier - a successful close records the issue for the run", async () => {
  const registry = new ProcessedIssueRegistry();

  await noteGhIssueClose(
    ["issue", "close", "21", "--repo", "o/r", "--comment", "done"],
    0,
    { registry },
  );

  assert(registry.wasClosedByWorker("o/r", 21));
  assertEquals(registry.reasonFor("o/r", 21), "closed");
});

Deno.test("close notifier - a failed close records nothing", async () => {
  const registry = new ProcessedIssueRegistry();

  await noteGhIssueClose(
    ["issue", "close", "21", "--repo", "o/r"],
    1,
    { registry },
  );

  assertFalse(registry.has("o/r", 21));
});

Deno.test("close notifier - non-close gh calls are ignored", async () => {
  const registry = new ProcessedIssueRegistry();

  await noteGhIssueClose(["issue", "list", "--repo", "o/r"], 0, { registry });
  await noteGhIssueClose(
    ["issue", "comment", "21", "--repo", "o/r", "--body", "hi"],
    0,
    { registry },
  );
  await noteGhIssueClose(["pr", "close", "7", "--repo", "o/r"], 0, {
    registry,
  });

  assertEquals(registry.size(), 0);
});

Deno.test("close notifier - a reopen clears the entry so the issue is claimable again", async () => {
  const registry = new ProcessedIssueRegistry();
  registry.record("o/r", 21, "closed");

  await noteGhIssueClose(["issue", "reopen", "21", "--repo", "o/r"], 0, {
    registry,
  });

  assertFalse(registry.has("o/r", 21));
});

Deno.test("close notifier - closing drops the repo's stale scan-cache entries", async () => {
  const repo = "o/r";
  const { cache, dir } = await seededCache(repo, 21);
  try {
    // Sanity: the entries are readable before the close.
    assert(await cache.read(repo, "issues_all"));

    await noteGhIssueClose(
      ["issue", "close", "21", "--repo", repo],
      0,
      { registry: new ProcessedIssueRegistry(), cache },
    );

    for (const key of closeInvalidatedCacheKeys(21)) {
      assertEquals(
        await cache.read(repo, key),
        null,
        `${key} should have been invalidated`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("close notifier - another repo's cache entries survive", async () => {
  const { cache, dir } = await seededCache("o/other", 21);
  try {
    await noteGhIssueClose(
      ["issue", "close", "21", "--repo", "o/r"],
      0,
      { registry: new ProcessedIssueRegistry(), cache },
    );

    assert(await cache.read("o/other", "issues_all"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("close notifier - a close with no derivable repo warns instead of failing silently", async () => {
  const warnings: string[] = [];
  const registry = new ProcessedIssueRegistry();

  // No `--repo`: gh would resolve it from the clone, which this hook cannot see.
  await noteGhIssueClose(["issue", "close", "21"], 0, {
    registry,
    warn: (message) => warnings.push(message),
  });

  assertEquals(registry.size(), 0);
  assertEquals(warnings.length, 1);
  assert(warnings[0]!.includes("21"));
});

Deno.test("close notifier - reads the issue number from either argument order", () => {
  // `gh issue close <n> --repo o/r --comment "..."` (most call sites).
  assertEquals(
    issueNumberFromCloseArgs(
      ["issue", "close", "21", "--repo", "o/r", "--comment", "done"],
      "close",
    ),
    21,
  );
  // `gh issue close --repo o/r <n> --reason completed`
  // (milestone_completion.ts).
  assertEquals(
    issueNumberFromCloseArgs(
      ["issue", "close", "--repo", "o/r", "34", "--reason", "completed"],
      "close",
    ),
    34,
  );
  // A numeric flag value is never mistaken for the target.
  assertEquals(
    issueNumberFromCloseArgs(
      ["issue", "close", "--repo", "o/r", "--comment", "7", "34"],
      "close",
    ),
    34,
  );
  assertEquals(
    issueNumberFromCloseArgs(["issue", "close", "--repo", "o/r"], "close"),
    undefined,
  );
});

Deno.test("close notifier - records a flag-first close (milestone completion shape)", async () => {
  const registry = new ProcessedIssueRegistry();

  await noteGhIssueClose(
    ["issue", "close", "--repo", "o/r", "34", "--reason", "completed"],
    0,
    { registry },
  );

  assert(registry.wasClosedByWorker("o/r", 34));
});

// ---------------------------------------------------------------------------
// The REST form (Issue #1753)
// ---------------------------------------------------------------------------

Deno.test("close notifier - a REST PATCH state=closed records the issue and drops the cache entries (Issue #1753)", async () => {
  const repo = "o/r";
  const { cache, dir } = await seededCache(repo, 21);
  const registry = new ProcessedIssueRegistry();
  try {
    await noteGhIssueClose(
      ["api", "-X", "PATCH", "repos/o/r/issues/21", "-f", "state=closed"],
      0,
      { registry, cache },
    );

    assert(registry.wasClosedByWorker(repo, 21));
    for (const key of closeInvalidatedCacheKeys(21)) {
      assertEquals(
        await cache.read(repo, key),
        null,
        `${key} should have been invalidated`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("close notifier - a REST PATCH state=open clears the entry like gh issue reopen", async () => {
  const registry = new ProcessedIssueRegistry();
  registry.record("o/r", 21, "closed");

  await noteGhIssueClose(
    ["api", "-X", "PATCH", "repos/o/r/issues/21", "-f", "state=open"],
    0,
    { registry },
  );

  assertFalse(registry.has("o/r", 21));
});

Deno.test("close notifier - a failed REST close records nothing", async () => {
  const registry = new ProcessedIssueRegistry();

  await noteGhIssueClose(
    ["api", "-X", "PATCH", "repos/o/r/issues/21", "-f", "state=closed"],
    1,
    { registry },
  );

  assertFalse(registry.has("o/r", 21));
});

Deno.test("close notifier - REST calls that are not a state change are ignored", async () => {
  const registry = new ProcessedIssueRegistry();
  const warnings: string[] = [];

  for (
    const args of [
      // The summary comment the wrapper closure posts before it closes.
      ["api", "-X", "POST", "repos/o/r/issues/21/comments", "-f", "body=done"],
      // A title edit: a PATCH without `state=`.
      ["api", "-X", "PATCH", "repos/o/r/issues/21", "-f", "title=renamed"],
      // Labels and assignees are not lifecycle changes.
      ["api", "-X", "POST", "repos/o/r/issues/21/labels", "-f", "labels[]=x"],
      [
        "api",
        "-X",
        "DELETE",
        "repos/o/r/issues/21/assignees",
        "-f",
        "assignees[]=me",
      ],
      // A PR close is not an issue close.
      ["api", "-X", "PATCH", "repos/o/r/pulls/21", "-f", "state=closed"],
    ]
  ) {
    await noteGhIssueClose(args, 0, {
      registry,
      warn: (message) => warnings.push(message),
    });
  }

  assertEquals(registry.size(), 0);
  assertEquals(warnings, []);
});

Deno.test("close notifier - a REST close on gh's {owner}/{repo} placeholder warns instead of guessing", async () => {
  const warnings: string[] = [];
  const registry = new ProcessedIssueRegistry();

  await noteGhIssueClose(
    [
      "api",
      "-X",
      "PATCH",
      "repos/{owner}/{repo}/issues/21",
      "-f",
      "state=closed",
    ],
    0,
    { registry, warn: (message) => warnings.push(message) },
  );

  assertEquals(registry.size(), 0);
  assertEquals(warnings.length, 1);
  assert(warnings[0]!.includes("cannot_note_issue-close"));
});
