/**
 * Tests for audit_mutation_classifier.ts (Issue #2380).
 *
 * Verifies that mutating `gh`/`git` commands are classified with the right
 * verb/repo/target and that read-only commands return null.
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  classifyGhMutation,
  classifyGitMutation,
} from "../lib/audit_mutation_classifier.ts";

Deno.test("classifyGhMutation - issue comment is a mutation", () => {
  const info = classifyGhMutation([
    "issue",
    "comment",
    "123",
    "-R",
    "org/repo",
    "-b",
    "hi",
  ]);
  assertEquals(info?.verb, "issue-comment");
  assertEquals(info?.repo, "org/repo");
  assertEquals(info?.target, "123");
});

Deno.test("classifyGhMutation - pr create is a mutation without a number", () => {
  const info = classifyGhMutation([
    "pr",
    "create",
    "--title",
    "T",
    "--body",
    "B",
  ]);
  assertEquals(info?.verb, "pr-create");
  assertEquals(info?.target, undefined);
});

Deno.test("classifyGhMutation - pr merge is a mutation", () => {
  const info = classifyGhMutation(["pr", "merge", "45", "--squash"]);
  assertEquals(info?.verb, "pr-merge");
  assertEquals(info?.target, "45");
});

Deno.test("classifyGhMutation - label create is a mutation", () => {
  const info = classifyGhMutation(["label", "create", "bug", "-R", "o/r"]);
  assertEquals(info?.verb, "label-create");
});

Deno.test("classifyGhMutation - --repo=form is parsed", () => {
  const info = classifyGhMutation([
    "issue",
    "close",
    "9",
    "--repo=acme/widget",
  ]);
  assertEquals(info?.repo, "acme/widget");
  assertEquals(info?.target, "9");
});

Deno.test("classifyGhMutation - issue view is read-only (null)", () => {
  assertEquals(classifyGhMutation(["issue", "view", "123"]), null);
});

Deno.test("classifyGhMutation - pr list is read-only (null)", () => {
  assertEquals(classifyGhMutation(["pr", "list", "--state", "open"]), null);
});

Deno.test("classifyGhMutation - api GET is read-only (null)", () => {
  assertEquals(classifyGhMutation(["api", "repos/o/r/issues"]), null);
});

Deno.test("classifyGhMutation - api with -X POST is a mutation", () => {
  const info = classifyGhMutation([
    "api",
    "-X",
    "POST",
    "repos/o/r/milestones",
    "-f",
    "title=v1",
  ]);
  assertEquals(info?.verb, "api-post");
  assertEquals(info?.repo, "o/r");
  assertEquals(info?.target, "repos/o/r/milestones");
});

Deno.test("classifyGhMutation - api with field flag implies POST", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/labels",
    "-f",
    "name=bug",
  ]);
  assertEquals(info?.verb, "api-post");
  assertEquals(info?.target, "repos/o/r/labels");
});

Deno.test("classifyGhMutation - api with --method=DELETE is a mutation", () => {
  const info = classifyGhMutation([
    "api",
    "--method=DELETE",
    "repos/o/r/issues/1/labels/bug",
  ]);
  assertEquals(info?.verb, "api-delete");
});

Deno.test("classifyGhMutation - leading flags are skipped", () => {
  const info = classifyGhMutation(["--verbose", "issue", "create", "-t", "x"]);
  assertEquals(info?.verb, "issue-create");
});

Deno.test("classifyGitMutation - push is a mutation with branch target", () => {
  const info = classifyGitMutation(["push", "-u", "origin", "feature-x"]);
  assertEquals(info?.verb, "git-push");
  assertEquals(info?.target, "feature-x");
});

Deno.test("classifyGitMutation - fetch is read-only (null)", () => {
  assertEquals(classifyGitMutation(["fetch", "origin"]), null);
});

Deno.test("classifyGitMutation - commit is local (null)", () => {
  assertEquals(classifyGitMutation(["commit", "-m", "msg"]), null);
});

// Issue #3950: git's value-carrying globals must be skipped with their value,
// otherwise the scan lands on the value and the push is never journalled.
Deno.test("classifyGitMutation - push with -C classifies", () => {
  const info = classifyGitMutation(["-C", "/repo", "push", "origin", "main"]);
  assertEquals(info?.verb, "git-push");
  assertEquals(info?.target, "main");
  assertEquals(info?.scope, "cwd");
});

Deno.test("classifyGitMutation - push with -c classifies", () => {
  const info = classifyGitMutation(["-c", "user.name=x", "push"]);
  assertEquals(info?.verb, "git-push");
  assertEquals(info?.target, undefined);
});

Deno.test("classifyGitMutation - push with --git-dir classifies", () => {
  const info = classifyGitMutation([
    "--git-dir",
    "/repo/.git",
    "push",
    "origin",
    "main",
  ]);
  assertEquals(info?.verb, "git-push");
  assertEquals(info?.target, "main");
});

Deno.test("classifyGitMutation - push with --work-tree classifies", () => {
  const info = classifyGitMutation(["--work-tree", "/repo", "push"]);
  assertEquals(info?.verb, "git-push");
});

Deno.test("classifyGitMutation - push with --exec-path classifies", () => {
  const info = classifyGitMutation([
    "--exec-path",
    "/usr/libexec/git-core",
    "push",
    "origin",
    "main",
  ]);
  assertEquals(info?.verb, "git-push");
  assertEquals(info?.target, "main");
});

Deno.test("classifyGitMutation - push with --namespace classifies", () => {
  const info = classifyGitMutation(["--namespace", "ns", "push"]);
  assertEquals(info?.verb, "git-push");
});

Deno.test("classifyGitMutation - attached global forms classify", () => {
  assertEquals(
    classifyGitMutation(["--git-dir=/repo/.git", "push", "origin", "main"])
      ?.target,
    "main",
  );
  assertEquals(
    classifyGitMutation(["-C/repo", "push", "origin", "main"])?.target,
    "main",
  );
  assertEquals(
    classifyGitMutation(["-cuser.name=x", "push"])?.verb,
    "git-push",
  );
});

Deno.test("classifyGitMutation - combined globals before push classify", () => {
  const info = classifyGitMutation([
    "-C",
    "/repo",
    "--no-pager",
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "--force-with-lease",
    "origin",
    "topic",
  ]);
  assertEquals(info?.verb, "git-push");
  assertEquals(info?.target, "topic");
});

Deno.test("classifyGitMutation - -C with a read sub-command is null", () => {
  assertEquals(classifyGitMutation(["-C", "/repo", "status"]), null);
  assertEquals(classifyGitMutation(["--no-pager", "log", "-p"]), null);
});

// Issue #3950: an unrecognised leading global may carry a value the scan does
// not skip, so a push anywhere in the vector fails closed and is journalled.
Deno.test("classifyGitMutation - unknown global fails closed to git-push", () => {
  const info = classifyGitMutation([
    "--future-global",
    "/some/value",
    "push",
    "origin",
    "main",
  ]);
  assertEquals(info?.verb, "git-push");
  assertEquals(info?.target, "main");
});

Deno.test("classifyGitMutation - unknown global without a push stays null", () => {
  assertEquals(classifyGitMutation(["--future-global", "v", "status"]), null);
});

// Issue #3950: git's globals must not leak into the gh value-flag table.
Deno.test("classifyGhMutation - git globals are not gh value flags", () => {
  assertEquals(
    classifyGhMutation(["-c", "issue", "create", "-t", "x"])?.verb,
    "issue-create",
  );
  assertEquals(
    classifyGhMutation(["-C", "issue", "comment", "7", "-b", "hi"])?.verb,
    "issue-comment",
  );
  assertEquals(
    classifyGhMutation(["--git-dir", "pr", "merge", "45"])?.verb,
    "pr-merge",
  );
});
