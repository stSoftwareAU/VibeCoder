/**
 * Tests for the Linux/podman verification host CloudFormation template
 * (Issue #721).
 *
 * The maintainer develops on macOS only, so the launcher's Linux/podman path
 * has never been confirmed on a real Linux host. The template committed at
 * `infra/cloudformation/linux-verification-host.yaml` launches one Ubuntu EC2
 * instance reachable **only** through SSM Session Manager, with the launcher
 * prerequisites installed, so that path can be exercised by hand.
 *
 * The template is deployed by a human, so these tests are the only automated
 * gate on it. They pin the properties a reviewer cannot eyeball reliably:
 *
 *   - Access really is SSM-only — no key pair, no inbound rule anywhere.
 *   - The instance profile carries the SSM managed policy and nothing wider.
 *   - The UserData script is valid bash (`bash -n`) once `Fn::Sub` is
 *     rendered, and every `${…}` in it is either an escaped shell variable
 *     (`${!VAR}`) or a name CloudFormation can actually resolve — the
 *     substitution footgun that turns a template into a stack that deploys
 *     and then silently boots a broken host.
 *   - The documented launch / verify / tear-down commands exist.
 *
 * Intrinsics in the template are written in full function form (`Ref:`,
 * `Fn::Sub:`) rather than the `!Ref` short tags precisely so a standard YAML
 * parser — and therefore this test — can read it.
 *
 * Australian English spelling used throughout (behaviour, colour).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

const TEMPLATE_PATH = "infra/cloudformation/linux-verification-host.yaml";
const DOC_PATH = "docs/EC2-LINUX-VERIFICATION.md";

/** tests/ → worker/deno/ → worker/ → repository root. */
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

function read(relative: string): string {
  return Deno.readTextFileSync(repoPath(relative));
}

type Node = Record<string, unknown>;

/** Assert `value` is a plain object and narrow it. */
function asRecord(value: unknown, what: string): Node {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${what} should be an object, got ${JSON.stringify(value)}`,
  );
  return value as Node;
}

function asArray(value: unknown, what: string): unknown[] {
  assert(Array.isArray(value), `${what} should be a list`);
  return value;
}

function template(): Node {
  return asRecord(parseYaml(read(TEMPLATE_PATH)), "the template");
}

function section(name: string): Node {
  return asRecord(template()[name], `the ${name} section`);
}

/** Every resource of `type`, keyed by logical id. */
function resourcesOfType(type: string): Map<string, Node> {
  const found = new Map<string, Node>();
  for (const [logicalId, raw] of Object.entries(section("Resources"))) {
    const resource = asRecord(raw, `resource ${logicalId}`);
    if (resource.Type === type) {
      found.set(logicalId, asRecord(resource.Properties ?? {}, logicalId));
    }
  }
  return found;
}

/**
 * Every value stored under `key` anywhere in the parsed template.
 *
 * Templates nest — a property can sit under a resource, a list item, or an
 * intrinsic — so a question like "is a key pair configured anywhere?" is asked
 * of the parsed model at any depth rather than of the file's characters.
 */
export function valuesOfKey(node: unknown, key: string): unknown[] {
  if (Array.isArray(node)) {
    return node.flatMap((item) => valuesOfKey(item, key));
  }
  if (typeof node !== "object" || node === null) return [];
  const found: unknown[] = [];
  for (const [name, value] of Object.entries(node as Node)) {
    if (name === key) found.push(value);
    found.push(...valuesOfKey(value, key));
  }
  return found;
}

/** The single resource of `type` — the template declares exactly one. */
function soleResource(type: string): Node {
  const found = resourcesOfType(type);
  assertEquals(found.size, 1, `expected exactly one ${type}`);
  return [...found.values()][0] as Node;
}

// ---------------------------------------------------------------------------
// Fn::Sub and script helpers. Each is exported so it is addressable on its own
// and is covered by unit tests over synthetic inputs below, as well as being
// used by the artefact tests further down.
// ---------------------------------------------------------------------------

/**
 * The names CloudFormation would substitute into an `Fn::Sub` string.
 *
 * `${!VAR}` is the documented escape for a literal `${VAR}` in the rendered
 * output (a shell variable), so it is not a substitution and is skipped.
 */
export function substitutionNames(script: string): string[] {
  const names: string[] = [];
  for (const match of script.matchAll(/\$\{([^}]*)\}/g)) {
    const body = match[1] ?? "";
    if (body.startsWith("!")) continue;
    names.push(body.trim());
  }
  return names;
}

/**
 * Render an `Fn::Sub` string the way CloudFormation would: named
 * substitutions replaced by `values`, `${!VAR}` unescaped back to `${VAR}`.
 *
 * Throws when a substitution has no value — the same failure CloudFormation
 * raises at deploy time, surfaced here instead.
 */
export function renderSubScript(
  script: string,
  values: Record<string, string>,
): string {
  return script.replace(/\$\{([^}]*)\}/g, (_whole, rawBody: string) => {
    const body = rawBody.trim();
    if (body.startsWith("!")) return `\${${body.slice(1)}}`;
    const value = values[body];
    if (value === undefined) {
      throw new Error(`no value for substitution \${${body}}`);
    }
    return value;
  });
}

/** The `Fn::Sub` script inside `{Fn::Base64: {Fn::Sub: "…"}}`, or null. */
export function extractUserDataScript(userData: unknown): string | null {
  if (typeof userData !== "object" || userData === null) return null;
  const base64 = (userData as Node)["Fn::Base64"];
  if (typeof base64 !== "object" || base64 === null) return null;
  const sub = (base64 as Node)["Fn::Sub"];
  return typeof sub === "string" ? sub : null;
}

/** Parameter defaults, as the strings a rendered script would carry. */
function parameterDefaults(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, raw] of Object.entries(section("Parameters"))) {
    const parameter = asRecord(raw, `parameter ${name}`);
    if (parameter.Default !== undefined) {
      values[name] = String(parameter.Default);
    }
  }
  return values;
}

/** Pseudo-parameters CloudFormation resolves without a declaration. */
const PSEUDO_PARAMETERS: Record<string, string> = {
  "AWS::StackName": "vibe-linux-verification",
  "AWS::Region": "ap-southeast-2",
  "AWS::Partition": "aws",
  "AWS::AccountId": "111111111111",
  "AWS::URLSuffix": "amazonaws.com",
};

/**
 * Package names an `apt-get install` line in `script` installs — flags and
 * the command itself dropped, so the assertion is about the package set and
 * not about how the line happens to be written.
 */
export function aptPackages(script: string): string[] {
  const packages: string[] = [];
  for (const match of script.matchAll(/apt-get\s+install\s+([^\n]*)/g)) {
    for (const token of (match[1] ?? "").trim().split(/\s+/)) {
      if (token && !token.startsWith("-")) packages.push(token);
    }
  }
  return packages;
}

/**
 * The script up to and including its `trap` line: the options, the failure
 * handler and the trap that arms it, with nothing that touches the host.
 */
export function scriptPrelude(script: string): string {
  const lines = script.split("\n");
  const trapIndex = lines.findIndex((line) => line.trim().startsWith("trap "));
  assert(trapIndex >= 0, "the bootstrap should install an ERR trap");
  return lines.slice(0, trapIndex + 1).join("\n");
}

function userDataScript(): string {
  const instance = soleResource("AWS::EC2::Instance");
  const script = extractUserDataScript(instance.UserData);
  assert(
    script !== null,
    "the instance should carry an Fn::Base64/Fn::Sub UserData script",
  );
  return script;
}

/** The UserData script as CloudFormation would render it on the host. */
function renderedUserData(overrides: Record<string, string> = {}): string {
  return renderSubScript(userDataScript(), {
    ...parameterDefaults(),
    ...PSEUDO_PARAMETERS,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Unit tests for the script helpers
// ---------------------------------------------------------------------------

Deno.test("aptPackages lists installed packages and drops flags", () => {
  assertEquals(
    aptPackages("apt-get update\napt-get install -y git podman\n"),
    ["git", "podman"],
  );
  assertEquals(aptPackages("apt-get update"), []);
});

Deno.test("scriptPrelude stops at the trap that arms the failure handler", () => {
  const script =
    "set -e\nfail() { :; }\ntrap 'fail' ERR\napt-get install -y git";
  assertEquals(scriptPrelude(script), "set -e\nfail() { :; }\ntrap 'fail' ERR");
});

Deno.test("substitutionNames lists template substitutions and skips shell escapes", () => {
  const script = 'echo "${AutoStopHours}" "${!HOME}" "${AWS::StackName}"';
  assertEquals(substitutionNames(script), ["AutoStopHours", "AWS::StackName"]);
});

Deno.test("substitutionNames returns nothing for a script with no substitutions", () => {
  assertEquals(substitutionNames(""), []);
  assertEquals(substitutionNames("echo $HOME && echo done"), []);
});

Deno.test("renderSubScript substitutes names and unescapes shell variables", () => {
  const rendered = renderSubScript(
    'shutdown -h +${AutoStopHours} "${!MESSAGE}"',
    { AutoStopHours: "480" },
  );
  assertEquals(rendered, 'shutdown -h +480 "${MESSAGE}"');
});

Deno.test("renderSubScript throws on a substitution with no value", () => {
  let message = "";
  try {
    renderSubScript("echo ${Unknown}", {});
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertStringIncludes(message, "no value for substitution ${Unknown}");
});

Deno.test("extractUserDataScript returns null for shapes that are not Fn::Base64/Fn::Sub", () => {
  assertEquals(extractUserDataScript(undefined), null);
  assertEquals(extractUserDataScript("#!/bin/bash"), null);
  assertEquals(extractUserDataScript({ "Fn::Base64": "plain" }), null);
  assertEquals(
    extractUserDataScript({ "Fn::Base64": { "Fn::Sub": "#!/bin/bash\n" } }),
    "#!/bin/bash\n",
  );
});

// ---------------------------------------------------------------------------
// The template itself
// ---------------------------------------------------------------------------

Deno.test("template parses and declares the CloudFormation format version", () => {
  const parsed = template();
  assertEquals(parsed.AWSTemplateFormatVersion, "2010-09-09");
  assertStringIncludes(String(parsed.Description), "Session Manager");
});

Deno.test("access is SSM only: no key pair and no inbound rule anywhere", () => {
  assertEquals(
    valuesOfKey(template(), "KeyName"),
    [],
    "a key pair would be a second way in — SSM Session Manager is the only access path",
  );
  assertEquals(
    resourcesOfType("AWS::EC2::SecurityGroupIngress").size,
    0,
    "no standalone ingress rule may be attached",
  );
  for (
    const [logicalId, properties] of resourcesOfType("AWS::EC2::SecurityGroup")
  ) {
    const ingress = properties.SecurityGroupIngress;
    assert(
      ingress === undefined || (Array.isArray(ingress) && ingress.length === 0),
      `${logicalId} declares inbound rules; the host takes no inbound traffic`,
    );
  }
});

Deno.test("egress is scoped to the ports the bootstrap needs, never to management ports", () => {
  const group = soleResource("AWS::EC2::SecurityGroup");
  const egress = asArray(group.SecurityGroupEgress, "SecurityGroupEgress");
  assert(
    egress.length > 0,
    "explicit egress rules replace the default allow-all",
  );
  const managementPorts = [22, 3389];
  for (const raw of egress) {
    const rule = asRecord(raw, "an egress rule");
    for (const port of managementPorts) {
      const opensPort = Number(rule.FromPort) <= port &&
        Number(rule.ToPort) >= port;
      assertEquals(
        opensPort,
        false,
        `egress must not open management port ${port}`,
      );
    }
  }
});

Deno.test("the instance profile grants the SSM managed policy and nothing wider", () => {
  const role = soleResource("AWS::IAM::Role");
  const managed = asArray(role.ManagedPolicyArns, "ManagedPolicyArns");
  assertEquals(
    managed.length,
    1,
    "one managed policy — SSM core — and no more",
  );
  assertStringIncludes(
    JSON.stringify(managed[0]),
    "AmazonSSMManagedInstanceCore",
  );
  assertEquals(
    role.Policies,
    undefined,
    "no inline policy: the host needs nothing beyond SSM core",
  );
  // Walk the parsed template rather than its characters, so a wildcard
  // survives no spelling — "*", ['*'], or a block sequence.
  const grants = [
    ...valuesOfKey(template(), "Action"),
    ...valuesOfKey(template(), "Resource"),
  ].flatMap((value) => Array.isArray(value) ? value : [value]);
  assertEquals(
    grants.filter((grant) => grant === "*"),
    [],
    "no wildcard IAM action or resource",
  );
});

Deno.test("the host is hardened: encrypted root volume, IMDSv2 required, stop on shutdown", () => {
  const instance = soleResource("AWS::EC2::Instance");
  const metadata = asRecord(instance.MetadataOptions, "MetadataOptions");
  assertEquals(metadata.HttpTokens, "required", "IMDSv2 only");
  assertEquals(metadata.HttpPutResponseHopLimit, 1);
  assertEquals(
    instance.InstanceInitiatedShutdownBehavior,
    "stop",
    "the auto-stop shutdown must stop the instance, not terminate it",
  );
  const devices = asArray(instance.BlockDeviceMappings, "BlockDeviceMappings");
  const ebs = asRecord(asRecord(devices[0], "the root device").Ebs, "Ebs");
  assertEquals(ebs.Encrypted, true, "the root volume is encrypted at rest");
  assertEquals(ebs.DeleteOnTermination, true);
});

Deno.test("the template is self-contained: its own VPC, public subnet and internet gateway", () => {
  assertEquals(resourcesOfType("AWS::EC2::VPC").size, 1);
  assertEquals(resourcesOfType("AWS::EC2::InternetGateway").size, 1);
  assertEquals(resourcesOfType("AWS::EC2::Subnet").size, 1);
  const routes = [...resourcesOfType("AWS::EC2::Route").values()];
  const defaultRoute = routes.find((route) =>
    route.DestinationCidrBlock === "0.0.0.0/0"
  );
  assert(
    defaultRoute !== undefined,
    "a default route to the gateway is needed for egress",
  );
  assert(
    "GatewayId" in defaultRoute,
    "the default route targets the internet gateway",
  );
});

Deno.test("parameters cover the instance size, disk, auto-stop window and checkout", () => {
  const parameters = section("Parameters");
  const autoStop = asRecord(parameters.AutoStopHours, "AutoStopHours");
  assertEquals(autoStop.Type, "Number");
  assertEquals(
    autoStop.Default,
    8,
    "the accepted default auto-stop window is 8 hours",
  );
  const instanceType = asRecord(parameters.InstanceType, "InstanceType");
  assertEquals(instanceType.Default, "t3.large");
  const volume = asRecord(parameters.RootVolumeSizeGb, "RootVolumeSizeGb");
  assertEquals(volume.Type, "Number");
  assert(
    Number(volume.MinValue) >= 60,
    "the image build plus the work volume needs headroom above the 20 GB claiming floor",
  );
  const repository = asRecord(
    parameters.VibeCoderRepositoryUrl,
    "VibeCoderRepositoryUrl",
  );
  assertStringIncludes(String(repository.Default), "VibeCoder");
});

Deno.test("the AMI comes from the SSM public parameter, never a hard-coded image id", () => {
  const ami = asRecord(section("Parameters").UbuntuAmiId, "UbuntuAmiId");
  assertEquals(ami.Type, "AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>");
  assertStringIncludes(String(ami.Default), "ubuntu/server/24.04");
  assertEquals(
    /\bami-[0-9a-f]{8,}/.test(read(TEMPLATE_PATH)),
    false,
    "a pinned AMI id would rot and would pin the template to one region",
  );
});

Deno.test("every UserData substitution resolves to a declared parameter or pseudo-parameter", () => {
  const known = new Set([
    ...Object.keys(section("Parameters")),
    ...Object.keys(PSEUDO_PARAMETERS),
  ]);
  const unknown = substitutionNames(userDataScript()).filter((name) =>
    !known.has(name)
  );
  assertEquals(
    unknown,
    [],
    "an unescaped shell ${VAR} in an Fn::Sub script fails the deploy — write it as ${!VAR}",
  );
});

Deno.test("the rendered UserData script is valid bash", async () => {
  const rendered = renderedUserData();
  const check = new Deno.Command("bash", {
    args: ["-n", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = check.stdin.getWriter();
  await writer.write(new TextEncoder().encode(rendered));
  await writer.close();
  const { code, stderr } = await check.output();
  assertEquals(
    code,
    0,
    `bash -n rejected the UserData script:\n${
      new TextDecoder().decode(stderr)
    }`,
  );
});

Deno.test("a failing bootstrap step records FAILED instead of carrying on", async () => {
  // Run the script's own prelude — its options, its fail() and its ERR trap —
  // against a failing command, with the status and log paths redirected into a
  // temporary directory. This exercises the fail-loud machinery rather than
  // asserting that the words are present in the file.
  const directory = await Deno.makeTempDir({ prefix: "vibe-bootstrap-" });
  try {
    const prelude = scriptPrelude(renderedUserData()).replaceAll(
      "/var/log/vibe-bootstrap",
      `${directory}/vibe-bootstrap`,
    );
    const result = await new Deno.Command("bash", {
      args: ["-c", `${prelude}\nfalse\necho "OK" > "$STATUS"\n`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      result.success,
      false,
      "the failing step must abort the bootstrap",
    );
    const status = await Deno.readTextFile(
      `${directory}/vibe-bootstrap.status`,
    );
    assertStringIncludes(
      status,
      "FAILED",
      "a failed bootstrap must leave a status an operator can read over SSM",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the UserData script installs the launcher prerequisites and clones the checkout", () => {
  const packages = aptPackages(renderedUserData());
  for (const required of ["git", "gh", "jq", "podman", "unzip"]) {
    assert(
      packages.includes(required),
      `the bootstrap should install ${required}; it installs ${
        packages.join(", ")
      }`,
    );
  }
  const script = userDataScript();
  assertStringIncludes(script, "https://deno.land/install.sh");
  assertStringIncludes(script, "https://claude.ai/install.sh");
  assertStringIncludes(script, "git clone ${VibeCoderRepositoryUrl}");
});

Deno.test("the bootstrap proves each prerequisite runs before it reports OK", () => {
  const lines = renderedUserData().split("\n").map((line) => line.trim());
  const okIndex = lines.findIndex((line) => line.startsWith('echo "OK"'));
  assert(okIndex > 0, "the bootstrap should record a final OK status");
  const beforeOk = lines.slice(0, okIndex).join("\n");
  for (const tool of ["podman", "git", "gh", "deno", "claude"]) {
    assertStringIncludes(
      beforeOk,
      `${tool} --version`,
      `OK must mean ${tool} actually runs, not that its installer did not obviously fail`,
    );
  }
});

Deno.test("every piped installer sets pipefail inside its own shell", () => {
  // runuser starts a fresh login shell, so the outer `set -o pipefail` does
  // not apply: without this, a failed download exits 0 through the
  // interpreter and the bootstrap continues as though it had worked.
  for (const line of renderedUserData().split("\n")) {
    if (!line.includes("runuser") || !line.includes("|")) continue;
    assertStringIncludes(
      line,
      "set -o pipefail",
      `unguarded pipeline: ${line.trim()}`,
    );
  }
});

Deno.test("the auto-stop delay is computed from the parameter, in minutes", async () => {
  const cases: [string, string][] = [["3", "+180"], ["8", "+480"]];
  for (const [hours, expected] of cases) {
    const rendered = renderedUserData({ AutoStopHours: hours });
    const line = rendered.split("\n").map((l) => l.trim()).find((l) =>
      l.startsWith("shutdown ")
    );
    assert(line !== undefined, "the bootstrap should schedule a shutdown");
    // Evaluate the real command line with `shutdown` stubbed out, so the
    // arithmetic is checked as bash would compute it.
    const result = await new Deno.Command("bash", {
      args: ["-c", `shutdown() { printf '%s' "$2"; }\n${line}`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      new TextDecoder().decode(result.stdout),
      expected,
      `AutoStopHours=${hours} should stop the host after ${expected} minutes`,
    );
  }
});

Deno.test("podman is left stock so the known environment faults still reproduce", () => {
  const script = renderedUserData();
  for (const patch of ["registries.conf", "short-name-mode"]) {
    assertEquals(
      script.includes(patch),
      false,
      `pre-patching ${patch} would hide the podman faults this host exists to reproduce (Issue #722)`,
    );
  }
  assertEquals(
    aptPackages(script).filter((name) => name.startsWith("docker")),
    [],
    "only podman is installed, so the launcher's podman branch is the path exercised",
  );
});

Deno.test("no credential material or account identifier is embedded", () => {
  const raw = read(TEMPLATE_PATH);
  const forbidden: [RegExp, string][] = [
    [/AKIA[0-9A-Z]{16}/, "an AWS access key id"],
    [/gh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
    [/sk-ant-[A-Za-z0-9-]{10,}/, "an Anthropic key"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key material"],
    [/arn:aws:[a-z0-9-]*:[a-z0-9-]*:\d{12}:/, "a hard-coded account id"],
  ];
  for (const [pattern, what] of forbidden) {
    assertEquals(
      pattern.test(raw),
      false,
      `the template must not contain ${what}`,
    );
  }
});

Deno.test("outputs name the instance and the session command, and export nothing", () => {
  const outputs = section("Outputs");
  assertStringIncludes(
    JSON.stringify(outputs.InstanceId),
    "VerificationHost",
    "the instance id is what `aws ssm start-session --target` needs",
  );
  assertStringIncludes(
    JSON.stringify(outputs.StartSessionCommand),
    "aws ssm start-session",
  );
  for (const [name, raw] of Object.entries(outputs)) {
    const output = asRecord(raw, `output ${name}`);
    assertEquals(
      output.Export,
      undefined,
      `${name} must not export: an export couples another stack to this throwaway host`,
    );
  }
});

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

Deno.test("the verification guide documents launch, verification and tear-down", () => {
  const doc = read(DOC_PATH);
  for (
    const needle of [
      TEMPLATE_PATH,
      "aws cloudformation deploy",
      "aws ssm start-session",
      "aws cloudformation delete-stack",
      "./setup.sh",
      "./run.sh",
      "/var/log/vibe-bootstrap.status",
    ]
  ) {
    assertStringIncludes(doc, needle);
  }
});

Deno.test("the deployment guide links the verification host page", () => {
  assertStringIncludes(read("docs/DEPLOYMENT.md"), "EC2-LINUX-VERIFICATION.md");
});
