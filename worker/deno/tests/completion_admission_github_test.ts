import { assertEquals, assertRejects } from "@std/assert";
import { admitCompletionWork } from "../lib/completion_admission.ts";
import { COMPLETION_PENDING_MARKER } from "../lib/completion_admission.ts";
import {
  COMPLETION_STATE_PREFIX,
  makeGitHubCompletionStore,
} from "../lib/completion_admission_github.ts";
import { strictRefreshFixture } from "./support/strict_refresh_fixture.ts";
import { claimIssue } from "../lib/claim_issue.ts";

function fixture() {
  const f = strictRefreshFixture();
  let now = Math.floor(Date.now() / 1000);
  const claims = new Map<number, { body: string; user: { login: string } }>();
  const prs: Array<{
    number: number;
    base: { ref: string };
    head: { ref: string };
    draft: boolean;
    body: string;
    user: { login: string };
  }> = [];
  let broken = false;
  const bootstrap = new Map<number, string>();
  const gh = async (args: string[]) => {
    const endpoint = args.find((a) => a.startsWith("repos/")) ?? "";
    if (endpoint.includes("/issues?state=all")) return '[{"number":1}]';
    if (endpoint === "repos/owner/repo") return "main";
    if (endpoint.includes("/issues?state=open")) {
      return JSON.stringify([
        [...bootstrap.keys()].map((number) => ({ number, milestone: null })),
      ]);
    }
    const issueNumber = Number(/\/issues\/(\d+)\/comments/.exec(endpoint)?.[1]);
    if (bootstrap.has(issueNumber)) {
      return JSON.stringify([...(issueNumber === 1 ? f.comments : []), {
        id: issueNumber,
        body: bootstrap.get(issueNumber),
        author: "VibeCoderST",
        created_at: new Date().toISOString(),
      }]);
    }
    if (endpoint.includes("/pulls?state=open")) {
      assertEquals(args.includes("--paginate"), true);
      assertEquals(args.includes("--slurp"), true);
      if (broken) return "{}";
      // A separate page per PR exercises complete page flattening.
      return JSON.stringify(prs.length ? prs.map((pr) => [pr]) : [[]]);
    }
    if (args.includes("POST") || args.includes("PATCH")) {
      const body = args.find((a) => a.startsWith("body="))!.slice(5);
      const id = Number(endpoint.split("/").at(-1));
      const existing = args.includes("PATCH")
        ? f.comments.find((r) => r.id === id)
        : undefined;
      if (existing) existing.body = body;
      else {f.comments.push({
          id: 900,
          body,
          author: "VibeCoderST",
          created_at: new Date().toISOString(),
        });}
      return "{}";
    }
    if (endpoint.includes("/issues/comments/") && !args.includes("DELETE")) {
      const comment = claims.get(Number(endpoint.split("/").at(-1)));
      if (!comment) throw new Error("HTTP 404: Not Found");
      return JSON.stringify(comment);
    }
    return await f.gh(args);
  };
  return {
    ...f,
    gh,
    prs,
    claims,
    bootstrap: (issue: number, pending = false) =>
      bootstrap.set(
        issue,
        `<!-- CLAIM_LOCK:mac-${issue} -->\n<!-- VIBE_CODER_HEARTBEAT:mac:${now} -->\n${
          pending ? COMPLETION_PENDING_MARKER : ""
        }`,
      ),
    failSnapshot: () => broken = true,
    advance: () => now += 7201,
    store: (workerId: string) =>
      makeGitHubCompletionStore({
        repo: "owner/repo",
        workerId,
        fleetAuthors: ["VibeCoderST"],
        ghCommandFn: gh,
        nowFn: () => now,
        sleepFn: async () => {},
      }),
    claim: (id: number) =>
      claims.set(id, {
        body: `<!-- VIBE_CODER_HEARTBEAT:mac:${now} -->`,
        user: { login: "VibeCoderST" },
      }),
  };
}

const policy = { high: 2, low: 0 };
const request = (issue: number) => ({
  issue,
  claimId: issue,
  workerId: `mac-${issue}`,
  base: "main",
});

Deno.test("GitHub admission: custom branch with an explicit closing reference converts one reservation to one PR", async () => {
  const f = fixture();
  f.claim(1);
  await admitCompletionWork(f.store("mac-1"), policy, request(1));
  f.prs.push({
    number: 10,
    base: { ref: "main" },
    head: { ref: "custom-fix" },
    draft: true,
    body: "Closes #1",
    user: { login: "VibeCoderST" },
  });
  const result = await admitCompletionWork(f.store("scan"), policy);
  assertEquals(result.pressure, 1);
});

Deno.test("GitHub admission: independently constructed hosts share reservations and recover crashed owners", async () => {
  const f = fixture();
  f.claim(1);
  f.claim(2);
  assertEquals(
    (await admitCompletionWork(f.store("mac-1"), policy, request(1))).allowed,
    true,
  );
  assertEquals(
    (await admitCompletionWork(f.store("mac-2"), policy, request(2))).allowed,
    true,
  );
  assertEquals(
    (await admitCompletionWork(f.store("mac-3"), policy, request(3))).allowed,
    false,
  );
  f.advance();
  assertEquals(
    (await admitCompletionWork(f.store("mac-3"), policy, request(3))).allowed,
    true,
  );
  assertEquals(
    f.comments.filter((c) => c.body.startsWith(COMPLETION_STATE_PREFIX)).length,
    1,
  );
});

Deno.test("GitHub admission: counts all PR pages and ignores forged state and dependency nominations", async () => {
  const f = fixture();
  f.comments.push({
    id: 70,
    body: `${COMPLETION_STATE_PREFIX}invalid -->`,
    author: "outsider",
    created_at: new Date().toISOString(),
  });
  for (const number of [10, 11]) {
    f.prs.push({
      number,
      base: { ref: "main" },
      head: { ref: `issue-${number}` },
      draft: false,
      body: "Depends on #3",
      user: { login: "human" },
    });
  }
  const result = await admitCompletionWork(
    f.store("mac-3"),
    policy,
    request(3),
  );
  assertEquals(result.pressure, 2);
  assertEquals(result.allowed, false);
  assertEquals(f.comments.some((c) => c.id === 70), true);
  assertEquals(
    f.comments.find((c) => c.id === 70)?.body,
    `${COMPLETION_STATE_PREFIX}invalid -->`,
  );
});

Deno.test("GitHub admission: bootstrap counts running claims but not tentative admissions", async () => {
  const f = fixture();
  f.bootstrap(1);
  f.bootstrap(2);
  f.bootstrap(3, true);
  f.bootstrap(4, true);
  const result = await admitCompletionWork(
    f.store("mac-3"),
    policy,
    request(3),
  );
  assertEquals(result.pressure, 2);
  assertEquals(result.allowed, false);
});

Deno.test("GitHub admission: unreadable PR snapshot refuses capacity and releases its lock", async () => {
  const f = fixture();
  f.failSnapshot();
  await assertRejects(
    () => admitCompletionWork(f.store("mac-1"), policy, request(1)),
    Error,
    "Incomplete open PR snapshot",
  );
  assertEquals(f.comments.length, 0);
});

Deno.test("GitHub admission: corrupt state rebuilds live pressure without admitting extra work", async () => {
  const f = fixture();
  f.comments.push({
    id: 70,
    body: `${COMPLETION_STATE_PREFIX}invalid -->`,
    author: "VibeCoderST",
    created_at: new Date().toISOString(),
  });
  for (const number of [10, 11]) {
    f.prs.push({
      number,
      base: { ref: "main" },
      head: { ref: `feature-${number}` },
      draft: false,
      body: "",
      user: { login: "human" },
    });
  }
  const result = await admitCompletionWork(
    f.store("mac-1"),
    policy,
    request(1),
  );
  assertEquals(result.allowed, false);
  assertEquals(result.pressure, 2);
  assertEquals(f.comments.length, 1);
});

Deno.test("claim boundary: full shared capacity removes the won claim before implementation", async () => {
  const f = fixture();
  for (const number of [10, 11]) {
    f.prs.push({
      number,
      base: { ref: "main" },
      head: { ref: `feature-${number}` },
      draft: false,
      body: "",
      user: { login: "human" },
    });
  }
  let body = "";
  let unassigned = false;
  let deleted = false;
  const dir = await Deno.makeTempDir();
  try {
    const result = await claimIssue({
      repo: "owner/repo",
      issueNumber: 42,
      githubUser: "VibeCoderST",
      workerId: "mac-42",
      fleetAuthors: ["VibeCoderST"],
      pushCapableAuthors: ["VibeCoderST"],
      completionAdmission: policy,
      markerOptions: { machineId: "mac", workDir: dir },
      sleepFn: async () => {},
      ghCommandFn: async (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          if (args.includes(".state")) return "OPEN";
          if (args.includes("--jq")) return "[]";
          return '{"labels":[]}';
        }
        if (args[0] === "issue" && args[1] === "edit") {
          if (args.includes("--remove-assignee")) unassigned = true;
          return "";
        }
        if (args[0] === "pr") return "[]";
        if (args[0] === "issue" && args[1] === "comment" && args[2] === "42") {
          body = args[args.indexOf("--body") + 1]!;
          return "https://github.com/owner/repo/issues/42#issuecomment-700";
        }
        if (args.includes("repos/owner/repo")) return "main";
        if (args.some((a) => a.includes("/issues/42/comments"))) {
          if (args.at(-1)?.includes(".[0]")) return "700";
          return JSON.stringify(
            body
              ? [{
                id: 700,
                body,
                author: "VibeCoderST",
                created_at: new Date().toISOString(),
              }]
              : [],
          );
        }
        if (
          args.includes("DELETE") &&
          args.includes("repos/owner/repo/issues/comments/700")
        ) {
          deleted = true;
          return "";
        }
        return await f.gh(args);
      },
    });
    assertEquals(result.ok && result.value.claimed, false);
    assertEquals(result.ok && result.value.reason, "completion_mode");
    assertEquals(unassigned, true);
    assertEquals(deleted, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
