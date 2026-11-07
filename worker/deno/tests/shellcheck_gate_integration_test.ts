/** Real ShellCheck integration tests for publication policy (Issue #4631). */
import { assert, assertInstanceOf } from "@std/assert";
import { runPrePushGate } from "../lib/pre_push_gate.ts";
import {
  gateUnpushedCommits,
  PrePushGateBlockedError,
} from "../lib/git_push.ts";
import {
  requireRealShellcheck,
  STUB_SHELLCHECK_VERSION,
} from "./support/shellcheck_support.ts";

const REAL_SHELLCHECK = await requireRealShellcheck();
const ZERO = "0".repeat(40);

const GIT_ENV = ["-c", "user.email=t@e", "-c", "user.name=t"];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: [...GIT_ENV, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(new TextDecoder().decode(out.stderr));
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/** Bare remote + clone with a pushed initial commit, then one local doc commit. */
async function makeRepoWithDocCommit(): Promise<
  { root: string; clone: string; stdin: string }
> {
  const root = await Deno.makeTempDir({ prefix: "vibe-pp-gate-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  await git(root, "clone", "-q", remote, clone);
  await Deno.writeTextFile(`${clone}/deno.json`, "{}\n");
  await Deno.writeTextFile(`${clone}/.markdownlint-cli2.jsonc`, "{}\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "init");
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await Deno.writeTextFile(`${clone}/README.md`, "#Bad\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "docs");
  const sha = await git(clone, "rev-parse", "HEAD");
  return {
    root,
    clone,
    stdin: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
  };
}

const SHELLCHECK_WORKFLOW = (
  flags: string,
  version = STUB_SHELLCHECK_VERSION,
) =>
  `jobs:\n  lint:\n    env:\n      SHELLCHECK_VERSION: "${version}"\n    steps:\n      - run: |\n          find . -name "*.sh" -type f -exec shellcheck ${flags} {} +\n`;

async function commitShellcheckFiles(
  clone: string,
  files: Record<string, string>,
  flags = "-e SC1091 -e SC2034",
  version = STUB_SHELLCHECK_VERSION,
): Promise<string> {
  // Keep the unrelated doc commit on the remote so these fixtures need only
  // ShellCheck, as in the CI test shard which does not install markdownlint.
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await Deno.mkdir(`${clone}/.github/workflows`, { recursive: true });
  await Deno.writeTextFile(
    `${clone}/.github/workflows/validate-scripts.yml`,
    SHELLCHECK_WORKFLOW(flags, version),
  );
  for (const [path, contents] of Object.entries(files)) {
    await Deno.writeTextFile(`${clone}/${path}`, contents);
  }
  await git(clone, "add", "-A");
  await git(clone, "commit", "-qm", "add ShellCheck policy and scripts");
  return await git(clone, "rev-parse", "HEAD");
}

function prePushInput(tip: string): string {
  return `refs/heads/main ${tip} refs/heads/main ${ZERO}\n`;
}

Deno.test(
  "runPrePushGate: a changed shell script is blocked through git_push with the actual repository workflow",
  async () => {
    const { root, clone } = await makeRepoWithDocCommit();
    try {
      await commitShellcheckFiles(clone, {
        "bad script.sh": "#!/bin/bash\necho $1\n",
        "excluded.sh": "#!/bin/bash\nsource absent.sh\nunused=1\n",
        "bash dialect.sh": "#!/bin/sh\n[[ -f /tmp/not-present ]]\n",
      }, "--shell=bash -e SC1091 -e SC2034");
      await Deno.writeTextFile(
        `${clone}/.github/workflows/validate-scripts.yml`,
        // The host's own ShellCheck stands in for the pinned CI version.
        (await Deno.readTextFile(
          new URL(
            "../../../.github/workflows/validate-scripts.yml",
            import.meta.url,
          ),
        )).replace(
          /(SHELLCHECK_VERSION:\s*["']?)\d+\.\d+\.\d+/g,
          `$1${REAL_SHELLCHECK.version}`,
        ),
      );
      await git(clone, "add", ".github/workflows/validate-scripts.yml");
      await git(clone, "commit", "-qm", "use actual repository workflow");
      const result = await gateUnpushedCommits(
        "main",
        { cwd: clone },
        { commands: [] },
        false,
        "origin/main",
      );
      assert(!result.ok, "a real ShellCheck diagnostic must block the gate");
      assertInstanceOf(result.error, PrePushGateBlockedError);
      assert(result.error.message.includes("SC2086"), result.error.message);
      assert(
        !result.error.message.includes("SC1091 (info)"),
        result.error.message,
      );
      assert(
        !result.error.message.includes("SC2034 (warning)"),
        result.error.message,
      );
      assert(result.error.message.includes("bad script.sh"));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "runPrePushGate: clean scripts pass the workflow's dialect and exclusions",
  async () => {
    const { root, clone } = await makeRepoWithDocCommit();
    try {
      const tip = await commitShellcheckFiles(
        clone,
        {
          "clean.sh": "#!/bin/bash\necho 'ok'\n",
          "excluded.sh": "#!/bin/bash\nsource absent.sh\nunused=1\n",
          "bash dialect.sh": "#!/bin/sh\n[[ -f /tmp/not-present ]]\n",
        },
        "--shell=bash -e SC1091 -e SC2034",
        REAL_SHELLCHECK.version,
      );
      const result = await runPrePushGate({
        cwd: clone,
        stdin: prePushInput(tip),
        preFlightCommands: [],
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      assert(
        result.value.checksRun.some((command) =>
          command.includes("--shell=bash")
        ),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "runPrePushGate: a later script edit invalidates the earlier clean result",
  async () => {
    const { root, clone } = await makeRepoWithDocCommit();
    try {
      await commitShellcheckFiles(
        clone,
        {
          "edit me.sh": "#!/bin/sh\ntrue\n",
        },
        "-e SC1091 -e SC2034",
        REAL_SHELLCHECK.version,
      );
      const first = await gateUnpushedCommits(
        "main",
        { cwd: clone },
        { commands: [] },
        false,
        "origin/main",
      );
      assert(first.ok, first.ok ? "" : first.error.message);

      await Deno.writeTextFile(`${clone}/edit me.sh`, "#!/bin/sh\necho $1\n");
      await git(clone, "add", "-A");
      await git(clone, "commit", "-qm", "introduce ShellCheck finding");
      const second = await gateUnpushedCommits(
        "main",
        { cwd: clone },
        { commands: [] },
        false,
        "origin/main",
      );
      assert(!second.ok);
      assertInstanceOf(second.error, PrePushGateBlockedError);
      assert(second.error.message.includes("SC2086"), second.error.message);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);
