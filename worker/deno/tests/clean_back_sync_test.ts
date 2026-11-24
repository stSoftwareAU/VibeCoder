import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { cleanBackSync } from "../lib/milestone_sync_pr.ts";

Deno.test("only reproducible merges of published milestone and Develop tips qualify", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "back-sync-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const milestone = "milestone/feature";
  const verify = () =>
    cleanBackSync(
      "stSoftwareAU/GRQ-AutoTrader",
      milestone,
      "Develop",
      (args) => {
        const result = spawnSync("git", args, { cwd, encoding: "utf8" });
        return Promise.resolve({
          code: result.status ?? 1,
          stdout: result.stdout,
        });
      },
    );
  const add = (path: string, value: string) => {
    writeFileSync(join(cwd, path), value);
    git("add", path);
    git("commit", "-qm", value);
  };
  try {
    git("init", "-qb", "Develop");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    git("init", "--bare", "-q", "origin.git");
    git("remote", "add", "origin", "./origin.git");
    add("shared", "initial");
    git("branch", milestone);
    add("develop", "accepted");
    git("push", "-q", "origin", milestone, "Develop");
    assert.equal((await verify())?.head, git("rev-parse", "Develop"));
    git("checkout", "-q", milestone);
    add("feature", "in progress");
    git("push", "-q", "origin", milestone);
    const base = git("rev-parse", "HEAD");
    git("merge", "-q", "--no-edit", "Develop");
    const head = git("rev-parse", "HEAD");
    assert.deepEqual(await verify(), {
      head,
      branch: `sync/milestone-clean/${milestone}/${base}/${head}`,
    });
    writeFileSync(join(cwd, "feature"), "extra edit");
    git("commit", "-qam", "extra edit", "--amend");
    assert.equal(await verify(), undefined);
    git("reset", "-q", "--hard", base);
    add("shared", "milestone version");
    git("push", "-q", "origin", milestone);
    git("checkout", "-q", "Develop");
    add("shared", "Develop version");
    git("push", "-q", "origin", "Develop");
    git("checkout", "-q", milestone);
    git("merge", "-q", "-X", "ours", "--no-edit", "Develop");
    assert.equal(await verify(), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
