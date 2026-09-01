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

/** The single resource of `type` — the template declares exactly one. */
function soleResource(type: string): Node {
  const found = resourcesOfType(type);
  assertEquals(found.size, 1, `expected exactly one ${type}`);
  return [...found.values()][0] as Node;
}

// ---------------------------------------------------------------------------
// Fn::Sub helpers — exported so they are exercised directly below, and so the
// artefact tests and the unit tests share one implementation.
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

function userDataScript(): string {
  const instance = soleResource("AWS::EC2::Instance");
  const script = extractUserDataScript(instance.UserData);
  assert(
    script !== null,
    "the instance should carry an Fn::Base64/Fn::Sub UserData script",
  );
  return script;
}

// ---------------------------------------------------------------------------
// Unit tests for the Fn::Sub helpers
// ---------------------------------------------------------------------------

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
  const raw = read(TEMPLATE_PATH);
  assertEquals(
    raw.includes("KeyName"),
    false,
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
  assertEquals(
    read(TEMPLATE_PATH).includes('Action: "*"'),
    false,
    "no wildcard IAM action",
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
  const rendered = renderSubScript(userDataScript(), {
    ...parameterDefaults(),
    ...PSEUDO_PARAMETERS,
  });
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

Deno.test("the UserData script fails loud rather than booting a half-built host", () => {
  const script = userDataScript();
  assertStringIncludes(script, "set -euo pipefail");
  assertStringIncludes(script, "trap");
  assertStringIncludes(
    script,
    "FAILED",
    "a failed bootstrap must leave a status an operator can read over SSM",
  );
});

Deno.test("the UserData script installs the launcher prerequisites and clones the checkout", () => {
  const script = userDataScript();
  for (
    const needle of [
      "podman",
      "git",
      "gh",
      "https://deno.land/install.sh",
      "https://claude.ai/install.sh",
      "git clone",
      "${VibeCoderRepositoryUrl}",
    ]
  ) {
    assertStringIncludes(script, needle);
  }
});

Deno.test("the UserData script schedules the parameterised auto-stop", () => {
  const script = userDataScript();
  assertStringIncludes(script, "${AutoStopHours}");
  assertStringIncludes(script, "shutdown");
});

Deno.test("podman is left stock so the known environment faults still reproduce", () => {
  const raw = read(TEMPLATE_PATH);
  for (const patch of ["registries.conf", "short-name-mode"]) {
    assertEquals(
      raw.includes(patch),
      false,
      `pre-patching ${patch} would hide the podman faults this host exists to reproduce (Issue #722)`,
    );
  }
  assertEquals(
    /\bdocker\.io\/|install -y docker/.test(raw),
    false,
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
