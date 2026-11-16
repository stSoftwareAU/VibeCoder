/**
 * Behaviour tests for `container/aws-emulator-run.sh` (Issue #5109).
 *
 * The real helper is spawned against a FAKE `aws-emulator` that mirrors the
 * observed upstream contract: a three-line `--version`, `-b/-p/-t/-a/
 * --idle-timeout`, a per-run CA and an IP-SAN server certificate, the four
 * state files written only after binding, HTTPS `/__admin/health` answering
 * `ok`, and a clean SIGTERM stop that removes the files. Nothing here needs
 * the real emulator, a network or AWS.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const HELPER =
  new URL("../../../container/aws-emulator-run.sh", import.meta.url).pathname;
const SYSTEM_PATH = "/usr/bin:/bin";
// Composed at run time so no credential-shaped literal sits in the source.
const FAKE_SECRET = "Qx7/".repeat(10);
const HOSTILE_KEY_ID = ["AKIA", "REALKEY", "000000000"].join("");
const HOSTILE_ENV: Record<string, string> = {
  AWS_PROFILE: "prod",
  AWS_ACCESS_KEY_ID: HOSTILE_KEY_ID,
  AWS_SECRET_ACCESS_KEY: "real",
  AWS_SESSION_TOKEN: "x",
  AWS_ENDPOINT_URL_S3: "https://s3.amazonaws.com",
  AWS_WEB_IDENTITY_TOKEN_FILE: "/x",
  AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/r",
  AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/x",
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
  ECS_CONTAINER_METADATA_URI_V4: "http://x",
};

type Mode = "normal" | "crash" | "hang" | "wrong-ca" | "die-after-ready";

function fakeEmulatorSource(mode: Mode, rec: string): string {
  return `#!/usr/bin/env python3
import http.server, os, secrets, signal, ssl, subprocess, sys, tempfile, threading, time

MODE = ${JSON.stringify(mode)}
REC = ${JSON.stringify(rec)}
args = sys.argv[1:]
if args == ["--version"]:
    print("Version: 1.0.385")
    print("Release date: 2026.11.14")
    print("Commit: 813af480bf7f16d5418b64e4f5644a74a7da11c5")
    sys.exit(0)

os.makedirs(REC, exist_ok=True)
with open(os.path.join(REC, "argv"), "w") as f:
    f.write(" ".join(args))
with open(os.path.join(REC, "env"), "w") as f:
    for k, v in os.environ.items():
        f.write("%s=%s\\n" % (k, v))
with open(os.path.join(REC, "pid"), "w") as f:
    f.write(str(os.getpid()))

bind, port = "127.0.0.1", 9297
t_flag, auth = None, "on"
i = 0
while i < len(args):
    a = args[i]
    v = args[i + 1] if i + 1 < len(args) else ""
    if a in ("-b", "--bind"):
        bind = v
    elif a in ("-p", "--port"):
        port = int(v)
    elif a in ("-t", "--telemetry"):
        if v not in ("on", "off"):
            sys.stderr.write("invalid value for --telemetry: %s\\n" % v)
            sys.exit(2)
        t_flag = v
    elif a in ("-a", "--auth"):
        if v not in ("on", "off"):
            sys.stderr.write("invalid value for --auth: %s\\n" % v)
            sys.exit(2)
        auth = v
    elif a == "--idle-timeout":
        pass
    else:
        sys.stderr.write("unknown flag %s\\n" % a)
        sys.exit(2)
    i += 2

# Real precedence: -t off always wins; else EMULATOR_TELEMETRY off/false/0; else on.
if t_flag == "off":
    telemetry = "off"
elif os.environ.get("EMULATOR_TELEMETRY", "").lower() in ("off", "false", "0"):
    telemetry = "off"
else:
    telemetry = "on"
with open(os.path.join(REC, "settings"), "w") as f:
    f.write("telemetry=%s\\nauth=%s\\nbind=%s\\nrequested_port=%d\\n" % (telemetry, auth, bind, port))

if MODE == "crash":
    sys.stderr.write("credential error: aws_secret_access_key = ${FAKE_SECRET}\\n")
    sys.stderr.write("emulator serve failed: Address in use\\n")
    sys.stderr.flush()
    sys.exit(1)
if MODE == "hang":
    sys.stderr.write("emulator thread panicked: stuck binding\\n")
    sys.stderr.flush()
    while True:
        time.sleep(1)

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/__admin/health":
            body = b"ok"
            self.send_response(200)
        else:
            body = b"nope"
            self.send_response(404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

server = http.server.HTTPServer((bind, port), Handler)
port = server.server_address[1]
home = os.environ["HOME"]
work = tempfile.mkdtemp(dir=home)

def sh(*a):
    subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def make_ca(name):
    key, pem = os.path.join(work, name + ".key"), os.path.join(work, name + ".pem")
    sh("openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
       "-nodes", "-keyout", key, "-out", pem, "-subj", "/CN=fake ca", "-days", "1",
       "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign")
    return key, pem

ca_key, ca_pem = make_ca("ca")
srv_key, srv_csr, srv_pem = [os.path.join(work, n) for n in ("srv.key", "srv.csr", "srv.pem")]
ext = os.path.join(work, "ext")
with open(ext, "w") as f:
    f.write("subjectAltName=IP:127.0.0.1\\n")
sh("openssl", "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
   "-nodes", "-keyout", srv_key, "-out", srv_csr, "-subj", "/CN=127.0.0.1")
sh("openssl", "x509", "-req", "-in", srv_csr, "-CA", ca_pem, "-CAkey", ca_key, "-CAcreateserial",
   "-out", srv_pem, "-days", "1", "-extfile", ext)
published_ca = ca_pem
if MODE == "wrong-ca":
    published_ca = make_ca("other")[1]

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(srv_pem, srv_key)
server.socket = ctx.wrap_socket(server.socket, server_side=True)

key = "EMULATORAK" + secrets.token_hex(5).upper()
secret = secrets.token_hex(20)
with open(os.path.join(REC, "key"), "w") as f:
    f.write(key)
with open(os.path.join(REC, "secret"), "w") as f:
    f.write(secret)
with open(os.path.join(REC, "port"), "w") as f:
    f.write(str(port))

pdir = os.path.join(home, ".aws", "emulator", str(port))
os.makedirs(pdir, mode=0o700, exist_ok=True)
os.chmod(pdir, 0o700)
ca_dest = os.path.join(pdir, "ca.pem")
files = {
    "ca.pem": open(published_ca).read(),
    "config": "[default]\\nregion = us-east-1\\nendpoint_url = https://127.0.0.1:%d\\nca_bundle = %s\\ns3 =\\n  signature_version = s3v4\\n" % (port, ca_dest),
    "emulator_credentials": "[default]\\naws_access_key_id = %s\\naws_secret_access_key = %s\\n" % (key, secret),
    "truststore.p12": "placeholder",
}
if auth == "off":
    del files["emulator_credentials"]  # the real emulator writes none without auth
for name, content in files.items():
    path = os.path.join(pdir, name)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(content)

def stop(*_):
    for name in files:
        try:
            os.remove(os.path.join(pdir, name))
        except OSError:
            pass
    sys.exit(0)

signal.signal(signal.SIGTERM, stop)
if MODE == "die-after-ready":
    threading.Thread(target=server.serve_forever, daemon=True).start()
    while not os.path.exists(os.path.join(REC, "stop-now")):
        time.sleep(0.1)
    sys.stderr.write("emulator fatal error: worker thread died\\n")
    sys.stderr.flush()
    sys.exit(1)
server.serve_forever()
`;
}

function fakeAwsSource(rec: string, account: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
rec=${JSON.stringify(rec)}
[[ "\${AWS_ENDPOINT_URL-}" == https://127.0.0.1:* ]] || { echo "bad AWS_ENDPOINT_URL" >&2; exit 90; }
[[ -r "\${AWS_CA_BUNDLE-}" ]] || { echo "AWS_CA_BUNDLE unreadable" >&2; exit 91; }
[[ "\${AWS_ACCESS_KEY_ID-}" == "$(cat "$rec/key")" ]] || { echo "bad key" >&2; exit 92; }
while [[ "\${1-}" == --cli-* ]]; do shift 2; done
store="$AWS_EMULATOR_STATE_DIR/fakes3"
op="$1 $2"
shift 2
opt() { local n="$1"; shift; while [[ $# -gt 0 ]]; do if [[ "$1" == "$n" ]]; then echo "$2"; return; fi; shift; done; }
case "$op" in
  "sts get-caller-identity") echo ${JSON.stringify(account)} ;;
  "s3api create-bucket") mkdir -p "$store/$(opt --bucket "$@")" ;;
  "s3api put-object") cp "$(opt --body "$@")" "$store/$(opt --bucket "$@")/$(opt --key "$@")" ;;
  "s3api get-object") eval "out=\\"\\\${$#}\\""; cp "$store/$(opt --bucket "$@")/$(opt --key "$@")" "$out" ;;
  "s3api delete-object") rm "$store/$(opt --bucket "$@")/$(opt --key "$@")" ;;
  "s3api delete-bucket") rmdir "$store/$(opt --bucket "$@")" ;;
  *) echo "unsupported: $op" >&2; exit 93 ;;
esac
`;
}

interface Fixture {
  root: string;
  bin: string;
  tmp: string;
  rec: string;
  path: string;
}

async function makeFixture(
  mode: Mode,
  opts: { awsAccount?: string; shareTmp?: string } = {},
): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "aws-emu-5109-" });
  const bin = `${root}/bin`;
  const rec = `${root}/rec`;
  const tmp = opts.shareTmp ?? `${root}/tmp`;
  await Deno.mkdir(bin);
  await Deno.mkdir(rec);
  await Deno.mkdir(tmp, { recursive: true });
  await Deno.writeTextFile(
    `${bin}/aws-emulator`,
    fakeEmulatorSource(mode, rec),
    { mode: 0o755 },
  );
  if (opts.awsAccount !== undefined) {
    await Deno.writeTextFile(
      `${bin}/aws`,
      fakeAwsSource(rec, opts.awsAccount),
      { mode: 0o755 },
    );
  }
  return { root, bin, tmp, rec, path: `${bin}:${SYSTEM_PATH}` };
}

const decoder = new TextDecoder();

function currentUser(): string {
  const out = new Deno.Command("id", { args: ["-un"], stdout: "piped" })
    .outputSync();
  return decoder.decode(out.stdout).trim();
}

const IS_WORKER_ACCOUNT = currentUser() === "vibe";

// The helper refuses the credential-bearing worker account by design, so every
// case that needs it to get past the refusal is ignored when the tests run as
// `vibe`; CI runs these as an ordinary user.
function testAsOrdinaryUser(
  name: string,
  fn: () => Promise<void>,
  alsoIgnore = false,
): void {
  Deno.test({ name, ignore: IS_WORKER_ACCOUNT || alsoIgnore, fn });
}

function helperCommand(
  fx: Fixture,
  args: string[],
  env: Record<string, string> = {},
  path: string = fx.path,
): Deno.Command {
  return new Deno.Command("bash", {
    args: [HELPER, ...args],
    clearEnv: true,
    env: {
      PATH: path,
      HOME: fx.root,
      TMPDIR: fx.tmp,
      ...env,
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHelper(
  fx: Fixture,
  args: string[],
  env: Record<string, string> = {},
  path: string = fx.path,
): Promise<Result> {
  const out = await helperCommand(fx, args, env, path).output();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

// Sends no signal: asks ps for the command line of the pid and looks for a
// token unique to the process under test, so a reaped or reused pid reads as
// "not running".
function isRunning(pid: number, token: string): boolean {
  const out = new Deno.Command("ps", {
    args: ["-p", String(pid), "-o", "command="],
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  return decoder.decode(out.stdout).includes(token);
}

async function readRecord(fx: Fixture, name: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${fx.rec}/${name}`);
  } catch {
    return null;
  }
}

async function assertCleanedUp(fx: Fixture): Promise<void> {
  const left: string[] = [];
  for await (const entry of Deno.readDir(fx.tmp)) left.push(entry.name);
  assertEquals(left, [], "TMPDIR must be empty after the helper exits");
  const pid = await readRecord(fx, "pid");
  if (pid !== null) {
    assertEquals(
      isRunning(Number(pid), `${fx.bin}/aws-emulator`),
      false,
      "fake emulator must not be running",
    );
  }
}

async function withFixture(
  mode: Mode,
  opts: { awsAccount?: string },
  body: (fx: Fixture) => Promise<void>,
): Promise<void> {
  const fx = await makeFixture(mode, opts);
  try {
    await body(fx);
  } finally {
    await Deno.remove(fx.root, { recursive: true });
  }
}

function parseEnv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return map;
}

async function waitForFile(path: string, limitMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return false;
}

testAsOrdinaryUser(
  "aws-emulator-run: happy path scrubs the environment and verifies health",
  async () => {
    await withFixture("normal", {}, async (fx) => {
      const out = `${fx.root}/out`;
      await Deno.mkdir(out);
      const script = `env > "${out}/env.txt"; ` +
        `curl -sS --fail --noproxy '*' --cacert "$AWS_CA_BUNDLE" "$AWS_ENDPOINT_URL/__admin/health" > "${out}/health.txt"`;
      const r = await runHelper(fx, [
        "--ready-timeout",
        "30",
        "--",
        "bash",
        "-c",
        script,
      ], HOSTILE_ENV);
      assertEquals(r.code, 0, r.stderr);
      const port = (await readRecord(fx, "port"))!;
      const key = (await readRecord(fx, "key"))!;
      const secret = (await readRecord(fx, "secret"))!;
      const env = parseEnv(await Deno.readTextFile(`${out}/env.txt`));
      assertEquals(env.get("AWS_ENDPOINT_URL"), `https://127.0.0.1:${port}`);
      assert(env.get("AWS_ACCESS_KEY_ID")!.startsWith("EMULATORAK"));
      assertEquals(env.get("AWS_ACCESS_KEY_ID"), key);
      assertEquals(env.get("AWS_SECRET_ACCESS_KEY"), secret);
      assertEquals(env.get("AWS_PROFILE"), "default");
      assertEquals(env.get("AWS_REGION"), "us-east-1");
      assertEquals(env.get("AWS_EC2_METADATA_DISABLED"), "true");
      assertEquals(env.get("EMULATOR_TELEMETRY"), "off");
      for (
        const name of [
          "AWS_CONFIG_FILE",
          "AWS_SHARED_CREDENTIALS_FILE",
          "AWS_CA_BUNDLE",
        ]
      ) {
        assert(env.get(name)!.startsWith(fx.tmp), `${name} under TMPDIR`);
      }
      for (
        const name of [
          "AWS_ENDPOINT_URL_S3",
          "AWS_WEB_IDENTITY_TOKEN_FILE",
          "AWS_ROLE_ARN",
          "AWS_CONTAINER_CREDENTIALS_FULL_URI",
          "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
          "AWS_SESSION_TOKEN",
          "ECS_CONTAINER_METADATA_URI_V4",
        ]
      ) {
        assertEquals(env.has(name), false, `${name} must be scrubbed`);
      }
      assertEquals((await Deno.readTextFile(`${out}/health.txt`)).trim(), "ok");

      const settings = parseEnv((await readRecord(fx, "settings"))!);
      assertEquals(settings.get("telemetry"), "off");
      assertEquals(settings.get("auth"), "on");
      assertEquals(settings.get("bind"), "127.0.0.1");
      assertEquals(settings.get("requested_port"), "0");
      const emuEnv = parseEnv((await readRecord(fx, "env"))!);
      assertEquals([...emuEnv.keys()].filter((k) => k.startsWith("AWS_")), []);
      assertEquals(emuEnv.get("EMULATOR_TELEMETRY"), "off");
      assertEquals((r.stdout + r.stderr).includes(secret), false);
      await assertCleanedUp(fx);
    });
  },
);

testAsOrdinaryUser(
  "aws-emulator-run: propagates the command's exit code",
  async () => {
    await withFixture("normal", {}, async (fx) => {
      const r = await runHelper(fx, ["--", "bash", "-c", "exit 7"]);
      assertEquals(r.code, 7, r.stderr);
      await assertCleanedUp(fx);
    });
  },
);

testAsOrdinaryUser(
  "aws-emulator-run: emulator never ready exits 5",
  async () => {
    await withFixture("hang", {}, async (fx) => {
      const r = await runHelper(fx, ["--ready-timeout", "2", "--", "true"]);
      assertEquals(r.code, 5, r.stderr);
      assertStringIncludes(r.stderr, "[aws-emulator-run] FAILED:");
      assertStringIncludes(r.stderr, "not ready");
      assertStringIncludes(r.stderr, "stuck binding");
      await assertCleanedUp(fx);
    });
  },
);

testAsOrdinaryUser(
  "aws-emulator-run: emulator exiting early exits 5 with its cause line",
  async () => {
    await withFixture("crash", {}, async (fx) => {
      const r = await runHelper(fx, ["--ready-timeout", "20", "--", "true"]);
      assertEquals(r.code, 5, r.stderr);
      assertStringIncludes(r.stderr, "[aws-emulator-run] FAILED:");
      assertStringIncludes(r.stderr, "Address in use");
      assertEquals(
        r.stderr.includes(FAKE_SECRET),
        false,
        "the emulator's credential text must be redacted",
      );
      await assertCleanedUp(fx);
    });
  },
);

testAsOrdinaryUser(
  "aws-emulator-run: health not verified against this run's CA exits 5",
  async () => {
    await withFixture("wrong-ca", {}, async (fx) => {
      const marker = `${fx.root}/ran`;
      const r = await runHelper(fx, [
        "--ready-timeout",
        "3",
        "--",
        "bash",
        "-c",
        `touch "${marker}"`,
      ]);
      assertEquals(r.code, 5, r.stderr);
      assertStringIncludes(r.stderr, "[aws-emulator-run] FAILED:");
      assertStringIncludes(r.stderr, "not verified");
      assertEquals(
        await waitForFile(marker, 200),
        false,
        "COMMAND must never run",
      );
      await assertCleanedUp(fx);
    });
  },
);

testAsOrdinaryUser(
  "aws-emulator-run: concurrent runs never share a port or state dir",
  async () => {
    const a = await makeFixture("normal");
    const b = await makeFixture("normal", { shareTmp: a.tmp });
    try {
      const ctl = `${a.root}/ctl`;
      await Deno.mkdir(ctl);
      // Each COMMAND announces itself, then waits (bounded) for the other run's
      // announcement, so both emulators are provably up at the same time.
      const script = `ctl="$1"; me="$2"; other="$3"
: > "$ctl/ready-$me"
i=0
while [[ ! -e "$ctl/ready-$other" && $i -lt 300 ]]; do sleep 0.1; i=$((i + 1)); done
[[ -e "$ctl/ready-$other" ]] || { echo "the other run never started" >&2; exit 9; }
echo "$AWS_ENDPOINT_URL $AWS_EMULATOR_STATE_DIR"`;
      const [ra, rb] = await Promise.all([
        runHelper(a, [
          "--ready-timeout",
          "30",
          "--",
          "bash",
          "-c",
          script,
          "_",
          ctl,
          "1",
          "2",
        ]),
        runHelper(b, [
          "--ready-timeout",
          "30",
          "--",
          "bash",
          "-c",
          script,
          "_",
          ctl,
          "2",
          "1",
        ]),
      ]);
      assertEquals([ra.code, rb.code], [0, 0], ra.stderr + rb.stderr);
      const [urlA, dirA] = ra.stdout.trim().split(" ");
      const [urlB, dirB] = rb.stdout.trim().split(" ");
      assert(urlA !== urlB, "different endpoints");
      assert(dirA !== dirB, "different state dirs");
      await assertCleanedUp(a);
      await assertCleanedUp(b);
    } finally {
      await Deno.remove(a.root, { recursive: true });
      await Deno.remove(b.root, { recursive: true });
    }
  },
);

Deno.test({
  name:
    "aws-emulator-run: the worker account vibe is always refused, even with the override emptied",
  ignore: !IS_WORKER_ACCOUNT,
  fn: async () => {
    await withFixture("normal", {}, async (fx) => {
      for (
        const env of [{} as Record<string, string>, {
          AWS_EMULATOR_RUN_REFUSED_USERS: "",
        }]
      ) {
        const r = await runHelper(fx, ["--", "true"], env);
        assertEquals(r.code, 3, r.stderr);
        assertStringIncludes(r.stderr, "[aws-emulator-run] FAILED:");
        assertStringIncludes(r.stderr, "vibe");
        assertEquals(
          await readRecord(fx, "pid"),
          null,
          "emulator must not have started",
        );
      }
      await assertCleanedUp(fx);
    });
  },
});

Deno.test({
  name:
    "aws-emulator-run: AWS_EMULATOR_RUN_REFUSED_USERS adds accounts and never starts the emulator",
  ignore: IS_WORKER_ACCOUNT, // the allowed control run needs a non-vibe account
  fn: async () => {
    await withFixture("normal", {}, async (fx) => {
      const me = currentUser();
      const r = await runHelper(fx, ["--", "true"], {
        AWS_EMULATOR_RUN_REFUSED_USERS: `someone ${me}`,
      });
      assertEquals(r.code, 3, r.stderr);
      assertStringIncludes(r.stderr, "[aws-emulator-run] FAILED:");
      assertStringIncludes(r.stderr, me);
      assertEquals(
        await readRecord(fx, "pid"),
        null,
        "emulator must not have started",
      );
      // Control: the same account is allowed when it is not listed.
      const ok = await runHelper(fx, ["--", "true"], {
        AWS_EMULATOR_RUN_REFUSED_USERS: "someone",
      });
      assertEquals(ok.code, 0, ok.stderr);
      await assertCleanedUp(fx);
    });
  },
});

const HAS_TIMEOUT = ["timeout", "gtimeout"].some((name) =>
  new Deno.Command("sh", {
    args: ["-c", `command -v ${name}`],
    env: { PATH: SYSTEM_PATH },
    clearEnv: true,
    stdout: "null",
    stderr: "null",
  }).outputSync().success
);

testAsOrdinaryUser(
  "aws-emulator-run: SIGTERM stops the command, the emulator and the state dir",
  async () => {
    await withFixture("normal", {}, async (fx) => {
      const marker = `${fx.root}/marker`;
      const sleeperPid = `${fx.root}/sleeper.pid`;
      // A fractional duration makes the sleeper's command line unique to us.
      const sleepToken = `sleep 300.${Date.now()}${
        Math.floor(Math.random() * 1000)
      }`;
      const script =
        `echo up > "${marker}"; ${sleepToken} & echo $! > "${sleeperPid}"; wait`;
      const child = helperCommand(fx, [
        "--ready-timeout",
        "30",
        "--",
        "bash",
        "-c",
        script,
      ]).spawn();
      const out = child.output();
      assert(await waitForFile(sleeperPid), "command must start");
      assert(await waitForFile(marker), "command marker must appear");
      child.kill("SIGTERM");
      const r = await out;
      assertEquals(r.code, 143, decoder.decode(r.stderr));
      await assertCleanedUp(fx);
      const sleeper = Number((await Deno.readTextFile(sleeperPid)).trim());
      assertEquals(
        isRunning(sleeper, sleepToken),
        false,
        "the command's sleep child must not be running",
      );
    });
  },
  !HAS_TIMEOUT,
); // neither timeout nor gtimeout: only COMMAND itself is signalled

Deno.test({
  name: "aws-emulator-run: --timeout kills a long command with exit 124",
  ignore: IS_WORKER_ACCOUNT || !HAS_TIMEOUT, // refused account, or no timeout/gtimeout
  fn: async () => {
    await withFixture("normal", {}, async (fx) => {
      const r = await runHelper(fx, [
        "--ready-timeout",
        "30",
        "--timeout",
        "1",
        "--",
        "sleep",
        "30",
      ]);
      assertEquals(r.code, 124, r.stderr);
      await assertCleanedUp(fx);
    });
  },
});

testAsOrdinaryUser(
  "aws-emulator-run: missing aws-emulator exits 4 naming it",
  async () => {
    await withFixture("normal", {}, async (fx) => {
      const r = await runHelper(fx, ["--", "true"], {}, SYSTEM_PATH);
      assertEquals(r.code, 4, r.stderr);
      assertStringIncludes(r.stderr, "[aws-emulator-run] FAILED:");
      assertStringIncludes(r.stderr, "aws-emulator");
      await assertCleanedUp(fx);
    });
  },
);

Deno.test("aws-emulator-run: usage errors exit 2", async () => {
  await withFixture("normal", {}, async (fx) => {
    const noCommand = await runHelper(fx, []);
    assertEquals(noCommand.code, 2, noCommand.stderr);
    assertStringIncludes(noCommand.stderr, "FAILED:");
    const zero = await runHelper(fx, ["--ready-timeout", "0", "--", "true"]);
    assertEquals(zero.code, 2, zero.stderr);
    assertStringIncludes(zero.stderr, "--ready-timeout");
    assertEquals(await readRecord(fx, "pid"), null);
  });
});

testAsOrdinaryUser(
  "aws-emulator-run: --smoke passes against the fake",
  async () => {
    await withFixture("normal", { awsAccount: "000000000000" }, async (fx) => {
      const r = await runHelper(fx, ["--ready-timeout", "30", "--smoke"]);
      assertEquals(r.code, 0, r.stderr);
      assertStringIncludes(r.stdout + r.stderr, "smoke passed");
      await assertCleanedUp(fx);
    });
  },
);

testAsOrdinaryUser(
  "aws-emulator-run: --smoke fails on an account mismatch",
  async () => {
    await withFixture("normal", { awsAccount: "123456789012" }, async (fx) => {
      const r = await runHelper(fx, ["--ready-timeout", "30", "--smoke"]);
      assert(r.code !== 0, "a real account id must fail the smoke");
      assertStringIncludes(r.stderr, "[aws-emulator-run] FAILED:");
      assertStringIncludes(r.stderr, "account mismatch");
      await assertCleanedUp(fx);
    });
  },
);

testAsOrdinaryUser(
  "aws-emulator-run: an emulator that stops while COMMAND runs exits 5",
  async () => {
    await withFixture("die-after-ready", {}, async (fx) => {
      const r = await runHelper(fx, [
        "--ready-timeout",
        "30",
        "--",
        "bash",
        "-c",
        `touch "${fx.rec}/stop-now"; sleep 2`,
      ]);
      assertEquals(r.code, 5, r.stderr);
      assertStringIncludes(
        r.stderr,
        "[aws-emulator-run] FAILED: emulator stopped while COMMAND ran:",
      );
      assertStringIncludes(r.stderr, "worker thread died");
      await assertCleanedUp(fx);
    });
  },
);
