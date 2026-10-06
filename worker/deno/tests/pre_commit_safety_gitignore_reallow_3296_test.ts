/**
 * Tests for the repo-`.gitignore` re-allow exemption (Issue #3296, hardened
 * against #3309).
 *
 * `ALLOWED_HIDDEN_PATHS` is the worker's one canonical allowlist, but a
 * target repo's own `.gitignore` may legitimately re-allow a hidden path
 * (this repo's `.gitignore` re-allows `.claude/skills` and `.claude/agents`,
 * for instance). `gitignoreReallowed` and the wiring in `assertSafeToCommit`
 * accept such a path only when the repo's own tracked, unmodified
 * `.gitignore` re-allows it: `git check-ignore -v -n --no-index`, walked
 * over the path and its ancestor directories, must find an explicit
 * `!`-negation rule whose deciding source is that root `.gitignore` itself —
 * never a nested or untracked one, never a plain non-negation match, and
 * never a path matching `FORBIDDEN_STAGED_PATTERNS`. Exit 1 from a bare
 * `check-ignore -q` is not sufficient on its own: it means only "no rule
 * matches", which also holds for a repo whose `.gitignore` never governs the
 * path at all (Issue #3309).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  assertSafeToCommit,
  gitignoreReallowed,
} from "../lib/pre_commit_safety.ts";
import type { GitCommandOutput } from "../lib/git_timeout.ts";
import type { Result } from "../types.ts";

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Run git in a fixture and fail the test loudly on a non-zero exit. */
async function mustGit(args: string[], cwd: string): Promise<string> {
  const out = await runGit(args, cwd);
  if (out.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`);
  }
  return out.stdout;
}

async function makeRepo(prefix: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "commit.gpgsign", "false"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "test"], dir);
  return dir;
}

async function stageFile(
  dir: string,
  relativePath: string,
  content = "x\n",
): Promise<void> {
  const fullPath = `${dir}/${relativePath}`;
  const lastSlash = fullPath.lastIndexOf("/");
  if (lastSlash > -1) {
    await Deno.mkdir(fullPath.slice(0, lastSlash), { recursive: true });
  }
  await Deno.writeTextFile(fullPath, content);
  // Use -f so .gitignore (if present) does not block the test from
  // staging — the safety gate is the layer being tested, not gitignore.
  await runGit(["add", "-f", "--", relativePath], dir);
}

const REALLOWING_GITIGNORE = [
  ".*",
  "!.gitignore",
  "!.claude",
  ".claude/*",
  "!.claude/skills",
  "",
].join("\n");

const NON_REALLOWING_GITIGNORE = [
  ".*",
  "!.gitignore",
  "",
].join("\n");

const SKILL_PATH = ".claude/skills/x/SKILL.md";

/**
 * A repo with `SKILL_PATH` already committed, plus a `.gitignore` committed
 * with the given contents. Both committed in one go so the `.gitignore` is
 * tracked at `HEAD` and unmodified for the edit that follows.
 */
async function makeSkillRepo(
  prefix: string,
  gitignore: string | null,
): Promise<string> {
  const dir = await makeRepo(prefix);
  await stageFile(dir, SKILL_PATH, "# skill\n");
  if (gitignore !== null) {
    await stageFile(dir, ".gitignore", gitignore);
  }
  await mustGit(["commit", "-q", "-m", "base"], dir);
  return dir;
}

// --- Case 1: edited SKILL.md, re-allowing .gitignore committed — Ok -------

Deno.test("assertSafeToCommit - an edited committed SKILL.md passes when the repo's own .gitignore re-allows .claude/skills (Issue #3296)", async () => {
  const dir = await makeSkillRepo(
    "pre_commit_3296_reallow_ok_",
    REALLOWING_GITIGNORE,
  );
  try {
    await stageFile(dir, SKILL_PATH, "# skill\nedited\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Case 2: same path, no re-allow in .gitignore — Err --------------------

Deno.test("assertSafeToCommit - an edited committed SKILL.md is refused when the repo's .gitignore does not re-allow .claude/skills (Issue #3296)", async () => {
  const dir = await makeSkillRepo(
    "pre_commit_3296_no_reallow_",
    NON_REALLOWING_GITIGNORE,
  );
  try {
    await stageFile(dir, SKILL_PATH, "# skill\nedited\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(!result.ok, "no re-allow in .gitignore means no exemption");
    if (!result.ok) {
      assert(
        result.error.message.includes(SKILL_PATH),
        `expected ${SKILL_PATH} named in error, got: ${result.error.message}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Case 3: .claude/settings.local.json still refused ---------------------

Deno.test("assertSafeToCommit - .claude/settings.local.json stays refused even though .claude/skills is re-allowed (Issue #3296)", async () => {
  const dir = await makeSkillRepo(
    "pre_commit_3296_settings_",
    REALLOWING_GITIGNORE,
  );
  try {
    await stageFile(dir, ".claude/settings.local.json", '{"x":1}\n');
    const result = await assertSafeToCommit({ cwd: dir });
    assert(
      !result.ok,
      ".claude/settings.local.json is still .claude/* — ignored",
    );
    if (!result.ok) {
      assert(
        result.error.message.includes(".claude/settings.local.json"),
        `expected the path named, got: ${result.error.message}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertSafeToCommit - meanwhile a SKILL.md edit alone in the same repo is Ok (Issue #3296)", async () => {
  const dir = await makeSkillRepo(
    "pre_commit_3296_settings_ok_",
    REALLOWING_GITIGNORE,
  );
  try {
    await stageFile(dir, SKILL_PATH, "# skill\nedited again\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Case 4: FORBIDDEN_STAGED_PATTERNS always win, even if re-allowed -----

Deno.test("assertSafeToCommit - .env, .config.local.json and key.pem stay refused even when the repo's .gitignore re-allows them (Issue #3296)", async () => {
  const gitignore = [
    ".*",
    "!.gitignore",
    "!.env",
    "!.config.local.json",
    "!*.pem",
    "",
  ].join("\n");
  const dir = await makeSkillRepo("pre_commit_3296_forbidden_", gitignore);
  try {
    await stageFile(dir, ".env", "SECRET=1\n");
    await stageFile(dir, ".config.local.json", "{}\n");
    await stageFile(dir, "key.pem", "-----BEGIN RSA PRIVATE KEY-----\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(!result.ok, "secret patterns are never exempt via .gitignore");
    if (!result.ok) {
      const msg = result.error.message;
      assert(msg.includes(".env"), `expected .env named, got: ${msg}`);
      assert(
        msg.includes(".config.local.json"),
        `expected .config.local.json named, got: ${msg}`,
      );
      assert(msg.includes("key.pem"), `expected key.pem named, got: ${msg}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Case 5: .gitignore not provably tracked+unmodified — Err --------------

Deno.test("assertSafeToCommit - an untracked .gitignore exempts nothing (Issue #3296)", async () => {
  const dir = await makeSkillRepo("pre_commit_3296_gi_untracked_", null);
  try {
    // .gitignore present in the working tree but never committed.
    await Deno.writeTextFile(`${dir}/.gitignore`, REALLOWING_GITIGNORE);
    await stageFile(dir, SKILL_PATH, "# skill\nedited\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(!result.ok, "an untracked .gitignore cannot vouch for anything");
    if (!result.ok) {
      assert(result.error.message.includes(SKILL_PATH));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertSafeToCommit - a working-tree-modified .gitignore exempts nothing (Issue #3296)", async () => {
  const dir = await makeSkillRepo(
    "pre_commit_3296_gi_wt_modified_",
    REALLOWING_GITIGNORE,
  );
  try {
    // Modified in the working tree only (not staged).
    await Deno.writeTextFile(
      `${dir}/.gitignore`,
      REALLOWING_GITIGNORE + "\n!x\n",
    );
    await stageFile(dir, SKILL_PATH, "# skill\nedited\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(!result.ok, "a working-tree-modified .gitignore cannot vouch");
    if (!result.ok) {
      assert(result.error.message.includes(SKILL_PATH));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertSafeToCommit - a staged-modified .gitignore exempts nothing (Issue #3296)", async () => {
  const dir = await makeSkillRepo(
    "pre_commit_3296_gi_staged_modified_",
    REALLOWING_GITIGNORE,
  );
  try {
    await stageFile(dir, ".gitignore", REALLOWING_GITIGNORE + "\n!y\n");
    await stageFile(dir, SKILL_PATH, "# skill\nedited\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(!result.ok, "a staged-modified .gitignore cannot vouch");
    if (!result.ok) {
      assert(result.error.message.includes(SKILL_PATH));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Case 6: no .gitignore at all — Err -------------------------------------

Deno.test("assertSafeToCommit - no .gitignore at all exempts nothing (Issue #3296)", async () => {
  const dir = await makeSkillRepo("pre_commit_3296_gi_missing_", null);
  try {
    await stageFile(dir, SKILL_PATH, "# skill\nedited\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(!result.ok, "no .gitignore means no exemption");
    if (!result.ok) {
      assert(result.error.message.includes(SKILL_PATH));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Case 7: check-ignore cannot run — fail closed --------------------------

Deno.test("gitignoreReallowed - empty candidates short-circuits without running git", async () => {
  const exempt = await gitignoreReallowed({
    violations: [],
    options: { cwd: "/does/not/matter" },
  });
  assertEquals(exempt.size, 0);
});

Deno.test("gitignoreReallowed - a non-repo cwd (check-ignore cannot run) exempts nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pre_commit_3296_not_a_repo_" });
  try {
    const exempt = await gitignoreReallowed({
      violations: [SKILL_PATH],
      options: { cwd: dir },
    });
    assertEquals(exempt.size, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitignoreReallowed - exempts a path check-ignore reports as not ignored (exit 1)", async () => {
  const dir = await makeSkillRepo(
    "pre_commit_3296_helper_exempt_",
    REALLOWING_GITIGNORE,
  );
  try {
    const exempt = await gitignoreReallowed({
      violations: [SKILL_PATH],
      options: { cwd: dir },
    });
    assertEquals(exempt.has(SKILL_PATH), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitignoreReallowed - does not exempt a path check-ignore reports as ignored (exit 0)", async () => {
  const dir = await makeSkillRepo(
    "pre_commit_3296_helper_not_exempt_",
    REALLOWING_GITIGNORE,
  );
  try {
    const exempt = await gitignoreReallowed({
      violations: [".claude/settings.local.json"],
      options: { cwd: dir },
    });
    assertEquals(exempt.has(".claude/settings.local.json"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitignoreReallowed - never exempts a FORBIDDEN_STAGED_PATTERNS path", async () => {
  const gitignore = [".*", "!.gitignore", "!.env", ""].join("\n");
  const dir = await makeSkillRepo(
    "pre_commit_3296_helper_forbidden_",
    gitignore,
  );
  try {
    const exempt = await gitignoreReallowed({
      violations: [".env"],
      options: { cwd: dir },
    });
    assertEquals(exempt.has(".env"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Case 8: injected-runner seam probes the ancestor-walk governance ------
// (Issue #3309 — exit 1 from a single `check-ignore -q` no longer decides
// the exemption; the walk and the deciding rule's source/sign do.)

function okOutput(code: number, stdout = ""): Result<GitCommandOutput> {
  return { ok: true, value: { code, stdout, stderr: "" } };
}

/**
 * Build a `check-ignore -v -n` stub. `decisions` maps a probe path to its
 * `<source>:<line>:<pattern>` decision string; a probe not listed gets the
 * default "no rule decides this segment" (`::`, exit 1) every ancestor-walk
 * step takes until something decides it.
 */
function checkIgnoreStub(
  decisions: Record<string, string>,
): (args: string[]) => Promise<Result<GitCommandOutput>> {
  return (args: string[]) => {
    const sub = args[0];
    if (sub === "cat-file" || sub === "diff") {
      return Promise.resolve(okOutput(0));
    }
    if (sub === "check-ignore") {
      const probe = args[args.length - 1] ?? "";
      const decision = decisions[probe];
      if (decision === undefined) return Promise.resolve(okOutput(1));
      return Promise.resolve(okOutput(0, `${decision}\t${probe}\n`));
    }
    throw new Error(`unexpected git subcommand: ${sub}`);
  };
}

Deno.test("gitignoreReallowed - a check-ignore call that cannot run at all exempts nothing", async () => {
  let checkIgnoreCalled = false;
  const run = (args: string[]) => {
    const sub = args[0];
    if (sub === "cat-file" || sub === "diff") {
      return Promise.resolve(okOutput(0));
    }
    if (sub === "check-ignore") {
      checkIgnoreCalled = true;
      return Promise.resolve(
        { ok: false, error: new Error("spawn failed") } as Result<
          GitCommandOutput
        >,
      );
    }
    throw new Error(`unexpected git subcommand: ${sub}`);
  };
  const exempt = await gitignoreReallowed({
    violations: [SKILL_PATH],
    options: { cwd: "/does/not/matter" },
    run,
  });
  assert(checkIgnoreCalled, "expected check-ignore to have been attempted");
  assertEquals(exempt.size, 0);
});

Deno.test("gitignoreReallowed - a check-ignore exit code other than 0 or 1 exempts nothing", async () => {
  const run = (args: string[]) => {
    const sub = args[0];
    if (sub === "cat-file" || sub === "diff") {
      return Promise.resolve(okOutput(0));
    }
    if (sub === "check-ignore") return Promise.resolve(okOutput(128));
    throw new Error(`unexpected git subcommand: ${sub}`);
  };
  const exempt = await gitignoreReallowed({
    violations: [SKILL_PATH],
    options: { cwd: "/does/not/matter" },
    run,
  });
  assertEquals(exempt.size, 0);
});

Deno.test("gitignoreReallowed - positive control: a root .gitignore negation on an ancestor directory exempts a nested file (Issue #3309)", async () => {
  // SKILL_PATH itself and its nearer ancestors are undecided ("::", the
  // default); only ".claude/skills" is decided, by a root .gitignore
  // negation — the real shape the #3296 SKILL.md case takes (verified
  // against a real repo above).
  const run = checkIgnoreStub({
    ".claude/skills": ".gitignore:5:!.claude/skills",
  });
  const exempt = await gitignoreReallowed({
    violations: [SKILL_PATH],
    options: { cwd: "/does/not/matter" },
    run,
  });
  assertEquals(exempt.has(SKILL_PATH), true);
});

Deno.test("gitignoreReallowed - a decision from a nested/untracked .gitignore does not exempt (Issue #3309)", async () => {
  // The file's own decision comes from a non-root source — the shape an
  // untracked nested `.claude/.gitignore` re-allow takes.
  const run = checkIgnoreStub({
    [SKILL_PATH]: ".claude/.gitignore:1:!SKILL.md",
  });
  const exempt = await gitignoreReallowed({
    violations: [SKILL_PATH],
    options: { cwd: "/does/not/matter" },
    run,
  });
  assertEquals(exempt.has(SKILL_PATH), false);
});

Deno.test("gitignoreReallowed - a non-negation decision from the root .gitignore does not exempt (Issue #3309)", async () => {
  const run = checkIgnoreStub({ [SKILL_PATH]: ".gitignore:4:.claude/*" });
  const exempt = await gitignoreReallowed({
    violations: [SKILL_PATH],
    options: { cwd: "/does/not/matter" },
    run,
  });
  assertEquals(exempt.has(SKILL_PATH), false);
});

Deno.test("gitignoreReallowed - no decision anywhere in the ancestor chain does not exempt (Issue #3309)", async () => {
  // Every probe is undecided ("::") — the shape an unpatched repo whose
  // .gitignore lacks the `.*` rule takes for a path it simply never governs.
  const run = checkIgnoreStub({});
  const exempt = await gitignoreReallowed({
    violations: [SKILL_PATH],
    options: { cwd: "/does/not/matter" },
    run,
  });
  assertEquals(exempt.has(SKILL_PATH), false);
});

// --- Existing #2737 guarantee must still hold (sanity, no re-allow here) ---

Deno.test("assertSafeToCommit - an agent-added .env or .claude/secret during a merge is still refused with no re-allowing .gitignore present (Issue #3296 sanity)", async () => {
  const dir = await makeRepo("pre_commit_3296_sanity_");
  try {
    await stageFile(dir, "README.md", "# project\n");
    await mustGit(["commit", "-q", "-m", "base"], dir);
    await stageFile(dir, ".env", "SECRET=1\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(!result.ok);
    if (!result.ok) {
      assert(result.error.message.includes(".env"));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Case 9: real repo — exit 1 alone is not a re-allow (Issue #3309) -----

const UNPATCHED_GITIGNORE = "node_modules/\n";

Deno.test("assertSafeToCommit - a tracked .gitignore lacking the `.*` rule exempts nothing for .aws/credentials, .netrc or .npmrc (Issue #3309)", async () => {
  const dir = await makeRepo("pre_commit_3309_unpatched_");
  try {
    await stageFile(dir, ".gitignore", UNPATCHED_GITIGNORE);
    await mustGit(["commit", "-q", "-m", "base"], dir);
    await stageFile(dir, ".aws/credentials", "key=1\n");
    await stageFile(dir, ".netrc", "machine example.com\n");
    await stageFile(dir, ".npmrc", "//registry.example.com/:_authToken=x\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(
      !result.ok,
      "check-ignore exit 1 means 'no rule matches', not 're-allowed'",
    );
    if (!result.ok) {
      const msg = result.error.message;
      assert(msg.includes(".aws/credentials"), msg);
      assert(msg.includes(".netrc"), msg);
      assert(msg.includes(".npmrc"), msg);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Case 10: real repo — an untracked nested .gitignore is not the root's -

Deno.test("assertSafeToCommit - an untracked nested .claude/.gitignore re-allowing settings.local.json is still refused (Issue #3309)", async () => {
  const dir = await makeSkillRepo(
    "pre_commit_3309_nested_gi_",
    REALLOWING_GITIGNORE,
  );
  try {
    await Deno.writeTextFile(
      `${dir}/.claude/.gitignore`,
      "!settings.local.json\n",
    );
    await stageFile(dir, ".claude/settings.local.json", '{"x":1}\n');
    const result = await assertSafeToCommit({ cwd: dir });
    assert(
      !result.ok,
      "an untracked nested .gitignore must not stand in for the root one",
    );
    if (!result.ok) {
      assert(result.error.message.includes(".claude/settings.local.json"));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Case 11: real repo — index-only .gitignore edit (Issue #3309) --------

Deno.test("assertSafeToCommit - a .gitignore modified only in the index exempts nothing (Issue #3309)", async () => {
  const dir = await makeSkillRepo(
    "pre_commit_3309_gi_index_only_",
    REALLOWING_GITIGNORE,
  );
  try {
    // Stage a self-serving rewrite, then restore the working-tree file to
    // the committed content without unstaging. `git diff HEAD -- .gitignore`
    // (working tree vs HEAD) now sees no difference, and
    // `check-ignore --no-index` reads the restored, innocuous-looking file
    // — only `git diff --cached` catches that the index still differs.
    await Deno.writeTextFile(
      `${dir}/.gitignore`,
      REALLOWING_GITIGNORE + "!.aws\n",
    );
    await runGit(["add", ".gitignore"], dir);
    await Deno.writeTextFile(`${dir}/.gitignore`, REALLOWING_GITIGNORE);
    await stageFile(dir, SKILL_PATH, "# skill\nedited\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(
      !result.ok,
      "an index-modified .gitignore cannot vouch, even if the working tree matches HEAD",
    );
    if (!result.ok) {
      assert(result.error.message.includes(SKILL_PATH));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
