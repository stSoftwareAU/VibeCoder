import { assert, assertEquals, assertRejects } from "@std/assert";
import {
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
