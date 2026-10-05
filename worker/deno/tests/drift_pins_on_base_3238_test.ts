/**
 * Issue #3238 — `deno task drift-pins-on-base` reported every phrase as
 * "absent on base" when the given `<doc>` could not be resolved at all (e.g.
 * `../../prompts/pr_feedback/prompt.md`, run from `worker/deno`), because
 * `git show <base>:<path>` misses silently on an unresolvable path and the
 * old code read that miss as "doc new on base". A bad path must fail loud
 * instead, distinctly from a doc that is genuinely absent on base.
 *
 * `resolveRepoDoc` normalises and validates `<doc>` before git ever sees it;
 * `driftPinsCli` is the CLI body, exercised directly here rather than via a
 * subprocess.
 *
 * Uses Australian English spelling throughout (behaviour, colour,
 * organisation, etc.).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { driftPinsCli, resolveRepoDoc } from "./support/markdown_docs.ts";
import {
  commitFile,
  gitOk,
  setupGitRepoFixture,
} from "./support/git_repo_fixture.ts";

const BASE_DOC = [
  "# Page",
  "",
  "## Escalation",
  "",
  "Escalate with the needs-human",
  "label when the fix fails.",
  "",
].join("\n");

Deno.test("resolveRepoDoc - rejects any path that escapes the repo root", async () => {
  const fixture = await setupGitRepoFixture("issue-3238-escape-");
  try {
    const { clone } = fixture;
    await commitFile(clone, "doc.md", BASE_DOC, "doc");
    await Deno.mkdir(`${clone}/sub`);

    await assertRejects(
      () => resolveRepoDoc("../doc.md", clone),
      Error,
      '"../doc.md"',
    );
    await assertRejects(
      () => resolveRepoDoc("sub/../doc.md", clone),
      Error,
      '"sub/../doc.md"',
    );
    await assertRejects(
      () => resolveRepoDoc("/abs/doc.md", clone),
      Error,
      '"/abs/doc.md"',
    );

    assertEquals(await resolveRepoDoc("./doc.md", clone), "doc.md");
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("resolveRepoDoc - rejects a path missing from the working tree", async () => {
  const fixture = await setupGitRepoFixture("issue-3238-missing-");
  try {
    const { clone } = fixture;
    const err = await assertRejects(
      () => resolveRepoDoc("nope/missing.md", clone),
      Error,
      '"nope/missing.md"',
    );
    assertStringIncludes((err as Error).message, `${clone}/nope/missing.md`);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("resolveRepoDoc - rejects a path through a symlink", async () => {
  const fixture = await setupGitRepoFixture("issue-3238-symlink-");
  try {
    const { clone, root } = fixture;
    await commitFile(clone, "doc.md", BASE_DOC, "doc");

    // A directory symlink that escapes the repo entirely.
    const outside = `${root}/outside`;
    await Deno.mkdir(outside);
    await Deno.writeTextFile(`${outside}/doc.md`, BASE_DOC);
    await Deno.symlink(outside, `${clone}/link`, { type: "dir" });

    await assertRejects(
      () => resolveRepoDoc("link/doc.md", clone),
      Error,
      '"link/doc.md"',
    );
    // The ".." rule catches this combined shape before the symlink check runs.
    await assertRejects(
      () => resolveRepoDoc("missing/../link/doc.md", clone),
      Error,
      '"missing/../link/doc.md"',
    );

    // An in-repo file symlink is still a symlink — git would not follow it.
    await Deno.symlink("doc.md", `${clone}/alias.md`, { type: "file" });
    await assertRejects(
      () => resolveRepoDoc("alias.md", clone),
      Error,
      '"alias.md"',
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("driftPinsCli - an unresolvable doc path fails loud, prints nothing on out", async () => {
  const fixture = await setupGitRepoFixture("issue-3238-cli-escape-");
  try {
    const { clone } = fixture;
    await gitOk(["checkout", "-q", "-b", "base"], clone);
    await commitFile(clone, "doc.md", BASE_DOC, "base doc");

    const out: string[] = [];
    const err: string[] = [];
    const code = await driftPinsCli(
      ["base", "../doc.md", "Escalation", "needs-human label"],
      (line) => out.push(line),
      (line) => err.push(line),
      clone,
    );

    assertEquals(code, 2);
    assertEquals(out, []);
    assertEquals(err.length, 1);
    assertStringIncludes(err[0]!, "../doc.md");
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("driftPinsCli - a doc only on the feature branch is reported as not on base", async () => {
  const fixture = await setupGitRepoFixture("issue-3238-cli-new-");
  try {
    const { clone } = fixture;
    await gitOk(["checkout", "-q", "-b", "base"], clone);
    await commitFile(clone, "doc.md", BASE_DOC, "base doc");
    await gitOk(["checkout", "-q", "-b", "feature"], clone);
    await commitFile(clone, "new.md", BASE_DOC, "new doc");

    const out: string[] = [];
    const err: string[] = [];
    const code = await driftPinsCli(
      ["base", "new.md", "Escalation", "needs-human label", "something else"],
      (line) => out.push(line),
      (line) => err.push(line),
      clone,
    );

    assertEquals(code, 0);
    assertEquals(out, ["doc not on base: new.md"]);
    assertEquals(err, []);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("driftPinsCli - happy path: ALREADY ON BASE and absent on base, per phrase", async () => {
  const fixture = await setupGitRepoFixture("issue-3238-cli-happy-");
  try {
    const { clone } = fixture;
    await gitOk(["checkout", "-q", "-b", "base"], clone);
    await commitFile(clone, "doc.md", BASE_DOC, "base doc");
    await gitOk(["checkout", "-q", "-b", "feature"], clone);

    const out: string[] = [];
    const err: string[] = [];
    const code = await driftPinsCli(
      [
        "base",
        "doc.md",
        "Escalation",
        "needs-human label",
        "a brand new rule",
      ],
      (line) => out.push(line),
      (line) => err.push(line),
      clone,
    );

    assertEquals(code, 1);
    assertEquals(out, [
      "ALREADY ON BASE: needs-human label",
      "absent on base: a brand new rule",
    ]);
    assertEquals(err, []);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("driftPinsCli - a base ref that does not resolve fails loud, prints nothing on out", async () => {
  const fixture = await setupGitRepoFixture("issue-3238-cli-badref-");
  try {
    const { clone } = fixture;
    await commitFile(clone, "doc.md", BASE_DOC, "doc");

    const out: string[] = [];
    const err: string[] = [];
    const code = await driftPinsCli(
      ["no-such-ref", "doc.md", "Escalation", "needs-human label"],
      (line) => out.push(line),
      (line) => err.push(line),
      clone,
    );

    assertEquals(code, 2);
    assertEquals(out, []);
    assertEquals(err.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("driftPinsCli - too few arguments is a usage error", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await driftPinsCli(
    ["base", "doc.md", "Escalation"],
    (line) => out.push(line),
    (line) => err.push(line),
  );

  assertEquals(code, 2);
  assertEquals(out, []);
  assertEquals(err.length, 1);
});
