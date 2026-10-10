/**
 * Tests for `infra/cloudformation/test-floci.sh` (Issue #3369, PR #3478 review).
 *
 * The script is copied into a throwaway tree beside fixture templates and run
 * under bash with a `PATH` that holds only stub binaries, so no Docker, no real
 * `aws` CLI and no Floci are needed. Each case asserts on the exit code and
 * the output the script prints.
 *
 * Stub contracts mirrored:
 * - `aws cloudformation deploy` exits non-zero when the stack fails to deploy
 *   (the real CLI exits 255 on a failed changeset or stack);
 * - `aws cloudformation describe-stacks --query ... --output text` prints the
 *   bare status word;
 * - `aws cloudformation describe-stack-resources --output text` prints the
 *   matching resource types, or `None` when the query matches nothing;
 * - `curl` exits 0 once the endpoint answers and non-zero (7) when it refuses
 *   the connection.
 *
 * Uses Australian English spelling (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/** Join path segments with `/` (the sandboxes are POSIX temp directories). */
function join(...parts: string[]): string {
  return parts.join("/");
}

const SCRIPT_PATH = new URL(
  "../../../infra/cloudformation/test-floci.sh",
  import.meta.url,
).pathname;

const EC2_TEMPLATE = `Resources:
  Host:
    Type: AWS::EC2::Instance
`;

const SSM_TEMPLATE = `Parameters:
  UbuntuAmiId:
    Type: AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>
    Default: /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id
  OtherParam:
    Type: AWS::SSM::Parameter::Value<String>
    Default: /some/path
Resources:
  Host:
    Type: AWS::EC2::Instance
`;

const PLAIN_TEMPLATE = `Resources:
  Bucket:
    Type: AWS::S3::Bucket
`;

/** Absolute path of `tool` on the real PATH, failing loud when absent. */
function realTool(tool: string): string {
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, tool);
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  throw new Error(`${tool} not found on PATH`);
}

interface Sandbox {
  root: string;
  bin: string;
  argvLog: string;
}

interface Options {
  /** Templates written beside the script, name -> body. */
  templates: Record<string, string>;
  /** Install the `aws` stub (default true). */
  aws?: boolean;
  /** Exit code of the `curl` stub (default 0: Floci answers). */
  curlExit?: number;
  /**
   * Install a `floci` stub. When set, `curl` fails until the stub has run
   * (it touches `floci-started`), then succeeds; with `answers: false` it
   * never succeeds.
   */
  floci?: { answers: boolean };
}

const BASH = realTool("bash");

function makeSandbox(opts: Options): Sandbox {
  const root = Deno.makeTempDirSync({ prefix: "floci_script_" });
  const dir = join(root, "infra");
  const bin = join(root, "bin");
  Deno.mkdirSync(dir);
  Deno.mkdirSync(bin);
  Deno.copyFileSync(SCRIPT_PATH, join(dir, "test-floci.sh"));
  Deno.chmodSync(join(dir, "test-floci.sh"), 0o755);
  for (const [name, body] of Object.entries(opts.templates)) {
    Deno.writeTextFileSync(join(dir, name), body);
  }
  // Only the tools the script needs; `aws` and `floci` are deliberately absent
  // unless a case installs a stub, whatever the host has installed.
  for (
    const tool of [
      "dirname",
      "grep",
      "awk",
      "sort",
      "tr",
      "rm",
      "mktemp",
      "tail",
      "touch",
    ]
  ) {
    Deno.symlinkSync(realTool(tool), join(bin, tool));
  }
  const argvLog = join(root, "aws-argv.log");
  const started = join(root, "floci-started");
  const curlBody = opts.floci
    ? (opts.floci.answers
      // Mirror `--retry --retry-connrefused`: a bounded builtin-only loop
      // gives the backgrounded stub time to start without a sleep.
      ? `[ -e "${started}" ] && exit 0
case "$*" in
  *--retry*) for ((i = 0; i < 200000; i++)); do [ -e "${started}" ] && exit 0; done ;;
esac
exit 7
`
      : "exit 7\n")
    : `exit ${opts.curlExit ?? 0}\n`;
  Deno.writeTextFileSync(join(bin, "curl"), `#!${BASH}\n${curlBody}`);
  Deno.chmodSync(join(bin, "curl"), 0o755);
  if (opts.floci) {
    Deno.writeTextFileSync(
      join(bin, "floci"),
      `#!${BASH}\ntouch "${started}"\necho "floci stub args: $*"\n`,
    );
    Deno.chmodSync(join(bin, "floci"), 0o755);
  }
  if (opts.aws !== false) {
    Deno.writeTextFileSync(
      join(bin, "aws"),
      `#!${BASH}
printf '%s\\n' "$*" >> "${argvLog}"
case "$2" in
  deploy) exit "\${AWS_STUB_DEPLOY_EXIT:-0}" ;;
  describe-stacks) printf '%s\\n' "\${AWS_STUB_STATUS:-CREATE_COMPLETE}" ;;
  describe-stack-resources) [ -z "\${AWS_STUB_RESOURCES_EXIT:-}" ] || exit "\$AWS_STUB_RESOURCES_EXIT"; printf '%s\\n' "\${AWS_STUB_STUBBED:-None}" ;;
  describe-stack-events) exit 0 ;;
  *) echo "unexpected aws call: $*" >&2; exit 2 ;;
esac
`,
    );
    Deno.chmodSync(join(bin, "aws"), 0o755);
  }
  return { root, bin, argvLog };
}

interface Result {
  code: number;
  output: string;
  argv: string;
}

function run(
  sandbox: Sandbox,
  env: Record<string, string>,
): Result {
  const out = new Deno.Command(BASH, {
    args: [join(sandbox.root, "infra", "test-floci.sh")],
    // clearEnv: CI, GITHUB_ACTIONS and DOCKER_HOST from the host must not leak.
    clearEnv: true,
    env: { PATH: sandbox.bin, HOME: sandbox.root, ...env },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const dec = new TextDecoder();
  let argv = "";
  try {
    argv = Deno.readTextFileSync(sandbox.argvLog);
  } catch {
    // No aws call was made.
  }
  return {
    code: out.code,
    output: dec.decode(out.stdout) + dec.decode(out.stderr),
    argv,
  };
}

/**
 * Run `fn` with a live Unix socket at the returned `DOCKER_HOST`, then clean up.
 *
 * The test tasks grant no `--allow-net`, so a child `deno` (permitted by
 * `--allow-run`) binds the socket. It prints `ready` once listening and exits
 * when its stdin closes, so no sleep or kill is needed.
 */
async function withSocket(
  sandbox: Sandbox,
  fn: (host: string) => void,
): Promise<void> {
  const path = join(sandbox.root, "docker.sock");
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--no-config",
      "--no-lock",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      `Deno.listen({ transport: "unix", path: ${JSON.stringify(path)} });
       console.log("ready");
       await Deno.stdin.read(new Uint8Array(1));`,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    assertEquals(
      new TextDecoder().decode(first.value).trim(),
      "ready",
      "the socket helper did not start",
    );
    reader.releaseLock();
    fn(`unix://${path}`);
  } finally {
    await child.stdin.close();
    await child.stdout.cancel();
    await child.status;
  }
}

function cleanup(sandbox: Sandbox) {
  Deno.removeSync(sandbox.root, { recursive: true });
}

Deno.test("test-floci.sh skips an EC2 template without Docker outside CI", () => {
  const sb = makeSandbox({ templates: { "host.yaml": EC2_TEMPLATE } });
  try {
    const r = run(sb, { DOCKER_HOST: "unix:///nonexistent/docker.sock" });
    assertEquals(r.code, 0, r.output);
    assertStringIncludes(r.output, "SKIPPED (needs Docker): host.yaml");
    assertEquals(r.argv, "", "a skipped run must make no aws call");
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh fails closed on a missing Docker socket when CI=true", () => {
  const sb = makeSandbox({ templates: { "host.yaml": EC2_TEMPLATE } });
  try {
    const r = run(sb, {
      DOCKER_HOST: "unix:///nonexistent/docker.sock",
      CI: "true",
    });
    assertEquals(r.code, 1, r.output);
    assertStringIncludes(r.output, "::error::Docker socket");
    assert(!r.output.includes("SKIPPED"), r.output);
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh fails closed on a missing Docker socket when GITHUB_ACTIONS=true", () => {
  const sb = makeSandbox({ templates: { "host.yaml": EC2_TEMPLATE } });
  try {
    const r = run(sb, {
      DOCKER_HOST: "unix:///nonexistent/docker.sock",
      GITHUB_ACTIONS: "true",
    });
    assertEquals(r.code, 1, r.output);
    assertStringIncludes(r.output, "::error::Docker socket");
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh does not treat CI=false as CI", () => {
  const sb = makeSandbox({ templates: { "host.yaml": EC2_TEMPLATE } });
  try {
    const r = run(sb, {
      DOCKER_HOST: "unix:///nonexistent/docker.sock",
      CI: "false",
    });
    assertEquals(r.code, 0, r.output);
    assertStringIncludes(r.output, "SKIPPED (needs Docker)");
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh reports the Docker gate before a missing aws CLI", () => {
  // Skipping needs no aws, so a host without it still exits 0.
  const sb = makeSandbox({
    templates: { "host.yaml": EC2_TEMPLATE },
    aws: false,
  });
  try {
    const r = run(sb, { DOCKER_HOST: "unix:///nonexistent/docker.sock" });
    assertEquals(r.code, 0, r.output);
    assertStringIncludes(r.output, "SKIPPED (needs Docker): host.yaml");
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh fails when the aws CLI is missing and there is work to do", async () => {
  const sb = makeSandbox({
    templates: { "host.yaml": EC2_TEMPLATE },
    aws: false,
  });
  try {
    await withSocket(sb, (host) => {
      const r = run(sb, { DOCKER_HOST: host });
      assertEquals(r.code, 1, r.output);
      assertStringIncludes(r.output, "::error::aws CLI not found");
    });
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh fails when no template exists", () => {
  const sb = makeSandbox({ templates: {} });
  try {
    const r = run(sb, {});
    assertEquals(r.code, 1, r.output);
    assertStringIncludes(r.output, "::error::No CloudFormation templates");
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh fails when nothing answers and floci is not installed", () => {
  const sb = makeSandbox({
    templates: { "bucket.yaml": PLAIN_TEMPLATE },
    curlExit: 7,
  });
  try {
    const r = run(sb, {});
    assertEquals(r.code, 1, r.output);
    assertStringIncludes(r.output, "floci is not on PATH");
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh starts floci on demand when nothing answers", () => {
  const sb = makeSandbox({
    templates: { "bucket.yaml": PLAIN_TEMPLATE },
    floci: { answers: true },
  });
  try {
    const r = run(sb, {});
    assertEquals(r.code, 0, r.output);
    assert(
      Deno.statSync(join(sb.root, "floci-started")).isFile,
      "the floci stub never ran",
    );
    assertStringIncludes(r.output, "PASS: bucket.yaml CREATE_COMPLETE");
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh fails when started floci never answers", () => {
  const sb = makeSandbox({
    templates: { "bucket.yaml": PLAIN_TEMPLATE },
    floci: { answers: false },
  });
  try {
    const r = run(sb, {});
    assertEquals(r.code, 1, r.output);
    assertStringIncludes(r.output, "::error::Floci did not answer");
    assertEquals(r.argv, "", "no aws call may follow a dead emulator");
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh fails when describe-stack-resources fails", () => {
  const sb = makeSandbox({ templates: { "bucket.yaml": PLAIN_TEMPLATE } });
  try {
    const r = run(sb, { AWS_STUB_RESOURCES_EXIT: "254" });
    assertEquals(r.code, 1, r.output);
    assertStringIncludes(
      r.output,
      "::error::bucket.yaml: describe-stack-resources failed",
    );
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh passes a stack that reaches CREATE_COMPLETE", () => {
  const sb = makeSandbox({ templates: { "bucket.yaml": PLAIN_TEMPLATE } });
  try {
    const r = run(sb, {});
    assertEquals(r.code, 0, r.output);
    assertStringIncludes(r.output, "PASS: bucket.yaml CREATE_COMPLETE");
    assertStringIncludes(r.output, "1 deployed, 0 failed");
    assertStringIncludes(r.argv, "--stack-name floci-bucket");
    assert(!r.argv.includes("--parameter-overrides"), r.argv);
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh fails a stack whose status is not CREATE_COMPLETE", () => {
  const sb = makeSandbox({ templates: { "bucket.yaml": PLAIN_TEMPLATE } });
  try {
    const r = run(sb, { AWS_STUB_STATUS: "ROLLBACK_COMPLETE" });
    assertEquals(r.code, 1, r.output);
    assertStringIncludes(
      r.output,
      "::error::bucket.yaml: stack floci-bucket is ROLLBACK_COMPLETE, expected CREATE_COMPLETE",
    );
    assertStringIncludes(r.output, "1 deployed, 1 failed");
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh fails a deploy that exits non-zero even when the status reads CREATE_COMPLETE", () => {
  const sb = makeSandbox({ templates: { "bucket.yaml": PLAIN_TEMPLATE } });
  try {
    const r = run(sb, { AWS_STUB_DEPLOY_EXIT: "255" });
    assertEquals(r.code, 1, r.output);
    assertStringIncludes(
      r.output,
      "is CREATE_COMPLETE, expected CREATE_COMPLETE",
    );
    assert(!r.output.includes("PASS:"), r.output);
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh tries every template before failing", () => {
  const sb = makeSandbox({
    templates: { "a.yaml": PLAIN_TEMPLATE, "b.yaml": PLAIN_TEMPLATE },
  });
  try {
    const r = run(sb, { AWS_STUB_DEPLOY_EXIT: "255" });
    assertEquals(r.code, 1, r.output);
    assertStringIncludes(r.output, "=== a.yaml");
    assertStringIncludes(r.output, "=== b.yaml");
    assertStringIncludes(r.output, "2 deployed, 2 failed");
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh overrides SSM-typed parameters with literals", async () => {
  const sb = makeSandbox({ templates: { "host.yaml": SSM_TEMPLATE } });
  try {
    await withSocket(sb, (host) => {
      const r = run(sb, { DOCKER_HOST: host });
      assertEquals(r.code, 0, r.output);
      assertStringIncludes(
        r.argv,
        "--parameter-overrides UbuntuAmiId=ami-0123456789abcdef0 OtherParam=placeholder",
      );
    });
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh warns once per stubbed resource type", () => {
  const sb = makeSandbox({ templates: { "bucket.yaml": PLAIN_TEMPLATE } });
  try {
    const r = run(sb, {
      AWS_STUB_STUBBED: "AWS::Foo::Bar\tAWS::Foo::Bar\tAWS::Baz::Qux",
    });
    assertEquals(r.code, 0, r.output);
    const warnings = r.output.split("\n").filter((l) =>
      l.startsWith("::warning::")
    );
    assertEquals(warnings.length, 2, r.output);
    assertStringIncludes(warnings[0] ?? "", "AWS::Baz::Qux");
    assertStringIncludes(warnings[1] ?? "", "AWS::Foo::Bar");
  } finally {
    cleanup(sb);
  }
});

Deno.test("test-floci.sh emits no warning when nothing was stubbed", () => {
  const sb = makeSandbox({ templates: { "bucket.yaml": PLAIN_TEMPLATE } });
  try {
    const r = run(sb, {});
    assertEquals(r.code, 0, r.output);
    assert(!r.output.includes("::warning::"), r.output);
  } finally {
    cleanup(sb);
  }
});
