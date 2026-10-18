/**
 * Synthetic Linux namespace prerequisite probe, never a production wrapper.
 * The trusted parent alone creates a random upstream credential. All traffic
 * stays inside this throwaway container; no real account or internet call.
 */
import { createCredentialBroker } from "../../lib/credential_broker.ts";
import {
  assertNamespaceEvidence,
  type NamespaceEvidence,
} from "../support/agent_namespace_evidence.ts";

interface Fixture {
  ipv4: { hostname: string; port: number };
  ipv6: { hostname: string; port: number };
  socket: string;
  capability: string;
}

function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function childEvidence(fixture: Fixture): Promise<NamespaceEvidence> {
  const status = await Deno.readTextFile("/proc/self/status");
  const field = (name: string) => {
    const value = new RegExp(`^${name}:\\s+(\\w+)$`, "m").exec(status)?.[1];
    requireFact(value, `Missing process status field ${name}`);
    return value;
  };
  const namespaces = {} as NamespaceEvidence["namespaces"];
  for (const name of ["user", "net", "pid", "mnt"] as const) {
    namespaces[name] = await Deno.readLink(`/proc/self/ns/${name}`);
  }
  const directTcp = {} as NamespaceEvidence["directTcp"];
  for (const family of ["ipv4", "ipv6"] as const) {
    try {
      const connection = await Deno.connect(fixture[family]);
      connection.close();
      directTcp[family] = true;
    } catch (error) {
      // Only actual connection failures count as denial: a programming or
      // Deno permission error is not network containment.
      requireFact(
        error instanceof Deno.errors.ConnectionRefused ||
          error instanceof Deno.errors.NetworkUnreachable ||
          error instanceof Deno.errors.AddrNotAvailable,
        `Unexpected ${family} connection error: ${(error as Error).name}`,
      );
      directTcp[family] = false;
    }
  }
  const client = Deno.createHttpClient({
    proxy: { transport: "unix", path: fixture.socket },
  });
  try {
    const call = (path: string, authorised = true) =>
      fetch(`http://broker${path}`, {
        method: path.startsWith("/claude/") ? "POST" : "GET",
        headers: authorised
          ? { authorization: `Bearer ${fixture.capability}` }
          : {},
        body: path.startsWith("/claude/") ? "{}" : undefined,
        client,
        signal: AbortSignal.timeout(5000),
      });
    const allowed = await call("/claude/v1/messages");
    requireFact(
      allowed.status === 200,
      "Allowed synthetic model request failed",
    );
    requireFact(
      await allowed.text() === "data: fixture-complete\n\n",
      "Synthetic model stream changed",
    );
    const github = await call("/github/repos/fixture/allowed/issues");
    requireFact(github.status === 200, "Allowed synthetic GitHub read failed");
    requireFact(
      await github.text() === "[]",
      "Synthetic GitHub response changed",
    );
    for (
      const path of [
        "/github/repos/fixture/forbidden/issues",
        "/unknown/",
        "/claude/v1/messages?target=http://127.0.0.1",
      ]
    ) {
      const denied = await call(path);
      requireFact(
        denied.status === 403,
        "Disallowed broker request was accepted",
      );
      await denied.body?.cancel();
    }
    const unauthorised = await call("/claude/v1/messages", false);
    requireFact(
      unauthorised.status === 401,
      "Missing broker capability was accepted",
    );
    await unauthorised.body?.cancel();
  } finally {
    client.close();
  }
  return {
    namespaces,
    capabilities: {
      effective: field("CapEff"),
      permitted: field("CapPrm"),
      bounding: field("CapBnd"),
    },
    noNewPrivileges: Number(field("NoNewPrivs")),
    seccomp: Number(field("Seccomp")),
    directTcp,
    broker: "passed",
  };
}

async function trustedProbe(): Promise<void> {
  console.log(
    JSON.stringify({
      date: new Date().toISOString(),
      kernel: Deno.osRelease(),
      arch: Deno.build.arch,
      deno: Deno.version.deno,
    }),
  );
  const directory = await Deno.makeTempDir({ prefix: "vibe-namespace-" });
  const credential = `synthetic-${crypto.randomUUID()}`;
  const capability = crypto.randomUUID().replaceAll("-", "");
  let authenticatedRequests = 0;
  const fixtureHandler = (request: Request): Response => {
    const github = new URL(request.url).pathname.startsWith("/repos/");
    const actual = request.headers.get(github ? "authorization" : "x-api-key");
    if (actual !== (github ? `Bearer ${credential}` : credential)) {
      return new Response("Synthetic upstream authentication failed", {
        status: 401,
      });
    }
    authenticatedRequests++;
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
    { hostname: "::1", port: 0, onListen() {} },
    fixtureHandler,
  );
  const address = Deno.networkInterfaces().find((item) =>
    item.family === "IPv4" && !item.address.startsWith("127.")
  )?.address;
  requireFact(
    address,
    "No non-loopback container IPv4 address for the outside control",
  );
  const socket = `${directory}/broker.sock`;
  const broker = Deno.serve(
    { path: socket, onListen() {} },
    createCredentialBroker({
      capability,
      credentials: { claude: credential, github: credential },
      repositories: ["fixture/allowed"],
      // Test transport only: policy still selects the real fixed origin, then
      // this seam substitutes a controlled TCP listener without external DNS.
      fetch(request) {
        const upstream = new URL(request.url);
        return fetch(
          new Request(
            `http://127.0.0.1:${ipv4.addr.port}${upstream.pathname}`,
            request,
          ),
        );
      },
    }),
  );
  let brokerStopped = false;
  const fixture: Fixture = {
    ipv4: { hostname: address, port: ipv4.addr.port },
    ipv6: { hostname: "::1", port: ipv6.addr.port },
    socket,
    capability,
  };
  const input = `${directory}/fixture.json`;
  await Deno.writeTextFile(input, JSON.stringify(fixture));
  const script = new URL(import.meta.url).pathname;
  const denoArgs = [
    "run",
    "--no-config",
    "--no-lock",
    "--allow-all",
    script,
    "child",
    input,
  ];
  const run = async (isolated: boolean): Promise<NamespaceEvidence> => {
    const command = isolated ? "unshare" : Deno.execPath();
    const args = isolated
      ? [
        "--user",
        "--map-root-user",
        "--mount",
        "--net",
        "--pid",
        "--fork",
        "--mount-proc",
        "--kill-child=SIGKILL",
        "--",
        "setpriv",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--no-new-privs",
        "--",
        Deno.execPath(),
        ...denoArgs,
      ]
      : denoArgs;
    const result = await new Deno.Command(command, {
      args,
      clearEnv: true,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: directory },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(20_000),
    }).output();
    const decoder = new TextDecoder();
    if (!result.success) {
      console.log(
        JSON.stringify({
          phase: isolated ? "namespace-prerequisite" : "outside-control",
          code: result.code,
          stderr: decoder.decode(result.stderr),
        }),
      );
      throw new Error(
        isolated
          ? "Nested namespace prerequisite failed; no security-profile relaxation was attempted"
          : "Outside control failed",
      );
    }
    const evidence = JSON.parse(
      decoder.decode(result.stdout),
    ) as NamespaceEvidence;
    console.log(
      JSON.stringify({
        phase: isolated ? "isolated" : "outside-control",
        evidence,
      }),
    );
    return evidence;
  };
  try {
    for (const tool of ["unshare", "setpriv"]) {
      const version = await new Deno.Command(tool, {
        args: ["--version"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      requireFact(version.success, `${tool} version probe failed`);
      console.log(new TextDecoder().decode(version.stdout).trim());
    }
    const before = await run(false);
    let isolated: NamespaceEvidence;
    let after: NamespaceEvidence;
    try {
      isolated = await run(true);
    } finally {
      // Even a refused namespace has an after-control, so listener failure
      // cannot be mistaken for the cause of the refusal.
      after = await run(false);
      console.log(JSON.stringify({ phase: "after-control", evidence: after }));
    }
    assertNamespaceEvidence(before, isolated, after);
    requireFact(
      authenticatedRequests === 6,
      "Unexpected synthetic upstream request count",
    );
    await broker.shutdown();
    brokerStopped = true;
    const client = Deno.createHttpClient({
      proxy: { transport: "unix", path: socket },
    });
    try {
      let unavailable = false;
      try {
        await fetch("http://broker/claude/v1/messages", {
          method: "POST",
          headers: { authorization: `Bearer ${capability}` },
          body: "{}",
          client,
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        unavailable = true;
      }
      requireFact(
        unavailable,
        "Stopped broker still accepted its old capability",
      );
    } finally {
      client.close();
    }
    console.log(
      "PASS: Linux namespace prerequisite and synthetic broker transport; production integration remains unproved",
    );
  } finally {
    await Promise.all([
      ...(brokerStopped ? [] : [broker.shutdown()]),
      ipv4.shutdown(),
      ipv6.shutdown(),
    ]);
    await Deno.remove(directory, { recursive: true });
  }
}

if (import.meta.main) {
  requireFact(
    Deno.build.os === "linux",
    "This probe requires a Linux container",
  );
  if (Deno.args[0] === "child") {
    console.log(
      JSON.stringify(
        await childEvidence(JSON.parse(await Deno.readTextFile(Deno.args[1]!))),
      ),
    );
  } else {
    await trustedProbe();
  }
}
