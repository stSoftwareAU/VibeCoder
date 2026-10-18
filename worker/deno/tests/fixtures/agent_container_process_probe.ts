/** Synthetic processes for the separate-container diagnostic; no live accounts. */
import { createCredentialBroker } from "../../lib/credential_broker.ts";
import {
  buildBrokeredAnthropicEnvironment,
  serveAnthropicAgentGateway,
} from "../../lib/anthropic_agent_gateway.ts";
import {
  childEvidence,
  type Fixture,
} from "./agent_namespace_container_probe.ts";
import {
  type AgentContainerEvidence,
  type BrokerWitness,
  countSyntheticCredentialMatches,
} from "../support/agent_container_evidence.ts";
import { probeNativeGitHubClient } from "./native_github_client_probe.ts";
import {
  geminiNativeFixtureResponse,
  runGeminiNativeClientProbe,
} from "./gemini_native_client_probe.ts";

import {
  codexNativeFixtureResponse,
  runCodexNativeClientProbe,
} from "./native_codex_client_probe.ts";

const privateDirectory = "/tmp/vibe-broker-private";
const metadataPath = `${privateDirectory}/fixture.json`;
const witnessPath = `${privateDirectory}/witness.json`;

interface ContainerFixture extends Fixture {
  privatePath: string;
  secretHash: string;
  credentialRoot: string;
  nativeCapabilities: Record<"api-key" | "subscription", string>;
}

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function startBroker(credentialRoot: string): Promise<void> {
  await Deno.mkdir(privateDirectory, { mode: 0o700 });
  const secret = `synthetic-${crypto.randomUUID()}`;
  const privatePath = `${privateDirectory}/provider-credential`;
  await Deno.writeTextFile(privatePath, secret, { mode: 0o600 });
  // Put the secret in the trusted server's initial environment, so Linux
  // /proc/<pid>/environ really contains it. setenv after exec would not prove
  // that positive control because proc reports the original environment area.
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--no-lock",
      "--allow-all",
      new URL(import.meta.url).pathname,
      "broker-server",
      credentialRoot,
    ],
    clearEnv: true,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: privateDirectory,
      SYNTHETIC_UPSTREAM_SECRET: secret,
    },
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  if (!(await child.status).success) {
    throw new Error("Synthetic broker server failed");
  }
}

async function broker(credentialRoot: string): Promise<void> {
  const secret = Deno.env.get("SYNTHETIC_UPSTREAM_SECRET");
  requireFact(secret, "Synthetic broker credential was not provisioned");
  const secretHash = await sha256(secret);
  const privatePath = `${privateDirectory}/provider-credential`;
  // Keep a readable descriptor open on the trusted side: the agent's fd and
  // /proc checks must distinguish containers, not merely an unopened file.
  const credentialFile = await Deno.open(privatePath, { read: true });
  const witness: BrokerWitness & {
    nativeRequests: Record<"api-key" | "subscription", number>;
    nativeGitHubRequests: number;
    nativeGeminiRequests: number;
    nativeCodexRequests: number;
  } = {
    fileMatches:
      await sha256(await Deno.readTextFile(privatePath)) === secretHash,
    environmentMatches: await countSyntheticCredentialMatches(
      await Deno.readTextFile("/proc/self/environ"),
      secretHash,
    ) === 1,
    descriptorMatches: false,
    authenticatedRequests: 0,
    nativeRequests: { "api-key": 0, subscription: 0 },
    nativeGitHubRequests: 0,
    nativeGeminiRequests: 0,
    nativeCodexRequests: 0,
  };
  for await (const entry of Deno.readDir("/proc/self/fd")) {
    const path = `/proc/self/fd/${entry.name}`;
    try {
      if (await Deno.readLink(path) === privatePath) {
        witness.descriptorMatches =
          await sha256(await Deno.readTextFile(path)) === secretHash;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  await Deno.writeTextFile(witnessPath, JSON.stringify(witness));
  const fixtureHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const github = url.pathname.startsWith("/repos/");
    const gemini = url.pathname.startsWith("/v1beta/models/");
    const key = request.headers.get("x-api-key");
    const bearer = request.headers.get("authorization");
    if (
      gemini
        ? request.headers.get("x-goog-api-key") !== secret || bearer !== null
        : github
        ? bearer !== `Bearer ${secret}`
        : !((key === secret && bearer === null) ||
          (key === null && bearer === `Bearer ${secret}`))
    ) {
      return new Response("Synthetic authentication failed", { status: 401 });
    }
    if (
      request.headers.get("x-fixture-upstream-origin") ===
        "https://api.openai.com" && url.pathname === "/v1/responses"
    ) {
      requireFact(
        request.method === "POST" && bearer === `Bearer ${secret}`,
        "Native Codex used an invalid authenticated route",
      );
      const body = await request.json();
      requireFact(
        body.stream === true && Array.isArray(body.input),
        "Native Codex omitted streamed Responses input",
      );
      witness.nativeCodexRequests++;
      await Deno.writeTextFile(witnessPath, JSON.stringify(witness));
      return codexNativeFixtureResponse();
    }
    if (gemini) {
      const body = await request.json();
      requireFact(
        Array.isArray(body.contents),
        "Native Gemini omitted contents",
      );
      witness.nativeGeminiRequests++;
      await Deno.writeTextFile(witnessPath, JSON.stringify(witness));
      return geminiNativeFixtureResponse(
        url.pathname.endsWith(":streamGenerateContent"),
      );
    }
    if (github && url.searchParams.get("per_page") === "1") {
      witness.nativeGitHubRequests++;
      await Deno.writeTextFile(witnessPath, JSON.stringify(witness));
      return request.method === "HEAD"
        ? new Response(null, {
          headers: { "content-type": "application/json" },
        })
        : Response.json([{ number: 7, title: "fixture-native-gh-complete" }]);
    }
    const body = github ? undefined : await request.json();
    if (typeof body?.model === "string") {
      const auth = key === secret ? "api-key" : "subscription";
      if (
        auth === "subscription" &&
        !request.headers.get("anthropic-beta")?.includes("oauth-")
      ) {
        return new Response("Synthetic subscription capability missing", {
          status: 401,
        });
      }
      if (new URL(request.url).pathname.endsWith("/count_tokens")) {
        return Response.json({ input_tokens: 1 });
      }
      witness.nativeRequests[auth]++;
      await Deno.writeTextFile(witnessPath, JSON.stringify(witness));
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "fixture-native-complete" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      return new Response(
        events.map((event) =>
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        ).join(""),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    }
    witness.authenticatedRequests++;
    await Deno.writeTextFile(witnessPath, JSON.stringify(witness));
    return new Response(
      github ? "[]" : new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: fixture-"));
          controller.enqueue(new TextEncoder().encode("complete\n\n"));
          controller.close();
        },
      }),
      {
        headers: {
          "content-type": github ? "application/json" : "text/event-stream",
        },
      },
    );
  };
  const ipv4 = Deno.serve(
    { hostname: "0.0.0.0", port: 0, onListen() {} },
    fixtureHandler,
  );
  const ipv6 = Deno.serve(
    { hostname: "::", port: 0, onListen() {} },
    fixtureHandler,
  );
  const interfaces = Deno.networkInterfaces();
  const v4 = interfaces.find((item) =>
    item.family === "IPv4" && !item.address.startsWith("127.")
  )?.address;
  const v6 = interfaces.find((item) =>
    item.family === "IPv6" && item.address !== "::1" &&
    !item.address.startsWith("fe80:")
  )?.address;
  requireFact(
    v4 && v6,
    "Disposable bridge must supply non-loopback IPv4 and IPv6 addresses",
  );
  const fixture: ContainerFixture = {
    ipv4: { hostname: v4, port: ipv4.addr.port },
    ipv6: { hostname: v6, port: ipv6.addr.port },
    socket: "/run/broker/broker.sock",
    capability: crypto.randomUUID().replaceAll("-", ""),
    privatePath,
    secretHash,
    credentialRoot,
    nativeCapabilities: {
      "api-key": crypto.randomUUID().replaceAll("-", ""),
      subscription: crypto.randomUUID().replaceAll("-", ""),
    },
  };
  const createHandler = (
    capability: string,
    claudeAuthentication: "api-key" | "bearer",
  ) =>
    createCredentialBroker({
      capability,
      claudeAuthentication,
      credentials: {
        claude: secret,
        github: secret,
        gemini: secret,
        openai: secret,
      },
      repositories: ["fixture/allowed"],
      // The fixed-origin policy runs first. Only the test forwarding seam
      // substitutes this controlled local HTTP listener; no internet request.
      fetch(request) {
        const url = new URL(request.url);
        const forwarded = new Request(
          `http://127.0.0.1:${ipv4.addr.port}${url.pathname}${url.search}`,
          request,
        );
        forwarded.headers.set("x-fixture-upstream-origin", url.origin);
        return fetch(forwarded);
      },
    });
  const ordinaryHandler = createHandler(fixture.capability, "api-key");
  const nativeApiHandler = createHandler(
    fixture.nativeCapabilities["api-key"],
    "api-key",
  );
  const nativeSubscriptionHandler = createHandler(
    fixture.nativeCapabilities.subscription,
    "bearer",
  );
  const server = Deno.serve(
    { path: fixture.socket, onListen() {} },
    (request) => {
      // The trusted fixture configures each mode before either client runs.
      // Requests cannot choose a credential or change an existing capability.
      const auth = request.headers.get("authorization");
      const handler = auth === `Bearer ${fixture.nativeCapabilities["api-key"]}`
        ? nativeApiHandler
        : auth === `Bearer ${fixture.nativeCapabilities.subscription}`
        ? nativeSubscriptionHandler
        : ordinaryHandler;
      return handler(request);
    },
  );
  await Deno.chmod(fixture.socket, 0o600);
  await Deno.writeTextFile(metadataPath, JSON.stringify(fixture));
  console.log(
    JSON.stringify({
      phase: "broker-ready",
      kernel: Deno.osRelease(),
      arch: Deno.build.arch,
      deno: Deno.version.deno,
    }),
  );
  try {
    await server.finished;
  } finally {
    credentialFile.close();
    await Promise.all([ipv4.shutdown(), ipv6.shutdown()]);
  }
}

async function nativeClient(
  fixture: ContainerFixture,
  mode: "api-key" | "subscription",
): Promise<void> {
  requireFact(
    mode === "api-key" || mode === "subscription",
    "Unknown native authentication fixture",
  );
  const home = await Deno.makeTempDir({ prefix: "vibe-native-" });
  const gateway = serveAnthropicAgentGateway({
    service: "claude",
    capability: fixture.nativeCapabilities[mode],
  });
  try {
    const env = buildBrokeredAnthropicEnvironment({
      service: "claude",
      mode,
      capability: fixture.nativeCapabilities[mode],
      baseUrl: gateway.baseUrl,
      homeDir: home,
      configDir: `${home}/config`,
    });
    const child = new Deno.Command("/usr/local/bin/claude", {
      args: [
        "-p",
        "--output-format",
        "json",
        "--max-turns",
        "1",
        "--model",
        "haiku",
        "--tools",
        "",
        "--setting-sources",
        "",
      ],
      clearEnv: true,
      env,
      cwd: home,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(45_000),
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(
      new TextEncoder().encode("Reply with the fixture response.\n"),
    );
    await writer.close();
    const output = await child.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    requireFact(
      await countSyntheticCredentialMatches(
        stdout + stderr + Object.values(env).join("\n"),
        fixture.secretHash,
      ) === 0,
      "Native client received the planted upstream credential",
    );
    // Only synthetic client data may be printed; no live account is used.
    if (!output.success) console.error(stderr);
    requireFact(
      output.success,
      `Native Claude ${mode} fixture exited ${output.code}`,
    );
    const result = JSON.parse(stdout.trim());
    requireFact(
      result.is_error === false && result.result === "fixture-native-complete",
      `Native Claude ${mode} did not complete synthetic inference`,
    );
    console.log(
      JSON.stringify({
        mode,
        nativeClientCompleted: true,
        upstreamCredentialVisible: false,
      }),
    );
  } finally {
    await gateway.close();
    await Deno.remove(home, { recursive: true });
  }
}

async function agent(
  fixture: ContainerFixture,
): Promise<AgentContainerEvidence> {
  const visibility = {
    privatePathReadable: false,
    secretMatches: 0,
    processEnvironmentsRead: 0,
    regularDescriptorsRead: 0,
  };
  // The generated plaintext marker is recognised without handing the real
  // value to the agent or returning readable process/file content in logs.
  const inspectText = async (value: string) => {
    visibility.secretMatches += await countSyntheticCredentialMatches(
      value,
      fixture.secretHash,
    );
  };
  await inspectText(Object.values(Deno.env.toObject()).join("\n"));
  for (const prefix of ["", "/proc/self/root", "/proc/1/root"]) {
    try {
      const text = await Deno.readTextFile(`${prefix}${fixture.privatePath}`);
      visibility.privatePathReadable = true;
      await inspectText(text);
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound ||
          error instanceof Deno.errors.PermissionDenied)
      ) throw error;
    }
  }
  // A known regular descriptor proves the scan actually reads descriptors.
  // Pipes/devices are excluded so this diagnostic cannot block on stdin.
  const positiveDescriptor = await Deno.open(new URL(import.meta.url), {
    read: true,
  });
  try {
    for await (const process of Deno.readDir("/proc")) {
      if (!/^\d+$/.test(process.name)) continue;
      try {
        await inspectText(
          await Deno.readTextFile(`/proc/${process.name}/environ`),
        );
        visibility.processEnvironmentsRead++;
        for await (const entry of Deno.readDir(`/proc/${process.name}/fd`)) {
          const path = `/proc/${process.name}/fd/${entry.name}`;
          try {
            const stat = await Deno.stat(path);
            if (stat.isFile && stat.size <= 1024 * 1024) {
              await inspectText(await Deno.readTextFile(path));
              visibility.regularDescriptorsRead++;
            }
          } catch (error) {
            if (
              !(error instanceof Deno.errors.NotFound ||
                error instanceof Deno.errors.PermissionDenied)
            ) throw error;
          }
        }
      } catch (error) {
        if (
          !(error instanceof Deno.errors.NotFound ||
            error instanceof Deno.errors.PermissionDenied)
        ) throw error;
      }
    }
  } finally {
    positiveDescriptor.close();
  }
  const mounts = (await Deno.readTextFile("/proc/self/mountinfo")).trim().split(
    "\n",
  ).map((line) => line.split(" "));
  requireFact(
    !mounts.some((fields) =>
      fields[4] === fixture.credentialRoot ||
      fields[4]?.startsWith(`${fixture.credentialRoot}/`)
    ),
    "Credential mount is visible inside the agent",
  );
  const readOnly = (target: string) =>
    mounts.some((fields) =>
      fields[4] === target && fields[5]?.split(",").includes("ro")
    );
  return {
    ...await childEvidence(fixture),
    rootReadOnly: readOnly("/"),
    socketReadOnly: readOnly("/run/broker"),
    proxyVariablesPresent: Object.keys(Deno.env.toObject()).some((key) =>
      /^(https?|all|no)_proxy$/i.test(key)
    ),
    visibility,
  };
}

const mode = Deno.args[0];
if (mode === "broker") {
  await startBroker(Deno.args[1]!);
} else if (mode === "broker-server") {
  await broker(Deno.args[1]!);
} else if (mode === "metadata" || mode === "witness") {
  console.log(
    await Deno.readTextFile(mode === "metadata" ? metadataPath : witnessPath),
  );
} else if (mode === "control") {
  console.log(
    JSON.stringify(
      await childEvidence(JSON.parse(await Deno.readTextFile(metadataPath))),
    ),
  );
} else if (mode === "agent") {
  const fixture = JSON.parse(Deno.args[1]!) as ContainerFixture;
  console.log(JSON.stringify(await agent(fixture)));
} else if (mode === "native-client") {
  await nativeClient(
    JSON.parse(Deno.args[1]!),
    Deno.args[2] as "api-key" | "subscription",
  );
} else if (mode === "native-github") {
  const fixture = JSON.parse(Deno.args[1]!) as ContainerFixture;
  console.log(JSON.stringify(await probeNativeGitHubClient(fixture)));
} else if (mode === "native-gemini") {
  const fixture = JSON.parse(Deno.args[1]!) as ContainerFixture;
  console.log(JSON.stringify(
    await runGeminiNativeClientProbe({
      ...fixture,
      expectedVersion: Deno.args[2]!,
    }),
  ));
} else if (mode === "native-codex") {
  const fixture = JSON.parse(Deno.args[1]!) as ContainerFixture;
  console.log(JSON.stringify(
    await runCodexNativeClientProbe({
      ...fixture,
      expectedVersion: Deno.args[2]!,
    }),
  ));
} else if (mode === "broker-stopped") {
  const fixture = JSON.parse(Deno.args[1]!) as ContainerFixture;
  let refused = false;
  try {
    const connection = await Deno.connect({
      transport: "unix",
      path: fixture.socket,
    });
    connection.close();
  } catch (error) {
    if (
      !(error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.ConnectionRefused)
    ) throw error;
    refused = true;
  }
  requireFact(
    refused,
    "Stopped broker transport was still available to the agent",
  );
  console.log(JSON.stringify({ brokerTransportUnavailable: true }));
} else {
  throw new Error("Unknown separate-container probe mode");
}
