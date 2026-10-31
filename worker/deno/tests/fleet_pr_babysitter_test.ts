import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  eligibleAuthor,
  reason,
  recoverTemporaryClones,
  validateAndCommit,
} from "../commands/fleet_pr_babysitter.ts";

const pr = {
  state: "OPEN",
  number: 1,
  title: "fix",
  author: { login: "fleet" },
  headRefName: "feature",
  headRefOid: "abc",
  baseRefName: "main",
  isCrossRepository: false,
  isDraft: false,
  mergeable: "MERGEABLE",
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
};
Deno.test("isolated fix commits before quality and a failed quality gate stops validation", async () => {
  const dir = await Deno.makeTempDir();
  const git = async (...args: string[]) => {
    const result = await new Deno.Command("git", {
      args,
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
    assert(result.success);
  };
  try {
    await git("init");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await Deno.writeTextFile(
      `${dir}/quality.sh`,
      '#!/bin/sh\ntest -z "$(git status --porcelain)"\n',
    );
    await Deno.writeTextFile(`${dir}/fix.txt`, "before\n");
    await git("add", ".");
    await git("commit", "-m", "initial");
    await Deno.writeTextFile(`${dir}/fix.txt`, "fixed\n");
    await validateAndCommit(dir, 123);
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/sh\nexit 1\n");
    await assertRejects(
      () => validateAndCommit(dir, 123),
      Error,
      "bash failed",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("author filter permits an explicit PR without widening fleet scans", () => {
  assert(eligibleAuthor("VibeCoderST", ["vibecoderst"], false));
  assert(!eligibleAuthor("human", ["VibeCoderST"], false));
  assert(eligibleAuthor("human", ["VibeCoderST"], true));
});

Deno.test("babysitter selects only conflicts and failed CI", () => {
  assertEquals(reason(pr), null);
  assertEquals(reason({ ...pr, mergeable: "CONFLICTING" }), "merge conflict");
  assertEquals(
    reason({ ...pr, statusCheckRollup: [{ conclusion: "FAILURE" }] }),
    "failed CI",
  );
  assertEquals(
    reason({ ...pr, statusCheckRollup: [{ conclusion: "CANCELLED" }] }),
    null,
  );
  assertEquals(
    reason({ ...pr, state: "CLOSED", mergeable: "CONFLICTING" }),
    null,
  );
  assertEquals(
    reason({ ...pr, isDraft: true, mergeable: "CONFLICTING" }),
    null,
  );
  assertEquals(
    reason({ ...pr, isCrossRepository: true, mergeable: "CONFLICTING" }),
    null,
  );
  assertEquals(
    reason({ ...pr, statusCheckRollup: null, mergeable: "CONFLICTING" }),
    null,
  );
});

Deno.test("cleanup removes abandoned clones but preserves live and unrelated directories", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dead = `${root}/fleet-pr-babysitter-99999999-abcdef`;
    const live = `${root}/fleet-pr-babysitter-${Deno.pid}-abcdef`;
    const unrelated = `${root}/fleet-pr-babysitter-unrelated`;
    for (const path of [dead, live, unrelated]) await Deno.mkdir(path);
    await recoverTemporaryClones(root);
    const names = (await Array.fromAsync(Deno.readDir(root))).map((entry) =>
      entry.name
    );
    assertEquals(
      names.sort(),
      [
        `fleet-pr-babysitter-${Deno.pid}-abcdef`,
        "fleet-pr-babysitter-unrelated",
      ].sort(),
    );
    assert((await Deno.stat(live)).isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("babysitter stages resolved merge files and refuses conflict markers", async () => {
  const dir = await Deno.makeTempDir();
  const git = async (...args: string[]) =>
    await new Deno.Command("git", {
      args,
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
  try {
    assert((await git("init")).success);
    assert((await git("config", "user.name", "Test")).success);
    assert((await git("config", "user.email", "test@example.invalid")).success);
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/sh\nexit 0\n");
    await Deno.writeTextFile(`${dir}/file.txt`, "original\n");
    assert((await git("add", ".")).success);
    assert((await git("commit", "-m", "initial")).success);
    assert((await git("checkout", "-b", "other")).success);
    await Deno.writeTextFile(`${dir}/file.txt`, "other\n");
    assert((await git("commit", "-am", "other")).success);
    assert((await git("checkout", "-")).success);
    await Deno.writeTextFile(`${dir}/file.txt`, "feature\n");
    assert((await git("commit", "-am", "feature")).success);
    assert(!(await git("merge", "--no-commit", "other")).success);
    await assertRejects(() => validateAndCommit(dir, 123), Error, "git failed");
    await Deno.writeTextFile(`${dir}/file.txt`, "feature and other\n");
    await validateAndCommit(dir, 123);
    assert((await git("diff", "--quiet", "HEAD")).success);
    assert((await git("rev-parse", "HEAD^2")).success);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
