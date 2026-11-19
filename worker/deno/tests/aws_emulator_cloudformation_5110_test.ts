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

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";

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
 * PATH; `extra` adds variables on top of HOME and TMPDIR (both the sandbox);
 * `script` defaults to the script under test.
 */
async function runScript(
  sb: Sandbox,
  path: string,
  extra: Record<string, string> = {},
  script: string = SCRIPT_PATH,
): Promise<RunResult> {
  const out = await new Deno.Command(BASH, {
    args: [script],
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

Deno.test(
  "aws-emulator-cloudformation 5110: an aws CLI that succeeds with no data fails the run on its first data assertion",
  async () => {
    await withSandbox(async (sb) => {
      await writeFake(sb, "aws", "exit 0\n");
      const r = await runScript(
        sb,
        `${sb.bin}:${SYSTEM_PATH}`,
        insideEnv(sb, "https://127.0.0.1:45871"),
      );
      assertEquals(r.code, 1, r.output);
      assertStringIncludes(r.output, "::error::SSM round trip value");
      assert(
        !r.output.includes("PASS"),
        `an empty response must not be reported as a pass:\n${r.output}`,
      );
    });
  },
);

/**
 * A stateful fake `aws` that answers by its argv, so wrong wiring in the script
 * gives a wrong outcome. FAKE_DIR holds its state and call log; FAKE_MODE picks
 * the CloudFormation behaviour (gap, create_fail, stack_rollback,
 * resource_failed, resources_error, gap_gone, role_lingers). Reply shapes
 * mirror what the aws CLI v2 prints for the --query/--output the script passes:
 *  - `--output text` on a scalar query prints the bare value;
 *  - `--output text` on a list of lists prints one tab-separated row per item;
 *  - create-stack, put-parameter print their JSON (StackId, Version/Tier);
 *  - failures print "An error occurred (Code) when calling the Op operation:
 *    message" on stderr and exit 254 (the CLI's service-error status).
 */
const FAKE_AWS = String.raw`
LOG="$FAKE_DIR/calls.log"
echo "$*" >> "$LOG"
mkdir -p "$FAKE_DIR/ssm"
arg() {
  local flag="$1"
  shift
  while [ $# -gt 0 ]; do
    if [ "$1" = "$flag" ]; then printf '%s' "$2"; return; fi
    shift
  done
}
fail() { echo "An error occurred ($1) when calling the $2 operation: $3" >&2; exit 254; }
key() { printf '%s' "$1" | tr '/' '_'; }
svc="$1"
op="$2"
case "$svc $op" in
  "ssm put-parameter")
    name="$(arg --name "$@")"
    printf '%s' "$(arg --value "$@")" > "$FAKE_DIR/ssm/$(key "$name")"
    echo '{"Version": 1, "Tier": "Standard"}' ;;
  "ssm get-parameter")
    f="$FAKE_DIR/ssm/$(key "$(arg --name "$@")")"
    [ -f "$f" ] || fail ParameterNotFound GetParameter "Parameter $(arg --name "$@") not found."
    cat "$f"; echo ;;
  "ssm delete-parameter")
    f="$FAKE_DIR/ssm/$(key "$(arg --name "$@")")"
    [ -f "$f" ] || fail ParameterNotFound DeleteParameter "Parameter not found."
    rm -f "$f" ;;
  "cloudformation create-stack")
    stack="$(arg --stack-name "$@")"
    if [ "$FAKE_MODE" = create_fail ]; then
      fail AlreadyExistsException CreateStack "Stack [$stack] already exists"
    fi
    case "$*" in *"--on-failure DO_NOTHING"*) ;; *) fail ValidationError CreateStack "missing --on-failure DO_NOTHING" ;; esac
    ami="$(printf '%s' "$*" | sed -n 's/.*ParameterValue=\([^ ]*\).*/\1/p')"
    [ -f "$FAKE_DIR/ssm/$(key "$ami")" ] || fail ValidationError CreateStack "Parameter $ami not found in SSM"
    printf '%s' "$(arg --template-body "$@")" | sed 's#^file://##' > "$FAKE_DIR/template"
    echo "{\"StackId\": \"arn:aws:cloudformation:us-east-1:000000000000:stack/$stack/1111\"}" ;;
  "cloudformation wait")
    [ "$3" = stack-delete-complete ] && exit 0
    [ "$FAKE_MODE" = gap_gone ] && exit 0
    echo "Waiter StackCreateComplete failed: terminal failure state" >&2
    exit 255 ;;
  "cloudformation describe-stacks")
    if [ -f "$FAKE_DIR/deleted" ]; then
      fail ValidationError DescribeStacks "Stack with id $(arg --stack-name "$@") does not exist"
    fi
    case "$FAKE_MODE" in
      stack_rollback) echo ROLLBACK_COMPLETE ;;
      gap_gone) echo CREATE_COMPLETE ;;
      *) echo CREATE_FAILED ;;
    esac ;;
  "cloudformation describe-stack-resources")
    [ "$FAKE_MODE" = resources_error ] &&
      fail ValidationError DescribeStackResources "Stack does not exist: describe failed upstream"
    tpl="$(cat "$FAKE_DIR/template")"
    awk '
      /^Resources:/ { r = 1; next }
      r && /^[^ #]/ { r = 0 }
      !r { next }
      /^  [A-Za-z0-9]+:[ ]*$/ { id = $0; sub(/^  /, "", id); sub(/:.*$/, "", id); next }
      /^    Type:/ { print id "\t" $2 }
    ' "$tpl" | while IFS=$'\t' read -r lid rtype; do
      status=CREATE_COMPLETE; reason=none
      if [ "$lid" = VerificationHost ] && [ "$FAKE_MODE" != gap_gone ]; then
        status=CREATE_FAILED
        reason="Resource handler returned message: this emulator does not apply the MetadataOptions property of AWS::EC2::Instance"
      fi
      if [ "$lid" = HostRole ] && [ "$FAKE_MODE" = resource_failed ]; then
        status=CREATE_FAILED; reason="Role creation rejected by the fake emulator"
      fi
      printf '%s\t%s\t%s\t%s\n' "$lid" "$rtype" "$status" "$reason"
    done ;;
  "cloudformation describe-stack-resource")
    echo "phys-$(arg --logical-resource-id "$@")" ;;
  "cloudformation delete-stack") touch "$FAKE_DIR/deleted" ;;
  "ec2 describe-vpcs")
    [ -f "$FAKE_DIR/deleted" ] && fail InvalidVpcID.NotFound DescribeVpcs "The vpc ID does not exist"
    echo 10.42.0.0/16 ;;
  "ec2 describe-vpc-attribute") echo True ;;
  "ec2 describe-subnets")
    case "$*" in
      *CidrBlock*) echo 10.42.0.0/24 ;;
      *VpcId*) echo phys-VerificationVpc ;;
      *MapPublicIpOnLaunch*) echo True ;;
    esac ;;
  "ec2 describe-internet-gateways") printf 'phys-VerificationVpc\tavailable\n' ;;
  "ec2 describe-route-tables")
    case "$*" in
      *DestinationCidrBlock*) echo phys-InternetGateway ;;
      *) echo phys-PublicRouteTable ;;
    esac ;;
  "ec2 describe-security-groups")
    case "$*" in
      *"length("*) echo 0 ;;
      *)
        printf 'tcp\t443\t443\t0.0.0.0/0\ntcp\t80\t80\t0.0.0.0/0\nudp\t53\t53\t0.0.0.0/0\n'
        printf 'tcp\t53\t53\t0.0.0.0/0\nudp\t123\t123\t0.0.0.0/0\n' ;;
    esac ;;
  "iam get-role")
    [ -f "$FAKE_DIR/deleted" ] && [ "$FAKE_MODE" != role_lingers ] &&
      fail NoSuchEntity GetRole "The role cannot be found."
    echo ec2.amazonaws.com ;;
  "iam list-attached-role-policies") echo arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore ;;
  "iam get-instance-profile") echo phys-HostRole ;;
  *) fail UnknownOperation Fake "fake aws has no answer for: $*" ;;
esac
`;

/** Runs the script inside the fake emulator with the stateful fake aws. */
async function runWithFakeCfn(
  sb: Sandbox,
  mode: string,
): Promise<{ r: RunResult; log: string }> {
  await writeFake(sb, "aws", FAKE_AWS);
  const r = await runScript(sb, `${sb.bin}:${SYSTEM_PATH}`, {
    ...insideEnv(sb, "https://127.0.0.1:45871"),
    FAKE_DIR: sb.root,
    FAKE_MODE: mode,
  });
  let log = "";
  try {
    log = await Deno.readTextFile(`${sb.root}/calls.log`);
  } catch {
    // The fake was never called.
  }
  return { r, log };
}

/** Asserts the run got past the SSM round trip and seeding to create-stack. */
function assertReachedCloudFormation(r: RunResult, log: string) {
  assertStringIncludes(r.output, "PASS: SSM round trip value");
  assertStringIncludes(r.output, "PASS: seeded SSM parameter");
  assertStringIncludes(log, "cloudformation create-stack --stack-name vc5110-");
}

Deno.test(
  "aws-emulator-cloudformation 5110: a failed create-stack exits 1 with its cause and still cleans up",
  async () => {
    await withSandbox(async (sb) => {
      const { r, log } = await runWithFakeCfn(sb, "create_fail");
      assertEquals(r.code, 1, r.output);
      assertReachedCloudFormation(r, log);
      assertStringIncludes(r.output, "cloudformation create-stack");
      assertStringIncludes(r.output, "AlreadyExistsException");
      assertStringIncludes(r.output, "already exists");
      assert(!log.includes("describe-stacks"), "must stop at create-stack");
      assertStringIncludes(
        log,
        "cloudformation delete-stack --stack-name vc5110-",
      );
      assertStringIncludes(
        log,
        "ssm delete-parameter --name /vibe-coder-test/ubuntu-ami-id-",
      );
      assert(!r.output.includes("all "), r.output);
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: an unexpected stack status (ROLLBACK_COMPLETE) exits 1 and names it",
  async () => {
    await withSandbox(async (sb) => {
      const { r, log } = await runWithFakeCfn(sb, "stack_rollback");
      assertEquals(r.code, 1, r.output);
      assertReachedCloudFormation(r, log);
      assertStringIncludes(log, "describe-stack-resources");
      assertStringIncludes(r.output, "gap changed: update KNOWN_GAPS");
      assertStringIncludes(r.output, "is ROLLBACK_COMPLETE");
      assertStringIncludes(r.output, "expected CREATE_FAILED");
      assert(!r.output.includes("PASS: stack vc5110-"), r.output);
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: a named gap that now builds (stack and resource CREATE_COMPLETE) is reported as a changed gap",
  async () => {
    await withSandbox(async (sb) => {
      const { r, log } = await runWithFakeCfn(sb, "gap_gone");
      assertEquals(r.code, 1, r.output);
      assertReachedCloudFormation(r, log);
      assertStringIncludes(r.output, "gap changed: update KNOWN_GAPS");
      assertStringIncludes(
        r.output,
        "VerificationHost (AWS::EC2::Instance) is CREATE_COMPLETE",
      );
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: an unexpected resource status exits 1 and names the resource, status and reason",
  async () => {
    await withSandbox(async (sb) => {
      const { r, log } = await runWithFakeCfn(sb, "resource_failed");
      assertEquals(r.code, 1, r.output);
      assertReachedCloudFormation(r, log);
      assertStringIncludes(log, "describe-stack-resources");
      assertStringIncludes(
        r.output,
        "HostRole (AWS::IAM::Role) is CREATE_FAILED: Role creation rejected by the fake emulator",
      );
      assert(!r.output.includes("PASS: stack vc5110-"), r.output);
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: a failed describe-stack-resources exits 1 with its cause",
  async () => {
    await withSandbox(async (sb) => {
      const { r, log } = await runWithFakeCfn(sb, "resources_error");
      assertEquals(r.code, 1, r.output);
      assertReachedCloudFormation(r, log);
      assertStringIncludes(log, "cloudformation describe-stacks");
      assertStringIncludes(r.output, "cloudformation describe-stack-resources");
      assertStringIncludes(r.output, "ValidationError");
      assertStringIncludes(r.output, "describe failed upstream");
      assert(!r.output.includes("PASS: stack vc5110-"), r.output);
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: the expected named-gap run exits 0 and reports the gap as UNSUPPORTED, never a pass",
  async () => {
    await withSandbox(async (sb) => {
      const { r, log } = await runWithFakeCfn(sb, "gap");
      assertEquals(r.code, 0, r.output);
      assertReachedCloudFormation(r, log);
      assertMatch(
        r.output,
        /PASS: stack vc5110-linux-verification-host-[0-9a-f]+ CREATE_FAILED: \d+ resources CREATE_COMPLETE, 1 named gap\(s\)/,
      );
      assertStringIncludes(
        r.output,
        "UNSUPPORTED (gap reproduced, not proven): VerificationHost CREATE_FAILED",
      );
      assertStringIncludes(
        r.output,
        "exercised: 10 resources (properties checked)",
      );
      assertStringIncludes(r.output, "UNSUPPORTED (not proven, named gaps):");
      assertStringIncludes(r.output, "VerificationHost (AWS::EC2::Instance)");
      assert(!/PASS:[^\n]*VerificationHost/.test(r.output), r.output);
      assertStringIncludes(r.output, "removed: ValidationError (as expected)");
      assertStringIncludes(
        log,
        "cloudformation delete-stack --stack-name vc5110-",
      );
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: a role left behind after delete-stack fails the cleanup assertion",
  async () => {
    await withSandbox(async (sb) => {
      const { r, log } = await runWithFakeCfn(sb, "role_lingers");
      assertEquals(r.code, 1, r.output);
      assertReachedCloudFormation(r, log);
      assertStringIncludes(r.output, "removed: ValidationError (as expected)");
      assertStringIncludes(
        log,
        "cloudformation delete-stack --stack-name vc5110-",
      );
      const calls = log.split("\n");
      const deleteAt = calls.findIndex((line) =>
        line.startsWith("cloudformation delete-stack --stack-name vc5110-")
      );
      assert(deleteAt >= 0, log);
      assert(
        calls.slice(deleteAt + 1).some((line) =>
          line.startsWith("iam get-role ")
        ),
        `no iam get-role call after delete-stack:\n${log}`,
      );
      assertStringIncludes(
        r.output,
        "role phys-HostRole removed: expected a failure containing 'NoSuchEntity', but the call succeeded",
      );
      assert(!r.output.includes("assertions passed"), r.output);
    });
  },
);

Deno.test(
  "aws-emulator-cloudformation 5110: a template with no property checks fails before any AWS call",
  async () => {
    await withSandbox(async (sb) => {
      const dir = `${sb.root}/cfn`;
      const copied = `${dir}/test-aws-emulator.sh`;
      const realTemplate = new URL(
        "../../../infra/cloudformation/linux-verification-host.yaml",
        import.meta.url,
      ).pathname;
      const minimal = [
        'AWSTemplateFormatVersion: "2010-09-09"',
        "Resources:",
        "  Marker:",
        "    Type: AWS::SSM::Parameter",
        "    Properties:",
        "      Type: String",
        "      Value: marker",
        "",
      ].join("\n");
      await Deno.mkdir(dir);
      await Deno.copyFile(SCRIPT_PATH, copied);
      await Deno.copyFile(realTemplate, `${dir}/linux-verification-host.yaml`);
      await Deno.writeTextFile(`${dir}/extra.yaml`, minimal);
      await writeFake(sb, "aws", FAKE_AWS);
      const fakeEnv = (state: string) => ({
        ...insideEnv(sb, "https://127.0.0.1:45871"),
        FAKE_DIR: state,
        FAKE_MODE: "gap",
      });

      const failState = `${sb.root}/state-extra`;
      await Deno.mkdir(failState);
      const r = await runScript(
        sb,
        `${sb.bin}:${SYSTEM_PATH}`,
        fakeEnv(failState),
        copied,
      );
      assertEquals(r.code, 1, r.output);
      assertStringIncludes(
        r.output,
        "no property checks for extra.yaml; add them",
      );
      let calls = "";
      try {
        calls = await Deno.readTextFile(`${failState}/calls.log`);
      } catch {
        // The fake was never called.
      }
      assertEquals(calls, "", `the fake aws must not be called:\n${calls}`);
      assert(!r.output.includes("PASS"), r.output);

      // Positive control: the same copy without extra.yaml runs the real flow.
      await Deno.remove(`${dir}/extra.yaml`);
      const okState = `${sb.root}/state-ok`;
      await Deno.mkdir(okState);
      const ok = await runScript(
        sb,
        `${sb.bin}:${SYSTEM_PATH}`,
        fakeEnv(okState),
        copied,
      );
      assertEquals(ok.code, 0, ok.output);
      assertStringIncludes(
        ok.output,
        "exercised: 10 resources (properties checked)",
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
        "PASS: SSM get-parameter after delete (seeded AMI id): ParameterNotFound (as expected)",
      );
      assertStringIncludes(
        r.output,
        "exercised: 10 resources (properties checked)",
      );
      assertStringIncludes(
        r.output,
        "UNSUPPORTED (gap reproduced, not proven): VerificationHost CREATE_FAILED",
      );
      assert(
        !r.output.includes("PASS: gap reproduced"),
        `a reproduced gap must not be reported as a pass:\n${r.output}`,
      );
      assertStringIncludes(
        r.output,
        "UNSUPPORTED (not proven, named gaps):",
      );
      assertStringIncludes(r.output, "VerificationHost");
    });
  },
});
