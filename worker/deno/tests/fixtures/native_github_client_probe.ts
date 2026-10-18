/** Real gh against the synthetic, isolated credential broker; no live account. */
import {
  buildBrokeredGitHubEnvironment,
  githubAgentSocketConfig,
  serveGitHubAgentGateway,
} from "../../lib/github_agent_gateway.ts";
import { countSyntheticCredentialMatches } from "../support/agent_container_evidence.ts";

export interface NativeGitHubEvidence {
  nativeGitHubCompleted: boolean;
  readCompleted: boolean;
  headCompleted: boolean;
  deniedRequests: number;
  localCapabilityOnly: boolean;
  upstreamCredentialVisible: boolean;
  ghVersion: string;
  startupCompleted: boolean;
  paginationCompleted: boolean;
  repositoryReadsCompleted: boolean;
}

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/**
 * Called inside the network/PID/mount-isolated agent container. The trusted
 * fixture supplies only a local capability and the planted secret's hash.
 * GET/HEAD successes must also be counted by the separate upstream witness.
 */
export async function probeNativeGitHubClient(options: {
  capability: string;
  secretHash: string;
}): Promise<NativeGitHubEvidence> {
  const home = await Deno.makeTempDir({ prefix: "vibe-native-gh-" });
  let gateway: ReturnType<typeof serveGitHubAgentGateway> | undefined;
  try {
    const configDir = `${home}/config`;
    const socketPath = `${home}/gh.sock`;
    await Deno.mkdir(configDir, { mode: 0o700 });
    await Deno.writeTextFile(
      `${configDir}/config.yml`,
      githubAgentSocketConfig(socketPath),
      { mode: 0o600 },
    );
    gateway = serveGitHubAgentGateway({
      capability: options.capability,
      socketPath,
    });
    const env = buildBrokeredGitHubEnvironment({
      capability: options.capability,
      homeDir: home,
      configDir,
    });
    requireFact(
      await countSyntheticCredentialMatches(
        Object.values(env).join("\n"),
        options.secretHash,
      ) === 0,
      "Native gh environment contains the planted upstream credential",
    );
    const run = async (args: string[]) => {
      const result = await new Deno.Command("gh", {
        args,
        clearEnv: true,
        env,
        cwd: home,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(20_000),
      }).output();
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);
      requireFact(
        await countSyntheticCredentialMatches(
          stdout + stderr,
          options.secretHash,
        ) === 0,
        "Native gh output contains the planted upstream credential",
      );
      return { success: result.success, stdout, stderr };
    };
    const version = await run(["--version"]);
    requireFact(version.success, "Native gh version could not be read");
    const read = await run([
      "api",
      "repos/fixture/allowed/issues?per_page=1",
      "--method",
      "GET",
    ]);
    requireFact(read.success, `Native gh REST read failed: ${read.stderr}`);
    requireFact(
      JSON.stringify(JSON.parse(read.stdout)) === JSON.stringify([
        { number: 7, title: "fixture-native-gh-complete" },
      ]),
      "Native gh did not receive the synthetic REST response",
    );
    const head = await run([
      "api",
      "repos/fixture/allowed/issues?per_page=1",
      "--method",
      "HEAD",
      "--silent",
    ]);
    requireFact(head.success, `Native gh HEAD failed: ${head.stderr}`);
    const identity = await run(["api", "user", "--jq", ".login"]);
    requireFact(
      identity.success && identity.stdout.trim() === "fixture-user",
      "Native gh startup identity failed",
    );
    const quota = await run([
      "api",
      "rate_limit",
      "--jq",
      ".resources.core.remaining",
    ]);
    requireFact(
      quota.success && quota.stdout.trim() === "4999",
      "Native gh quota read failed",
    );
    const auth = await run(["auth", "status", "--hostname", "github.com"]);
    requireFact(auth.success, `Native gh auth status failed: ${auth.stderr}`);
    const paged = await run([
      "api",
      "repos/fixture/allowed/issues?per_page=2",
      "--paginate",
      "--slurp",
    ]);
    requireFact(paged.success, `Native gh pagination failed: ${paged.stderr}`);
    requireFact(
      JSON.stringify(JSON.parse(paged.stdout)) ===
        JSON.stringify([[{ number: 11 }], [{ number: 12 }]]),
      "Native gh pagination silently omitted or changed a page",
    );
    for (
      const [field, expected] of [["viewerPermission", "WRITE"], [
        "defaultBranchRef",
        { name: "main" },
      ]] as const
    ) {
      const repo = await run([
        "repo",
        "view",
        "fixture/allowed",
        "--json",
        field,
      ]);
      requireFact(
        repo.success,
        `Native gh repository read failed: ${repo.stderr}`,
      );
      requireFact(
        JSON.stringify(JSON.parse(repo.stdout)) ===
          JSON.stringify({ [field]: expected }),
        "Native gh repository result differed from the fixture",
      );
    }
    const deniedRequests = [
      ["api", "repos/fixture/allowed/issues", "--method", "POST"],
      ["api", "repos/fixture/other/issues", "--method", "GET"],
      ["api", "graphql", "--method", "POST"],
      ["api", "repos/fixture/allowed/issues?access_token=untrusted"],
    ];
    for (const args of deniedRequests) {
      const denied = await run(args);
      requireFact(
        !denied.success && denied.stderr.includes("HTTP 403"),
        "Native gh forbidden request was not refused by the broker policy",
      );
    }
    // This deliberately invokes the real CLI without the worker's disclosure
    // shim: even its credential-printing command can only reveal the local cap.
    const token = await run(["auth", "token", "--hostname", "github.com"]);
    requireFact(
      token.success && token.stdout.trim() === options.capability,
      "Native gh token lookup did not return only its local capability",
    );
    return {
      nativeGitHubCompleted: true,
      readCompleted: true,
      headCompleted: true,
      deniedRequests: deniedRequests.length,
      localCapabilityOnly: true,
      upstreamCredentialVisible: false,
      ghVersion: version.stdout.split("\n")[0]!,
      startupCompleted: true,
      paginationCompleted: true,
      repositoryReadsCompleted: true,
    };
  } finally {
    try {
      await gateway?.close();
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }
}
