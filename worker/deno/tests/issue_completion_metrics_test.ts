import { assertEquals, assertRejects } from "@std/assert";
import { collectIssueCompletions } from "../lib/issue_completion_metrics.ts";

const cohort = {
  start: "2026-11-01T00:00:00Z",
  end: "2026-11-08T00:00:00Z",
  observedAt: "2026-11-08T00:00:00Z",
};

Deno.test("issue collector verifies default-branch delivery and excludes manual or abandoned closures", async () => {
  const sha = "a".repeat(40);
  const evidence = await collectIssueCompletions(
    ["owner/repo"],
    cohort,
    async (path) => {
      if (path === "repos/owner/repo") return { default_branch: "Develop" };
      if (path.includes("issues?")) {
        return [1, 2, 3, 4].map((number) => ({
          number,
          created_at: "2026-10-30T00:00:00Z",
          closed_at: "2026-11-05T00:00:00Z",
          state_reason: number === 3 ? "not_planned" : "completed",
          ...(number === 4 ? { pull_request: {} } : {}),
        }));
      }
      if (path.includes("issues/1/timeline")) {
        return [{
          event: "closed",
          commit_id: sha,
        }];
      }
      if (path.includes("issues/2/timeline")) {
        return [{
          event: "closed",
          commit_id: null,
        }];
      }
      if (path.includes(`/commits/${sha}/pulls`)) {
        return [{
          number: 50,
          base: { ref: "Develop", repo: { full_name: "owner/repo" } },
          merged_at: "2026-11-04T23:59:00Z",
        }];
      }
      throw new Error(`Unexpected GET ${path}`);
    },
  );
  assertEquals(evidence.records.map((r) => r.number), [1]);
  assertEquals(evidence.records[0]?.closingPr, 50);
  assertEquals(evidence.unknownClosures, 1);
  assertEquals(evidence.excludedClosures, 1);
});

Deno.test("issue collector refuses truncated pages rather than reporting an empty completed cohort", async () => {
  await assertRejects(
    () =>
      collectIssueCompletions(
        ["owner/repo"],
        cohort,
        async (path) =>
          path === "repos/owner/repo"
            ? { default_branch: "main" }
            : Array.from({ length: 100 }, () => ({ pull_request: {} })),
      ),
    Error,
    "pagination bound",
  );
});
