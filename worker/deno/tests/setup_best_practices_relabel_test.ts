/**
 * Tests for setup/best_practices_relabel.ts — one-shot backfill that
 * relabels existing "Workflow best-practice findings" issues with the
 * correct `severity:*` + category labels (Issue #2336).
 *
 * All tests use an injected `ghCommandFn` mock — no real network.
 */

import { assertEquals } from "@std/assert";
import {
  BEST_PRACTICES_CATEGORY_LABEL,
  BEST_PRACTICES_MARKER,
  type CommandOutput,
  type GhCommandFn,
} from "../setup/best_practices_sync.ts";
import {
  parseSeveritiesFromBody,
  relabelBestPracticesForAllRepos,
  relabelBestPracticesForRepo,
} from "../setup/best_practices_relabel.ts";

/** The fleet login every fixture issue is authored by. */
const FLEET_AUTHOR = "vibe-coder-bot";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build an issue body with the marker and the given rendered severities. */
function bodyWithSeverities(severities: string[]): string {
  const findings = severities
    .map(
      (sev, i) =>
        `### ${i + 1}. \`check-${i}\` — severity: **${sev}**\n\n- detail`,
    )
    .join("\n\n");
  return `## Workflow best-practice findings\n\n${findings}\n\n${BEST_PRACTICES_MARKER}`;
}

interface IssueFixture {
  number: number;
  labels: string[];
  body: string;
}

interface MockState {
  /** Issues returned by `gh issue list` for the repo. */
  issues: IssueFixture[];
  labelsCreated: string[];
  /** `{issue, label}` pairs added via REST/CLI. */
  labelsAdded: { issue: number; label: string }[];
  existingLabels: string[];
  /** Substrings of commands that should fail. */
  failOn?: (cmd: string[]) => boolean;
}

function buildMockRunner(state: MockState): GhCommandFn {
  return (cmd: string[]): Promise<CommandOutput> => {
    const ok = (stdout = ""): Promise<CommandOutput> =>
      Promise.resolve({ success: true, stdout, stderr: "" });
    const fail = (stderr: string): Promise<CommandOutput> =>
      Promise.resolve({ success: false, stdout: "", stderr });

    if (state.failOn?.(cmd)) return fail("simulated failure");

    // label list (ensureLabelExists → getCachedLabels)
    if (cmd[0] === "gh" && cmd[1] === "label" && cmd[2] === "list") {
      return ok(state.existingLabels.join("\n"));
    }

    // label create via REST
    if (
      cmd[0] === "gh" && cmd[1] === "api" &&
      cmd.some((a) => /^repos\/[^/]+\/[^/]+\/labels$/.test(a))
    ) {
      const nameArg = cmd.find((a) => a.startsWith("name="));
      if (nameArg) state.labelsCreated.push(nameArg.slice("name=".length));
      return ok();
    }

    // label create via CLI fallback
    if (cmd[0] === "gh" && cmd[1] === "label" && cmd[2] === "create") {
      state.labelsCreated.push(cmd[3] ?? "");
      return ok();
    }

    // add label via REST: gh api .../issues/<n>/labels
    if (
      cmd[0] === "gh" && cmd[1] === "api" &&
      cmd.some((a) => /\/issues\/\d+\/labels$/.test(a))
    ) {
      const pathArg = cmd.find((a) => /\/issues\/\d+\/labels$/.test(a))!;
      const issue = Number(pathArg.match(/\/issues\/(\d+)\/labels$/)![1]);
      const arg = cmd.find((a) => a.startsWith("labels[]="));
      if (arg) {
        state.labelsAdded.push({ issue, label: arg.slice("labels[]=".length) });
      }
      return ok();
    }

    // add label via CLI fallback: gh issue edit <n> --add-label
    if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "edit") {
      const issue = Number(cmd[3]);
      const addIdx = cmd.indexOf("--add-label");
      if (addIdx >= 0) {
        state.labelsAdded.push({ issue, label: cmd[addIdx + 1]! });
      }
      return ok();
    }

    // issue list with marker
    if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "list") {
      const payload = JSON.stringify(
        state.issues.map((iss) => ({
          number: iss.number,
          labels: iss.labels.map((name) => ({ name })),
          body: iss.body,
          author: { login: FLEET_AUTHOR },
        })),
      );
      return ok(payload);
    }

    return ok();
  };
}

function emptyState(overrides: Partial<MockState> = {}): MockState {
  return {
    issues: [],
    labelsCreated: [],
    labelsAdded: [],
    existingLabels: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseSeveritiesFromBody
// ---------------------------------------------------------------------------

Deno.test("parseSeveritiesFromBody - extracts rendered severities", () => {
  const body = bodyWithSeverities(["medium", "high", "low"]);
  assertEquals(parseSeveritiesFromBody(body), ["medium", "high", "low"]);
});

Deno.test("parseSeveritiesFromBody - no severities returns empty", () => {
  assertEquals(parseSeveritiesFromBody("nothing here"), []);
});

// ---------------------------------------------------------------------------
// relabelBestPracticesForRepo
// ---------------------------------------------------------------------------

Deno.test("relabel - adds severity + category to enhancement-only issue", async () => {
  const state = emptyState({
    issues: [
      {
        number: 2780,
        labels: ["enhancement"],
        body: bodyWithSeverities(["high"]),
      },
    ],
  });
  const result = await relabelBestPracticesForRepo("o/r", {
    fleetAuthors: [FLEET_AUTHOR],
    ghCommandFn: buildMockRunner(state),
  });

  assertEquals(result.ok, true);
  assertEquals(result.relabelled, 1);
  assertEquals(result.skipped, 0);
  const added = state.labelsAdded.filter((l) => l.issue === 2780).map((l) =>
    l.label
  );
  assertEquals(added.sort(), ["best-practices", "severity:high"]);
});

Deno.test("relabel - highest severity wins on mixed body", async () => {
  const state = emptyState({
    issues: [
      {
        number: 5,
        labels: ["enhancement"],
        body: bodyWithSeverities(["low", "high", "medium"]),
      },
    ],
  });
  await relabelBestPracticesForRepo("o/r", {
    fleetAuthors: [FLEET_AUTHOR],
    ghCommandFn: buildMockRunner(state),
  });
  const added = state.labelsAdded.map((l) => l.label);
  assertEquals(added.includes("severity:high"), true);
  assertEquals(added.includes("severity:medium"), false);
  assertEquals(added.includes("severity:low"), false);
});

Deno.test("relabel - idempotent when already correctly labelled", async () => {
  const state = emptyState({
    issues: [
      {
        number: 7,
        labels: ["enhancement", "severity:high", BEST_PRACTICES_CATEGORY_LABEL],
        body: bodyWithSeverities(["high"]),
      },
    ],
  });
  const result = await relabelBestPracticesForRepo("o/r", {
    fleetAuthors: [FLEET_AUTHOR],
    ghCommandFn: buildMockRunner(state),
  });
  assertEquals(result.relabelled, 0);
  assertEquals(result.skipped, 1);
  assertEquals(state.labelsAdded.length, 0);
});

Deno.test("relabel - dry-run reports without mutating", async () => {
  const state = emptyState({
    issues: [
      {
        number: 9,
        labels: ["enhancement"],
        body: bodyWithSeverities(["medium"]),
      },
    ],
  });
  const result = await relabelBestPracticesForRepo("o/r", {
    fleetAuthors: [FLEET_AUTHOR],
    ghCommandFn: buildMockRunner(state),
    dryRun: true,
  });
  assertEquals(result.relabelled, 1);
  assertEquals(state.labelsAdded.length, 0);
  assertEquals(state.labelsCreated.length, 0);
});

Deno.test("relabel - per-issue failure does not abort the run", async () => {
  const state = emptyState({
    issues: [
      {
        number: 1,
        labels: ["enhancement"],
        body: bodyWithSeverities(["high"]),
      },
      { number: 2, labels: ["enhancement"], body: bodyWithSeverities(["low"]) },
    ],
    // Fail every label add/create for issue 1's REST path AND CLI path.
    failOn: (cmd) =>
      (cmd.includes("--add-label") && cmd[3] === "1") ||
      cmd.some((a) => /\/issues\/1\/labels$/.test(a)),
  });
  const result = await relabelBestPracticesForRepo("o/r", {
    fleetAuthors: [FLEET_AUTHOR],
    ghCommandFn: buildMockRunner(state),
  });
  // Run completes; issue 2 still relabelled.
  assertEquals(result.ok, true);
  const issue2 = state.labelsAdded.filter((l) => l.issue === 2);
  assertEquals(issue2.length > 0, true);
});

Deno.test("relabel - issue list failure is caught (silent skip)", async () => {
  const state = emptyState({
    failOn: (cmd) => cmd[1] === "issue" && cmd[2] === "list",
  });
  const result = await relabelBestPracticesForRepo("o/r", {
    fleetAuthors: [FLEET_AUTHOR],
    ghCommandFn: buildMockRunner(state),
  });
  // Repo-level failure does not throw; result reports it.
  assertEquals(result.ok, false);
  assertEquals(result.relabelled, 0);
});

// ---------------------------------------------------------------------------
// relabelBestPracticesForAllRepos
// ---------------------------------------------------------------------------

Deno.test("relabelAll - iterates every repo, one failure does not stop others", async () => {
  const calls: string[] = [];
  const runner: GhCommandFn = (cmd) => {
    if (cmd[1] === "issue" && cmd[2] === "list") {
      const repoIdx = cmd.indexOf("--repo");
      const repo = cmd[repoIdx + 1]!;
      calls.push(repo);
      if (repo === "o/bad") {
        return Promise.resolve({ success: false, stdout: "", stderr: "boom" });
      }
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify([
          {
            number: 1,
            labels: [{ name: "enhancement" }],
            body: bodyWithSeverities(["high"]),
            author: { login: FLEET_AUTHOR },
          },
        ]),
        stderr: "",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };

  const results = await relabelBestPracticesForAllRepos({
    repos: ["o/good", "o/bad", "o/good2"],
    ghCommandFn: runner,
    fleetAuthors: [FLEET_AUTHOR],
  });

  assertEquals(results.length, 3);
  assertEquals(calls.sort(), ["o/bad", "o/good", "o/good2"]);
  assertEquals(results.find((r) => r.repo === "o/bad")!.ok, false);
  assertEquals(results.find((r) => r.repo === "o/good")!.relabelled, 1);
});
