/**
 * Issue #5046: the pre-push gate refused every shell-touching push in repos
 * whose CI delegates ShellCheck to a script — and in repos whose scripts only
 * *mention* ShellCheck. A mention is not delegation; a real delegation runs
 * the repository's own script, as CI does, instead of refusing the push.
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertInstanceOf,
} from "@std/assert";
import {
  PrePushGateInfrastructureError,
  repoShellcheckPolicy,
  runAffectedShellcheckChecks,
} from "../lib/pre_push_gate.ts";
import type { PreFlightRunner } from "../lib/pre_flight_gate.ts";
import { stubShellcheck } from "./support/shellcheck_support.ts";

const WORKFLOW = ".github/workflows/quality.yml";

async function withRepo(
  files: Record<string, string>,
  fn: (root: string, tracked: string[]) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    for (const [path, text] of Object.entries(files)) {
      const dir = path.split("/").slice(0, -1).join("/");
      if (dir) await Deno.mkdir(`${root}/${dir}`, { recursive: true });
      await Deno.writeTextFile(`${root}/${path}`, text);
    }
    await fn(root, Object.keys(files));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const STEP_RUN = "bash --noprofile --norc -eo pipefail ";

/** Records the CI step bodies the gate runs, read from its temp script. */
function runner(code: number, seen: string[]): PreFlightRunner {
  return async (command) => {
    assert(command.startsWith(STEP_RUN), command);
    seen.push((await Deno.readTextFile(command.slice(STEP_RUN.length))).trim());
    return {
      started: true,
      code,
      stdout: code === 0 ? "" : "a.sh:1:1: warning: SC2086",
      stderr: "",
    };
  };
}

const workflowRunning = (command: string) =>
  `jobs:\n  lint:\n    steps:\n      - run: ${command}\n`;

Deno.test("a script whose case arms name shellcheck does not delegate ShellCheck (Issue #5046)", async () => {
  await withRepo({
    [WORKFLOW]: workflowRunning("bash quality/lint_scope.sh"),
    "quality/lint_scope.sh": [
      "#!/bin/bash",
      'case "$1" in',
      "  shellcheck) ;;",
      "  *.sh | .shellcheckrc | .github/workflows/*)",
      "    echo changed ;;",
      "esac",
      "",
    ].join("\n"),
  }, async (root, tracked) => {
    assertEquals(await repoShellcheckPolicy(root, tracked), {
      ok: true,
      value: null,
    });
  });
});

Deno.test("a script that only searches for the word shellcheck does not delegate it (Issue #5046)", async () => {
  await withRepo({
    [WORKFLOW]: workflowRunning("bash quality/scan.sh"),
    "quality/scan.sh": "#!/bin/bash\ngrep -q shellcheck README.md || true\n",
  }, async (root, tracked) => {
    assertEquals(await repoShellcheckPolicy(root, tracked), {
      ok: true,
      value: null,
    });
  });
});

const DELEGATING = {
  [WORKFLOW]: workflowRunning("bash ./quality/shellcheck.sh"),
  "quality/shellcheck.sh": "#!/bin/bash\nshellcheck -e SC1091 ./*.sh\n",
  "a.sh": "#!/bin/sh\necho ok\n",
};

Deno.test("a real delegation runs the repository's own ShellCheck script instead of refusing the push (Issue #5046)", async () => {
  await withRepo(DELEGATING, async (root, tracked) => {
    const seen: string[] = [];
    const result = await runAffectedShellcheckChecks({
      cwd: root,
      changed: ["a.sh"],
      tracked,
      ...stubShellcheck(),
      runner: runner(0, seen),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(seen, ["bash ./quality/shellcheck.sh"]);
    assertEquals(result.value.checksRun, [`ShellCheck step of ${WORKFLOW}`]);
  });
});

Deno.test("a delegated ShellCheck finding blocks the push as a lint failure, not infrastructure (Issue #5046)", async () => {
  await withRepo(DELEGATING, async (root, tracked) => {
    const result = await runAffectedShellcheckChecks({
      cwd: root,
      changed: ["a.sh"],
      tracked,
      ...stubShellcheck(),
      runner: runner(1, []),
    });
    assertFalse(result.ok);
    assertFalse(result.error instanceof PrePushGateInfrastructureError);
  });
});

Deno.test("a delegated check without ShellCheck installed is infrastructure (Issue #5046)", async () => {
  await withRepo(DELEGATING, async (root, tracked) => {
    const seen: string[] = [];
    const result = await runAffectedShellcheckChecks({
      cwd: root,
      changed: ["a.sh"],
      tracked,
      findShellcheck: () => Promise.resolve(null),
      runner: runner(0, seen),
    });
    assertFalse(result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assertEquals(seen, []);
  });
});

Deno.test("a delegated check is not run for a push that touches no shell surface (Issue #5046)", async () => {
  await withRepo(
    { ...DELEGATING, "README.md": "# r\n" },
    async (root, tracked) => {
      const seen: string[] = [];
      const result = await runAffectedShellcheckChecks({
        cwd: root,
        changed: ["README.md"],
        tracked,
        ...stubShellcheck(),
        runner: runner(0, seen),
      });
      assert(result.ok);
      assertEquals(seen, []);
    },
  );
});

Deno.test("an inline ShellCheck step in an unsupported shape is run as CI runs it (Issue #5046)", async () => {
  const step = [
    "set --",
    "for candidate in infra/*.sh; do",
    '[ -f "$candidate" ] && set -- ${1+"$@"} "$candidate"',
    "done",
    'shellcheck -s bash "$@"',
  ];
  await withRepo({
    [WORKFLOW]: "jobs:\n  lint:\n    steps:\n      - run: |\n" +
      step.map((line) => `          ${line}\n`).join(""),
    "infra/a.sh": "#!/bin/bash\necho ok\n",
  }, async (root, tracked) => {
    const seen: string[] = [];
    const result = await runAffectedShellcheckChecks({
      cwd: root,
      changed: ["infra/a.sh"],
      tracked,
      ...stubShellcheck(),
      runner: runner(0, seen),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(seen, [step.join("\n")]);
  });
});

Deno.test("a fixture harness that labels a check shellcheck is not delegation (Issue #5046)", async () => {
  await withRepo({
    [WORKFLOW]: workflowRunning(".github/scripts/negative-fixtures.sh"),
    ".github/scripts/negative-fixtures.sh": [
      "#!/bin/bash",
      'require shellcheck "see the install hints"',
      'must_reject "shellcheck" shellcheck -s bash fixtures/unquoted.sh',
      "",
    ].join("\n"),
  }, async (root, tracked) => {
    assertEquals(await repoShellcheckPolicy(root, tracked), {
      ok: true,
      value: null,
    });
  });
});

Deno.test("a script under xargs bash -c that runs shellcheck is delegation (Issue #5046)", async () => {
  await withRepo({
    [WORKFLOW]: workflowRunning("bash ./quality/shellcheck.sh"),
    "quality/shellcheck.sh": [
      "#!/bin/bash",
      "if ! command -v shellcheck >/dev/null 2>&1; then exit 1; fi",
      "git ls-files -z -- '*.sh' | xargs -0 -n 50 -P 4 bash -c \\",
      "  'shellcheck -f gcc \"$@\" || true' sh",
      "",
    ].join("\n"),
    "a.sh": "#!/bin/sh\necho ok\n",
  }, async (root, tracked) => {
    const seen: string[] = [];
    const result = await runAffectedShellcheckChecks({
      cwd: root,
      changed: ["a.sh"],
      tracked,
      ...stubShellcheck(),
      runner: runner(0, seen),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(seen, ["bash ./quality/shellcheck.sh"]);
  });
});
