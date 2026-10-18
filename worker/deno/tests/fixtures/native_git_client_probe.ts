/** Native clone/fetch in the network-none agent; no live account or push grant. */
import {
  buildBrokeredGitEnvironment,
  gitAgentReadConfig,
  serveGitAgentGateway,
} from "../../lib/git_agent_gateway.ts";
import { GITHUB_GIT_UPSTREAM } from "../../lib/credential_broker_policy.ts";
import { countSyntheticCredentialMatches } from "../support/agent_container_evidence.ts";

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export interface NativeGitEvidence {
  nativeGitCompleted: boolean;
  gitVersion: string;
  cloneCompleted: boolean;
  shallowClone: boolean;
  fetchCompleted: boolean;
  deniedRepository: boolean;
  deniedPush: boolean;
  credentialFreeConfig: boolean;
  upstreamCredentialVisible: boolean;
}

/** The trusted fixture supplies only a local capability and its secret hash. */
export async function probeNativeGitClient(options: {
  capability: string;
  secretHash: string;
}): Promise<NativeGitEvidence> {
  const home = await Deno.makeTempDir({ prefix: "vibe-native-git-" });
  let gateway: ReturnType<typeof serveGitAgentGateway> | undefined;
  try {
    gateway = serveGitAgentGateway({ capability: options.capability });
    const configFile = `${home}/gitconfig`;
    const config = gitAgentReadConfig(gateway.baseUrl);
    await Deno.writeTextFile(configFile, config, { mode: 0o600 });
    const env = buildBrokeredGitEnvironment({ homeDir: home, configFile });
    const clean = async (value: string) => {
      requireFact(
        await countSyntheticCredentialMatches(value, options.secretHash) === 0,
        "Native Git observed the upstream credential",
      );
    };
    await clean(config + JSON.stringify(env));
    const run = async (args: string[], cwd = home) => {
      const result = await new Deno.Command("git", {
        args,
        cwd,
        env,
        clearEnv: true,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(30_000),
      }).output();
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);
      await clean(stdout + stderr);
      return { success: result.success, stdout, stderr };
    };
    const version = await run(["--version"]);
    requireFact(version.success, "Native Git version check failed");
    const clone = await run([
      "clone",
      "--single-branch",
      "--depth=1",
      "--branch=main",
      `${GITHUB_GIT_UPSTREAM}/fixture/allowed.git`,
      `${home}/checkout`,
    ]);
    requireFact(clone.success, `Native Git clone failed: ${clone.stderr}`);
    const cwd = `${home}/checkout`;
    requireFact(
      await Deno.readTextFile(`${cwd}/fixture.txt`) ===
        "fixture-native-git-main\n",
      "Native Git clone returned different content",
    );
    const shallow = await run(["rev-parse", "--is-shallow-repository"], cwd);
    requireFact(
      shallow.success && shallow.stdout.trim() === "true",
      "Native Git clone was not shallow",
    );
    const absent = await run([
      "show-ref",
      "--verify",
      "refs/remotes/origin/fixture-next",
    ], cwd);
    requireFact(
      !absent.success,
      "Native fetch positive control already had its target ref",
    );
    const fetched = await run([
      "fetch",
      "--end-of-options",
      "origin",
      "refs/heads/fixture-next:refs/remotes/origin/fixture-next",
    ], cwd);
    requireFact(fetched.success, `Native Git fetch failed: ${fetched.stderr}`);
    const content = await run([
      "show",
      "refs/remotes/origin/fixture-next:fixture.txt",
    ], cwd);
    requireFact(
      content.success && content.stdout === "fixture-native-git-fetched\n",
      "Native Git fetch did not deliver the second branch",
    );
    const offRepo = await run([
      "ls-remote",
      `${GITHUB_GIT_UPSTREAM}/fixture/other.git`,
    ]);
    requireFact(
      !offRepo.success && offRepo.stderr.includes("403"),
      "Native Git off-repository read was not refused by policy",
    );
    const push = await run([
      "push",
      "--end-of-options",
      "origin",
      "HEAD:refs/heads/fixture-probe-denied",
    ], cwd);
    requireFact(
      !push.success && push.stderr.includes("403"),
      "Read-only native Git adapter allowed push discovery",
    );
    const effectiveConfig = await run(
      ["config", "--list", "--show-origin"],
      cwd,
    );
    requireFact(
      effectiveConfig.success,
      "Native Git config could not be inspected",
    );
    requireFact(
      !effectiveConfig.stdout.includes(options.capability),
      "Native Git config contains its adapter capability",
    );
    return {
      nativeGitCompleted: true,
      gitVersion: version.stdout.trim(),
      cloneCompleted: true,
      shallowClone: true,
      fetchCompleted: true,
      deniedRepository: true,
      deniedPush: true,
      credentialFreeConfig: true,
      upstreamCredentialVisible: false,
    };
  } finally {
    await gateway?.close();
    await Deno.remove(home, { recursive: true });
  }
}
