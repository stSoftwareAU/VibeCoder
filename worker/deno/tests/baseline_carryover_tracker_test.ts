/**
 * Tests for the deduplicated, non-fatal baseline-carryover tracking-issue
 * filer (Issue #2605).
 *
 * The filer is called from the generic baseline-aware quality-gate bypass
 * branch (Issue #2604): when an unrelated PR is waved through because every
 * current diffable finding was already present at baseline, the pre-existing
 * breakage is filed on its own line as a `needs-human` tracking issue so a
 * human fixes it independently rather than letting it silently rot.
 *
 * The `gh` runner is injected so these tests never spawn a real subprocess.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BASELINE_CARRYOVER_MARKER,
  buildCarryoverTrackerTitle,
  buildRedCheckTrackerTitle,
  fileBaselineCarryoverTracker,
  fileRedCheckTracker,
  formatRedCheckTrackerBody,
  PRE_EXISTING_GATE_MARKER,
} from "../lib/baseline_carryover_tracker.ts";
import type { GenericFinding } from "../lib/baseline_gate.ts";
import { mermaidFinding } from "../lib/baseline_gate.ts";

const REPO = "org/repo";

const FINDINGS: GenericFinding[] = [
  mermaidFinding({
    file: "docs/x.md",
    startLine: 3,
    type: "sequenceDiagram",
    error: "participant Loop",
  }),
];

// ---------------------------------------------------------------------------
// Files a needs-human tracker when none is open
// ---------------------------------------------------------------------------

Deno.test(
  "fileBaselineCarryoverTracker - files a needs-human issue with the marker when no tracker is open",
  async () => {
    const calls: string[][] = [];
    const ghCommand = (args: string[]): Promise<string> => {
      calls.push(args);
      // First call is the dedup search → no open tracker.
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      // Second call is the create.
      return Promise.resolve("https://github.com/org/repo/issues/42");
    };

    await fileBaselineCarryoverTracker(REPO, FINDINGS, { ghCommand });

    assertEquals(calls.length, 2, "expected a search then a create");
    const create = calls[1]!;
    assertEquals(create[0], "issue");
    assertEquals(create[1], "create");

    // Filed against the right repo.
    const repoIdx = create.indexOf("--repo");
    assert(repoIdx >= 0);
    assertEquals(create[repoIdx + 1], REPO);

    // Filed with the only self-appliable triage label.
    const labelIdx = create.indexOf("--label");
    assert(labelIdx >= 0);
    assertEquals(create[labelIdx + 1], "needs-human");

    // Stable title and marker present in the body.
    const titleIdx = create.indexOf("--title");
    assert(titleIdx >= 0);
    assertEquals(create[titleIdx + 1], buildCarryoverTrackerTitle(REPO));

    const bodyIdx = create.indexOf("--body");
    assert(bodyIdx >= 0);
    const body = create[bodyIdx + 1] ?? "";
    assertStringIncludes(body, BASELINE_CARRYOVER_MARKER);
    // Body lists the carried-over finding.
    assertStringIncludes(body, "participant Loop");
  },
);

// ---------------------------------------------------------------------------
// Dedup — skip filing when a tracker is already open
// ---------------------------------------------------------------------------

Deno.test(
  "fileBaselineCarryoverTracker - skips filing when an open tracker already exists",
  async () => {
    const calls: string[][] = [];
    const ghCommand = (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(
          JSON.stringify([
            {
              number: 7,
              title: buildCarryoverTrackerTitle(REPO),
              // The dedup search now counts a title match only when the
              // fleet authored it — a title is text anybody may write, and
              // an unverified match would suppress the tracker for good.
              author: { login: "vibe-bot" },
            },
          ]),
        );
      }
      return Promise.resolve("");
    };

    await fileBaselineCarryoverTracker(REPO, FINDINGS, {
      ghCommand,
      dedupAuthors: { fleetAuthors: ["vibe-bot"] },
    });

    assertEquals(calls.length, 1, "dedup must short-circuit before create");
    assertEquals(calls[0]![1], "list");
  },
);

// ---------------------------------------------------------------------------
// Non-fatal — swallows and logs an injected gh error
// ---------------------------------------------------------------------------

Deno.test(
  "fileBaselineCarryoverTracker - is non-fatal when gh throws",
  async () => {
    const logged: string[] = [];
    const ghCommand = (_args: string[]): Promise<string> =>
      Promise.reject(new Error("gh boom"));

    // Must not throw.
    await fileBaselineCarryoverTracker(REPO, FINDINGS, {
      ghCommand,
      logger: { warn: (msg: string) => logged.push(msg) },
    });

    assert(
      logged.some((m) =>
        m.includes("gh boom") || m.toLowerCase().includes("carryover")
      ),
      "the failure should be logged",
    );
  },
);

// ---------------------------------------------------------------------------
// fileRedCheckTracker (Issue #1852) — names the check red on the untouched tree
// ---------------------------------------------------------------------------

Deno.test(
  "fileRedCheckTracker - files one tracker naming each red check",
  async () => {
    const calls: string[][] = [];
    const ghCommand = (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("https://github.com/org/repo/issues/43");
    };

    await fileRedCheckTracker(REPO, ["repo quality.sh"], { ghCommand });

    assertEquals(calls.length, 2, "expected a search then a create");
    const create = calls[1]!;
    const body = create[create.indexOf("--body") + 1]!;
    assertStringIncludes(body, PRE_EXISTING_GATE_MARKER);
    assertStringIncludes(body, "`repo quality.sh`");
    assertStringIncludes(body, "default branch");
    assertEquals(
      create[create.indexOf("--title") + 1],
      buildRedCheckTrackerTitle(REPO),
      "its own stable title, so it dedups independently",
    );
  },
);

Deno.test(
  "fileRedCheckTracker - skips filing when its own tracker is already open",
  async () => {
    const calls: string[][] = [];
    const ghCommand = (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(
          JSON.stringify([
            {
              number: 7,
              title: buildRedCheckTrackerTitle(REPO),
              author: { login: "vibe-bot" },
            },
          ]),
        );
      }
      return Promise.resolve("");
    };

    await fileRedCheckTracker(REPO, ["repo quality.sh"], {
      ghCommand,
      dedupAuthors: { fleetAuthors: ["vibe-bot"] },
    });

    assertEquals(calls.length, 1, "dedup must short-circuit before create");
  },
);

Deno.test(
  "fileRedCheckTracker - an open findings tracker does not suppress it",
  async () => {
    // The two trackers answer different questions, so a findings tracker
    // must never leave the repository unable to say which check is red.
    const calls: string[][] = [];
    const ghCommand = (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(
          JSON.stringify([
            {
              number: 7,
              title: buildCarryoverTrackerTitle(REPO),
              author: { login: "vibe-bot" },
            },
          ]),
        );
      }
      return Promise.resolve("https://github.com/org/repo/issues/44");
    };

    await fileRedCheckTracker(REPO, ["repo quality.sh"], {
      ghCommand,
      dedupAuthors: { fleetAuthors: ["vibe-bot"] },
    });

    assertEquals(calls.length, 2, "the red-check tracker is still filed");
    assertEquals(
      calls[1]![calls[1]!.indexOf("--title") + 1],
      buildRedCheckTrackerTitle(REPO),
    );
  },
);

Deno.test("fileRedCheckTracker - is non-fatal when gh throws", async () => {
  const logged: string[] = [];
  await fileRedCheckTracker(REPO, ["repo quality.sh"], {
    ghCommand: () => Promise.reject(new Error("gh boom")),
    logger: { warn: (msg: string) => logged.push(msg) },
  });
  assert(logged.some((m) => m.includes("gh boom")), "the failure is logged");
});

Deno.test(
  "formatRedCheckTrackerBody - says so plainly when no check could be named",
  () => {
    const body = formatRedCheckTrackerBody(REPO, []);
    assertStringIncludes(body, "could not be named");
  },
);
