/**
 * Tests for `infra/cloudformation/test-aws-emulator.sh` (Issue #5110).
 *
 * The script is spawned for real under bash with a controlled environment and
 * stdin closed. The first cases use fake `aws-emulator-run` and `aws` binaries
 * on a minimal PATH, so no emulator, network or AWS account is needed. The last
 * case runs the script through the real `aws-emulator-run` and is ignored unless
 * the current account is ordinary (neither root nor the worker account `vibe`)
 * and `aws-emulator` and `aws` are on PATH, as the 5109 suite does.
 *
 * Uses Australian English spelling (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH = new URL(
  "../../../infra/cloudformation/test-aws-emulator.sh",
  import.meta.url,
).pathname;
const SYSTEM_PATH = "/usr/bin:/bin";
const decoder = new TextDecoder();

/** Absolute path of `tool` on the real PATH, failing loud when absent. */
function realTool(tool: string): string {
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = `${dir}/${tool}`;
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  throw new Error(`${tool} not found on PATH`);
}

/** Whether `tool` resolves on the colon-separated `path`. */
function onPath(tool: string, path: string): boolean {
  return path.split(":").some((dir) => {
    if (dir === "") return false;
    try {
      return Deno.statSync(`${dir}/${tool}`).isFile;
    } catch {
      return false;
    }
  });
}

function currentUser(): string {
  const out = new Deno.Command("id", { args: ["-un"], stdout: "piped" })
    .outputSync();
  return decoder.decode(out.stdout).trim();
}

const CURRENT_USER = currentUser();
const IS_WORKER_ACCOUNT = CURRENT_USER === "vibe";
const IS_ROOT = CURRENT_USER === "root";
const HAS_REAL_EMULATOR =
  onPath("aws-emulator-run", Deno.env.get("PATH") ?? "") &&
  onPath("aws-emulator", Deno.env.get("PATH") ?? "") &&
  onPath("aws", Deno.env.get("PATH") ?? "");

const BASH = realTool("bash");

/** A throwaway root with a `bin` directory for fake tools. */
interface Sandbox {
  root: string;
  bin: string;
  caFile: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await Deno.makeTempDir({ prefix: "aws_emu_5110_" });
  const bin = `${root}/bin`;
  await Deno.mkdir(bin);
  const caFile = `${root}/ca.pem`;
  await Deno.writeTextFile(caFile, "not a real certificate\n");
  return { root, bin, caFile };
}

async function writeFake(sb: Sandbox, name: string, body: string) {
  const path = `${sb.bin}/${name}`;
  await Deno.writeTextFile(path, `#!${BASH}\n${body}`);
  await Deno.chmod(path, 0o755);
}

interface RunResult {
  code: number;
  output: string;
}

/**
 * Runs the script under bash with a clean environment. `path` is the whole
 * PATH; `extra` adds variables on top of HOME and TMPDIR (both the sandbox).
 */
async function runScript(
  sb: Sandbox,
  path: string,
  extra: Record<string, string> = {},
): Promise<RunResult> {
  const out = await new Deno.Command(BASH, {
    args: [SCRIPT_PATH],
    clearEnv: true,
    env: { PATH: path, HOME: sb.root, TMPDIR: sb.root, ...extra },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    output: decoder.decode(out.stdout) + decoder.decode(out.stderr),
  };
}

/** Environment of an inside-the-emulator run pointing at a loopback endpoint. */
function insideEnv(sb: Sandbox, endpoint: string): Record<string, string> {
  return {
    AWS_EMULATOR_STATE_DIR: sb.root,
    AWS_ENDPOINT_URL: endpoint,
    AWS_CA_BUNDLE: sb.caFile,
  };
}

async function withSandbox(fn: (sb: Sandbox) => Promise<void>): Promise<void> {
  const sb = await makeSandbox();
  try {
    await fn(sb);
  } finally {
    await Deno.remove(sb.root, { recursive: true });
  }
}

Deno.test(
  "aws-emulator-cloudformation 5110: outside the emulator without aws-emulator-run exits 4",
  async () => {
    assert(
      !onPath("aws-emulator-run", SYSTEM_PATH),
      "aws-emulator-run is on /usr/bin:/bin; this case needs it absent",
    );
    await withSandbox(async (sb) => {
      const r = await runScript(sb, SYSTEM_PATH);
      assertEquals(r.code, 4, r.output);
      assertStringIncludes(r.output, "aws-emulator-run");
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: outside the emulator re-execs under aws-emulator-run and passes its status through",
  async () => {
    await withSandbox(async (sb) => {
      const record = `${sb.root}/argv.txt`;
      await writeFake(
        sb,
        "aws-emulator-run",
        `printf '%s\\n' "$@" > "${record}"\nexit 37\n`,
      );
      const r = await runScript(sb, `${sb.bin}:${SYSTEM_PATH}`);
      assertEquals(r.code, 37, r.output);
      const argv = (await Deno.readTextFile(record)).split("\n").filter((
        line,
      ) => line !== "");
      assertEquals(argv, ["--timeout", "900", "--", SCRIPT_PATH]);
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: inside the emulator refuses a non-loopback endpoint and names it",
  async () => {
    await withSandbox(async (sb) => {
      const r = await runScript(
        sb,
        `${sb.bin}:${SYSTEM_PATH}`,
        insideEnv(sb, "https://example.com"),
      );
      assertEquals(r.code, 2, r.output);
      assertStringIncludes(r.output, "refusing");
      assertStringIncludes(r.output, "https://example.com");
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: inside the emulator with a loopback endpoint and CA reaches the aws check",
  async () => {
    assert(
      !onPath("aws", SYSTEM_PATH),
      "aws is on /usr/bin:/bin; this control needs it absent",
    );
    await withSandbox(async (sb) => {
      const r = await runScript(
        sb,
        `${sb.bin}:${SYSTEM_PATH}`,
        insideEnv(sb, "https://127.0.0.1:45871"),
      );
      assertEquals(r.code, 4, r.output);
      assertStringIncludes(r.output, "aws CLI not found");
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: an emulator 501 is reported as UNSUPPORTED OPERATION",
  async () => {
    await withSandbox(async (sb) => {
      await writeFake(
        sb,
        "aws",
        `case "$*" in
  *"ssm get-parameter"*)
    echo "An error occurred (501) when calling the GetParameter operation: NotImplemented" >&2
    exit 254 ;;
  *) exit 0 ;;
esac
`,
      );
      const r = await runScript(
        sb,
        `${sb.bin}:${SYSTEM_PATH}`,
        insideEnv(sb, "https://127.0.0.1:45871"),
      );
      assert(r.code !== 0, r.output);
      assertStringIncludes(r.output, "UNSUPPORTED OPERATION");
      assertStringIncludes(r.output, "ssm get-parameter");
      assertStringIncludes(r.output, "(501)");
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: an unexpected AWS failure quotes its cause line and is not called unsupported",
  async () => {
    await withSandbox(async (sb) => {
      await writeFake(
        sb,
        "aws",
        `echo "An error occurred (AccessDeniedException) when calling the PutParameter operation: not allowed here" >&2
exit 255
`,
      );
      const r = await runScript(
        sb,
        `${sb.bin}:${SYSTEM_PATH}`,
        insideEnv(sb, "https://127.0.0.1:45871"),
      );
      assert(r.code !== 0, r.output);
      assertStringIncludes(r.output, "ssm put-parameter");
      assertStringIncludes(
        r.output,
        "An error occurred (AccessDeniedException) when calling the PutParameter operation: not allowed here",
      );
      assert(
        !r.output.includes("UNSUPPORTED OPERATION"),
        `an access failure must not be reported as unsupported:\n${r.output}`,
      );
    });
  },
);

// The real end-to-end run. As with the 5109 suite, the helper refuses the
// worker account `vibe` and uid 0 by design, so this case is ignored for both
// and runs in CI as an ordinary user.
Deno.test({
  name:
    "aws-emulator-cloudformation 5110: real aws-emulator-run runs the whole template suite (ordinary user only)",
  ignore: IS_WORKER_ACCOUNT || IS_ROOT || !HAS_REAL_EMULATOR,
  fn: async () => {
    await withSandbox(async (sb) => {
      const r = await runScript(sb, Deno.env.get("PATH") ?? "");
      assertEquals(r.code, 0, r.output);
      assertStringIncludes(r.output, "PASS: SSM round trip value");
      assertStringIncludes(
        r.output,
        "PASS: SSM get-parameter after delete: ParameterNotFound (as expected)",
      );
      assertStringIncludes(
        r.output,
        "PASS: stack vc5110-linux-verification-host-",
      );
      assertStringIncludes(r.output, "removed: ValidationError (as expected)");
      assertStringIncludes(r.output, "all ");
      assertStringIncludes(
        r.output,
        "exercised: 10 resources (properties checked)",
      );
      assertStringIncludes(
        r.output,
        "UNSUPPORTED (not proven, named gaps):",
      );
      assertStringIncludes(r.output, "VerificationHost");
    });
  },
});
