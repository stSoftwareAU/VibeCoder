/**
 * Dependabot upkeep of the review-fleet-prs skill: update approved behind
 * heads through GitHub, wait on conflicts, arm auto-merge once current.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { updateBranchOnce } from "../../../.claude/skills/review-fleet-prs/scripts/branch_update.ts";
import { dependabotAction } from "../../../.claude/skills/review-fleet-prs/scripts/dependabot.ts";
import {
  pass,
  type SearchPr,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";

const pr = (over: Partial<SearchPr> = {}): SearchPr => ({
  number: 30,
  title: "chore: bump x",
  url: "https://github.com/o/r/pull/30",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  autoMergeRequest: null,
  headRefOid: "head",
  baseRefName: "Develop",
  repository: {
    nameWithOwner: "o/r",
    defaultBranchRef: { name: "Develop" },
    autoMergeAllowed: true,
    squashMergeAllowed: true,
    mergeCommitAllowed: true,
  },
  author: { login: "app/dependabot" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  reviews: { nodes: [] },
  ...over,
});

const approved = {
  nodes: [{
    author: { login: "nleck" },
    state: "APPROVED",
    body: "",
    commit: { oid: "head" },
  }],
};

async function upkeep(prs: SearchPr[], dir: string, refusal?: string) {
  const calls: string[][] = [];
  const result = await pass(new Set(["o/r"]), new Set(), "nleck", {
    dir,
    gh: (args) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "graphql") {
        return Promise.resolve(JSON.stringify({
          data: {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: prs,
            },
          },
        }));
      }
      if (args[3]?.endsWith("/update-branch") && refusal) {
        return Promise.reject(new Error(refusal));
      }
      if (args[1]?.includes("/files")) return Promise.resolve("[]");
      return Promise.resolve("{}");
    },
  });
  return { calls, result };
}

Deno.test("Dependabot upkeep updates an approved behind head once, using its head lease and no comment (Issue #3663)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const behind = pr({
      mergeStateStatus: "BEHIND",
      reviews: approved,
      autoMergeRequest: { enabledAt: "t" },
    });
    // A pre-upgrade rebase cache must neither suppress the update nor be
    // rewritten by the replacement upkeep path.
    const oldCache = '{"o/r#30":"head"}';
    await Deno.writeTextFile(`${dir}/dependabot-rebase.json`, oldCache);
    const first = await upkeep([behind], dir);
    assertEquals(first.result.upkeep, ["o/r#30 branch update requested"]);
    assertEquals(first.calls.filter((c) => c[3]?.endsWith("/update-branch")), [[
      "api",
      "--method",
      "PUT",
      "repos/o/r/pulls/30/update-branch",
      "-f",
      "expected_head_sha=head",
    ]]);
    assertEquals(first.calls.some((c) => c.includes("comment")), false);
    assertEquals(
      await Deno.readTextFile(`${dir}/dependabot-rebase.json`),
      oldCache,
    );
    const second = await upkeep([behind], dir);
    assertEquals(second.result.upkeep, []);
    assertEquals(
      second.calls.some((c) => c[3]?.endsWith("/update-branch")),
      false,
    );
    const next = {
      ...behind,
      headRefOid: "next",
      reviews: { nodes: [{ ...approved.nodes[0]!, commit: { oid: "next" } }] },
    };
    const third = await upkeep([next], dir);
    assertEquals(third.result.upkeep, ["o/r#30 branch update requested"]);
    assertEquals(
      third.calls.some((c) => c.includes("expected_head_sha=next")),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Dependabot upkeep leaves unapproved, stale, other-reviewer, draft and conflicting heads untouched (Issue #3663)", async () => {
  for (
    const [over, expected] of [
      [{}, []],
      [{
        reviews: { nodes: [{ ...approved.nodes[0]!, commit: { oid: "old" } }] },
      }, []],
      [{
        reviews: {
          nodes: [{ ...approved.nodes[0]!, author: { login: "other" } }],
        },
      }, []],
      [{ reviews: approved, isDraft: true }, []],
      [{ reviews: approved, mergeable: "CONFLICTING" }, [
        "o/r#30 conflicting, waiting on Dependabot",
      ]],
    ] as [Partial<SearchPr>, string[]][]
  ) {
    const dir = await Deno.makeTempDir();
    try {
      const { calls, result } = await upkeep([
        pr({ mergeStateStatus: "BEHIND", ...over }),
      ], dir);
      assertEquals(result.upkeep, expected);
      assertEquals(
        calls.some((c) =>
          c.includes("comment") || c.includes("PUT") || c.includes("merge")
        ),
        false,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("Dependabot branch update refusal reports its cause and waits for another head (Issue #3663)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const behind = pr({
      mergeStateStatus: "BEHIND",
      reviews: approved,
      autoMergeRequest: { enabledAt: "t" },
    });
    const first = await upkeep(
      [behind],
      dir,
      "gh api: HTTP 422: expected head sha\nmore",
    );
    assertEquals(first.result.upkeep, [
      "o/r#30 branch update failed: gh api: HTTP 422: expected head sha",
    ]);
    assertEquals(first.calls.some((c) => c.includes("comment")), false);
    const second = await upkeep([behind], dir);
    assertEquals(second.result.upkeep, []);
    assertEquals(second.calls.some((c) => c.includes("PUT")), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function postReview(
  dir: string,
  live: Record<string, unknown> = {},
  refusal = false,
  headSha = "head",
  options: {
    number?: number;
    stateDir?: string;
    barrier?: string;
    restricted?: boolean;
  } = {},
) {
  const number = options.number ?? 30;
  const stateDir = options.stateDir ?? `${dir}/state`;
  await Deno.mkdir(`${dir}/bin`, { recursive: true });
  await Deno.writeTextFile(`${dir}/calls`, "");
  const state = JSON.stringify({
    headRefOid: "head",
    state: "OPEN",
    mergeStateStatus: "BEHIND",
    isDraft: false,
    mergeable: "MERGEABLE",
    ...live,
  });
  await Deno.writeTextFile(
    `${dir}/bin/gh`,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls"
if [ "$1 $2" = "pr view" ]; then
  echo '${state}'
elif [ "$1 $2 $3" = "api --method PUT" ]; then
  touch "${dir}/updating"
  if [ -n "${options.barrier ?? ""}" ]; then
    touch "${options.barrier}/${number}"
    while [ ! -f "${options.barrier}/release-${number}" ]; do sleep 0.02; done
  fi
  if [ "${refusal}" = "true" ]; then
    echo "HTTP 422: expected head sha" >&2
    exit 1
  fi
  echo '{}'
else
  echo '{}'
fi
`,
    { mode: 0o755 },
  );
  await Deno.writeTextFile(
    `${dir}/bin/ps`,
    `#!/bin/sh
touch "${dir}/lock-probe"
echo "$2"
`,
    { mode: 0o755 },
  );
  await Deno.writeTextFile(
    `${dir}/input.json`,
    JSON.stringify({
      pr: {
        repo: "o/r",
        number,
        title: "Bump dependency",
        url: "https://github.com/o/r/pull/30",
        headSha,
        kind: "dependabot",
        testChanges: { removed: [], edited: [] },
        checklistState: { problem: null, expected: [] },
        previousFindings: [],
      },
      review: {
        summary: "Looks right.",
        findings: [],
        testChanges: "none",
      },
    }),
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      ...(options.restricted
        ? [
          "--allow-run=gh,osascript",
          "--allow-read",
          "--allow-write",
          "--allow-env=HOME,XDG_STATE_HOME",
        ]
        : ["--allow-all"]),
      new URL(
        "../../../.claude/skills/review-fleet-prs/scripts/post.ts",
        import.meta.url,
      ).pathname,
      `--input=${dir}/input.json`,
      `--state-dir=${stateDir}`,
      "--no-model",
    ],
    env: { PATH: `${dir}/bin:${Deno.env.get("PATH")}`, HOME: dir },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const result = JSON.parse(new TextDecoder().decode(out.stdout).trim());
  const calls = (await Deno.readTextFile(`${dir}/calls`)).trim().split(
    "\n",
  );
  return { result, calls };
}

Deno.test("post approves a Dependabot PR before the leased update and refuses stale, draft or conflicting updates (Issue #3663)", async () => {
  for (
    const [live, shouldUpdate] of [
      [{}, true],
      [{ headRefOid: "new-head" }, false],
      [{ isDraft: true }, false],
      [{ mergeable: "CONFLICTING" }, false],
    ] as [Record<string, unknown>, boolean][]
  ) {
    const dir = await Deno.makeTempDir({ prefix: "post-3663-" });
    try {
      const { result, calls } = await postReview(dir, live);
      const update = calls.findIndex((c) => c.includes("/update-branch"));
      assertEquals(update >= 0, shouldUpdate);
      assertEquals(result.branchUpdated === true, shouldUpdate);
      assertEquals(calls.some((c) => c.includes("@dependabot")), false);
      if (shouldUpdate) {
        assertStringIncludes(calls[update]!, "expected_head_sha=head");
        const approval = calls.findIndex((c) => c.includes("--approve"));
        assert(approval >= 0 && approval < update);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("post and gate share successful and refused branch-update memory across heads (Issue #3663)", async () => {
  for (const firstPath of ["post", "gate"]) {
    for (const refusal of [false, true]) {
      const dir = await Deno.makeTempDir({ prefix: "post-memory-3663-" });
      try {
        const stateDir = `${dir}/state`;
        await Deno.mkdir(stateDir);
        await Deno.writeTextFile(
          `${stateDir}/branch-update.json`,
          JSON.stringify({ "other/repo#1": "other-head" }),
        );
        await Deno.writeTextFile(
          `${stateDir}/dependabot-failed.json`,
          JSON.stringify({
            "o/r#30 auto-merge": "head",
            "other/repo#2 branch-update": "other-head",
          }),
        );
        const behind = pr({
          mergeStateStatus: "BEHIND",
          reviews: approved,
          autoMergeRequest: { enabledAt: "t" },
        });
        if (firstPath === "post") {
          const first = await postReview(dir, {}, refusal);
          assertEquals(
            first.calls.filter((c) => c.includes("/update-branch")).length,
            1,
          );
          assertEquals(first.result.branchUpdated === true, !refusal);
          if (refusal) {
            assertStringIncludes(
              first.result.branchUpdateError,
              "HTTP 422: expected head sha",
            );
          }
        } else {
          const first = await upkeep(
            [behind],
            stateDir,
            refusal ? "HTTP 422: expected head sha" : undefined,
          );
          assertEquals(first.calls.filter((c) => c.includes("PUT")).length, 1);
        }
        const repeatPost = await postReview(dir, {}, refusal);
        assertEquals(
          repeatPost.calls.some((c) => c.includes("/update-branch")),
          false,
        );
        assertEquals(repeatPost.result.branchUpdated, undefined);
        const repeatGate = await upkeep([behind], stateDir);
        assertEquals(repeatGate.calls.some((c) => c.includes("PUT")), false);
        assertEquals(repeatGate.result.upkeep, []);
        assertEquals(
          JSON.parse(await Deno.readTextFile(`${stateDir}/branch-update.json`)),
          {
            "other/repo#1": "other-head",
            ...(!refusal ? { "o/r#30": "head" } : {}),
          },
        );
        assertEquals(
          JSON.parse(
            await Deno.readTextFile(`${stateDir}/dependabot-failed.json`),
          ),
          {
            "o/r#30 auto-merge": "head",
            "other/repo#2 branch-update": "other-head",
            ...(refusal ? { "o/r#30 branch-update": "head" } : {}),
          },
        );
        const next = await postReview(
          dir,
          { headRefOid: "next" },
          false,
          "next",
        );
        assertEquals(next.result.branchUpdated, true);
        assertEquals(
          next.calls.filter((c) => c.includes("/update-branch")).length,
          1,
        );
        assert(next.calls.some((c) => c.includes("expected_head_sha=next")));
        const nextGate = await upkeep([{
          ...behind,
          headRefOid: "next",
          reviews: {
            nodes: [{ ...approved.nodes[0]!, commit: { oid: "next" } }],
          },
        }], stateDir);
        assertEquals(nextGate.calls.some((c) => c.includes("PUT")), false);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    }
  }
});

async function waitForFile(path: string | string[]) {
  const paths = typeof path === "string" ? [path] : path;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const candidate of paths) {
      try {
        await Deno.stat(candidate);
        return;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for subprocess barrier ${paths.join(", ")}`,
  );
}

Deno.test("overlapping post processes preserve both PRs in shared upkeep memory (Issue #3663)", async () => {
  for (const refusal of [false, true]) {
    const dir = await Deno.makeTempDir({ prefix: "overlap-post-3663-" });
    const stateDir = `${dir}/state`;
    const barrier = `${dir}/barrier`;
    await Deno.mkdir(barrier);
    const first = postReview(`${dir}/first`, {}, refusal, "head", {
      number: 30,
      stateDir,
      barrier,
    });
    const second = postReview(`${dir}/second`, {}, refusal, "head", {
      number: 31,
      stateDir,
      barrier,
    });
    try {
      // Both real post processes have read the shared cache and reached the
      // API before either finishes. The second writer must merge the first.
      await Promise.all([
        waitForFile(`${barrier}/30`),
        waitForFile(`${barrier}/31`),
      ]);
      await Deno.writeTextFile(`${barrier}/release-30`, "");
      const firstResult = await first;
      await Deno.writeTextFile(`${barrier}/release-31`, "");
      const secondResult = await second;
      for (const posted of [firstResult, secondResult]) {
        assertEquals(
          posted.calls.filter((c) => c.includes("/update-branch")).length,
          1,
        );
        assertEquals(posted.result.branchUpdated === true, !refusal);
      }
      const file = refusal ? "dependabot-failed.json" : "branch-update.json";
      const suffix = refusal ? " branch-update" : "";
      assertEquals(JSON.parse(await Deno.readTextFile(`${stateDir}/${file}`)), {
        [`o/r#30${suffix}`]: "head",
        [`o/r#31${suffix}`]: "head",
      });
      const next = await upkeep(
        [30, 31].map((number) =>
          pr({
            number,
            mergeStateStatus: "BEHIND",
            reviews: approved,
            autoMergeRequest: { enabledAt: "t" },
          })
        ),
        stateDir,
      );
      assertEquals(next.calls.some((c) => c.includes("PUT")), false);
    } finally {
      await Deno.writeTextFile(`${barrier}/release-30`, "");
      await Deno.writeTextFile(`${barrier}/release-31`, "");
      await Promise.allSettled([first, second]);
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("overlapping posts request a shared PR head only once (Issue #3663)", async () => {
  for (const refusal of [false, true]) {
    const dir = await Deno.makeTempDir({ prefix: "same-head-post-3663-" });
    const stateDir = `${dir}/state`;
    const barrier = `${dir}/barrier`;
    await Deno.mkdir(barrier);
    const first = postReview(`${dir}/first`, {}, refusal, "head", {
      stateDir,
      barrier,
    });
    const posts = [first];
    try {
      await waitForFile(`${barrier}/30`);
      const second = postReview(`${dir}/second`, {}, refusal, "head", {
        stateDir,
        barrier,
      });
      posts.push(second);
      // The second process has either contended on the real PR lock (whose
      // liveness probe uses ps), or wrongly reached the update endpoint.
      await waitForFile([`${dir}/second/lock-probe`, `${dir}/second/updating`]);
      await Deno.writeTextFile(`${barrier}/release-30`, "");
      await first;
      const result = await second;
      assertEquals(
        result.calls.some((c) => c.includes("/update-branch")),
        false,
      );
      assertEquals(result.result.branchUpdated, undefined);
      assertEquals(result.result.branchUpdateError, undefined);
    } finally {
      await Deno.writeTextFile(`${barrier}/release-30`, "");
      await Promise.allSettled(posts);
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("upkeep memory surfaces an atomic replacement failure (Issue #3663)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/branch-update.json`);
    await assertRejects(
      () =>
        updateBranchOnce(
          { repo: "o/r", number: 30, headSha: "head" },
          dir,
          () => Promise.resolve("{}"),
        ),
      Error,
      "atomicWrite",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a persistence lock timeout after the API request stays a loud write failure (Issue #3663)", async () => {
  const dir = await Deno.makeTempDir();
  let calls = 0;
  try {
    await Deno.writeTextFile(
      `${dir}/branch-update.json.lock`,
      JSON.stringify({
        token: "another-writer",
        pid: Deno.pid,
        acquiredAt: new Date().toISOString(),
      }),
    );
    await assertRejects(
      () =>
        updateBranchOnce(
          { repo: "o/r", number: 30, headSha: "head" },
          dir,
          () => {
            calls++;
            return Promise.resolve("{}");
          },
        ),
      Error,
      "could not take the lock",
    );
    assertEquals(calls, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gate rechecks a post update written after its initial cache read (Issue #3663)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gate-post-overlap-3663-" });
  const calls: string[][] = [];
  try {
    const result = await pass(new Set(["o/r"]), new Set(), "nleck", {
      dir: `${dir}/state`,
      gh: async (args) => {
        calls.push(args);
        if (args[0] === "api" && args[1] === "graphql") {
          await postReview(dir);
          return JSON.stringify({
            data: {
              search: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  pr({
                    mergeStateStatus: "BEHIND",
                    reviews: approved,
                    autoMergeRequest: { enabledAt: "t" },
                  }),
                ],
              },
            },
          });
        }
        return "{}";
      },
    });
    assertEquals(calls.some((c) => c.includes("PUT")), false);
    assertEquals(result.upkeep, []);
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${dir}/state/branch-update.json`)),
      { "o/r#30": "head" },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("post persists upkeep memory with the documented granular permissions (Issue #3663)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "post-permissions-3663-" });
  try {
    const posted = await postReview(dir, {}, false, "head", {
      restricted: true,
    });
    assertEquals(posted.result.branchUpdated, true);
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${dir}/state/branch-update.json`)),
      { "o/r#30": "head" },
    );
    const repeated = await postReview(dir, {}, false, "head", {
      restricted: true,
    });
    assertEquals(
      repeated.calls.some((c) => c.includes("/update-branch")),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a contended PR lock reports its cause without caching an unsent update or stopping other PRs (Issue #3663)", async () => {
  const dir = await Deno.makeTempDir();
  const lock = `${dir}/branch-update-${encodeURIComponent("o/r#30")}.lock`;
  try {
    await Deno.writeTextFile(
      lock,
      JSON.stringify({
        token: "held-by-another-process",
        pid: Deno.pid,
        acquiredAt: new Date().toISOString(),
      }),
    );
    const behind = pr({
      mergeStateStatus: "BEHIND",
      reviews: approved,
      autoMergeRequest: { enabledAt: "t" },
    });
    const result = await upkeep([behind, { ...behind, number: 31 }], dir);
    assertEquals(
      result.calls.filter((c) => c.includes("PUT")).map((c) => c[3]),
      ["repos/o/r/pulls/31/update-branch"],
    );
    assertStringIncludes(
      result.result.upkeep[0]!,
      "o/r#30 branch update failed: could not take the lock",
    );
    assertStringIncludes(result.result.upkeep[0]!, "held by");
    assertEquals(result.result.upkeep[1], "o/r#31 branch update requested");
    await Deno.remove(lock);
    const retry = await upkeep([behind], dir);
    assertEquals(
      retry.calls.filter((c) => c.includes("PUT")).map((c) => c[3]),
      ["repos/o/r/pulls/30/update-branch"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a Dependabot PR behind or conflicting waits without a bot command", () => {
  assertEquals(
    dependabotAction(
      pr({ mergeStateStatus: "BEHIND", reviews: approved }),
      "nleck",
    ).kind,
    "none",
  );
  assertEquals(
    dependabotAction(pr({ mergeStateStatus: "BEHIND" }), "nleck")
      .kind,
    "none",
  );
  assertEquals(
    dependabotAction(pr({ mergeable: "CONFLICTING" }), "nleck").kind,
    "none",
  );
  assertEquals(
    dependabotAction(pr({ mergeStateStatus: "BEHIND" }), "nleck").kind,
    "none",
  );
});

Deno.test("an approved, up-to-date Dependabot PR gets auto-merge armed with the repo's allowed method", () => {
  assertEquals(
    dependabotAction(pr({ reviews: approved }), "nleck"),
    { kind: "auto-merge", method: "squash" },
  );
  assertEquals(
    dependabotAction(
      pr({
        reviews: approved,
        repository: { ...pr().repository, squashMergeAllowed: false },
      }),
      "nleck",
    ),
    { kind: "auto-merge", method: "merge" },
    "uses merge when the repository disables squash",
  );
});

Deno.test("no auto-merge without the reviewer's approval at the head, when already armed, or when the repo forbids it", () => {
  assertEquals(dependabotAction(pr(), "nleck").kind, "none");
  const stale = {
    nodes: [{ ...approved.nodes[0]!, commit: { oid: "older" } }],
  };
  assertEquals(
    dependabotAction(pr({ reviews: stale }), "nleck").kind,
    "none",
  );
  assertEquals(
    dependabotAction(
      pr({ reviews: approved, autoMergeRequest: { enabledAt: "t" } }),
      "nleck",
    ),
    { kind: "none", reason: "auto-merge armed" },
  );
  assertEquals(
    dependabotAction(
      pr({
        reviews: approved,
        repository: { ...pr().repository, autoMergeAllowed: false },
      }),
      "nleck",
    ),
    { kind: "none", reason: "repo does not allow auto-merge" },
  );
  assertEquals(
    dependabotAction(
      pr({ isDraft: true, mergeStateStatus: "BEHIND" }),
      "nleck",
    ),
    { kind: "none", reason: "draft" },
  );
});
