/**
 * The pre-PR verifier releases the cargo target directory its disposable
 * checkout built into, once the verifier has finished (Issue #4743). Real git
 * in temporary directories, a scripted model, and a temporary ephemeral root
 * standing in for `/var/tmp/vibe-cargo-target`.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  ClaudeRunResult,
  RunClaudeOptions,
} from "../lib/claude_runner.ts";
import { loadTrustedCapabilityBundle } from "../lib/capability_security_guidance.ts";
import { cargoTargetDirForCheckout } from "../lib/ephemeral_build_cache.ts";
import {
  releaseCheckoutTargetDirs,
  type ReleasedTargetDirs,
  unmeasuredEphemeralRootDeps,
} from "../lib/heavy_build_gate.ts";
import {
  defaultPrePrVerifierDeps,
  prePrVerifierBlocked,
  type PrePrVerifierDeps,
  type PrePrVerifierInput,
  runPrePrVerifier,
} from "../lib/pre_pr_verifier.ts";
import type { Logger } from "../types.ts";
import { gitOk } from "./support/git_repo_fixture.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";

const TEMPLATE = await Deno.readTextFile(
  new URL("../../../prompts/pr_review_brief/prompt.md", import.meta.url),
);

const REPLY_CLEAN = JSON.stringify({
  summary: "fine",
  findings: [],
  testChanges: "none",
});

const NOTHING_RELEASED: ReleasedTargetDirs = { bytes: 0, dirs: 0, errors: [] };

const exists = (p: string) => Deno.stat(p).then(() => true, () => false);

interface Fixture {
  repo: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
}

async function makeRepo(): Promise<Fixture> {
  const repo = await Deno.makeTempDir({ prefix: "pre-pr-4743-repo-" });
  const g = (args: string[]) => gitOk(args, repo);
  await g(["init", "--quiet", "-b", "main"]);
  await g(["config", "user.email", "t@example.com"]);
  await g(["config", "user.name", "T"]);
  await g(["config", "commit.gpgsign", "false"]);
  await Deno.writeTextFile(`${repo}/a.ts`, "export const a = 1;\n");
  await g(["add", "."]);
  await g(["commit", "--quiet", "-m", "base"]);
  const baseSha = (await g(["rev-parse", "HEAD"])).trim();
  await g(["checkout", "--quiet", "-b", "feature"]);
  await Deno.writeTextFile(`${repo}/a.ts`, "export const a = 2;\n");
  await g(["commit", "--quiet", "-am", "head"]);
  const headSha = (await g(["rev-parse", "HEAD"])).trim();
  return {
    repo,
    baseSha,
    headSha,
    cleanup: () => Deno.remove(repo, { recursive: true }),
  };
}

function runResult(over: Partial<ClaudeRunResult>): ClaudeRunResult {
  return {
    exitCode: 0,
    output: "",
    timedOut: false,
    ...over,
  } as unknown as ClaudeRunResult;
}

function okRun(over: Partial<ClaudeRunResult>) {
  return { ok: true as const, value: runResult(over) };
}

function inputFor(
  f: Fixture,
  over: Partial<PrePrVerifierInput> = {},
): PrePrVerifierInput {
  return {
    repo: "owner/repo",
    issueNumber: 4743,
    issueTitle: "Title",
    issueBody: "Body",
    repoPath: f.repo,
    baseRef: f.baseSha,
    summaryPath: "docs/archive/pr-summaries/pr-summary-4743.md",
    summaryContent: "# Summary\nClaims.\n",
    changedFiles: ["a.ts"],
    timeoutSeconds: 60,
    logger: makeRecordingLogger().logger,
    ...over,
  };
}

/** The verifier's deps, with the release supplied by the test. */
function makeDeps(
  ask: PrePrVerifierDeps["ask"],
  tmps: string[],
  releaseBuildArtefacts: PrePrVerifierDeps["releaseBuildArtefacts"],
): PrePrVerifierDeps {
  return {
    ...defaultPrePrVerifierDeps,
    // This checkout's trusted bundle, never the host's PROMPTS_DIR or
    // VIBE_BASE_DIR, as the Issue #3395 tests do.
    loadTrustedCapabilityBundle: () =>
      loadTrustedCapabilityBundle(
        () => undefined,
        new URL("../../../prompts", import.meta.url).pathname,
      ),
    ask,
    loadBrief: () => Promise.resolve({ ok: true, value: TEMPLATE }),
    makeTempDir: async () => {
      const d = await defaultPrePrVerifierDeps.makeTempDir();
      tmps.push(d);
      return d;
    },
    releaseBuildArtefacts,
  };
}

Deno.test("runPrePrVerifier removes the cargo target dir its checkout built into, and keeps a sibling (Issue #4743)", async () => {
  const f = await makeRepo();
  const tmpRoot = await Deno.makeTempDir({ prefix: "4743-root-" });
  const tmps: string[] = [];
  try {
    // Another checkout's target dir under the same root must survive.
    const sibling = cargoTargetDirForCheckout(`${f.repo}-other-checkout`, {
      root: tmpRoot,
    });
    await Deno.mkdir(sibling, { recursive: true });
    await Deno.writeTextFile(`${sibling}/keep`, "keep");

    // The fake agent builds where a trim-refused cargo build would: in the
    // target dir keyed by the working directory it was given.
    let built = "";
    const ask = (options: RunClaudeOptions) => {
      if (options.cwd === undefined) throw new Error("no cwd given");
      built = cargoTargetDirForCheckout(options.cwd, { root: tmpRoot });
      return Deno.mkdir(`${built}/debug`, { recursive: true }).then(() =>
        Deno.writeTextFile(`${built}/debug/artefact`, "x".repeat(1024))
      ).then(() => okRun({ output: REPLY_CLEAN }));
    };
    const result = await runPrePrVerifier(
      inputFor(f),
      makeDeps(
        ask,
        tmps,
        (p) =>
          releaseCheckoutTargetDirs(p, unmeasuredEphemeralRootDeps, tmpRoot),
      ),
    );

    assert(built !== "", "the model was never asked");
    assertEquals(result.status, "checked");
    assert(!prePrVerifierBlocked(result));
    assertEquals(await exists(built), false);
    assertEquals(await exists(`${sibling}/keep`), true);
  } finally {
    await f.cleanup();
    await Deno.remove(tmpRoot, { recursive: true });
  }
});

Deno.test("runPrePrVerifier releases its checkout even when removeDir throws (Issue #4743)", async () => {
  const f = await makeRepo();
  const tmps: string[] = [];
  const released: string[] = [];
  try {
    const deps = makeDeps(
      () => Promise.resolve(okRun({ output: REPLY_CLEAN })),
      tmps,
      (p) => {
        released.push(p);
        return Promise.resolve(NOTHING_RELEASED);
      },
    );
    const result = await runPrePrVerifier(inputFor(f), {
      ...deps,
      removeDir: async (p) => {
        await defaultPrePrVerifierDeps.removeDir(p);
        throw new Error("cannot remove");
      },
    });
    assertEquals(result.status, "checked");
    assertEquals(released, [`${tmps[0]}/checkout`]);
  } finally {
    await f.cleanup();
  }
});

/** A recording logger that keeps warnings apart, with their context. */
function warningLogger(): {
  logger: Logger;
  warnings: Array<[string, unknown]>;
} {
  const warnings: Array<[string, unknown]> = [];
  const logger: Logger = {
    ...makeRecordingLogger().logger,
    warn(message, context) {
      warnings.push([message, context]);
    },
  };
  return { logger, warnings };
}

Deno.test("runPrePrVerifier keeps the result when the release throws, and warns with the cause (Issue #4743)", async () => {
  const f = await makeRepo();
  const tmps: string[] = [];
  const { logger, warnings } = warningLogger();
  try {
    const result = await runPrePrVerifier(
      inputFor(f, { logger }),
      makeDeps(
        () => Promise.resolve(okRun({ output: REPLY_CLEAN })),
        tmps,
        () => Promise.reject(new Error("release-cause-4743-thrown")),
      ),
    );
    assertEquals(result.status, "checked");
    assert(!prePrVerifierBlocked(result));
    const warned = warnings.filter(([m]) => m.includes("Pre-PR verifier"));
    assert(
      warned.some(([, c]) =>
        JSON.stringify(c).includes("release-cause-4743-thrown")
      ),
      `no warning carries the cause: ${JSON.stringify(warnings)}`,
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier keeps the result when the release reports errors, and warns with them (Issue #4743)", async () => {
  const f = await makeRepo();
  const tmps: string[] = [];
  const { logger, warnings } = warningLogger();
  try {
    const result = await runPrePrVerifier(
      inputFor(f, { logger }),
      makeDeps(
        () => Promise.resolve(okRun({ output: REPLY_CLEAN })),
        tmps,
        () =>
          Promise.resolve({
            bytes: 0,
            dirs: 0,
            errors: ["release-cause-4743-reported"],
          }),
      ),
    );
    assertEquals(result.status, "checked");
    assert(!prePrVerifierBlocked(result));
    const warned = warnings.filter(([m]) => m.includes("Pre-PR verifier"));
    assert(
      warned.some(([, c]) =>
        JSON.stringify(c).includes("release-cause-4743-reported")
      ),
      `no warning carries the cause: ${JSON.stringify(warnings)}`,
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("unmeasuredEphemeralRootDeps lists directory names only, with no bytes and no last write (Issue #4743)", async () => {
  const root = await Deno.makeTempDir({ prefix: "4743-list-" });
  try {
    await Deno.mkdir(`${root}/checkout-a/debug`, { recursive: true });
    await Deno.writeTextFile(`${root}/checkout-a/debug/big`, "x".repeat(4096));
    await Deno.mkdir(`${root}/checkout-b`);
    await Deno.writeTextFile(`${root}/stray-file`, "y");

    const dirs = await unmeasuredEphemeralRootDeps.listTargetDirs(root);
    assertEquals(dirs.map((d) => d.path).sort(), [
      `${root}/checkout-a`,
      `${root}/checkout-b`,
    ]);
    assert(dirs.every((d) => d.bytes === 0 && d.lastWriteMs === 0));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("unmeasuredEphemeralRootDeps rejects with NotFound for a missing root (Issue #4743)", async () => {
  const parent = await Deno.makeTempDir({ prefix: "4743-missing-" });
  try {
    await assertRejects(
      () => unmeasuredEphemeralRootDeps.listTargetDirs(`${parent}/no-root`),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
