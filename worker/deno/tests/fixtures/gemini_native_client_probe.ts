/** Real pinned Gemini client fixture for the separate-container diagnostic. */
import {
  buildBrokeredGeminiEnvironment,
  serveGeminiAgentGateway,
} from "../../lib/gemini_agent_gateway.ts";
import { countSyntheticCredentialMatches } from "../support/agent_container_evidence.ts";

/** Synthetic upstream text; the trusted fixture must witness a Gemini call too. */
export const GEMINI_NATIVE_FIXTURE_RESULT = "Gemini broker fixture complete.";

/** The native SDK consumes standard Gemini responses, including incremental SSE. */
export function geminiNativeFixtureResponse(stream: boolean): Response {
  const result = {
    candidates: [{
      content: {
        role: "model",
        parts: [{ text: GEMINI_NATIVE_FIXTURE_RESULT }],
      },
      finishReason: "STOP",
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: 1,
      candidatesTokenCount: 5,
      totalTokenCount: 6,
    },
    modelVersion: "gemini-2.5-flash",
  };
  return stream
    ? new Response(`data: ${JSON.stringify(result)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
    : Response.json(result);
}

/**
 * Run only inside the network-none diagnostic agent. The caller records the
 * broker-side credential witness separately; this process never receives it.
 * expectedVersion comes from the checked-in container provider manifest.
 */
export async function runGeminiNativeClientProbe(options: {
  capability: string;
  expectedVersion: string;
  secretHash: string;
}): Promise<{
  nativeClientCompleted: true;
  versionMatched: true;
  upstreamCredentialVisible: false;
}> {
  const root = await Deno.makeTempDir({ prefix: "gemini-broker-native-" });
  let gateway: ReturnType<typeof serveGeminiAgentGateway> | undefined;
  try {
    gateway = serveGeminiAgentGateway({ capability: options.capability });
    const env = buildBrokeredGeminiEnvironment({
      capability: options.capability,
      baseUrl: gateway.baseUrl,
      homeDir: root,
    });
    if (
      await countSyntheticCredentialMatches(
        Object.values(env).join("\n"),
        options.secretHash,
      ) !== 0
    ) {
      throw new Error(
        "Native Gemini environment contains the upstream credential",
      );
    }
    await Deno.mkdir(`${root}/.gemini`, { mode: 0o700 });
    await Deno.writeTextFile(
      `${root}/.gemini/settings.json`,
      JSON.stringify({
        security: { auth: { selectedType: "gateway" } },
        telemetry: { enabled: false },
        general: { disableAutoUpdate: true, disableUpdateNag: true },
      }),
    );
    const invoke = (args: string[]) =>
      new Deno.Command("/usr/local/bin/gemini", {
        args,
        env,
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
        options.expectedVersion
    ) {
      throw new Error(
        "Native Gemini version does not match the provider manifest",
      );
    }
    const result = await invoke([
      "--model",
      "gemini-2.5-flash",
      "--prompt",
      "Return the synthetic gateway fixture response without tools.",
      "--output-format",
      "json",
    ]);
    if (!result.success) {
      throw new Error(`Native Gemini fixture failed with exit ${result.code}`);
    }
    if (
      await countSyntheticCredentialMatches(
        new TextDecoder().decode(result.stdout) +
          new TextDecoder().decode(result.stderr),
        options.secretHash,
      ) !== 0
    ) throw new Error("Native Gemini output contains the upstream credential");
    let parsed: { response?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(result.stdout));
    } catch {
      throw new Error("Native Gemini fixture did not emit JSON");
    }
    if (parsed.response !== GEMINI_NATIVE_FIXTURE_RESULT) {
      throw new Error(
        "Native Gemini fixture did not return the broker response",
      );
    }
    return {
      nativeClientCompleted: true,
      versionMatched: true,
      upstreamCredentialVisible: false,
    };
  } finally {
    try {
      await gateway?.close();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
}
