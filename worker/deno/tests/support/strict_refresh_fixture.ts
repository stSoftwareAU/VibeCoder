/** Stateful GitHub contract for strict-base refresh integration tests. */
export function strictRefreshFixture(
  repo = "owner/repo",
  base = "main",
  author = "VibeCoderST",
) {
  const head = "a".repeat(40);
  const state = {
    decision: "APPROVED",
    conclusion: "success",
    status: "completed",
    statuses: [] as Array<{ context: string; state: string }>,
    rules: [{
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: "gate" }],
      },
    }] as unknown[],
    protection: {
      enabled: false,
      required_status_checks: {
        contexts: [],
        checks: [],
        enforcement_level: "off",
      },
    } as unknown,
    classicStrict: true,
    candidateReads: 0,
    mergeReads: 0,
    changeAtView: 0,
    changeField: "baseRefName",
    changeAtMerge: 0,
    refusal: "",
  };
  const calls: string[][] = [];
  const comments: Array<
    { id: number; body: string; author: string; created_at: string }
  > = [];
  let id = 100;
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    const endpoint = args[1] ?? "";
    if (args[0] === "pr" && endpoint === "view") {
      const candidate = args.at(-1)?.includes("isDraft");
      if (candidate) state.candidateReads++;
      return JSON.stringify({
        state: "OPEN",
        isDraft: false,
        baseRefName: base,
        headRefOid: head,
        autoMergeRequest: {},
        reviewDecision: state.decision,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BEHIND",
        ...(candidate && state.candidateReads === state.changeAtView
          ? {
            [state.changeField]: state.changeField === "baseRefName"
              ? "other"
              : state.changeField === "headRefOid"
              ? "d".repeat(40)
              : "REVIEW_REQUIRED",
          }
          : {}),
      });
    }
    if (args[0] === "issue" && endpoint === "comment") {
      const commentId = id++;
      comments.push({
        id: commentId,
        body: args[args.indexOf("--body") + 1]!,
        author,
        created_at: new Date().toISOString(),
      });
      return `https://github.com/${repo}/issues/${
        args[2]
      }#issuecomment-${commentId}`;
    }
    if (args[0] === "api" && endpoint.includes("/comments?")) {
      return JSON.stringify(comments);
    }
    if (args.includes("DELETE")) {
      const index = comments.findIndex((row) =>
        row.id === Number(args.at(-1)?.split("/").at(-1))
      );
      if (index >= 0) comments.splice(index, 1);
      return "";
    }
    if (endpoint === "--method") {
      if (state.refusal) throw new Error(state.refusal);
      return "{}";
    }
    if (endpoint.includes("/pulls?state=all")) return "1\n";
    if (endpoint.includes("/pulls/")) {
      state.mergeReads++;
      return JSON.stringify({
        state: "open",
        mergeable: true,
        merge_commit_sha: state.mergeReads === state.changeAtMerge
          ? "e".repeat(40)
          : "b".repeat(40),
        head: { sha: head },
        base: { ref: base, sha: "c".repeat(40) },
      });
    }
    if (endpoint.includes("/git/commits/")) {
      return JSON.stringify({
        parents: [{ sha: "c".repeat(40) }, { sha: head }],
      });
    }
    if (endpoint.includes("/rules/branches/")) {
      return JSON.stringify([state.rules]);
    }
    if (endpoint.endsWith("/protection/required_status_checks")) {
      if (
        state.protection === null ||
        (state.protection as Record<string, unknown>).enabled === false ||
        (state.protection as Record<string, unknown>).required_status_checks ===
          null
      ) {
        throw new Error("HTTP 404: Branch not protected");
      }
      return JSON.stringify({
        contexts: ["gate"],
        strict: state.classicStrict,
      });
    }
    if (endpoint.includes("/branches/")) {
      return JSON.stringify({ protection: state.protection });
    }
    if (endpoint.includes("/check-runs?")) {
      return JSON.stringify([{
        check_runs: endpoint.includes(head)
          ? [{
            name: "gate",
            status: state.status,
            conclusion: state.conclusion,
            app: { id: 1, slug: "external-ci" },
          }]
          : [],
      }]);
    }
    if (endpoint.includes("/status?")) {
      return JSON.stringify([{ statuses: state.statuses }]);
    }
    throw new Error(`Unexpected refresh command: ${args.join(" ")}`);
  };
  return { gh, state, calls, comments, head };
}
