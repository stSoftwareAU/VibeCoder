/**
 * Runner-owned validation before the babysitter publishes a repair (Issue
 * #4625). BABYSITTER_READY is the agent's claim; the repository's own gate on
 * the committed head is the verdict, and only a `passed` verdict pushes.
 *
 * These tests drive the real `fix()` in-process. Git runs for real against a
 * local bare upstream standing in for GitHub; gh, codex and rtk are answered by
 * a fake `Deno.Command`, and the GitHub token exchange by a fake `fetch`. The
 * gate itself is an injected `validate`, which is the seam under test.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  babysitterRepoConfigs,
  fix,
  withBabysitterWriteScope,
} from "../../commands/fleet_pr_babysitter.ts";
import {
  listBabysitterRetryStates,
  saveBabysitterRetryState,
} from "../../lib/babysitter_retry_state.ts";
import { loadConfig } from "../../lib/config.ts";
import { MAX_PUBLICATION_DEFERRALS } from "../../lib/publication_deferral_budget.ts";
import type { BabysitterAppConfig } from "../../lib/fleet_babysitter_app.ts";
import type {
  probePublicationCapability,
  PublicationRequest,
  PublicationValidation,
  validateRepositoryForPublication,
} from "../../lib/publication_validation.ts";

type Pr = Parameters<typeof fix>[1];
type Validate = typeof validateRepositoryForPublication;
type Probe = typeof probePublicationCapability;
type Review = { id: number; state: string; user: { login: string } };

const REPO = "owner/repo";
const GITHUB_REPO_URL =
  /^(?:git@github\.com:|https:\/\/github\.com\/)owner\/repo\.git$/;
const RealCommand = Deno.Command;
const realFetch = globalThis.fetch;

interface Host {
  root: string;
  upstream: string;
  /** The PR head before any repair: the upstream `feature` branch. */
  head: string;
  configPath: string;
  app: BabysitterAppConfig;
  pr: Pr;
  reviews: Review[];
  /** What the fake codex writes into feature.txt; undefined means no change. */
  agentChange: string | undefined;
  agentResponse: string;
  agentRuns: number;
  agentDirs: string[];
  /** Every `git push` the babysitter ran, with its argv. */
  pushes: string[][];
  dismissals: string[];
  ghCalls: string[][];
  lock: Record<string, unknown> | undefined;
  /** When set, the lock renewal (a PATCH of the lock comment) is refused. */
  renewalBroken: boolean;
}

let host: Host | undefined;

function current(): Host {
  if (!host) throw new Error("no fixture host is active");
  return host;
}

/** Run a real git command, bypassing the fake Deno.Command. */
async function git(args: string[], cwd: string): Promise<string> {
  const result = await new RealCommand("git", {
    args: [
      "-c",
      "user.name=Babysitter Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `git ${args[0]} failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function upstreamFeature(h: Host): Promise<string> {
  return git(["rev-parse", "feature"], h.upstream);
}

function stateDir(h: Host): string {
  return `${h.root}/state/vibe-coder/fleet-pr-babysitter`;
}

async function records(h: Host) {
  return await listBabysitterRetryStates(stateDir(h), REPO);
}

function output(success: boolean, stdout: string): Deno.CommandOutput {
  return {
    success,
    code: success ? 0 : 1,
    signal: null,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
  };
}

/** The fake GitHub CLI, shared by the injected gh seam and the subprocess. */
async function fakeGh(args: string[]): Promise<string> {
  const h = current();
  h.ghCalls.push(args);
  if (args[0] === "pr" && args[1] === "view") {
    return args.includes("--jq")
      ? ""
      : JSON.stringify({ ...h.pr, body: "", closingIssuesReferences: [] });
  }
  if (args[0] === "config") return "https\n";
  if (args.includes("PATCH")) {
    if (h.renewalBroken) throw new Error("lock renewal refused");
    return "{}";
  }
  if (args[0] === "api" && args[1]?.startsWith("users/")) return "12345\n";
  if (args[0] === "api" && args[1] === "repos/owner/repo/issues/1/comments") {
    return args.includes("POST") ? JSON.stringify({ id: 101 }) : "[[]]";
  }
  if (
    args[0] === "api" && args[1]?.startsWith("repos/owner/repo/actions/runs")
  ) {
    return "[]";
  }
  if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/1/reviews") {
    // `--paginate --slurp` answers with one array per page.
    return JSON.stringify([h.reviews]);
  }
  const dismissal = args.find((arg) => arg.endsWith("/dismissals"));
  if (args.includes("PUT") && dismissal) {
    h.dismissals.push(dismissal);
    return "";
  }
  if (args[0] === "issue" && args[1] === "comment") {
    h.lock = {
      id: 100,
      body: args[args.indexOf("--body") + 1],
      created_at: new Date().toISOString(),
      author: "babysitter[bot]",
    };
    return "https://github.com/owner/repo/issues/1#issuecomment-100";
  }
  if (args.includes("repos/owner/repo/issues/1/comments?per_page=100")) {
    return JSON.stringify(h.lock ? [h.lock] : []);
  }
  if (
    args.includes("DELETE") &&
    args.includes("repos/owner/repo/issues/comments/100")
  ) {
    h.lock = undefined;
    return "";
  }
  throw new Error(`unexpected gh ${args.join(" ")}`);
}

async function fakeCommand(
  executable: string,
  options: Deno.CommandOptions,
): Promise<Deno.CommandOutput> {
  const h = current();
  const args = (options.args ?? []).map(String);
  if (executable === "gh") {
    try {
      return output(true, await fakeGh(args));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...output(false, ""),
        stderr: new TextEncoder().encode(message),
      };
    }
  }
  if (executable === "git") {
    // Point every GitHub remote at the local upstream, so clone, fetch and push
    // run for real without the network.
    const local = args.map((arg) => arg.replace(GITHUB_REPO_URL, h.upstream));
    const result = await new RealCommand("git", { ...options, args: local })
      .output();
    if (local.includes("push")) {
      h.pushes.push(local);
      if (result.success) {
        h.pr = {
          ...h.pr,
          headRefOid: await git(["rev-parse", "HEAD"], String(options.cwd)),
        };
      }
    }
    return result;
  }
  if (executable === "codex") {
    if (args[0] === "--version") return output(true, "codex-cli 0.164.0\n");
    if (args[0] === "exec") {
      h.agentRuns++;
      const cwd = args[args.indexOf("--cd") + 1]!;
      h.agentDirs.push(cwd);
      if (h.agentChange !== undefined) {
        await Deno.writeTextFile(`${cwd}/feature.txt`, h.agentChange);
      }
      await Deno.writeTextFile(
        args[args.indexOf("--output-last-message") + 1]!,
        h.agentResponse,
      );
      return output(true, "");
    }
  }
  // rtk is not installed on this fake host: its probe fails.
  if (executable === "rtk") return output(false, "");
  throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
}

class FakeCommand {
  #executable: string;
  #options: Deno.CommandOptions;

  constructor(executable: string, options: Deno.CommandOptions = {}) {
    this.#executable = executable;
    this.#options = options;
  }

  output(): Promise<Deno.CommandOutput> {
    return fakeCommand(this.#executable, this.#options);
  }

  spawn(): Deno.ChildProcess {
    const finished = this.output();
    return {
      output: () => finished,
      status: finished.then(({ success, code, signal }) => ({
        success,
        code,
        signal,
      })),
      kill: () => {},
    } as unknown as Deno.ChildProcess;
  }
}

function fakeFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = String(input);
  if (url === "https://api.github.com/app/installations/456/access_tokens") {
    // Grant what was asked: the agent's token is requested read-only.
    const request = JSON.parse(String(init?.body ?? "{}"));
    return Promise.resolve(Response.json({
      token: "ghs_fixture_token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: request.permissions ?? { contents: "read" },
    }, { status: 201 }));
  }
  throw new Error(`unexpected fetch ${url}`);
}

/** A PKCS#8 RSA key, so the babysitter's app JWT can be signed. */
async function generateTestKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const lines = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!;
  return [
    "-----BEGIN PRIVATE KEY-----",
    ...lines,
    "-----END PRIVATE KEY-----",
  ].join("\n") + "\n";
}

/**
 * Build a host: a `main` base and a `feature` head on a local bare upstream,
 * a worker config with a per-repository setting, and the fakes installed for
 * the duration of `body`.
 */
async function withHost(body: (h: Host) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "babysitter-validation-" });
  const savedHome = Deno.env.get("HOME");
  const savedState = Deno.env.get("XDG_STATE_HOME");
  try {
    const work = `${root}/work`;
    await Deno.mkdir(work);
    await git(["init", "-q", "-b", "main"], work);
    await Deno.writeTextFile(`${work}/a.txt`, "first\n");
    await git(["add", "-A"], work);
    await git(["commit", "-q", "-m", "first"], work);
    await git(["checkout", "-q", "-b", "feature"], work);
    await Deno.writeTextFile(`${work}/feature.txt`, "feature\n");
    await git(["add", "-A"], work);
    await git(["commit", "-q", "-m", "feature"], work);
    const upstream = `${root}/upstream.git`;
    await git(["clone", "-q", "--bare", work, upstream], root);
    const head = await git(["rev-parse", "feature"], work);

    const home = `${root}/home`;
    await Deno.mkdir(home);
    Deno.env.set("HOME", home);
    Deno.env.set("XDG_STATE_HOME", `${root}/state`);
    const privateKeyPath = `${root}/app-key.pem`;
    await Deno.writeTextFile(privateKeyPath, await generateTestKeyPem());
    const configPath = `${root}/config.json`;
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        repos: [REPO],
        repo_config: { [REPO]: { quality_command: "./check.sh" } },
      }),
    );

    Deno.Command = FakeCommand as unknown as typeof Deno.Command;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    host = {
      root,
      upstream,
      head,
      configPath,
      app: { appId: "123", installationId: "456", privateKeyPath },
      pr: prFor(head, { failedCi: true }),
      reviews: [],
      agentChange: "feature, fixed\n",
      agentResponse: "Fixed.\nBABYSITTER_READY\n",
      agentRuns: 0,
      agentDirs: [],
      pushes: [],
      dismissals: [],
      ghCalls: [],
      lock: undefined,
      renewalBroken: false,
    };
    await body(host);
  } finally {
    Deno.Command = RealCommand;
    globalThis.fetch = realFetch;
    host = undefined;
    if (savedHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", savedHome);
    if (savedState === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", savedState);
    await Deno.remove(root, { recursive: true });
  }
}

/** A PR that CI fails, or one with a requested change and green CI. */
function prFor(head: string, options: { failedCi: boolean }): Pr {
  return {
    state: "OPEN",
    number: 1,
    title: "fix",
    author: { login: "fleet" },
    headRefName: "feature",
    headRefOid: head,
    baseRefName: "main",
    isCrossRepository: false,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: options.failedCi ? null : "CHANGES_REQUESTED",
    statusCheckRollup: [{
      conclusion: options.failedCi ? "FAILURE" : "SUCCESS",
    }],
  };
}

/** Switch the host to a requested-change repair with one open review. */
function reviewRepair(h: Host): void {
  h.pr = prFor(h.head, { failedCi: false });
  h.reviews = [{
    id: 77,
    state: "CHANGES_REQUESTED",
    user: { login: "reviewer" },
  }];
}

interface Seen {
  request: PublicationRequest;
  head: string;
  upstream: string;
  pushes: number;
}

/**
 * A validator that records what it was asked and what the upstream held when
 * it ran, then answers with `verdict` for the committed head.
 */
function validatorFor(
  h: Host,
  verdict: (head: string) => PublicationValidation,
  seen: Seen[] = [],
): Validate {
  return async (request) => {
    const head = await git(["rev-parse", "HEAD"], request.cwd);
    seen.push({
      request,
      head,
      upstream: await upstreamFeature(h),
      pushes: h.pushes.length,
    });
    return verdict(head);
  };
}

/** A capability probe that finds nothing wrong with the host. */
const capableHost: Probe = () => Promise.resolve(undefined);

function repair(
  h: Host,
  validate: Validate,
  configPath = h.configPath,
  probeCapability: Probe = capableHost,
): Promise<void> {
  const initial = { ...h.pr };
  return withBabysitterWriteScope(REPO, () =>
    fix(
      REPO,
      initial,
      ["fleet"],
      "babysitter[bot]",
      h.app,
      configPath,
      fakeGh,
      () => Promise.resolve(),
      3,
      { armAutoMerge: () => Promise.resolve(), validate, probeCapability },
    ));
}

Deno.test("a failed repository gate blocks the push, keeps the attempt, and dismisses no review", async () => {
  await withHost(async (h) => {
    reviewRepair(h);
    const seen: Seen[] = [];
    const error = await assertRejects(
      () =>
        repair(
          h,
          validatorFor(h, () => ({
            status: "failed",
            head: null,
            output: "FAIL: tests/fleet_pr_babysitter_test.ts",
          }), seen),
        ),
      Error,
      "required repository checks failed",
    );
    assertStringIncludes(
      error.message,
      "FAIL: tests/fleet_pr_babysitter_test.ts",
    );
    assertEquals(seen.length, 1);
    assertEquals(h.pushes.length, 0);
    assertEquals(await upstreamFeature(h), h.head);
    assertEquals(h.dismissals, []);
    assertEquals(h.ghCalls.filter((args) => args.includes("edit")), []);
    assertEquals((await records(h))[0]?.blockerClass, "code");
  });
});

Deno.test("an unavailable repository gate cools down without a substantive attempt, then retries", async () => {
  await withHost(async (h) => {
    const first: Seen[] = [];
    const error = await assertRejects(
      () =>
        repair(
          h,
          validatorFor(h, (head) => ({
            status: "unavailable",
            head,
            reason: "failed_docker_infra: the docker daemon is down",
          }), first),
        ),
      Error,
      "repository checks unavailable, repair deferred:",
    );
    assertStringIncludes(error.message, "the docker daemon is down");
    assertEquals(first.length, 1);
    assertEquals(h.pushes.length, 0);
    assertEquals(await upstreamFeature(h), h.head);
    const record = (await records(h))[0]!;
    assertEquals(record.blockerClass, "capability");
    assertEquals(record.attempts.substantive, 0);
    assert(record.nextEligibleAt !== null);
    await saveBabysitterRetryState(stateDir(h), {
      ...record,
      nextEligibleAt: null,
    });
    assertEquals(h.agentRuns, 1);

    // The same head is attempted again: the agent runs, and the gate passes.
    const second: Seen[] = [];
    await repair(
      h,
      validatorFor(
        h,
        (head) => ({ status: "passed", head, gate: "ran" }),
        second,
      ),
    );
    assertEquals(h.agentRuns, 2);
    assertEquals(second.length, 1);
    assertEquals(h.pushes.length, 1);
    assertEquals(await upstreamFeature(h), second[0]!.head);
    assertEquals(
      (await records(h))[0]?.reconciliation,
      "waiting-for-ci-review",
    );
  });
});

Deno.test("a passed repository gate pushes as before and dismisses the addressed review after the push", async () => {
  await withHost(async (h) => {
    reviewRepair(h);
    const seen: Seen[] = [];
    await repair(
      h,
      validatorFor(
        h,
        (head) => ({ status: "passed", head, gate: "absent" }),
        seen,
      ),
    );
    assertEquals(seen.length, 1);
    assertEquals(h.pushes.length, 1);
    const pushed = await upstreamFeature(h);
    assertEquals(pushed, seen[0]!.head);
    assert(pushed !== h.head, "the fix was pushed");
    assertEquals(h.dismissals.length, 1);
    assertStringIncludes(h.dismissals[0]!, "/pulls/1/reviews/77/dismissals");
    assertEquals(
      (await records(h))[0]?.reconciliation,
      "waiting-for-ci-review",
    );
  });
});

Deno.test("a ready claim with a failed gate does not publish the head", async () => {
  await withHost(async (h) => {
    assertStringIncludes(h.agentResponse, "BABYSITTER_READY");
    const seen: Seen[] = [];
    await assertRejects(
      () =>
        repair(
          h,
          validatorFor(h, () => ({
            status: "failed",
            head: null,
            output: "the Deno test run failed",
          }), seen),
        ),
      Error,
      "required repository checks failed",
    );
    assertEquals(h.agentRuns, 1);
    assertEquals(seen.length, 1);
    assertEquals(h.pushes.length, 0);
    assertEquals(await upstreamFeature(h), h.head);
    assertEquals((await records(h))[0]?.blockerClass, "code");
  });
});

Deno.test("the gate runs on the committed head in the clone, with the loaded repository configs, before the push", async () => {
  await withHost(async (h) => {
    const seen: Seen[] = [];
    await repair(
      h,
      validatorFor(
        h,
        (head) => ({ status: "passed", head, gate: "ran" }),
        seen,
      ),
    );
    assertEquals(seen.length, 1);
    const call = seen[0]!;
    assertEquals(call.request.cwd, h.agentDirs[0]);
    assertEquals(call.request.repo, REPO);
    // The babysitter's account holds the fleet credentials, so the PR's own
    // code must never run as it (THREAT-MODEL C36).
    assertEquals(call.request.requireSeparateAccount, true);
    // The base failure comparison uses the PR's own base, not the default branch.
    assertEquals(call.request.baseRef, "origin/main");
    assertEquals(
      call.request.repoConfigs,
      (await loadConfig(h.configPath)).repoConfig,
    );
    assert(call.head !== h.head, "the commit exists when the gate runs");
    assertEquals(call.upstream, h.head, "nothing is pushed yet");
    assertEquals(call.pushes, 0);
  });
});

Deno.test("the repository configs come from the worker config, and a failed load is thrown", async () => {
  const configs = { [REPO]: { qualityCommand: "./check.sh" } };
  const loaded = { repoConfig: configs } as unknown as Awaited<
    ReturnType<typeof loadConfig>
  >;
  assertEquals(
    await babysitterRepoConfigs("/unused", () => Promise.resolve(loaded)),
    configs,
  );
  await assertRejects(
    () =>
      babysitterRepoConfigs(
        "/missing/config.json",
        () => Promise.reject(new Error("unreadable config")),
      ),
    Error,
    "unreadable config",
  );
});

/**
 * Capture the lock renewal's timer, so a test fires one renewal at a moment of
 * its choosing: the renewal runs every 100 seconds, too slow to wait for.
 */
async function withCapturedRenewal(
  body: (renew: () => void) => Promise<void>,
): Promise<void> {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let scheduled: (() => void) | undefined;
  globalThis.setInterval = ((callback: () => void) => {
    scheduled = callback;
    return 0;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval;
  try {
    await body(() => {
      if (!scheduled) throw new Error("no lock renewal was scheduled");
      scheduled();
    });
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
}

/** The entries under this host's babysitter state directory. */
async function stateEntries(h: Host): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (
      const entry of Deno.readDir(
        `${h.root}/state/vibe-coder/fleet-pr-babysitter`,
      )
    ) {
      names.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names;
}

Deno.test("a lock renewal that fails while the gate runs stops the push", async () => {
  await withHost((h) =>
    withCapturedRenewal(async (renew) => {
      const seen: Seen[] = [];
      const gate = validatorFor(
        h,
        (head) => ({ status: "passed", head, gate: "ran" }),
        seen,
      );
      const error = await assertRejects(
        () =>
          repair(h, async (request) => {
            const verdict = await gate(request);
            // The lock is lost while the gate runs, and the renewal reports it
            // before the verdict reaches the push.
            h.renewalBroken = true;
            renew();
            await new Promise((resolve) => setTimeout(resolve, 0));
            return verdict;
          }),
        Error,
        "PR lock renewal failed; refusing to push",
      );
      assertEquals(error.message, "PR lock renewal failed; refusing to push");
      assertEquals(seen.length, 1);
      assertEquals(h.pushes.length, 0);
      assertEquals(await upstreamFeature(h), h.head);
    })
  );
});

Deno.test("a repository config that cannot be loaded stops the repair before any agent runs or attempt is recorded", async () => {
  await withHost(async (h) => {
    const unreadable = `${h.root}/unreadable-config.json`;
    await Deno.writeTextFile(unreadable, "{ not json");
    const seen: Seen[] = [];
    await assertRejects(
      () =>
        repair(
          h,
          validatorFor(
            h,
            (head) => ({ status: "passed", head, gate: "ran" }),
            seen,
          ),
          unreadable,
        ),
      Error,
    );
    assertEquals(h.agentRuns, 0);
    assertEquals(h.agentDirs, []);
    assertEquals(seen.length, 0);
    assertEquals(h.pushes.length, 0);
    assertEquals(await stateEntries(h), []);
  });
});

Deno.test("a failed gate is a code failure whatever its output says, and counts one substantive attempt", async () => {
  // Each line would classify as owner, race or infrastructure if the verdict's
  // text, not the verdict, decided the class.
  const outputs = [
    "FAIL: tests/needs-human_label_test.ts needs-human",
    "FAIL: the file changed during the run",
    "the repository gate timed out (exit 124) and was killed at its time limit",
  ];
  for (const text of outputs) {
    await withHost(async (h) => {
      await assertRejects(
        () =>
          repair(
            h,
            validatorFor(h, () => ({
              status: "failed",
              head: null,
              output: text,
            })),
          ),
        Error,
        "required repository checks failed",
      );
      const record = (await records(h))[0]!;
      assertEquals(record.blockerClass, "code", text);
      assertEquals(record.attempts.substantive, 1, text);
      assertEquals(record.attempts.infrastructure, 0, text);
      assert(record.nextEligibleAt !== null, `${text}: the PR is retried`);
    });
  }
});

Deno.test("a host that cannot run the repository checks starts no session and records a capability deferral", async () => {
  await withHost(async (h) => {
    const asked: Parameters<Probe>[0][] = [];
    const headsAsked: string[] = [];
    const incapable: Probe = async (request) => {
      asked.push(request);
      headsAsked.push(await git(["rev-parse", "HEAD"], request.cwd));
      return "no separate account to run the commands";
    };
    const seen: Seen[] = [];
    await assertRejects(
      () =>
        repair(
          h,
          validatorFor(
            h,
            (head) => ({ status: "passed", head, gate: "ran" }),
            seen,
          ),
          h.configPath,
          incapable,
        ),
      Error,
      "no session started",
    );
    assertEquals(h.agentRuns, 0);
    assertEquals(seen.length, 0);
    assertEquals(h.pushes.length, 0);
    assertEquals(await upstreamFeature(h), h.head);
    // The probe is asked about the PR's own checkout, with the C36 protection.
    assertEquals(asked.length, 1);
    assertEquals(asked[0]!.requireSeparateAccount, true);
    assertEquals(asked[0]!.repo, REPO);
    assertEquals(headsAsked, [h.head]);
    const record = (await records(h))[0]!;
    assertEquals(record.blockerClass, "capability");
    assertEquals(record.attempts.substantive, 0);
    assert(record.nextEligibleAt !== null);

    // Positive control: a capable host runs the session and pushes.
    await saveBabysitterRetryState(stateDir(h), {
      ...record,
      nextEligibleAt: null,
    });
    await repair(
      h,
      validatorFor(h, (head) => ({ status: "passed", head, gate: "ran" })),
    );
    assertEquals(h.agentRuns, 1);
    assertEquals(h.pushes.length, 1);
  });
});

Deno.test("repeated unavailable rounds on one head stop at the bound and hand the PR on once", async () => {
  await withHost(async (h) => {
    const unavailable = validatorFor(h, (head) => ({
      status: "unavailable",
      head,
      reason: "failed_docker_infra: the docker daemon is down",
    }));
    const handoffs = () =>
      h.ghCalls.filter((args) =>
        args.includes("POST") &&
        args.some((arg) => arg.includes("paused this repair"))
      );
    for (let round = 1; round <= MAX_PUBLICATION_DEFERRALS; round++) {
      await assertRejects(() => repair(h, unavailable), Error, "unavailable");
      assertEquals(h.agentRuns, round);
      // Only the round that spends the budget hands the PR on.
      assertEquals(
        handoffs().length,
        round === MAX_PUBLICATION_DEFERRALS ? 1 : 0,
      );
      const record = (await records(h))[0]!;
      await saveBabysitterRetryState(stateDir(h), {
        ...record,
        nextEligibleAt: null,
      });
    }
    const paused = (await records(h))[0]!;
    assert(paused.escalation !== undefined, "the PR is paused for this head");
    assertEquals(paused.attempts.substantive, 0);

    // The cooldown is no longer what holds it back: another round on the same
    // head starts no session and posts nothing more.
    await repair(h, unavailable);
    assertEquals(h.agentRuns, MAX_PUBLICATION_DEFERRALS);
    assertEquals(handoffs().length, 1);
  });
});
