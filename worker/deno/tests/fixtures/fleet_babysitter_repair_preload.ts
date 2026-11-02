/** Offline boundaries for the real babysitter CLI's repair orchestration. */
export {};

const root = Deno.env.get("BABYSITTER_REPAIR_FIXTURE");
if (!root) throw new Error("BABYSITTER_REPAIR_FIXTURE is required");

const pr = {
  state: "OPEN",
  number: 1,
  title: "repair fixture",
  author: { login: "fleet" },
  headRefName: "feature",
  headRefOid: "abc",
  baseRefName: "main",
  isCrossRepository: false,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  statusCheckRollup: [{ conclusion: "FAILURE" }],
};
let lock: Record<string, unknown> | undefined;

function commandOutput(
  executable: string,
  options: Deno.CommandOptions,
): string {
  const args = options.args?.map(String) ?? [];
  if (executable === "gh") {
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify(pr);
    if (args[0] === "issue" && args[1] === "comment") {
      lock = {
        id: 100,
        body: args[args.indexOf("--body") + 1],
        created_at: new Date().toISOString(),
        author: "babysitter[bot]",
      };
      return "https://github.com/owner/repo/issues/1#issuecomment-100";
    }
    if (args.includes("repos/owner/repo/issues/1/comments?per_page=100")) {
      return JSON.stringify(lock ? [lock] : []);
    }
    if (
      args.includes("DELETE") &&
      args.includes("repos/owner/repo/issues/comments/100")
    ) {
      lock = undefined;
      return "";
    }
    if (args[0] === "repo" && args[1] === "clone") return "";
    // No cancelled runs, so the failed-CI repair proceeds to the agent.
    if (
      args[0] === "api" &&
      args[1]?.startsWith("repos/owner/repo/actions/runs?head_sha=abc")
    ) {
      return "[]";
    }
  }
  if (executable === "git") {
    if (args.includes("fetch") || args.includes("checkout")) return "";
    if (args.includes("rev-parse") && args.includes("HEAD")) return "abc";
    if (args.includes("status") && args.includes("--porcelain")) return "";
  }
  if (executable === "rtk" && args[0] === "--version") return "rtk 1";
  if (executable === "codex") {
    if (args[0] === "--version") return "codex-cli 0.164.0";
    if (args[0] === "exec") {
      Deno.writeTextFileSync(`${root}/agent-spawn.json`, JSON.stringify(args));
      Deno.writeTextFileSync(
        args[args.indexOf("--output-last-message") + 1]!,
        "BABYSITTER_READY\n",
      );
      return "";
    }
  }
  throw new Error(
    `Unexpected fixture command: ${executable} ${args.join(" ")}`,
  );
}

// No real subprocess can escape the fixture, including gh writes or Codex.
Deno.Command = class {
  constructor(
    private executable: string,
    private options: Deno.CommandOptions = {},
  ) {}

  async output(): Promise<Deno.CommandOutput> {
    return {
      success: true,
      code: 0,
      signal: null,
      stdout: new TextEncoder().encode(
        commandOutput(this.executable, this.options),
      ),
      stderr: new Uint8Array(),
    };
  }

  spawn(): Deno.ChildProcess {
    const output = this.output();
    return {
      output: () => output,
      status: output.then(({ success, code, signal }) => ({
        success,
        code,
        signal,
      })),
    } as Deno.ChildProcess;
  }
} as unknown as typeof Deno.Command;

globalThis.fetch = (input, init) => {
  const url = String(input);
  if (url === "https://api.github.com/app") {
    return Promise.resolve(Response.json({ id: 123, slug: "babysitter" }));
  }
  if (url === "https://api.github.com/app/installations/456/access_tokens") {
    const request = JSON.parse(String(init?.body ?? "{}"));
    return Promise.resolve(Response.json({
      token: "ghs_fixture_token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: request.permissions ?? { contents: "write" },
    }, { status: 201 }));
  }
  if (
    url ===
      "https://api.github.com/installation/repositories?per_page=100&page=1"
  ) {
    return Promise.resolve(Response.json({
      total_count: 1,
      repositories: [{ full_name: "owner/repo" }],
    }));
  }
  throw new Error(`Unexpected fixture request: ${url}`);
};

// GitHub consistency is immediate in the in-memory lock fixture.
globalThis.setTimeout = new Proxy(globalThis.setTimeout, {
  apply(target, receiver, [handler, delay, ...args]) {
    return Reflect.apply(target, receiver, [
      handler,
      delay === 3_000 ? 0 : delay,
      ...args,
    ]);
  },
});
