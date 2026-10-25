/**
 * The production formatter runner must be able to write the worktree
 * (Issue #4113).
 *
 * `createDefaultDeps().runCommand` drops to the untrusted `agent` account.
 * That account can read the worktree and cannot write it, so `deno fmt`
 * never fixes a file and the pre-push gate then fails the same diff. This
 * host has no `agent` user, so the probe would fall back to the worker and
 * the bug would stay green. The fixture puts `id` and `sudo` first on PATH:
 * the probe succeeds, and `sudo -u agent` refuses the write the way the
 * container does. The production runner (`createRepoFormatterDeps`) must
 * still format the file and commit it, which means it did not take that drop.
 *
 * Australian English throughout (behaviour).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { FORMATTER_COMMIT_MESSAGE } from "../lib/repo_formatters.ts";

const UNFORMATTED = "export const   x  =  1\n";
const FORMATTED = "export const x = 1;\n";

const ID_STUB = `#!/bin/sh
if [ "$1" = "-u" ] && [ "$2" = "agent" ]; then
  exit 0
fi
exit 1
`;

/** `sudo` that records every call, and refuses every command except the probe. */
function sudoStub(logPath: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
if [ "$1" = "true" ] && [ $# -eq 1 ]; then
  exit 0
fi
echo "Error writing files: Permission denied (os error 13)" >&2
exit 1
`;
}

interface ProbeResult {
  committed: boolean;
  changed: boolean;
  file: string;
  subject: string;
  sudoLog: string;
  failureExcerpt: string;
  /** The quality-gate runner still drops; the formatter runner must not. */
  qualityGateDropped: boolean;
}

/** Run the production formatter in a child whose PATH makes `agent` real. */
async function runProductionFormatter(): Promise<ProbeResult> {
  const root = await Deno.makeTempDir({ prefix: "fmt4113-" });
  const bin = `${root}/bin`;
  const repo = `${root}/repo`;
  const sudoLog = `${root}/sudo.log`;
  await Deno.mkdir(bin);
  await Deno.writeTextFile(`${bin}/id`, ID_STUB);
  await Deno.writeTextFile(`${bin}/sudo`, sudoStub(sudoLog));
  await Deno.chmod(`${bin}/id`, 0o755);
  await Deno.chmod(`${bin}/sudo`, 0o755);
  await Deno.writeTextFile(sudoLog, "");

  const libUrl = new URL("../lib/repo_formatters.ts", import.meta.url).href;
  const script = `${root}/probe.ts`;
  await Deno.writeTextFile(
    script,
    `
import { assertEquals } from "@std/assert";
import { createDefaultDeps } from ${
      JSON.stringify(
        new URL("../lib/quality_gate_phase.ts", import.meta.url).href,
      )
    };
import {
  createRepoFormatterDeps,
  FORMATTER_COMMIT_MESSAGE,
  runRepoFormatters,
} from ${JSON.stringify(libUrl)};

const repo = ${JSON.stringify(repo)};
const sudoLog = ${JSON.stringify(sudoLog)};
await new Deno.Command("git", { args: ["init", "-b", "main", repo], stdout: "null", stderr: "piped" }).output();
const git = (args: string[]) =>
  new Deno.Command("git", {
    args,
    cwd: repo,
    stdout: "piped",
    stderr: "piped",
  }).output();
const config = async (key: string, value: string) => {
  const out = await git(["config", key, value]);
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
};
await config("user.useConfigOnly", "true");
await config("user.name", "Fixture");
await config("user.email", "fixture@example.com");
await config("core.hooksPath", ${JSON.stringify(`${root}/hooks`)});
await Deno.mkdir(${JSON.stringify(`${root}/hooks`)});
await Deno.writeTextFile(repo + "/deno.json", "{}\\n");
await Deno.writeTextFile(repo + "/bad.ts", ${JSON.stringify(UNFORMATTED)});
for (const args of [["add", "deno.json", "bad.ts"], ["commit", "-m", "seed"]]) {
  const out = await git(args);
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
}
const result = await runRepoFormatters(repo, ["bad.ts"], createRepoFormatterDeps());
const file = await Deno.readTextFile(repo + "/bad.ts");
const log = await git(["log", "-1", "--format=%s"]);
const subject = new TextDecoder().decode(log.stdout).trim();
const sudo = await Deno.readTextFile(sudoLog);
await createDefaultDeps().runCommand(["true"]);
const afterGate = await Deno.readTextFile(sudoLog);
const payload = {
  committed: result.committed,
  changed: result.runs[0]?.changed === true,
  file,
  subject,
  sudoLog: sudo,
  failureExcerpt: result.failures[0]?.excerpt ?? "",
  commitMessage: FORMATTER_COMMIT_MESSAGE,
  qualityGateDropped: afterGate.length > sudo.length && afterGate.includes("-u agent"),
};
console.log("PROBE " + JSON.stringify(payload));
`,
  );

  const path = `${bin}:${Deno.env.get("PATH") ?? ""}`;
  const denoJson = new URL("../deno.json", import.meta.url).pathname;
  const child = await new Deno.Command(Deno.execPath(), {
    args: ["run", `--config=${denoJson}`, "--allow-all", script],
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...Deno.env.toObject(),
      PATH: path,
      SUDO_LOG: sudoLog,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(child.stdout);
  const stderr = new TextDecoder().decode(child.stderr);
  const line = stdout.split("\n").find((row) => row.startsWith("PROBE "));
  assert(
    child.code === 0 && line !== undefined,
    `production formatter probe failed (exit ${child.code})\n${stdout}\n${stderr}`,
  );
  return JSON.parse(line.slice("PROBE ".length)) as ProbeResult;
}

Deno.test("runRepoFormatters production runner formats a file and commits it (Issue #4113)", async () => {
  const result = await runProductionFormatter();
  assertEquals(result.sudoLog.trim(), "", result.sudoLog);
  assertEquals(result.file, FORMATTED);
  assertEquals(result.changed, true);
  assertEquals(result.committed, true);
  assertEquals(result.subject, FORMATTER_COMMIT_MESSAGE);
  assertEquals(result.failureExcerpt, "");
  assertStringIncludes(result.subject, "style: apply repository formatters");
  assertEquals(result.qualityGateDropped, true);
});
