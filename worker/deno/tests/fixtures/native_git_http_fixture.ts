/** Trusted-side synthetic upstream; never execute this fixture in the agent. */
import { GITHUB_GIT_UPSTREAM } from "../../lib/credential_broker_policy.ts";

async function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  input?: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const child = new Deno.Command("git", {
    args,
    cwd,
    env,
    clearEnv: true,
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(20_000),
  }).spawn();
  if (input) {
    const writer = child.stdin.getWriter();
    await writer.write(input);
    await writer.close();
  }
  const result = await child.output();
  if (!result.success) throw new Error("Synthetic Git backend failed");
  return result.stdout;
}

export async function createNativeGitHttpFixture(options: {
  rootDir: string;
  upstreamToken: string;
  onRequest?: () => Promise<void>;
}): Promise<{
  handle: (request: Request) => Promise<Response>;
  witness: {
    authenticatedRequests: number;
    discoveries: number;
    fetches: number;
  };
  mainOid: string;
}> {
  const { rootDir } = options;
  await Deno.mkdir(`${rootDir}/fixture`, { recursive: true });
  const seed = `${rootDir}/seed`;
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: rootDir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  await runGit(["init", "--initial-branch=main", seed], rootDir, env);
  await runGit(["config", "user.name", "Native Git fixture"], seed, env);
  await runGit(["config", "user.email", "fixture@example.invalid"], seed, env);
  await runGit(["config", "commit.gpgsign", "false"], seed, env);
  await runGit(["config", "core.hooksPath", "/dev/null"], seed, env);
  await Deno.writeTextFile(`${seed}/fixture.txt`, "fixture-native-git-main\n");
  await runGit(["add", "fixture.txt"], seed, env);
  await runGit(["commit", "-m", "Native Git fixture main"], seed, env);
  const mainOid = new TextDecoder().decode(
    await runGit(["rev-parse", "HEAD"], seed, env),
  ).trim();
  await runGit(["checkout", "-b", "fixture-next"], seed, env);
  await Deno.writeTextFile(
    `${seed}/fixture.txt`,
    "fixture-native-git-fetched\n",
  );
  await runGit(
    ["commit", "-am", "Native Git fixture second branch"],
    seed,
    env,
  );
  const bare = `${rootDir}/fixture/allowed.git`;
  await runGit(["clone", "--bare", seed, bare], rootDir, env);
  await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], bare, env);
  await runGit(["config", "http.receivepack", "false"], bare, env);
  const expected = `Basic ${btoa(`x-access-token:${options.upstreamToken}`)}`;
  const witness = { authenticatedRequests: 0, discoveries: 0, fetches: 0 };
  return {
    witness,
    mainOid,
    async handle(request) {
      const url = new URL(request.url);
      const discovery = request.method === "GET" &&
        url.pathname === "/fixture/allowed.git/info/refs" &&
        url.search === "?service=git-upload-pack";
      const fetch = request.method === "POST" &&
        url.pathname === "/fixture/allowed.git/git-upload-pack" &&
        url.search === "";
      if (
        url.origin !== GITHUB_GIT_UPSTREAM || (!discovery && !fetch) ||
        request.headers.get("authorization") !== expected
      ) {
        return new Response("Synthetic Git upstream denied\n", { status: 403 });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      const protocol = request.headers.get("git-protocol");
      const cgi = await runGit(["http-backend"], rootDir, {
        ...env,
        GIT_PROJECT_ROOT: rootDir,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(body.length),
        SERVER_PROTOCOL: "HTTP/1.1",
        REMOTE_ADDR: "127.0.0.1",
        REMOTE_USER: "x-access-token",
        ...(protocol ? { GIT_PROTOCOL: protocol } : {}),
      }, body);
      let boundary = -1;
      for (let i = 0; i + 3 < cgi.length; i++) {
        if (
          cgi[i] === 13 && cgi[i + 1] === 10 && cgi[i + 2] === 13 &&
          cgi[i + 3] === 10
        ) {
          boundary = i;
          break;
        }
      }
      if (boundary < 0) {
        throw new Error("Synthetic Git CGI headers were missing");
      }
      const headers = new Headers();
      let status = 200;
      for (
        const line of new TextDecoder().decode(cgi.slice(0, boundary)).split(
          "\r\n",
        )
      ) {
        const colon = line.indexOf(":");
        if (colon < 1) {
          throw new Error("Synthetic Git CGI header was malformed");
        }
        const key = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else headers.set(key, value);
      }
      witness.authenticatedRequests++;
      if (discovery) witness.discoveries++;
      else witness.fetches++;
      await options.onRequest?.();
      return new Response(cgi.slice(boundary + 4), { status, headers });
    },
  };
}
