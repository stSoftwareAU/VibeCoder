/** Offline boundaries for the real babysitter CLI's repair orchestration. */
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

export {};

const root = Deno.env.get("BABYSITTER_REPAIR_FIXTURE");
if (!root) throw new Error("BABYSITTER_REPAIR_FIXTURE is required");
const scenario = Deno.env.get("BABYSITTER_REPAIR_SCENARIO");
const repair = scenario !== undefined;
// A later pass over the same fixture continues the earlier pass's record.
const events: string[] = (() => {
  try {
    return JSON.parse(Deno.readTextFileSync(`${root}/events.json`));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return [];
  }
})();
let agentCalls = 0;
let gateCalls = 0;
let renewLock: (() => void) | undefined;
let renewalObserved: (() => void) | undefined;

function record(event: string): void {
  events.push(event);
  Deno.writeTextFileSync(`${root}/events.json`, JSON.stringify(events));
}

// Exercise the macOS orchestration on every host; the command double below
// models gate outcomes, never the operating system's sandbox enforcement.
if (repair) {
  Object.defineProperty(Deno, "build", {
    value: {
      ...Deno.build,
      os: scenario?.startsWith("linux") ? "linux" : "darwin",
    },
  });
}
const realWriteTextFile = Deno.writeTextFile;
Deno.writeTextFile = async (path, data, options) => {
  if (repair && String(path).endsWith("/pr-body.md")) {
    await realWriteTextFile(`${root}/proposed-body.md`, data);
  }
  return await realWriteTextFile(path, data, options);
};

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
  mergedAt: null,
  number: 1,
  title: "repair fixture",
  // The body-proposal scenario's live PR closes #42, so the guard must keep it.
  body: scenario === "body-proposal"
    ? "Original body\n\nCloses\n#42"
    : "A description with no worker marker.",
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
  files: [],
  // Already armed, so the repair does not arm auto-merge; arming has its own
  // tests in fleet_pr_babysitter_single_push_test.ts.
  autoMergeRequest: { enabledAt: null, mergeMethod: "MERGE" },
  labels: [],
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
      if (repair) {
        Deno.writeTextFileSync(`${root}/applied-body.md`, pr.body);
        record("body-updated");
      }
      return "";
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (repair) {
        if (args[args.indexOf("--repo") + 1] !== "owner/repo") {
          throw new Error("Repository was not selected");
        }
        const fields = args[args.indexOf("--json") + 1];
        if (fields === "body") {
          if (args[args.indexOf("--jq") + 1] !== ".body") {
            return JSON.stringify({ body: "Original body\n\nCloses\n#42" });
          }
          return "Original body\n\nCloses\n#42";
        }
        if (!fields?.split(",").every((field) => Object.hasOwn(pr, field))) {
          throw new Error("Invalid PR fields");
        }
      }
      return JSON.stringify(pr);
    }
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
    if (repair && args.includes("users/babysitter%5Bbot%5D")) {
      // The validation context must retain the home captured for this repair.
      Deno.env.set("HOME", `${root}/changed-home`);
      return "123";
    }
    if (
      repair && args.includes("PATCH") &&
      args.includes("repos/owner/repo/issues/comments/100")
    ) {
      throw new Error("fixture lease expired");
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
  }
  if (executable === "git") {
    if (args.includes("maintenance")) return "";
    if (args[0] === "clone") {
      Deno.writeTextFileSync(`${root}/clone-calls.log`, args.join(" ") + "\n", {
        append: true,
      });
      // The mirror clone's last argv element is the directory git creates.
      if (args.includes("--bare")) {
        Deno.mkdirSync(args[args.length - 1]!);
      } else if (repair) {
        const dir = args[args.length - 1]!;
        Deno.writeTextFileSync(`${dir}/quality.sh`, "#!/bin/bash\nexit 0\n");
        if (scenario === "linux-symlink") {
          Deno.renameSync(`${dir}/quality.sh`, `${dir}/gate.sh`);
          Deno.symlinkSync("gate.sh", `${dir}/quality.sh`);
        }
        if (scenario === "linux-oversized") {
          Deno.writeTextFileSync(`${dir}/quality.sh`, "x".repeat(65537));
        }
      }
      return "";
    }
    if (args.slice(0, 3).join(" ") === "remote set-url origin") {
      Deno.writeTextFileSync(`${root}/origin-url`, args[3]!);
      return "";
    }
    if (
      args.join(" ") ===
        "-c maintenance.autoDetach=false -c gc.autoDetach=false maintenance run --auto"
    ) return "";
    if (args.includes("fetch") || args.includes("checkout")) return "";
    // Exit 0: the base is already in the head, so the repair merges nothing.
    if (args.includes("merge-base") && args.includes("--is-ancestor")) {
      return "";
    }
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      return scenario === "head-change" && agentCalls === 2
        ? "changed"
        : "a".repeat(40);
    }
    if (args.includes("status") && args.includes("--porcelain")) {
      return repair ? " M file.txt" : "";
    }
    if (repair && args[0] === "diff" && args.includes("--cached")) return "";
    if (repair && args[0] === "diff" && args.includes("--binary")) {
      return scenario === "capability-after-edits"
        ? "diff --git a/repair.txt b/repair.txt\nnew file mode 100644\n+repair preserved\n"
        : "";
    }
    if (repair && args[0] === "add" && args.includes("-N")) return "";
    if (repair && args[0] === "reset") return "";
    if (repair && args[0] === "apply") {
      if (!args.includes("--check")) {
        Deno.writeTextFileSync(
          `${options.cwd}/repair.txt`,
          "repair preserved\n",
        );
        record("checkpoint-applied");
      }
      return "";
    }
    if (repair && args.includes("diff")) return "";
    if (repair && args.includes("add") && args.includes("-A")) {
      try {
        Deno.statSync(`${options.cwd}/.babysitter-response`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        record("staged");
        return "";
      }
      throw new Error("Completion response would be staged");
    }
    if (repair && args.includes("commit")) {
      record("committed");
      return "";
    }
    if (repair && args.includes("push")) {
      record("pushed");
      return "";
    }
  }
  if (executable === "rtk" && args[0] === "--version") return "rtk 1";
  if (executable === "codex") {
    if (args[0] === "--version") return "codex-cli 0.164.0";
    if (args[0] === "exec") {
      agentCalls++;
      if (repair) record(`agent-${agentCalls}`);
      // The app pass (no repair scenario) proposes a description; repair
      // scenarios propose only what they script, so their body is not edited.
      if (!repair) {
        Deno.writeTextFileSync(
          `${args[args.indexOf("--cd") + 1]}/.babysitter-pr-body`,
          "Reviewed PR description\n",
        );
      }
      if (repair && scenario === "capability-after-edits") {
        Deno.writeTextFileSync(
          `${args[args.indexOf("--cd") + 1]}/repair.txt`,
          "repair preserved\n",
        );
      }
      Deno.writeTextFileSync(`${root}/agent-spawn.json`, JSON.stringify(args));
      const response = args[args.indexOf("--output-last-message") + 1]!;
      if (
        repair && agentCalls === 2 &&
        !args.at(-1)?.includes(
          scenario === "gate-output-capability-words"
            ? "Chromium sandbox denied"
            : "browser assertion failed",
        )
      ) {
        throw new Error("Repair prompt omitted the gate's cause");
      }
      if (!(scenario === "missing-response" && agentCalls === 2)) {
        Deno.writeTextFileSync(
          response,
          agentCalls === 2 && scenario === "not-ready"
            ? "Still broken\n"
            : agentCalls === 2 && scenario === "multiline-ready"
            ? "Fixed browser assertion\nBABYSITTER_READY\n"
            : "BABYSITTER_READY\n",
        );
      }
      if (scenario === "body-proposal" && agentCalls === 2) {
        Deno.writeTextFileSync(
          `${args[args.indexOf("--cd") + 1]}/.babysitter-pr-body`,
          "Repaired browser check",
        );
      }
      return "";
    }
  }
  if (repair && executable === "/usr/bin/sandbox-exec") {
    if (args[2] === "/usr/bin/true") {
      if (scenario === "probe-unavailable") throw new ProbeFailure();
      return "";
    }
    gateCalls++;
    record(`gate-${gateCalls}`);
    const profile = Deno.readTextFileSync(args[1]!);
    const configured = Deno.env.get("CONFIG_PATH") ?? ".config.json";
    const config = configured.startsWith("/")
      ? configured
      : `${root}/${configured}`;
    const home = `${root}/home`;
    for (
      const path of [
        config,
        `${root}/app.pem`,
        `${root}/custom-credential`,
        `${home}/Library/Keychains`,
      ]
    ) {
      if (
        !profile.includes(`(deny file-read* (subpath ${JSON.stringify(path)}))`)
      ) {
        throw new Error(`Missing credential denial: ${path}`);
      }
    }
    const env = options.env!;
    if (
      env.HOME === options.cwd || env.HOME !== env.TMPDIR ||
      !String(env.HOME).startsWith(`${root}/tmp/`)
    ) {
      throw new Error("Gate did not receive separate scratch directories");
    }
    if (scenario === "unavailable") {
      throw new Error("sandbox unavailable in fixture");
    }
    if (scenario === "capability-after-edits") {
      throw new Error("sandbox unavailable after Chromium capability changed");
    }
    if (scenario === "gate-output-capability-words") {
      throw new GateFailure(
        "Chromium sandbox denied by an ordinary test assertion",
      );
    }
    if (
      scenario !== "capable-resume" &&
      (gateCalls === 1 || scenario === "still-failing")
    ) {
      throw new GateFailure();
    }
    return "browser assertion passed";
  }
  throw new Error(
    `Unexpected fixture command: ${executable} ${args.join(" ")}`,
  );
}

class GateFailure extends Error {}
class ProbeFailure extends Error {}

// No real subprocess can escape the fixture, including gh writes or Codex.
Deno.Command = class {
  constructor(
    private executable: string,
    private options: Deno.CommandOptions = {},
  ) {}

  async output(): Promise<Deno.CommandOutput> {
    return this.outputSync();
  }

  private outputSync(): Deno.CommandOutput {
    let stdout: string;
    try {
      stdout = commandOutput(this.executable, this.options);
    } catch (error) {
      if (!(error instanceof GateFailure)) throw error;
      return {
        success: false,
        code: 1,
        signal: null,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode("browser assertion failed"),
      };
    }
    return {
      success: true,
      code: 0,
      signal: null,
      stdout: new TextEncoder().encode(
        stdout,
      ),
      stderr: new Uint8Array(),
    };
  }

  spawn(): Deno.ChildProcess {
    // status() is the rendezvous: renew the fake lock while the retry agent is
    // completing, so the caller must reject a successful child after lock loss.
    const output = Promise.resolve(this.outputSync());
    return {
      output: () => output,
      status: output.then(async ({ success, code, signal }) => {
        if (repair && this.executable === "codex" && agentCalls === 2) {
          if (scenario === "agent-failed") {
            return { success: false, code: 1, signal: null };
          }
          if (scenario === "lock-lost-after-spawn") {
            await new Promise<void>((resolve) => {
              renewalObserved = resolve;
              renewLock!();
            });
          }
        }
        return { success, code, signal };
      }),
      kill: () => {},
      stdout: new ReadableStream({
        start(controller) {
          output.then((value) => {
            controller.enqueue(value.stdout);
            controller.close();
          });
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          output.then((value) => {
            controller.enqueue(value.stderr);
            controller.close();
          });
        },
      }),
    } as Deno.ChildProcess;
  }
} as unknown as typeof Deno.Command;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === "https://api.github.com/app") {
    return Promise.resolve(Response.json({ id: 123, slug: "babysitter" }));
  }
  if (url === "https://api.github.com/app/installations/456/access_tokens") {
    const request = JSON.parse(String(init?.body ?? "{}"));
    if (
      repair && request.permissions?.contents === "read" && agentCalls === 1 &&
      scenario === "lock-lost-before-spawn"
    ) {
      await new Promise<void>((resolve) => {
        renewalObserved = resolve;
        renewLock!();
      });
    }
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

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = new Proxy(realSetInterval, {
  apply(target, receiver, [handler, delay, ...args]) {
    if (repair && delay === 100_000) renewLock = handler;
    return Reflect.apply(target, receiver, [handler, delay, ...args]);
  },
});
const realError = console.error;
console.error = (...args) => {
  realError(...args);
  if (String(args[0]).startsWith("Failed to renew PR lock comment")) {
    renewalObserved?.();
  }
};

// Node spawn owns the isolated process group; model the same offline gate here.
childProcess.spawn =
  ((executable: string, args: string[], options: Deno.CommandOptions) => {
    const child = new EventEmitter();
    let code = 0;
    let stdout = "";
    let stderr = "";
    let failure: unknown;
    try {
      stdout = commandOutput(executable, { ...options, args });
    } catch (error) {
      if (error instanceof GateFailure || error instanceof ProbeFailure) {
        code = 1;
        stderr = error instanceof ProbeFailure
          ? "sandbox-exec: sandbox_apply: Operation not permitted"
          : error instanceof GateFailure && error.message
          ? error.message
          : "browser assertion failed";
      } else failure = error;
    }
    Object.assign(child, {
      stdout: Readable.from([stdout]),
      stderr: Readable.from([stderr]),
    });
    queueMicrotask(() => {
      if (failure) child.emit("error", failure);
      else setTimeout(() => child.emit("close", code), 0);
    });
    return child;
  }) as typeof childProcess.spawn;
