/** Real pinned Codex client fixture; only the trusted broker has upstream secrets. */
import {
  type BrokeredCodexMode,
  buildBrokeredCodexLaunch,
  serveCodexAgentGateway,
} from "../../lib/codex_agent_gateway.ts";
import { countSyntheticCredentialMatches } from "../support/agent_container_evidence.ts";

import {
  assertCodexNativeOutput,
  CODEX_NATIVE_FIXTURE_RESULT,
} from "../support/codex_native_evidence.ts";
const VERIFIED_CODEX_VERSION = "0.147.0";

/** SSE shape from the pinned CLI's codex-api/src/sse/responses.rs tests. */
export function codexNativeFixtureResponse(): Response {
  const events = [
    {
      type: "response.output_item.done",
      item: {
        id: "msg_codex_fixture",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: CODEX_NATIVE_FIXTURE_RESULT }],
      },
    },
    {
      type: "response.completed",
      response: { id: "resp_codex_fixture", end_turn: true },
    },
  ];
  return new Response(
    events.map((event) =>
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    ).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/**
 * Run inside the network-none diagnostic agent. The parent must independently
 * witness the upstream request's authentication before claiming success.
 */
export async function runCodexNativeClientProbe(options: {
  mode: BrokeredCodexMode;
  capability: string;
  expectedVersion: string;
  secretHash: string;
}): Promise<{
  nativeClientCompleted: true;
  versionMatched: true;
  upstreamCredentialVisible: false;
  authenticationMode: BrokeredCodexMode;
}> {
  if (options.expectedVersion !== VERIFIED_CODEX_VERSION) {
    throw new Error(
      "Codex native fixture contract must be reverified for this version",
    );
  }
  const root = await Deno.makeTempDir({ prefix: "codex-broker-native-" });
  let gateway: ReturnType<typeof serveCodexAgentGateway> | undefined;
  try {
    gateway = serveCodexAgentGateway({
      mode: options.mode,
      capability: options.capability,
    });
    const launch = buildBrokeredCodexLaunch({
      mode: options.mode,
      capability: options.capability,
      baseUrl: gateway.baseUrl,
      homeDir: root,
      codexHome: `${root}/codex`,
    });
    if (
      await countSyntheticCredentialMatches(
        Object.values(launch.env).join("\n") + launch.configToml,
        options.secretHash,
      ) !== 0
    ) {
      throw new Error(
        "Native Codex configuration contains the upstream credential",
      );
    }
    await Deno.mkdir(launch.env.CODEX_HOME!, { mode: 0o700 });
    await Deno.writeTextFile(
      `${launch.env.CODEX_HOME}/config.toml`,
      launch.configToml,
      { mode: 0o600 },
    );
    const invoke = (args: string[]) =>
      new Deno.Command("/usr/local/bin/codex", {
        args,
        env: launch.env,
        clearEnv: true,
        cwd: root,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(45_000),
      }).output();
    const version = await invoke(["--version"]);
    if (
      !version.success ||
      new TextDecoder().decode(version.stdout).trim() !==
        `codex-cli ${options.expectedVersion}`
    ) {
      throw new Error(
        "Native Codex version does not match the provider manifest",
      );
    }
    const result = await invoke([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-rules",
      "--strict-config",
      // The diagnostic container supplies the same external boundary as the
      // production Codex executor; no container capability/profile is relaxed.
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5",
      "-c",
      `model_providers.${launch.providerId}.request_max_retries=0`,
      "-c",
      `model_providers.${launch.providerId}.stream_max_retries=0`,
      "Return the synthetic gateway fixture response without using tools.",
    ]);
    await assertCodexNativeOutput(result, options.secretHash);
    return {
      nativeClientCompleted: true,
      versionMatched: true,
      upstreamCredentialVisible: false,
      authenticationMode: options.mode,
    };
  } finally {
    try {
      await gateway?.close();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
}
