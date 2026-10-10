/**
 * Tests for suppression commit-identity binding (Issue #269).
 *
 * `author=` is self-asserted comment text. These tests pin the provenance
 * check: a marker whose allowlisted `author=` does not match the git
 * author of the line that carries it is rejected, and a matching identity
 * is still honoured. The helper tests call real `git` in a temp repo —
 * no mocked blame.
 *
 * Australian English spelling throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  findSuppressions,
  isSuppressed,
  loginFromGitIdentity,
} from "../lib/suppression_comments.ts";
import {
  blameFileLineLogins,
  blameLineAuthorLogin,
  parseBlamePorcelain,
} from "../lib/suppression_identity.ts";

const TODAY = "2026-08-02";
const TRAILER = "author=nigel expires=2026-12-31 mitigated by the WAF";

function markerLine(): string {
  return `doThing(); // security-scan-ignore: SEC-abc123 — ${TRAILER}`;
}

Deno.test("loginFromGitIdentity - extracts a login from a GitHub noreply email", () => {
  assertEquals(
    loginFromGitIdentity("Nigel Leck", "nigel@users.noreply.github.com"),
    "nigel",
  );
  assertEquals(
    loginFromGitIdentity("Nigel Leck", "12345+nigel@users.noreply.github.com"),
    "nigel",
  );
});

Deno.test("loginFromGitIdentity - treats a login-shaped author name as the login", () => {
  assertEquals(loginFromGitIdentity("nigel", "nigel@example.com"), "nigel");
  assertEquals(loginFromGitIdentity("Nigel", "dev@example.com"), "nigel");
});

Deno.test("loginFromGitIdentity - returns null when no login can be derived", () => {
  assertEquals(
    loginFromGitIdentity("Nigel Leck", "nigel@example.com"),
    null,
  );
  assertEquals(loginFromGitIdentity("", ""), null);
});

async function runGit(
  cwd: string,
  args: string[],
  identity: { name: string; email: string },
): Promise<void> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  const out = await cmd.output();
  assertEquals(
    out.code,
    0,
    `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
  );
}

/** Real repo whose single committed line was authored by `identity`. */
async function repoWithMarker(
  identity: { name: string; email: string },
): Promise<{ dir: string; file: string }> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-suppression-id-" });
  await runGit(dir, ["init", "-q", "-b", "main"], identity);
  const file = "src.ts";
  await Deno.writeTextFile(`${dir}/${file}`, `${markerLine()}\n`);
  await runGit(dir, ["add", file], identity);
  await runGit(dir, ["commit", "-q", "-m", "add marker"], identity);
  return { dir, file };
}

Deno.test("blameLineAuthorLogin - returns the committing login for the marker line", async () => {
  const { dir, file } = await repoWithMarker({
    name: "nigel",
    email: "nigel@users.noreply.github.com",
  });
  try {
    const login = await blameLineAuthorLogin(dir, file, 1);
    assertEquals(login, "nigel");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("blameLineAuthorLogin - fails closed when blame cannot run", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-suppression-id-nogit-" });
  try {
    const login = await blameLineAuthorLogin(dir, "missing.ts", 1);
    assertEquals(login, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findSuppressions - a fork-forged allowlisted author= is rejected when blame is the attacker (Issue #269)", async () => {
  const { dir, file } = await repoWithMarker({
    name: "mallory",
    email: "mallory@users.noreply.github.com",
  });
  try {
    const blamed = await blameLineAuthorLogin(dir, file, 1);
    assertEquals(blamed, "mallory");
    const source = await Deno.readTextFile(`${dir}/${file}`);
    const records = findSuppressions(source, "ts", {
      today: TODAY,
      allowedAuthors: ["nigel"],
      commitAuthors: blamed ? [blamed] : [],
    });
    assertEquals(records[0]?.valid, false);
    assertStringIncludes(records[0]?.invalidReason ?? "", "commit");
    assertEquals(isSuppressed("SEC-abc123", records, 1), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findSuppressions - a marker whose author= matches blame still suppresses (Issue #269)", async () => {
  const { dir, file } = await repoWithMarker({
    name: "nigel",
    email: "nigel@users.noreply.github.com",
  });
  try {
    const blamed = await blameLineAuthorLogin(dir, file, 1);
    assertEquals(blamed, "nigel");
    const source = await Deno.readTextFile(`${dir}/${file}`);
    const records = findSuppressions(source, "ts", {
      today: TODAY,
      allowedAuthors: ["nigel"],
      commitAuthors: blamed ? [blamed] : [],
    });
    assert(records[0]);
    assertEquals(records[0].valid, true);
    assertEquals(isSuppressed("SEC-abc123", records, 1), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const NIGEL = { name: "nigel", email: "nigel@users.noreply.github.com" };
const MALLORY = { name: "mallory", email: "mallory@users.noreply.github.com" };

/**
 * Two-commit origin: `nigel` commits the marker on line 1, then `mallory`
 * appends line 2. A `--depth=1` clone of it sees only mallory's commit,
 * which `git blame` reports as the `boundary` for every older line.
 */
async function shallowCloneOfTwoCommits(): Promise<
  { tmp: string; clone: string; file: string }
> {
  const tmp = await Deno.makeTempDir({ prefix: "vibe-suppression-shallow-" });
  const origin = `${tmp}/origin`;
  const clone = `${tmp}/clone`;
  const file = "src.ts";
  await Deno.mkdir(origin);
  await runGit(origin, ["init", "-q", "-b", "main"], NIGEL);
  await Deno.writeTextFile(`${origin}/${file}`, `${markerLine()}\n`);
  await runGit(origin, ["add", file], NIGEL);
  await runGit(origin, ["commit", "-q", "-m", "add marker"], NIGEL);
  await Deno.writeTextFile(
    `${origin}/${file}`,
    `${markerLine()}\nmore();\n`,
  );
  await runGit(origin, ["commit", "-q", "-am", "append"], MALLORY);
  await runGit(
    tmp,
    ["clone", "-q", "--depth=1", `file://${origin}`, clone],
    NIGEL,
  );
  return { tmp, clone, file };
}

Deno.test("blameFileLineLogins - a --depth=1 clone blames old lines on their real author, not the shallow boundary", async () => {
  const { tmp, clone, file } = await shallowCloneOfTwoCommits();
  try {
    const blamed = await blameFileLineLogins(clone, file);
    assertEquals(blamed[1], "nigel");
    assertEquals(blamed[2], "mallory");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("blameFileLineLogins - a shallow clone that cannot be deepened leaves boundary lines unknown", async () => {
  const { tmp, clone, file } = await shallowCloneOfTwoCommits();
  try {
    // No origin to deepen from: the boundary author must not be trusted.
    await Deno.remove(`${tmp}/origin`, { recursive: true });
    const blamed = await blameFileLineLogins(clone, file);
    assertEquals(blamed[1], undefined);
    assertEquals(blamed[2], undefined);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("blameFileLineLogins - a full history still attributes root-commit lines", async () => {
  const { dir, file } = await repoWithMarker(NIGEL);
  try {
    assertEquals(await blameFileLineLogins(dir, file), { 1: "nigel" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseBlamePorcelain - a boundary hunk is unknown identity", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  const stdout = [
    `${sha} 1 1 1`,
    "author nigel",
    "author-mail <nigel@users.noreply.github.com>",
    "summary old",
    "boundary",
    "filename src.ts",
    "\tline one",
    `${other} 2 2 1`,
    "author mallory",
    "author-mail <mallory@users.noreply.github.com>",
    "summary new",
    "filename src.ts",
    "\tline two",
    `${sha} 3 3`,
    "\tline three",
    "",
  ].join("\n");
  assertEquals(parseBlamePorcelain(stdout), { 2: "mallory" });
});
