/**
 * Tests for the repo-`.gitignore` re-allow exemption (Issue #3296).
 *
 * `ALLOWED_HIDDEN_PATHS` is the worker's one canonical allowlist, but a
 * target repo's own `.gitignore` may legitimately re-allow a hidden path
 * (this repo's `.gitignore` re-allows `.claude/skills` and `.claude/agents`,
 * for instance). `gitignoreReallowed` and the wiring in `assertSafeToCommit`
 * accept such a path only when the repo's own tracked, unmodified
 * `.gitignore` re-allows it via `git check-ignore --no-index`, and never for
 * a path matching `FORBIDDEN_STAGED_PATTERNS`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  assertSafeToCommit,
  gitignoreReallowed,
} from "../lib/pre_commit_safety.ts";

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
