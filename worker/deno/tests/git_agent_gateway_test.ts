import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  buildBrokeredGitEnvironment,
  createGitAgentGateway,
  gitAgentReadConfig,
  serveGitAgentGateway,
} from "../lib/git_agent_gateway.ts";

const capability = "fixture-git-local-capability-0123456789abcdef";
const baseUrl = "http://127.0.0.1:43123";

Deno.test("Git gateway translates native read paths and only carries protocol headers plus its opaque capability", async () => {
  const calls: Request[] = [];
  const gateway = createGitAgentGateway({
    capability,
    forward: (request) => {
      calls.push(request);
      return Promise.resolve(
        new Response("native packet bytes", {
          headers: { "content-type": "application/x-git-upload-pack-result" },
        }),
      );
    },
  });
  for (const repository of ["allowed", "allowed.git"]) {
    const result = await gateway(
      new Request(
        `${baseUrl}/fixture/${repository}/info/refs?service=git-upload-pack`,
        {
          headers: {
            authorization: "Bearer caller-secret",
            cookie: "private",
            "x-approval": "approved",
            "git-protocol": "version=2",
          },
        },
      ),
    );
    assertEquals(await result.text(), "native packet bytes");
    const sent = calls.at(-1)!;
    assertEquals(
      sent.url,
      "http://broker.invalid/git/fixture/allowed.git/info/refs?service=git-upload-pack",
    );
    assertEquals([...sent.headers], [
      ["authorization", `Bearer ${capability}`],
      ["git-protocol", "version=2"],
    ]);
    assertEquals(sent.redirect, "manual");
  }
  const bytes = new Uint8Array([0, 255, 1, 32]);
  const response = await gateway(
    new Request(`${baseUrl}/fixture/allowed.git/git-upload-pack`, {
      method: "POST",
      body: bytes,
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
        "git-protocol": "version=2",
      },
    }),
  );
  await response.body?.cancel();
  const sent = calls.at(-1)!;
  assertEquals(new Uint8Array(await sent.arrayBuffer()), bytes);
  assertEquals(sent.headers.get("content-encoding"), "gzip");
  assertEquals(
    sent.headers.get("content-type"),
    "application/x-git-upload-pack-request",
  );
  assertEquals(sent.method, "POST");
});

Deno.test("Git read gateway refuses write discovery, push and malformed endpoints before forwarding", async () => {
  let calls = 0;
  const gateway = createGitAgentGateway({
    capability,
    forward: () => {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  for (
    const [path, method] of [
      ["fixture/allowed.git/info/refs?service=git-receive-pack", "GET"],
      ["fixture/allowed.git/git-receive-pack", "POST"],
      ["fixture/allowed.git/info/refs?service=git-upload-pack&extra=1", "GET"],
      ["fixture/allowed.git/info/refs", "GET"],
      ["fixture/allowed.git/info/refs?service=git-upload-pack", "POST"],
      ["fixture/allowed.git/git-upload-pack", "GET"],
      ["fixture/allowed.git/git-upload-pack?extra=1", "POST"],
      ["fixture/allowed.git/git-upload-pack#fragment", "POST"],
      ["fixture/allowed.git/objects/aa/bb", "GET"],
      ["fixture/allowed.git//info/refs?service=git-upload-pack", "GET"],
      ["fixture/allowed%2egit/info/refs?service=git-upload-pack", "GET"],
      [
        "https://github.com/fixture/allowed.git/info/refs?service=git-upload-pack",
        "GET",
      ],
    ]
  ) {
    const response = await gateway(
      new Request(`${baseUrl}/${path}`, { method }),
    );
    assertEquals(response.status, 403, path);
    assertEquals(await response.text(), "Git read route denied\n");
  }
  assertEquals(calls, 0);
  assertThrows(() =>
    createGitAgentGateway({
      capability: "short",
      forward: () => Promise.resolve(new Response()),
    })
  );
});

Deno.test("Git gateway refuses and cancels redirects, scrubs forwarding errors and carries cancellation", async () => {
  let cancelled = false;
  const redirect = createGitAgentGateway({
    capability,
    forward: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 302,
            headers: { location: "https://outside.invalid/secret" },
          },
        ),
      ),
  });
  const request = () =>
    new Request(
      `${baseUrl}/fixture/allowed.git/info/refs?service=git-upload-pack`,
    );
  const response = await redirect(request());
  assertEquals(response.status, 502);
  assertEquals(response.headers.get("location"), null);
  assertEquals(await response.text(), "Git broker redirect denied\n");
  assert(cancelled);
  const throwing = createGitAgentGateway({
    capability,
    forward: () => Promise.reject(new Error("private upstream material")),
  });
  const failed = await throwing(request());
  assertEquals(failed.status, 502);
  assertEquals(await failed.text(), "Git broker transport unavailable\n");
  const abort = new AbortController();
  abort.abort();
  const cancelledGateway = createGitAgentGateway({
    capability,
    forward: (input) => {
      assert(input.signal.aborted);
      return Promise.resolve(new Response("cancelled", { status: 408 }));
    },
  });
  assertEquals(
    (await cancelledGateway(new Request(request(), { signal: abort.signal })))
      .status,
    408,
  );
});

Deno.test("Git adapter config rewrites only canonical GitHub HTTPS and isolates native config without credentials", async () => {
  for (
    const value of [
      "https://127.0.0.1:43123",
      "http://localhost:43123",
      "http://127.0.0.1",
      "http://user@127.0.0.1:43123",
      "http://:password@127.0.0.1:43123",
      "http://127.0.0.1:43123/path",
      "http://127.0.0.1:43123/?x=1",
      "http://127.0.0.1:43123/#x",
    ]
  ) assertThrows(() => gitAgentReadConfig(value));
  for (
    const path of [
      "relative",
      "/tmp/../private",
      "/tmp/unsafe\nconfig",
      '/tmp/quote"file',
    ]
  ) {
    assertThrows(() =>
      buildBrokeredGitEnvironment({
        homeDir: path,
        configFile: "/tmp/gitconfig",
      })
    );
    assertThrows(() =>
      buildBrokeredGitEnvironment({ homeDir: "/tmp/home", configFile: path })
    );
  }
  const root = await Deno.makeTempDir({ prefix: "vibe-git-config-" });
  try {
    const configFile = `${root}/gitconfig`;
    await Deno.writeTextFile(configFile, gitAgentReadConfig(baseUrl));
    const env = buildBrokeredGitEnvironment({ homeDir: root, configFile });
    assertEquals(env, {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_GLOBAL: configFile,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    const run = async (args: string[]) => {
      const result = await new Deno.Command("git", {
        args,
        cwd: root,
        clearEnv: true,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
      return new TextDecoder().decode(result.stdout).trim();
    };
    await run(["init", "."]);
    await run([
      "remote",
      "add",
      "origin",
      "https://github.com/fixture/allowed.git",
    ]);
    assertEquals(
      await run(["remote", "get-url", "origin"]),
      `${baseUrl}/fixture/allowed.git`,
    );
    await run([
      "remote",
      "set-url",
      "origin",
      "https://outside.invalid/fixture/allowed.git",
    ]);
    assertEquals(
      await run(["remote", "get-url", "origin"]),
      "https://outside.invalid/fixture/allowed.git",
    );
    assertEquals(await run(["config", "--get", "credential.helper"]), "");
    assertEquals(
      await run(["config", "--get", "http.followRedirects"]),
      "false",
    );
    assertEquals(await run(["config", "--get", "http.proxy"]), "");
    assertEquals(await run(["config", "--get", "protocol.allow"]), "never");
    assertEquals(
      await run(["config", "--get", "protocol.http.allow"]),
      "always",
    );
    const forbidden = await assertRejects(() =>
      run(["ls-remote", "https://outside.invalid/fixture/allowed.git"])
    );
    assertStringIncludes(String(forbidden), "transport 'https' not allowed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Git gateway production wrapper binds loopback and fixed UDS and closes both resources on success and failure", async () => {
  const originalServe = Deno.serve;
  const originalClient = Deno.createHttpClient;
  const originalFetch = globalThis.fetch;
  let closed = 0;
  let shutdown = 0;
  let startFails = false;
  let stopFails = false;
  let handler!: (request: Request) => Promise<Response>;
  const client = {
    close() {
      closed++;
    },
  } as Deno.HttpClient;
  try {
    Deno.createHttpClient = ((options: unknown) => {
      assertEquals(options, {
        proxy: { transport: "unix", path: "/run/broker/broker.sock" },
      });
      return client;
    }) as typeof Deno.createHttpClient;
    Deno.serve = ((
      options: { hostname: string; port: number; onListen: () => void },
      serve: typeof handler,
    ) => {
      assertEquals(options.hostname, "127.0.0.1");
      assertEquals(options.port, 0);
      options.onListen();
      if (startFails) throw new Error("fixture start failure");
      handler = serve;
      return {
        addr: { port: 43123 },
        async shutdown() {
          shutdown++;
          if (stopFails) throw new Error("fixture stop failure");
        },
      };
    }) as unknown as typeof Deno.serve;
    globalThis.fetch =
      ((_request: Request, options: { client: Deno.HttpClient }) => {
        assertEquals(options.client, client);
        return Promise.resolve(new Response("forwarded"));
      }) as typeof fetch;
    const gateway = serveGitAgentGateway({ capability });
    assertEquals(gateway.baseUrl, baseUrl);
    assertEquals(
      await (await handler(
        new Request(
          `${baseUrl}/fixture/allowed.git/info/refs?service=git-upload-pack`,
        ),
      )).text(),
      "forwarded",
    );
    await gateway.close();
    assertEquals({ closed, shutdown }, { closed: 1, shutdown: 1 });
    startFails = true;
    assertThrows(
      () => serveGitAgentGateway({ capability }),
      Error,
      "fixture start failure",
    );
    assertEquals(closed, 2);
    startFails = false;
    stopFails = true;
    const stop = serveGitAgentGateway({ capability });
    await assertRejects(() => stop.close(), Error, "fixture stop failure");
    assertEquals({ closed, shutdown }, { closed: 3, shutdown: 2 });
    assertThrows(() => serveGitAgentGateway({ capability: "short" }));
    assertEquals(closed, 3);
  } finally {
    Deno.serve = originalServe;
    Deno.createHttpClient = originalClient;
    globalThis.fetch = originalFetch;
  }
});
