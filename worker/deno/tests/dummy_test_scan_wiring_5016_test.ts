/**
 * The fleet reviewer and the pre-PR verifier both apply the dummy-test scan
 * (Issue #5016): a dummy test blocks the change even when the model's reply
 * is clean, and a mock-interaction assertion is a checklist item the reply
 * must judge. Driven through `pass` (gate.ts), `reviewForPost` (post.ts) and
 * `runPrePrVerifier`, over a real git diff.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  pass,
  type SearchPr,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";
import { reviewForPost } from "../../../.claude/skills/review-fleet-prs/scripts/post.ts";
import { loadTrustedCapabilityBundle } from "../lib/capability_security_guidance.ts";
import {
  DUMMY_TEST_CHECKLIST,
  dummyTestNoteItem,
} from "../lib/dummy_test_scan.ts";
import {
  defaultPrePrVerifierDeps,
  prePrVerifierBlocked,
  type PrePrVerifierDeps,
  releaseVerifierBuildArtefacts,
  runPrePrVerifier,
} from "../lib/pre_pr_verifier.ts";
import type { ClaudeRunResult } from "../lib/claude_runner.ts";
import { gitOk } from "./support/git_repo_fixture.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";

const TEMPLATE = await Deno.readTextFile(
  new URL("../../../prompts/pr_review_brief/prompt.md", import.meta.url),
);
const CHECKOUT_PROMPTS = new URL("../../../prompts", import.meta.url).pathname;
const checkoutBundle = () =>
  loadTrustedCapabilityBundle(() => undefined, CHECKOUT_PROMPTS);

const TEST_FILE = "tests/config_test.ts";

const DUMMY = `Deno.test("loads config", async () => {
  await loadConfig("x.json");
});
`;
const BEHAVIOUR = `Deno.test("loads config", async () => {
  assertEquals((await loadConfig("x.json")).repos, ["org/a"]);
});
`;
const INTERACTION = `Deno.test("notifies once", () => {
  const send = spy();
  assertEquals(notify(send), "sent");
  assertSpyCalls(send, 1);
});
`;

/** A clean model reply: no findings, and the given checklist verdicts. */
function reply(checklist: unknown[] = []): string {
  return JSON.stringify({
    summary: "fine",
    findings: [],
    testChanges: "none",
    checklist,
  });
}

function searchPr(): SearchPr {
  return {
    number: 7,
    title: "Load the config",
    body: "",
    url: "https://github.com/acme/app/pull/7",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: { enabledAt: "2026-10-05T00:00:00Z" },
    headRefOid: "head-7",
    baseRefName: "main",
    repository: {
      nameWithOwner: "acme/app",
      defaultBranchRef: { name: "main" },
    },
    author: { login: "VibeCoderST" },
    commits: {
      nodes: [{
        commit: {
          statusCheckRollup: { state: "SUCCESS" },
          checkSuites: { nodes: [] },
        },
      }],
    },
    reviews: { nodes: [] },
  };
}

async function runGate(diff: string) {
  const gh = (args: string[]): Promise<string> => {
    if (args[1] === "graphql") {
      return Promise.resolve(JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [searchPr()],
          },
        },
      }));
    }
    if (args[1]?.endsWith("/files")) {
      return Promise.resolve(JSON.stringify([{
        filename: TEST_FILE,
        status: "added",
        additions: 3,
        deletions: 0,
      }]));
    }
    if (args[1]?.includes("/contents/")) {
      return Promise.reject(new Error("gh: Not Found (HTTP 404)"));
    }
    if (args.some((arg) => arg.includes("application/vnd.github.diff"))) {
      return Promise.resolve(diff);
    }
    if (args[1]?.endsWith("/comments")) return Promise.resolve("[]");
    return Promise.resolve("");
  };
  const dir = await Deno.makeTempDir();
  try {
    const out = await pass(
      new Set(["acme/app"]),
      new Set(["VibeCoderST"]),
      "nleck",
      { gh, dir, loadCapabilityBundle: checkoutBundle },
    );
    assertEquals(out.ready.length, 1);
    return out.ready[0]!;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A repo whose feature branch adds `TEST_FILE` with `text`. */
async function repoAdding(text: string) {
  const repo = await Deno.makeTempDir({ prefix: "dummy-test-scan-" });
  const g = (args: string[]) => gitOk(args, repo);
  await g(["init", "--quiet", "-b", "main"]);
  await g(["config", "user.email", "t@example.com"]);
  await g(["config", "user.name", "T"]);
  await g(["config", "commit.gpgsign", "false"]);
  await Deno.writeTextFile(`${repo}/README.md`, "app\n");
  await g(["add", "-A"]);
  await g(["commit", "--quiet", "-m", "base"]);
  const baseSha = (await g(["rev-parse", "HEAD"])).trim();
  await g(["checkout", "--quiet", "-b", "feature"]);
  await Deno.mkdir(`${repo}/tests`, { recursive: true });
  await Deno.writeTextFile(`${repo}/${TEST_FILE}`, text);
  await g(["add", "-A"]);
  await g(["commit", "--quiet", "-m", "head"]);
  const diff = await g(["diff", `${baseSha}...HEAD`]);
  return { repo, baseSha, diff };
}

async function verify(repo: string, baseSha: string, answer: string) {
  const tmps: string[] = [];
  let prompt = "";
  const deps: PrePrVerifierDeps = {
    ...defaultPrePrVerifierDeps,
    releaseBuildArtefacts: (path) =>
      releaseVerifierBuildArtefacts(path, `${path}/../test-target-root`),
    loadTrustedCapabilityBundle: checkoutBundle,
    loadBrief: () => Promise.resolve({ ok: true, value: TEMPLATE }),
    makeTempDir: async () => {
      const d = await defaultPrePrVerifierDeps.makeTempDir();
      tmps.push(d);
      return d;
    },
    ask: (o) => {
      prompt = o.prompt;
      return Promise.resolve({
        ok: true,
        value: {
          exitCode: 0,
          output: answer,
          timedOut: false,
        } as ClaudeRunResult,
      });
    },
  };
  try {
    const result = await runPrePrVerifier({
      repo: "owner/repo",
      issueNumber: 5016,
      issueTitle: "Load the config",
      issueBody: "Load the config.",
      repoPath: repo,
      baseRef: baseSha,
      summaryPath: "docs/archive/pr-summaries/pr-summary-5016.md",
      summaryContent: "# Summary\n",
      changedFiles: [TEST_FILE],
      timeoutSeconds: 60,
      logger: makeRecordingLogger().logger,
    }, deps);
    return { prompt, result };
  } finally {
    for (const tmp of tmps) {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  }
}

Deno.test("a dummy test blocks in the fleet reviewer and the pre-PR verifier despite a clean reply", async () => {
  const tree = await repoAdding(DUMMY);
  try {
    const entry = await runGate(tree.diff);
    const posted = reviewForPost(reply(), entry);
    const finding = posted.findings.find((f) =>
      f.file === TEST_FILE && f.line === 1
    );
    assert(finding, "post.ts adds the dummy-test finding");
    assertStringIncludes(finding.problem, "asserts nothing");

    const checked = await verify(tree.repo, tree.baseSha, reply());
    assertEquals(checked.result.status, "checked");
    if (checked.result.status !== "checked") return;
    assertEquals(prePrVerifierBlocked(checked.result), true);
    assert(
      checked.result.review.findings.some((f) =>
        f.file === TEST_FILE && f.line === 1 &&
        f.problem.includes("asserts nothing")
      ),
    );
  } finally {
    await Deno.remove(tree.repo, { recursive: true });
  }
});

Deno.test("a behaviour test passes both consumers with a clean reply", async () => {
  const tree = await repoAdding(BEHAVIOUR);
  try {
    const entry = await runGate(tree.diff);
    assertEquals(reviewForPost(reply(), entry).findings, []);
    assertEquals(entry.reviewChecklists.includes(DUMMY_TEST_CHECKLIST), false);

    const checked = await verify(tree.repo, tree.baseSha, reply());
    assertEquals(checked.result.status, "checked");
    if (checked.result.status !== "checked") return;
    assertEquals(prePrVerifierBlocked(checked.result), false);
  } finally {
    await Deno.remove(tree.repo, { recursive: true });
  }
});

Deno.test("a mock-interaction assertion is a checklist item both consumers make the reply judge", async () => {
  const tree = await repoAdding(INTERACTION);
  const item = dummyTestNoteItem({
    file: TEST_FILE,
    line: 4,
    kind: "interaction",
  });
  const met = [{
    checklist: DUMMY_TEST_CHECKLIST,
    item,
    verdict: "met",
    note: "the returned status is asserted; the spy stands in for the mailer",
  }];
  try {
    const entry = await runGate(tree.diff);
    assertStringIncludes(entry.reviewChecklists, item);
    // No verdict for the item: the code sends it back, whatever the reply says.
    assert(reviewForPost(reply(), entry).findings.length > 0);
    assertEquals(reviewForPost(reply(met), entry).findings, []);

    const silent = await verify(tree.repo, tree.baseSha, reply());
    assertStringIncludes(silent.prompt, item);
    assertEquals(silent.result.status, "checked");
    if (silent.result.status !== "checked") return;
    assertEquals(prePrVerifierBlocked(silent.result), true);

    const judged = await verify(tree.repo, tree.baseSha, reply(met));
    assertEquals(judged.result.status, "checked");
    if (judged.result.status !== "checked") return;
    assertEquals(prePrVerifierBlocked(judged.result), false);
  } finally {
    await Deno.remove(tree.repo, { recursive: true });
  }
});
