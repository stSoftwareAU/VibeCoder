/** Shared stateful GitHub boundary for strict-base refresh tests (#4943). */
export const REPO = "owner/repo";
export const BASE = "main";
export const BASE_SHA = "c".repeat(40);
export const AUTHOR = "VibeCoderST";
const OWNER_PREFIX = "<!-- BASE_REFRESH_OWNER_4613:";

export interface Pr {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  headRefOid: string;
  mergeSha: string;
  mergeable: "MERGEABLE" | "CONFLICTING";
  mergeStateStatus: "BEHIND" | "DIRTY" | "CLEAN";
  reviewDecision: "APPROVED" | "REVIEW_REQUIRED";
  autoMergeRequest: unknown;
}

interface CommentRow {
  prNumber: number;
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  author: string;
  user: { login: string };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Fixed-width SHAs per PR number, so the fake can map a merge commit to its PR. */
export const headOf = (n: number) => `${"a".repeat(38)}${pad(n)}`;
const mergeOf = (n: number) => `${"e".repeat(38)}${pad(n)}`;
export const movedHeadOf = (n: number) => `${"d".repeat(38)}${pad(n)}`;
export const nowSeconds = () => Math.floor(Date.now() / 1000);

export function readyPr(number: number, overrides: Partial<Pr> = {}): Pr {
  return {
    number,
    state: "OPEN",
    isDraft: false,
    headRefOid: headOf(number),
    mergeSha: mergeOf(number),
    mergeable: "MERGEABLE",
    mergeStateStatus: "BEHIND",
    reviewDecision: "APPROVED",
    autoMergeRequest: {},
    ...overrides,
  };
}

/**
 * Stateful GitHub for one strict base shared by competing callers. Owner
 * comments, PR states and check runs are common to every caller.
 */
export class FakeFleet {
  readonly prs = new Map<number, Pr>();
  /** Gate conclusion per head SHA; a missing entry means no check run. */
  readonly gate = new Map<string, string>();
  readonly comments: CommentRow[] = [];
  readonly liveReads = new Map<number, number>();
  readonly parents = new Map<string, string[]>();
  baseSha = BASE_SHA;
  afterComment?: (body: string) => Promise<void>;
  strict = true;
  mergeQueue = false;
  /** Replace a PR's head on its Nth live read (a read that carries isDraft). */
  moveHead: { prNumber: number; atLiveRead: number; to: string } | null = null;
  private nextId = 100;

  constructor(prs: Pr[]) {
    for (const pr of prs) {
      this.prs.set(pr.number, pr);
      this.gate.set(pr.headRefOid, "success");
    }
  }

  readonly gh = async (args: string[]): Promise<string> => {
    const endpoint = args[1] ?? "";
    if (args[0] === "pr" && endpoint === "view") {
      return this.view(
        Number(args[2]),
        args.at(-1)?.includes("isDraft") === true,
      );
    }
    if (args[0] === "issue" && endpoint === "comment") {
      const body = args[args.indexOf("--body") + 1]!;
      const id = this.addComment(body, Number(args[2]));
      await this.afterComment?.(body);
      return `https://github.com/${REPO}/issues/10#issuecomment-${id}`;
    }
    if (args.includes("PUT")) {
      const path = args.find((arg) => arg.endsWith("/update-branch")) ?? "";
      const match = /\/pulls\/(\d+)\/update-branch$/.exec(path);
      if (!match) throw new Error(`Unexpected PUT: ${args.join(" ")}`);
      const expected = args.find((arg) => arg.startsWith("expected_head_sha="));
      const number = Number(match[1]);
      const expectedHead = expected?.slice("expected_head_sha=".length);
      const pr = this.prs.get(number);
      if (!pr || (expectedHead && expectedHead !== pr.headRefOid)) {
        throw new Error("HTTP 422: head changed before update-branch");
      }
      {
        const old = pr.headRefOid;
        pr.headRefOid = movedHeadOf(number);
        this.parents.set(pr.headRefOid, [old, this.baseSha]);
        pr.mergeStateStatus = "CLEAN";
        // The update is a new commit: earlier green CI does not validate it.
        this.gate.delete(pr.headRefOid);
      }
      return "{}";
    }
    if (args.includes("DELETE")) {
      const id = Number(args.at(-1)!.split("/").at(-1));
      const index = this.comments.findIndex((row) => row.id === id);
      if (index >= 0) this.comments.splice(index, 1);
      return "";
    }
    if (endpoint.includes("/comments?")) {
      const number = Number(/\/issues\/(\d+)\/comments/.exec(endpoint)?.[1]);
      return JSON.stringify(
        this.comments.filter((row) => row.prNumber === number),
      );
    }
    if (endpoint.includes("/pulls?state=all")) return "10\n";
    if (endpoint.includes("/rules/branches/")) {
      return JSON.stringify([[
        ...(this.mergeQueue ? [{ type: "merge_queue" }] : []),
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: this.strict,
            required_status_checks: [{ context: "gate" }],
          },
        },
      ]]);
    }
    if (endpoint.includes("/branches/")) {
      return JSON.stringify({ protection: null });
    }
    const commit = /\/commits\/([0-9a-f]{40})\//.exec(endpoint)?.[1];
    if (endpoint.includes("/check-runs?")) {
      const conclusion = commit ? this.gate.get(commit) : undefined;
      return JSON.stringify([{
        check_runs: conclusion === undefined ? [] : [{
          name: "gate",
          status: "completed",
          conclusion,
          app: { id: 1, slug: "external-ci" },
        }],
      }]);
    }
    if (endpoint.includes("/status?")) {
      return JSON.stringify([{ statuses: [] }]);
    }
    const mergeSha = /\/git\/commits\/([0-9a-f]{40})$/.exec(endpoint)?.[1];
    if (mergeSha) {
      const pr = [...this.prs.values()].find((p) => p.mergeSha === mergeSha);
      if (!pr) throw new Error(`Unknown merge commit ${mergeSha}`);
      return JSON.stringify({
        parents: [{ sha: this.baseSha }, { sha: pr.headRefOid }],
      });
    }
    const number = /\/pulls\/(\d+)$/.exec(endpoint)?.[1];
    if (number) {
      const pr = this.prs.get(Number(number));
      if (!pr) throw new Error(`Unknown PR ${number}`);
      return JSON.stringify({
        state: pr.state === "OPEN" ? "open" : "closed",
        mergeable: pr.mergeable === "MERGEABLE",
        merge_commit_sha: pr.mergeSha,
        head: { sha: pr.headRefOid },
        base: { ref: BASE, sha: this.baseSha },
      });
    }
    throw new Error(`Unexpected refresh command: ${args.join(" ")}`);
  };

  private view(number: number, live: boolean): string {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no pull request ${number}`);
    if (live) {
      const reads = (this.liveReads.get(number) ?? 0) + 1;
      this.liveReads.set(number, reads);
      const move = this.moveHead;
      if (move && move.prNumber === number && move.atLiveRead === reads) {
        pr.headRefOid = move.to;
      }
    }
    return JSON.stringify({
      state: pr.state,
      number,
      title: "Strict base fixture",
      author: { login: AUTHOR },
      headRefName: `feature-${number}`,
      isCrossRepository: false,
      labels: [],
      statusCheckRollup: [{
        conclusion: this.gate.get(pr.headRefOid)?.toUpperCase() ?? null,
      }],
      isDraft: pr.isDraft,
      baseRefName: BASE,
      headRefOid: pr.headRefOid,
      autoMergeRequest: pr.autoMergeRequest,
      reviewDecision: pr.reviewDecision,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
    });
  }

  private addComment(body: string, prNumber = 10): number {
    const id = this.nextId++;
    const now = new Date().toISOString();
    this.comments.push({
      prNumber,
      id,
      body,
      created_at: now,
      updated_at: now,
      author: AUTHOR,
      user: { login: AUTHOR },
    });
    return id;
  }

  /** Seed an owner record as a crashed or stale worker would have left it. */
  seedOwner(
    prNumber: number,
    headSha: string,
    workerId: string,
    expiresAt: number,
  ): void {
    this.addComment(
      `${OWNER_PREFIX}${encodeURIComponent(REPO)}:${
        encodeURIComponent(BASE)
      }:${prNumber}:${headSha}:${
        encodeURIComponent(workerId)
      }:${expiresAt} -->`,
    );
  }

  ownerPrs(): number[] {
    return this.comments
      .filter((row) => row.body.startsWith(OWNER_PREFIX))
      .map((row) => Number(row.body.split(":")[3]));
  }
}
