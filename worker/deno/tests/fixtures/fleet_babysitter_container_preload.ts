/**
 * Offline boundaries for the real babysitter CLI's container repair (Issue
 * #4770): `gh`, `git` against the repair clone and the container runtime are
 * faked, so the CLI runs end to end with no network, no container and no
 * credentials. The worker checkout is read through real git, as the repair
 * snapshots it.
 */
export {};

const root = Deno.env.get("BABYSITTER_REPAIR_FIXTURE");
if (!root) throw new Error("BABYSITTER_REPAIR_FIXTURE is required");
const realCheckoutEnv = Deno.env.get("BABYSITTER_REAL_CHECKOUT");
if (!realCheckoutEnv) throw new Error("BABYSITTER_REAL_CHECKOUT is required");
const realCheckout: string = realCheckoutEnv;
const RealCommand = Deno.Command;

// Exercise a real pending open in the production CLI child process.
if (Deno.env.get("BABYSITTER_BLOCK_OPEN") === "1") {
  const originalOpen = Deno.open;
  Deno.open = async (path, options) => {
    if (String(path).endsWith("/.babysitter-pr-body")) {
      await Deno.rename(`${root}/blocked-fifo`, path);
      return await originalOpen(path, { read: true });
    }
    return await originalOpen(path, options);
  };
}

const pr = {
  state: "OPEN",
  number: 1,
  title: "repair fixture",
  body: "A description with no worker marker.",
  closingIssuesReferences: [],
  author: { login: "fleet" },
  headRefName: "feature",
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  isCrossRepository: false,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  statusCheckRollup: [{ conclusion: "FAILURE" }],
  // Already armed, so the repair does not arm auto-merge; arming has its own
  // tests in fleet_pr_babysitter_single_push_test.ts.
  autoMergeRequest: { enabledAt: null, mergeMethod: "MERGE" },
};
let lock: Record<string, unknown> | undefined;
const attempts: Record<string, unknown>[] = [];

function commandOutput(
  executable: string,
  options: Deno.CommandOptions,
): string {
  const args = options.args?.map(String) ?? [];
  if (executable === "gh") {
    if (args[0] === "pr" && args[1] === "edit") {
      const path = args[args.indexOf("--body-file") + 1]!;
      Deno.writeTextFileSync(`${root}/body-file`, path);
      pr.body = Deno.readTextFileSync(path);
      Deno.writeTextFileSync(
        `${root}/applied-body`,
        pr.body,
      );
      return "";
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify(pr);
    if (
      args[0] === "api" &&
      args[1] === "repos/owner/repo/issues/1/comments" &&
      args.includes("--method") && args.includes("POST")
    ) {
      const field = args[args.indexOf("--field") + 1]!;
      const attempt = {
        id: 101,
        body: field.slice("body=".length),
        created_at: new Date().toISOString(),
        user: { login: "babysitter[bot]" },
      };
      attempts.push(attempt);
      Deno.writeTextFileSync(`${root}/attempt-marker.txt`, attempt.body);
      return JSON.stringify({ id: 101 });
    }
    if (
      args[0] === "api" &&
      args[1] === "repos/owner/repo/issues/1/comments" &&
      args.includes("--paginate") && args.includes("--slurp")
    ) return JSON.stringify([attempts]);
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
    if (args.join(" ") === "config get git_protocol -h github.com") {
      return "ssh\n";
    }
    // No cancelled runs, so the failed-CI repair proceeds to the agent.
    if (
      args[0] === "api" &&
      args[1]?.startsWith(
        `repos/owner/repo/actions/runs?head_sha=${"a".repeat(40)}`,
      )
    ) {
      return "[]";
    }
    // No failing check run, so the repair proceeds as before.
    if (
      args[0] === "api" &&
      args[1]?.startsWith(
        `repos/owner/repo/commits/${"a".repeat(40)}/check-runs?per_page=100`,
      )
    ) {
      return JSON.stringify({ total: 0, runs: [] });
    }
  }
  // Liveness probe for interrupted babysitter clones; success means "owner alive", so nothing is removed.
  if (executable === "/bin/kill" && args[0] === "-0") return "";
  if (executable === "git") {
    if (args.includes("maintenance")) return "";
    if (args[0] === "clone") {
      Deno.writeTextFileSync(`${root}/clone-calls.log`, args.join(" ") + "\n", {
        append: true,
      });
      // The mirror clone's last argv element is the directory git creates.
      if (args.includes("--bare")) {
        Deno.mkdirSync(args[args.length - 1]!);
      } else {
        // The repair clone has the `.git` directory the config reset checks.
        Deno.mkdirSync(`${args[args.length - 1]!}/.git`, { recursive: true });
      }
      return "";
    }
    if (args.slice(0, 3).join(" ") === "remote set-url origin") {
      Deno.writeTextFileSync(`${root}/origin-url`, args[3]!);
      return "";
    }
    if (args.includes("fetch") || args.includes("checkout")) return "";
    // The tree-safety check: HEAD and the index hold no gitlinks or refs/replace.
    if (
      args.includes("ls-tree") || args.includes("ls-files") ||
      args.includes("for-each-ref")
    ) return "";
    // The repair clone's byproduct excludes (Issue #4827); git answers relative.
    if (args.join(" ") === "rev-parse --git-path info/exclude") {
      return ".git/info/exclude\n";
    }
    // Exit 0: the base is already in the head, so the repair merges nothing.
    if (args.includes("merge-base") && args.includes("--is-ancestor")) {
      return "";
    }
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      return "a".repeat(40);
    }
    if (args.includes("status") && args.includes("--porcelain")) return "";
  }
  // Disk headroom check for the clone: plenty free.
  if (executable === "df") {
    return "Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 1000000000 1 999999999 1% /\n";
  }
  if (executable === "rtk" && args[0] === "--version") return "rtk 1";
  if (executable === "podman" || executable === "docker") {
    // The runtime: the image is built, and `run` is the in-container agent,
    // which leaves its completion response and a proposed PR description.
    if (args[0] === "image" && args[1] === "inspect") return "";
    // The egress proxy sidecar reports that it is listening.
    if (args[0] === "logs") return "[EGRESS_PROXY] listening\n";
    if (args[0] === "run") {
      if (args.includes("--entrypoint") && args.includes("bash")) {
        if (
          Deno.env.get("BABYSITTER_WATCH_PROBES") === "1" &&
          args.at(-1)?.includes("$CHROMIUM_PATH")
        ) {
          Deno.writeTextFileSync(`${root}/browser-probes`, "probe\n", {
            append: true,
          });
        }
        return "<html><head></head><body></body></html>\n";
      }
      const mount = args.find((arg) => /:\/babysitter\/clone(:|$)/.test(arg));
      // The egress proxy sidecar is also a `run`; only the agent mounts the clone.
      if (!mount) return "";
      const clone = mount.slice(0, mount.indexOf(":/babysitter/clone"))
        .replace(/^.*=/, "");
      Deno.writeTextFileSync(
        `${clone}/.babysitter-response`,
        "BABYSITTER_READY\n",
      );
      Deno.writeTextFileSync(
        `${clone}/.babysitter-pr-body`,
        "Reviewed PR description\n",
      );
      Deno.writeTextFileSync(`${root}/runtime-run.json`, JSON.stringify(args));
      return "";
    }
    return "";
  }
  throw new Error(
    `Unexpected fixture command: ${executable} ${args.join(" ")}`,
  );
}

// No real subprocess can escape the fixture, including gh writes or the
// container runtime. Only git and tar against the worker checkout run for real.
Deno.Command = class {
  constructor(
    private executable: string,
    private options: Deno.CommandOptions = {},
  ) {
    const args = options.args?.map(String) ?? [];
    if (
      (executable === "git" || executable === "tar") &&
      (options.cwd === realCheckout || args.includes(realCheckout))
    ) {
      return new RealCommand(executable, options) as never;
    }
  }

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
    // Readable streams that carry the faked output, as a real child's do.
    const stream = (pick: "stdout" | "stderr") =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue((await output)[pick]);
          controller.close();
        },
      });
    return {
      pid: 1,
      stdin: new WritableStream<Uint8Array>(),
      stdout: stream("stdout"),
      stderr: stream("stderr"),
      output: () => output,
      status: output.then(({ success, code, signal }) => ({
        success,
        code,
        signal,
      })),
      kill() {},
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as Deno.ChildProcess;
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
    if (Deno.env.get("BABYSITTER_WATCH_PROBES") === "1") {
      throw new Error("fixture stops at access discovery");
    }
    return Promise.resolve(Response.json({
      total_count: 1,
      repositories: [{ full_name: "owner/repo" }],
    }));
  }
  throw new Error(`Unexpected fixture request: ${url}`);
};

// GitHub consistency is immediate in the in-memory lock fixture.
let watchWaits = 0;
globalThis.setTimeout = new Proxy(globalThis.setTimeout, {
  apply(target, receiver, [handler, delay, ...args]) {
    if (delay === 300_000 && Deno.env.get("BABYSITTER_WATCH_PROBES") === "1") {
      if (++watchWaits === 2) Deno.exit(0);
      delay = 0;
    }
    return Reflect.apply(target, receiver, [
      handler,
      delay === 3_000 ? 0 : delay,
      ...args,
    ]);
  },
});
