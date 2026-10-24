/**
 * A second worker-gate failure takes the normal failure path (Issue #4130
 * removed).
 *
 * Owner rule (2026-10-25): the Vibe Coder completes the assigned issue. No
 * follow-up issues, no hand-back. A repeat worker-gate failure writes its
 * record on the issue, keeps `failed-once` and is retried after the
 * escalating cooldown. Nothing is filed, closed or deleted.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import type { FailureCategory } from "../lib/failure_diagnosis.ts";
import { handleIssueFailure } from "../lib/label_failure.ts";
import type { LabelManagerDeps } from "../lib/label_types.ts";

const WORKER_GATES: readonly FailureCategory[] = [
  "summary_incomplete",
  "quality_check",
  "pre_push_gate",
  "security_fix_gate",
  "criteria_unmet",
];

function secondFailureGh() {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("issue view") && joined.includes("labels")) {
      return Promise.resolve("bug,failed-once");
    }
    if (joined.includes("label list")) {
      return Promise.resolve("failed\nfailed-once\nenhancement\n");
    }
    if (args.includes("title,body,author")) {
      return Promise.resolve(JSON.stringify({
        title: "Blocked gate",
        body: "parent body",
        author: { login: "vibe-worker" },
      }));
    }
    if (args.includes("comments")) {
      return Promise.resolve(JSON.stringify({ comments: [] }));
    }
    if (args[0] === "repo" && args[1] === "view") {
      return Promise.resolve('{"viewerPermission":"WRITE"}');
    }
    if (args[0] === "search" || (args[0] === "issue" && args[1] === "list")) {
      return Promise.resolve("[]");
    }
    if (args[0] === "issue" && args[1] === "create") {
      return Promise.resolve("https://github.com/org/repo/issues/101\n");
    }
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(
        JSON.stringify([{ number: 7, headRefName: "issue-42-gate" }]),
      );
    }
    if (args.some((arg) => arg.includes("matching-refs"))) {
      return Promise.resolve(
        JSON.stringify([{ ref: "refs/heads/issue-42-gate" }]),
      );
    }
    return Promise.resolve("");
  };
  return { gh, calls };
}

function labelsAdded(calls: string[][]): string[] {
  return calls
    .filter((c) =>
      c.join(" ").includes("-X POST") && c.join(" ").includes("/labels")
    )
    .flatMap((c) => c.filter((a) => a.startsWith("labels[]=")))
    .map((a) => a.slice("labels[]=".length));
}

for (const category of WORKER_GATES) {
  Deno.test(`a second ${category} failure is recorded and retried, never split`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "gate-repeat-" });
    const { gh, calls } = secondFailureGh();
    // A planner left over from the removed split must change nothing.
    const deps: LabelManagerDeps = Object.assign(
      { ghCommandFn: gh, cacheDir: dir },
      {
        planWorkerGateSplit: () =>
          Promise.resolve({
            parts: [
              { title: "Part one", scope: "First part." },
              { title: "Part two", scope: "Second part." },
            ],
          }),
        readBranchProgress: () => Promise.resolve("Files:\n- src/app.ts"),
      },
    );
    try {
      const result = await handleIssueFailure({
        repo: "org/repo",
        issueNumber: 42,
        githubUser: "worker-user",
        failureMessage: "gate refused the branch\nfailing check: deno test",
        category,
      }, deps);

      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.markedAsFailedOnce, true);
        assertEquals(result.value.failureCategory, category);
      }
      // The evidence is written on the issue itself.
      assertEquals(
        calls.some((c) =>
          c[0] === "issue" && c[1] === "comment" && c.includes("42")
        ),
        true,
      );
      // `failed-once` stays; `failed` is never applied.
      assertEquals(
        calls.some((c) => c.join(" ").includes("--remove-label failed-once")),
        false,
      );
      assertEquals(labelsAdded(calls).includes("failed"), false);
      // Nothing is filed, closed or deleted.
      assertEquals(
        calls.some((c) => c[0] === "issue" && c[1] === "create"),
        false,
      );
      assertEquals(
        calls.some((c) => c[0] === "issue" && c[1] === "close"),
        false,
      );
      assertEquals(calls.some((c) => c[0] === "pr" && c[1] === "close"), false);
      assertEquals(calls.some((c) => c.includes("DELETE")), false);
      assertEquals(
        calls.some((c) => c.join(" ").toLowerCase().includes("split")),
        false,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
