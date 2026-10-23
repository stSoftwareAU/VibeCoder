/**
 * Issue #4158: an assigned issue is never parked.
 *
 * Owner rule (2026-10-23): an issue labelled `failed` is a failure of the
 * Vibe Coder, not a resolution. A repeated failure keeps `failed-once`, its
 * diagnostic comment and the escalating cooldown, and stays claimable; the
 * worker never applies `failed`, discovery never skips an issue for
 * carrying it, and a leftover `failed` is stripped as stale.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { checkClaimChurn } from "../lib/claim_issue.ts";
import {
  cleanStaleLabels,
  type FilterableIssue,
  filterAndSort,
  getStaleLabelsForReopenedIssue,
} from "../lib/issue_filter.ts";
import {
  handleIssueFailure,
  handleQuestionFailure,
} from "../lib/label_manager.ts";

/** Every label a call added through the REST label endpoint. */
function labelsAdded(calls: string[][]): string[] {
  return calls
    .filter((c) =>
      c.join(" ").includes("-X POST") && c.join(" ").includes("/labels")
    )
    .flatMap((c) => c.filter((a) => a.startsWith("labels[]=")))
    .map((a) => a.slice("labels[]=".length));
}

function cliLabelsAdded(calls: string[][]): string[] {
  return calls.flatMap((c) =>
    c.flatMap((a, i) => (a === "--add-label" ? [c[i + 1] ?? ""] : []))
  );
}

/** A gh stub that reports `failed-once` already on the issue. */
function secondFailureGh(currentLabels: string) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("issue view") && joined.includes("labels")) {
      return Promise.resolve(currentLabels);
    }
    if (joined.includes("label list")) {
      return Promise.resolve("failed\nfailed-once\nquestion\n");
    }
    if (joined.includes("Automated Processing Failed")) {
      return Promise.resolve("99");
    }
    return Promise.resolve("");
  };
  return { gh, calls };
}

function issue(number: number, labels: string[]): FilterableIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/org/repo/issues/${number}`,
    author: "owner",
    assignees: [],
    labels,
    createdAt: `2026-10-0${number}T00:00:00Z`,
    milestone: "",
  };
}

const FILTER_LABELS = {
  needsRevisionLabel: "needs-revision",
  refineIssueLabel: "refine-issue",
  planningLabel: "planning",
  questionLabel: "question",
  needsHumanLabel: "needs-human",
};

Deno.test("#4158 - a second coding failure keeps failed-once and never applies failed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "never-park-" });
  try {
    const { gh, calls } = secondFailureGh("bug,failed-once");
    const result = await handleIssueFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Quality checks failed",
    }, { ghCommandFn: gh, cacheDir: dir });

    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.markedAsFailedOnce, true);
    assertEquals(labelsAdded(calls).includes("failed"), false);
    assertEquals(cliLabelsAdded(calls).includes("failed"), false);
    assertEquals(
      calls.some((c) => c.join(" ").includes("--remove-label failed-once")),
      false,
    );
    // The failure is still recorded on the issue.
    assertEquals(
      calls.some((c) => c.join(" ").includes("issue comment")),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("#4158 - an infrastructure failure past every retry still never applies failed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "never-park-" });
  try {
    const { gh, calls } = secondFailureGh("failed-once");
    const result = await handleIssueFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Claude rate limit exceeded",
    }, { ghCommandFn: gh, cacheDir: dir });

    assertEquals(result.ok, true);
    assertEquals(labelsAdded(calls).includes("failed"), false);
    assertEquals(cliLabelsAdded(calls).includes("failed"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("#4158 - a second question failure keeps failed-once and never applies failed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "never-park-" });
  try {
    const { gh, calls } = secondFailureGh("question,failed-once");
    const result = await handleQuestionFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Timeout again",
    }, { ghCommandFn: gh, cacheDir: dir });

    assertEquals(result.ok, true);
    assertEquals(labelsAdded(calls).includes("failed"), false);
    assertEquals(cliLabelsAdded(calls).includes("failed"), false);
    assertEquals(
      calls.some((c) => c.join(" ").includes("--remove-label failed-once")),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("#4158 - discovery keeps an issue that carries a leftover failed label", () => {
  const result = filterAndSort([
    issue(1, ["work-on", "failed"]),
    issue(2, ["work-on", "needs-human"]),
    issue(3, ["work-on", "failed-once"]),
  ], FILTER_LABELS);
  // The other direction: a genuine hand-back label still blocks.
  assertEquals(result.map((i) => i.number), [1, 3]);
});

Deno.test("#4158 - a leftover failed label is stale without a reopen; failed-once is not", () => {
  const timeline = [
    {
      event: "labeled",
      label: { name: "failed" },
      created_at: "2026-10-01T00:00:00Z",
    },
    {
      event: "labeled",
      label: { name: "failed-once" },
      created_at: "2026-10-01T00:00:00Z",
    },
  ];
  assertEquals(
    getStaleLabelsForReopenedIssue(
      ["failed", "failed-once"],
      timeline,
      "failed",
      "failed-once",
    ),
    ["failed"],
  );
});

Deno.test("#4158 - cleanStaleLabels strips a leftover failed even when the timeline cannot be read", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.join(" ").includes("timeline")) {
      return Promise.reject(new Error("timeline unavailable"));
    }
    return Promise.resolve("");
  };
  const [cleaned] = await cleanStaleLabels(
    [issue(1, ["work-on", "failed"])],
    "org/repo",
    "failed",
    "failed-once",
    gh,
  );
  assertEquals(cleaned?.labels, ["work-on"]);
  assertEquals(
    calls.some((c) => c.join(" ").includes("--remove-label failed")),
    true,
  );
});

Deno.test("#4158 - claim churn cools down without applying failed or asking for planning", async () => {
  const at = (mins: number) =>
    new Date(Date.now() - mins * 60_000).toISOString();
  const events = JSON.stringify([55, 40, 25].map((m) => ({
    event: "unassigned",
    assignee: { login: "worker-user" },
    created_at: at(m),
  })));
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve(args.join(" ").includes("/events") ? events : "");
  };

  const result = await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-user",
    threshold: 3,
    ghCommandFn: gh,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.escalated, true);
  assertEquals(labelsAdded(calls).includes("failed"), false);
  assertEquals(cliLabelsAdded(calls).includes("failed"), false);
  const comments = calls
    .filter((c) => c[0] === "issue" && c[1] === "comment")
    .map((c) => c.join(" "));
  assertEquals(comments.some((c) => c.includes("planning")), false);
  assertEquals(
    calls.some((c) => c.join(" ").includes("--remove-assignee worker-user")),
    true,
  );
});
