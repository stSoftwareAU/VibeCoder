import { assert, assertEquals } from "@std/assert";
import {
  type GitBrokerContext,
  inspectGitReceivePack,
  resolveGitBrokerRequest,
} from "../lib/git_broker_transport.ts";
import { nativeGit, nativeGitPush } from "./fixtures/native_git_push_probe.ts";

Deno.test("Git broker accepts real native create, fast-forward and pinned owned rewrite packets and blocks an unapproved push", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "vibe-git-broker-native-",
  });
  const local = `${directory}/local`;
  const remote = `${directory}/remote.git`;
  const env = {
    PATH: Deno.env.get("PATH")!,
    HOME: directory,
    TMPDIR: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const ref = "refs/heads/issue-7-fixture";
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
  const git = (args: string[]) => nativeGit(args, local, env);
  try {
    await nativeGit(["init", "--bare", remote], directory, env);
    await nativeGit(["init", local], directory, env);
    await git(["config", "user.name", "Broker fixture"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await git(["config", "commit.gpgsign", "false"]);
    await git(["config", "core.hooksPath", "/dev/null"]);
    const commit = async (message: string) => {
      await Deno.writeTextFile(`${local}/fixture.txt`, message);
      await git(["add", "fixture.txt"]);
      await git(["commit", "-m", message]);
      return text(await git(["rev-parse", "HEAD"]));
    };
    const base = await commit("create");
    let previous = "0".repeat(40);
    let next = base;
    for (const kind of ["create", "fast-forward", "rewrite"] as const) {
      if (kind === "fast-forward") next = await commit("forward");
      if (kind === "rewrite") {
        await git(["reset", "--hard", base]);
        next = await commit("replacement");
      }
      const context: GitBrokerContext = {
        repositories: [{
          repo: "fixture/allowed",
          defaultBranch: "main",
          protectedBranches: [],
        }],
        transactions: [{
          repo: "fixture/allowed",
          ref,
          oldOid: previous,
          newOid: next,
          kind,
        }],
      };
      const result = await nativeGitPush({
        local,
        remote,
        env,
        ref,
        ...(kind === "rewrite" ? { baseline: previous } : {}),
        approve: (bytes) => {
          const verdict = resolveGitBrokerRequest(
            new Request(
              "http://broker.invalid/git/fixture/allowed.git/git-receive-pack",
              {
                method: "POST",
                headers: {
                  "content-type": "application/x-git-receive-pack-request",
                },
              },
            ),
            context,
            bytes,
          );
          assert(verdict.allowed, kind);
          assertEquals(verdict.body, bytes);
          assertEquals(verdict.updates, [{
            ref,
            oldOid: previous,
            newOid: next,
          }]);
          return verdict.allowed;
        },
      });
      assertEquals(result.exitCode, 0, kind);
      assert(result.forwarded);
      assertEquals(
        text(
          await nativeGit(["--git-dir", remote, "rev-parse", ref], local, env),
        ),
        next,
      );
      assert(inspectGitReceivePack(result.body));
      previous = next;
    }
    await commit("unapproved");
    const denied = await nativeGitPush({
      local,
      remote,
      env,
      ref,
      approve: (bytes) => {
        const result = resolveGitBrokerRequest(
          new Request(
            "http://broker.invalid/git/fixture/allowed.git/git-receive-pack",
            {
              method: "POST",
              headers: {
                "content-type": "application/x-git-receive-pack-request",
              },
            },
          ),
          {
            repositories: [{
              repo: "fixture/allowed",
              defaultBranch: "main",
              protectedBranches: [],
            }],
            transactions: [],
          },
          bytes,
        );
        assertEquals(result.allowed, false);
        return result.allowed;
      },
    });
    assertEquals(denied.forwarded, false);
    assert(denied.exitCode !== 0);
    assertEquals(
      text(
        await nativeGit(["--git-dir", remote, "rev-parse", ref], local, env),
      ),
      previous,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
