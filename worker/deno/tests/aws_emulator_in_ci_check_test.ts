/**
 * Tests for the deterministic AWS-emulator-in-CI check (Issue #3366, part
 * of #3346).
 *
 * Covers both halves of the check independently: does the repo show AWS
 * usage (manifests, CloudFormation templates, Terraform), and does any
 * loaded GitHub Actions workflow run the `floci/floci` emulator image.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";

import {
  type AwsEmulatorCheckResult,
  cargoTomlUsesAws,
  checkAwsEmulatorInCI,
  isCfnTemplate,
  isFlociImage,
  makeRepoScriptReader,
  packageJsonUsesAws,
  pomXmlUsesAws,
  requirementsUsesAws,
  terraformUsesAws,
  workflowRunsAwsEmulator,
  workflowRunsFloci,
} from "../lib/aws_emulator_in_ci_check.ts";
import { parse as parseYaml } from "@std/yaml/parse";
import {
  commandIndex,
  commandPrefixWords,
  reachableCommands,
  removeQuotes,
  shellSegments,
} from "../lib/shell_command_words.ts";

async function makeTempRepo(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "aws_emulator_in_ci_check_test_" });
}

async function writeFile(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  const path = `${root}/${relPath}`;
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, content);
}

// ---------------------------------------------------------------------------
// AWS detection — single-manifest cases
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - Cargo.toml with aws-sdk dependency is the only evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "Cargo.toml", '[dependencies]\naws-sdk-s3 = "1"\n');
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["Cargo.toml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - package.json with @aws-sdk dependency is the only evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "my-app",
        dependencies: { "@aws-sdk/client-s3": "^3.0.0" },
      }),
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["package.json"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - pom.xml with software.amazon.awssdk dependency is the only evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "pom.xml",
      `<project>
  <dependencies>
    <dependency>
      <groupId>software.amazon.awssdk</groupId>
      <artifactId>s3</artifactId>
    </dependency>
  </dependencies>
</project>
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["pom.xml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - requirements-dev.txt with boto3 is the only evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "requirements-dev.txt", "boto3==1.34.0\n");
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["requirements-dev.txt"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// AWS detection — nested manifests
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - nested Cargo.toml with aws-config under workspace.dependencies", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "crates/api/Cargo.toml",
      '[workspace.dependencies]\naws-config = "1"\n',
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["crates/api/Cargo.toml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - nested Cargo.toml with dotted dependency header", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "crates/api/Cargo.toml",
      '[dependencies.aws-sdk-s3]\nversion = "1"\n',
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["crates/api/Cargo.toml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// AWS detection — CloudFormation / Terraform
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - CloudFormation YAML with AWSTemplateFormatVersion and short-form tags", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "infra/cloudformation/host.yaml",
      `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Bucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Ref BucketNameParam
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["infra/cloudformation/host.yaml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - CloudFormation JSON with only Resources/Type AWS:: is detected", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "infra/host.json",
      JSON.stringify({
        Resources: {
          Bucket: { Type: "AWS::S3::Bucket" },
        },
      }),
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["infra/host.json"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - a .tf file alone is evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "infra/main.tf",
      'resource "aws_s3_bucket" "b" {}\n',
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["infra/main.tf"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Emulator detection with no AWS evidence
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - no AWS evidence, but workflow runs floci service image", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "left-pad",
        dependencies: { serde: "1.0" },
      }),
    );
    await writeFile(
      root,
      "Cargo.toml",
      '[package]\nname = "aws-sdk-thing"\n\n[dependencies]\nserde = "1"\n',
    );
    await writeFile(
      root,
      "some.yaml",
      'description: "just a plain config file, nothing AWS about it"\n',
    );
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      floci:
        image: floci/floci
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
    assertEquals(result.wiring, "floci-only");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Look-alikes that must NOT count
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - boto3-stubs in requirements does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "requirements.txt", "boto3-stubs==1.0\nboto==1.0\n");
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - pom.xml with project-level groupId only does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "pom.xml",
      `<project>
  <groupId>com.amazonaws</groupId>
  <!-- <dependency><groupId>com.amazonaws</groupId></dependency> -->
</project>
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - package.json named aws-sdk with no deps does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "aws-sdk", dependencies: { serde: "1.0" } }),
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - YAML mentioning AWS:: only in a plain string does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "config.yaml",
      'description: "uses AWS::S3"\n',
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Skip-dir enforcement
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - manifests under node_modules/target/vendor/.git are never evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "node_modules/aws-sdk/package.json",
      JSON.stringify({
        name: "aws-sdk",
        dependencies: { "@aws-sdk/client-s3": "1.0" },
      }),
    );
    await writeFile(
      root,
      "target/x/Cargo.toml",
      '[dependencies]\naws-sdk-s3 = "1"\n',
    );
    await writeFile(
      root,
      "vendor/y/Cargo.toml",
      '[dependencies]\naws-sdk-s3 = "1"\n',
    );
    await writeFile(
      root,
      ".git/z/Cargo.toml",
      '[dependencies]\naws-sdk-s3 = "1"\n',
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - a symlink to an outside directory with AWS evidence is never followed", async () => {
  const root = await makeTempRepo();
  const outside = await makeTempRepo();
  try {
    await writeFile(
      outside,
      "Cargo.toml",
      '[dependencies]\naws-sdk-s3 = "1"\n',
    );
    await Deno.symlink(outside, `${root}/escape`, { type: "dir" });
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Emulator detection — positive shapes
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - services.floci.image with a sha256 digest", async () => {
  const root = await makeTempRepo();
  try {
    const digest = "a".repeat(64);
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request
jobs:
  test:
    services:
      floci:
        image: floci/floci@sha256:${digest}
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "floci-only");
    assertEquals(result.workflowsLoaded, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - container as a plain string", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request
jobs:
  test:
    container: floci/floci:latest
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "floci-only");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - container as a record with image", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request
jobs:
  test:
    container:
      image: floci/floci:latest
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "floci-only");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - step uses docker://floci/floci", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request
jobs:
  test:
    steps:
      - uses: docker://floci/floci:1.0
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "floci-only");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - step run with docker run floci/floci", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request
jobs:
  test:
    steps:
      - run: docker run -d -p 4566:4566 floci/floci:latest
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "floci-only");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Emulator detection — negative shapes
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - comment mentioning floci/floci does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `# runs floci/floci later
on: pull_request
jobs:
  test:
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - run echoing floci/floci without docker run does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request
jobs:
  test:
    steps:
      - run: echo floci/floci
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - floci/floci-proxy image does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request
jobs:
  test:
    container:
      image: floci/floci-proxy
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// workflowsLoaded diagnostic flag
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - no workflows directory yields workflowsLoaded false", async () => {
  const root = await makeTempRepo();
  try {
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.workflowsLoaded, false);
    assertEquals(result.wiring, "missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - a workflow present yields workflowsLoaded true", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request
jobs:
  test:
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.workflowsLoaded, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - unreadable nested directory rejects with the path in the message", async () => {
  const root = await makeTempRepo();
  const sub = `${root}/locked`;
  try {
    await Deno.mkdir(sub);
    await Deno.writeTextFile(
      `${root}/package.json`,
      JSON.stringify({ name: "x" }),
    );
    await Deno.chmod(sub, 0o000);
    await assertRejects(
      () => checkAwsEmulatorInCI(root),
      Error,
      sub,
    );
  } finally {
    await Deno.chmod(sub, 0o755);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - a nonexistent repoPath rejects", async () => {
  await assertRejects(() => checkAwsEmulatorInCI("/nonexistent/path/xyz-123"));
});

Deno.test("checkAwsEmulatorInCI - invalid package.json JSON rejects with the path in the message", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "package.json", "{ not valid json");
    await assertRejects(
      () => checkAwsEmulatorInCI(root),
      Error,
      "package.json",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------

Deno.test("cargoTomlUsesAws - dotted dependency header counts", () => {
  assert(cargoTomlUsesAws('[dependencies.aws-sdk-s3]\nversion = "1"\n'));
});

Deno.test("cargoTomlUsesAws - target cfg dependency header counts", () => {
  assert(
    cargoTomlUsesAws(
      "[target.'cfg(unix)'.dependencies]\naws-sdk-s3 = \"1\"\n",
    ),
  );
});

Deno.test("cargoTomlUsesAws - package rename to aws-sdk counts", () => {
  assert(
    cargoTomlUsesAws(
      '[dependencies]\ns3 = { package = "aws-sdk-s3", version = "1" }\n',
    ),
  );
});

Deno.test("cargoTomlUsesAws - package.name = aws-sdk-foo does not count", () => {
  assert(!cargoTomlUsesAws('[package]\nname = "aws-sdk-foo"\n'));
});

Deno.test("cargoTomlUsesAws - commented-out dependency line does not count", () => {
  assert(!cargoTomlUsesAws('[dependencies]\n# aws-sdk-s3 = "1"\n'));
});

Deno.test("cargoTomlUsesAws - an aws-sdk-like key outside any dependency table does not count", () => {
  // A [features] (or any non-dependency) table may happen to declare a key
  // that looks like an AWS SDK crate name; only a key inside a genuine
  // dependency table is evidence of an actual AWS dependency.
  assert(!cargoTomlUsesAws("[features]\naws-sdk-s3 = []\n"));
});

Deno.test("packageJsonUsesAws - devDependencies @aws-sdk scope counts", () => {
  assert(
    packageJsonUsesAws(
      JSON.stringify({ devDependencies: { "@aws-sdk/client-s3": "1" } }),
    ),
  );
});

Deno.test("packageJsonUsesAws - own name as aws-sdk does not count", () => {
  assert(!packageJsonUsesAws(JSON.stringify({ name: "aws-sdk" })));
});

Deno.test("pomXmlUsesAws - amazonaws groupId inside a dependency counts", () => {
  assert(
    pomXmlUsesAws(
      "<dependency><groupId>com.amazonaws</groupId></dependency>",
    ),
  );
});

Deno.test("pomXmlUsesAws - commented-out dependency does not count", () => {
  assert(
    !pomXmlUsesAws(
      "<!-- <dependency><groupId>com.amazonaws</groupId></dependency> -->",
    ),
  );
});

Deno.test("requirementsUsesAws - aiobotocore counts, boto alone does not", () => {
  assert(requirementsUsesAws("aiobotocore==1.0\n"));
  assert(!requirementsUsesAws("boto==1.0\n"));
});

Deno.test("requirementsUsesAws - botocore with extras counts", () => {
  assert(requirementsUsesAws("botocore[crt]>=1.0\n"));
});

Deno.test("isCfnTemplate - AWSTemplateFormatVersion key counts", () => {
  assert(isCfnTemplate('AWSTemplateFormatVersion: "2010-09-09"\n'));
});

Deno.test("isCfnTemplate - plain string mention of AWS:: is not a template", () => {
  assert(!isCfnTemplate('description: "uses AWS::S3"\n'));
});

Deno.test("isFlociImage - exact, tag and digest forms match; near-miss does not", () => {
  assert(isFlociImage("floci/floci"));
  assert(isFlociImage("floci/floci:latest"));
  assert(isFlociImage("floci/floci@sha256:" + "a".repeat(64)));
  assert(!isFlociImage("floci/floci-other"));
  assert(!isFlociImage("floci/floci-proxy"));
});

Deno.test("workflowRunsFloci - run with docker run and floci/floci matches", () => {
  const doc = parseYaml(
    `on: pull_request
jobs:
  test:
    steps:
      - run: docker run -d floci/floci:latest
`,
  );
  assert(workflowRunsFloci(doc));
});

Deno.test("workflowRunsFloci - no jobs does not throw and returns false", () => {
  assertEquals(workflowRunsFloci({}), false);
  assertEquals(workflowRunsFloci(null), false);
  assertEquals(workflowRunsFloci("not a doc"), false);
});

// ---------------------------------------------------------------------------
// Official AWS Emulator (Issue #5110) — workflowRunsAwsEmulator
// ---------------------------------------------------------------------------

Deno.test("workflowRunsAwsEmulator - pinned install fragment alone does not count", () => {
  const doc = parseYaml(
    `on: pull_request
jobs:
  test:
    steps:
      - run: sudo env X=1 bash container/toolchains/aws-emulator.sh
      - run: container/toolchains/aws-emulator.sh
`,
  );
  assertEquals(workflowRunsAwsEmulator(doc), false);
  // Even with a reader, the install fragment contains no aws-emulator-run
  // invocation in command position.
  assertEquals(
    workflowRunsAwsEmulator(
      doc,
      () =>
        "install -m 0755 container/aws-emulator-run.sh /usr/local/bin/aws-emulator-run\n",
    ),
    false,
  );
});

Deno.test("workflowRunsAwsEmulator - exec and env prefixes before aws-emulator-run count", () => {
  const doc = parseYaml(
    `on: pull_request
jobs:
  test:
    steps:
      - run: exec aws-emulator-run --timeout 900 -- ./test.sh
`,
  );
  assert(workflowRunsAwsEmulator(doc));
});

// Issue #5351: after `env`, every operand containing `=` once quotes are
// removed is an assignment; at shell level only an unquoted name counts.
for (
  const [label, run, expected] of [
    [
      'aws-emulator-run -- env "X"=./pytest',
      'aws-emulator-run -- env "X"=./pytest',
      false,
    ],
    [
      "aws-emulator-run -- env ./a=./pytest",
      "aws-emulator-run -- env ./a=./pytest",
      false,
    ],
    [
      "aws-emulator-run -- env X=./pytest",
      "aws-emulator-run -- env X=./pytest",
      false,
    ],
    [
      'aws-emulator-run -- env "X"=1 pytest',
      'aws-emulator-run -- env "X"=1 pytest',
      true,
    ],
    [
      'env "X"=1 aws-emulator-run -- pytest',
      'env "X"=1 aws-emulator-run -- pytest',
      true,
    ],
    [
      "env X=1 aws-emulator-run -- pytest",
      "env X=1 aws-emulator-run -- pytest",
      true,
    ],
    [
      '"X=1" aws-emulator-run -- pytest',
      '"X=1" aws-emulator-run -- pytest',
      false,
    ],
    [
      'env "X"=1 aws-emulator-run -- pytest after set -euo pipefail',
      'set -euo pipefail\n          env "X"=1 aws-emulator-run -- pytest',
      true,
    ],
    // `env --split-string=echo …` runs `echo`, so an option word ends the scan
    // and stays the command word. That fails closed even where `env` would
    // still run the next word: GNU `env -S=echo cmd` stores `=echo` and runs
    // `cmd`, but `-S=echo` is not credited.
    [
      "aws-emulator-run -- env --split-string=echo pytest",
      "aws-emulator-run -- env --split-string=echo pytest",
      false,
    ],
    [
      "env --split-string=echo aws-emulator-run -- pytest",
      "env --split-string=echo aws-emulator-run -- pytest",
      false,
    ],
    [
      'env "--split-string"=echo aws-emulator-run -- pytest',
      'env "--split-string"=echo aws-emulator-run -- pytest',
      false,
    ],
    [
      "env -S=echo aws-emulator-run -- pytest",
      "env -S=echo aws-emulator-run -- pytest",
      false,
    ],
  ] as const
) {
  Deno.test(`workflowRunsAwsEmulator - ${label} is ${expected} (Issue #5351)`, () => {
    const doc = parseYaml(
      `on: pull_request
jobs:
  test:
    steps:
      - run: |
          ${run}
`,
    );
    assertEquals(workflowRunsAwsEmulator(doc), expected);
  });
}

Deno.test("workflowRunsAwsEmulator - env --split-string=echo ./ci.sh does not run the script (Issue #5351)", () => {
  const reader = (path: string) =>
    path === "ci.sh" || path === "./ci.sh"
      ? "aws-emulator-run -- pytest\n"
      : null;
  const workflow = (run: string) =>
    parseYaml(
      `on: pull_request
jobs:
  test:
    steps:
      - run: ${run}
`,
    );
  // Positive control: the same reader credits a plain script call.
  assert(workflowRunsAwsEmulator(workflow("./ci.sh"), reader));
  assert(workflowRunsAwsEmulator(workflow("env X=1 ./ci.sh"), reader));
  assertEquals(
    workflowRunsAwsEmulator(
      workflow("env --split-string=echo ./ci.sh"),
      reader,
    ),
    false,
  );
});

Deno.test("checkAwsEmulatorInCI - an embedded marker before env --split-string=echo cargo test is refused (Issue #5351)", async () => {
  const result = await checkRepoWith({
    "Cargo.toml": CARGO_TOML_AWS,
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(
        "# aws-emulator-embedded: version=1.2.3; justification=x\nenv --split-string=echo cargo test",
      ),
    ),
  });
  assertEquals(result.wiring, "missing");
  assertDiagnostic(result, "no status-preserving cargo test");
  // Positive control: an assignment operand still reaches `cargo test`.
  const control = await checkRepoWith({
    "Cargo.toml": CARGO_TOML_AWS,
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(
        '# aws-emulator-embedded: version=1.2.3; justification=x\nenv "X"=1 cargo test',
      ),
    ),
  });
  assertEquals(control.wiring, "official-embedded");
});

// Issue #5351: shell quote removal on a word as shellCommands returns it.
for (
  const [word, expected] of [
    ['"X"=1', "X=1"],
    ["'a b'", "a b"],
    ["X\\=1", "X=1"],
    ['"a\\"b"', 'a"b'],
    ['"a\\zb"', "a\\zb"],
    ["'a\\b'", "a\\b"],
    ["plain", "plain"],
  ] as const
) {
  Deno.test(`removeQuotes - ${word} (Issue #5351)`, () => {
    assertEquals(removeQuotes(word), expected);
  });
}

// Issue #5378: a `VAR=value` word whose unquoted `$( … )` or backtick value
// holds a blank is one assignment, not an assignment followed by a command.
for (
  const [run, expected] of [
    ["X=$(cat v) aws-emulator-run -- ./test.sh", true],
    [
      "AWS_REGION=$(aws configure get region) aws-emulator-run -- ./test.sh",
      true,
    ],
    ["X=`cat v` aws-emulator-run -- ./test.sh", true],
    ["env X=$(cat v) aws-emulator-run -- ./test.sh", true],
    ["X=$((1 + 2)) aws-emulator-run -- ./test.sh", true],
    // A quoted `)` does not close the substitution.
    ['X=$(echo "a )" b) aws-emulator-run -- ./test.sh', true],
    // A `!` inside the substitution is not a status-inverting prefix.
    ["X=$(test ! -f v) aws-emulator-run -- ./test.sh", true],
    ["X=$(test ! v) aws-emulator-run -- ./test.sh", true],
    ["X=$(cat $(echo v w)) aws-emulator-run -- ./test.sh", true],
    ["X=$(cat v) Y=$(cat w) aws-emulator-run -- ./test.sh", true],
    // Controls already true before the fix.
    ['X="$(cat v)" aws-emulator-run -- ./test.sh', true],
    ["X=$(date) aws-emulator-run -- ./test.sh", true],
    // The command is echo.
    ["X=$(cat v) echo aws-emulator-run -- ./test.sh", false],
    // The runner is an argument of cat inside the substitution.
    ["X=$(cat v aws-emulator-run -- ./test.sh)", false],
    // Never closed: nothing after it is a command.
    ["X=$(cat v aws-emulator-run -- ./test.sh", false],
    // A `(` inside `${…}` opens no substitution: a later `)` does not make
    // the word after it the command.
    ["X=${Y:-(} echo ${Z:-)} aws-emulator-run -- ./test.sh", false],
    // These pin the documented limit: shellCommands splits a substitution at
    // a `|` (or `;`, `&`, line break), so the runner is not seen after it.
    ["X=$(cat v | tr -d x) aws-emulator-run -- ./test.sh", false],
  ] as const
) {
  Deno.test(`workflowRunsAwsEmulator - ${run} is ${expected} (Issue #5378)`, () => {
    const doc = parseYaml(
      `on: pull_request
jobs:
  test:
    steps:
      - run: |
          ${run}
`,
    );
    assertEquals(workflowRunsAwsEmulator(doc), expected);
  });
}

Deno.test("commandIndex - skips an assignment whose substitution holds blanks (Issue #5378)", () => {
  for (
    const [script, expected] of [
      ["X=$(cat v) aws-emulator-run -- ./t.sh", 2],
      ["X=$(cat v)", 2],
      ["X=$(cat v", 2],
      ["X=`a b` cmd", 2],
      ['X=$(echo "a )" b) cmd', 3],
      ["env X=$(cat v) cmd", 3],
      ["X=1 cmd", 1],
      ["X=${Y:-(} echo ${Z:-)} cmd", 4],
      ["X=(a b) cmd", 2],
      ["X=<(cat v) cmd", 2],
    ] as const
  ) {
    assertEquals(
      commandIndex(shellSegments(script)[0] ?? []),
      expected,
      script,
    );
  }
});

Deno.test("commandPrefixWords - leaves out the words inside an assignment's substitution (Issue #5378)", () => {
  assertEquals(
    commandPrefixWords(shellSegments("X=$(test ! v) cmd")[0] ?? []),
    ["X=$(test"],
  );
  assertEquals(commandPrefixWords(shellSegments("! X=1 cmd")[0] ?? []), [
    "!",
    "X=1",
  ]);
});

Deno.test("checkAwsEmulatorInCI - a runner after X=$(cat v) counts in a step and a script; echo $(cat v) does not (Issue #5378)", async () => {
  const body = `X=$(cat v) ${RUNNER_STEP}`;
  const inWorkflow = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
  });
  assertEquals(inWorkflow.wiring, "official-server", "workflow");
  const inScript = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
  });
  assertEquals(inScript.wiring, "official-server", "script");
  const control = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`echo $(cat v) ${RUNNER_STEP}`),
    ),
  });
  assertEquals(control.wiring, "missing", "control");
});

// Issue #5378: the other callers of commandIndex read the same words.
Deno.test("checkAwsEmulatorInCI - X=$(cat v) before cargo test, a status prefix and a failure exit (Issue #5378)", async () => {
  // isCargoTestCommand: the assignment is skipped, so `cargo test` is found.
  const marker = "# aws-emulator-embedded: version=1.2.3; justification=x\n";
  const cargo = await checkRepoWith({
    "Cargo.toml": CARGO_TOML_AWS,
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`${marker}X=$(cat v) cargo test`),
    ),
  });
  assertEquals(cargo.wiring, "official-embedded", "cargo test");
  const cargoEcho = await checkRepoWith({
    "Cargo.toml": CARGO_TOML_AWS,
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`${marker}X=$(cat v) echo cargo test`),
    ),
  });
  assertEquals(cargoEcho.wiring, "missing", "echo cargo test");

  // staticStatus: a `!` inside the substitution does not invert `false`.
  const inWorkflow = async (body: string) =>
    (await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    })).wiring;
  assertEquals(
    await inWorkflow(`X=$(test ! v) false && ${RUNNER_STEP}`),
    "missing",
    "substitution ! does not invert false",
  );
  // Controls: a real prefix `!` is honoured (`! true` is false, `true` is
  // true), so the pair shows the inner `!` above was ignored on purpose.
  assertEquals(
    await inWorkflow(`! true && ${RUNNER_STEP}`),
    "missing",
    "! true",
  );
  assertEquals(
    await inWorkflow(`true && ${RUNNER_STEP}`),
    "official-server",
    "true",
  );

  // failureExits: without set -e, `|| exit 1` makes the script fail with the
  // runner; a prefix `!` breaks that; a `!` inside the substitution does not.
  const inScript = async (body: string) =>
    (await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    })).wiring;
  assertEquals(
    await inScript(`${RUNNER_STEP} || exit 1\necho done`),
    "official-server",
    "|| exit 1",
  );
  assertEquals(
    await inScript(`! ${RUNNER_STEP} || exit 1\necho done`),
    "missing",
    "! runner || exit 1",
  );
  assertEquals(
    await inScript(`X=$(test ! v) ${RUNNER_STEP} || exit 1\necho done`),
    "official-server",
    "substitution ! then runner || exit 1",
  );
});

Deno.test("workflowRunsAwsEmulator - step runs aws-emulator-run wrapper", () => {
  const doc = parseYaml(
    `on: pull_request
jobs:
  test:
    steps:
      - run: aws-emulator-run -- ./test.sh
`,
  );
  assert(workflowRunsAwsEmulator(doc));
});

Deno.test("workflowRunsAwsEmulator - path ending in aws-emulator-run in command position counts", () => {
  const doc = parseYaml(
    `on: pull_request
jobs:
  test:
    steps:
      - run: /usr/local/bin/aws-emulator-run -- ./test.sh
`,
  );
  assert(workflowRunsAwsEmulator(doc));
});

Deno.test("workflowRunsAwsEmulator - real .github/workflows/aws-emulator.yml counts via the repo script", async () => {
  const text = await Deno.readTextFile(
    new URL("../../../.github/workflows/aws-emulator.yml", import.meta.url),
  );
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  // aws-emulator.yml is `workflow_call` only: its credit depends on the
  // pull_request caller (quality.yml, see the real-checkout test below). Here
  // the file is given a pull_request trigger in memory, so only the step rules
  // (status preservation, the repo script) are under test.
  const doc = parseYaml(text) as Record<string, unknown>;
  const asPullRequest = { ...doc, on: "pull_request" };
  assert(
    workflowRunsAwsEmulator(asPullRequest, makeRepoScriptReader(repoRoot)),
  );
  // Without the script the install steps alone are not coverage.
  assertEquals(workflowRunsAwsEmulator(asPullRequest), false);
  // Without a pull_request caller, the same steps earn nothing.
  assertEquals(
    workflowRunsAwsEmulator(doc, makeRepoScriptReader(repoRoot)),
    false,
  );
});

Deno.test("checkAwsEmulatorInCI - VibeCoder's own checkout is official-server (quality.yml calls aws-emulator.yml, which runs the repo script)", async () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const result = await checkAwsEmulatorInCI(repoRoot);
  assertEquals(result.usesAws, true);
  assertEquals(result.wiring, "official-server");
  assert(
    result.wiringEvidence.some((e) => e.includes("`aws-emulator.yml` job")),
    `expected aws-emulator.yml evidence, got: ${
      result.wiringEvidence.join(" | ")
    }`,
  );
  assertEquals(result.unreadableWorkflows, []);
  assertEquals(result.workflowsLoaded, true);
});

// Issue #5110 (pre-PR verifier): only `aws-emulator-run [options] -- COMMAND`
// with a real COMMAND runs a repository test. The helper's own `--smoke`
// self-check, `--help` and a no-op COMMAND must not satisfy the rule.
for (
  const [label, run] of [
    ["--smoke self-check", "aws-emulator-run --smoke"],
    [
      "--smoke with timeouts",
      "aws-emulator-run --ready-timeout 60 --timeout 300 --smoke",
    ],
    ["--smoke-client", "aws-emulator-run --smoke-client"],
    ["--help", "aws-emulator-run --help"],
    ["-h", "aws-emulator-run -h"],
    ["-- true", "aws-emulator-run -- true"],
    ["-- :", "aws-emulator-run -- :"],
    [
      "--timeout 900 -- /bin/true",
      "aws-emulator-run --timeout 900 -- /bin/true",
    ],
    ["bare --", "aws-emulator-run --"],
    ["no arguments", "aws-emulator-run"],
    ["COMMAND without --", "aws-emulator-run ./ci/test.sh"],
    ["--timeout with no value", "aws-emulator-run --timeout"],
  ] as const
) {
  Deno.test(`workflowRunsAwsEmulator - aws-emulator-run ${label} does not count`, () => {
    assertEquals(workflowRunsAwsEmulator(workflowRunBlock(run)), false);
  });
}

Deno.test("workflowRunsAwsEmulator - aws-emulator-run -- ./ci/test.sh counts (positive control)", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock("aws-emulator-run -- ./ci/test.sh"),
    ),
  );
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock(
        "aws-emulator-run --ready-timeout 60 --timeout 900 -- ./ci/test.sh",
      ),
    ),
  );
});

Deno.test("checkAwsEmulatorInCI - script that only runs aws-emulator-run --smoke does not count", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/ci`);
    await Deno.writeTextFile(
      `${dir}/ci/check.sh`,
      "#!/usr/bin/env bash\naws-emulator-run --smoke\n",
    );
    const doc = workflowRunBlock("./ci/check.sh");
    assertEquals(
      workflowRunsAwsEmulator(doc, makeRepoScriptReader(dir)),
      false,
    );
    await Deno.writeTextFile(
      `${dir}/ci/check.sh`,
      "#!/usr/bin/env bash\naws-emulator-run -- ./ci/test.sh\n",
    );
    assert(workflowRunsAwsEmulator(doc, makeRepoScriptReader(dir)));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("workflowRunsAwsEmulator - echo aws-emulator-run does not count", () => {
  const doc = parseYaml(
    `on: pull_request
jobs:
  test:
    steps:
      - run: echo aws-emulator-run
`,
  );
  assertEquals(workflowRunsAwsEmulator(doc), false);
});

Deno.test("workflowRunsAwsEmulator - comment line naming aws-emulator-run does not count", () => {
  const doc = parseYaml(
    `on: pull_request
jobs:
  test:
    steps:
      - run: |
          # aws-emulator-run
          echo hi
`,
  );
  assertEquals(workflowRunsAwsEmulator(doc), false);
});

Deno.test("workflowRunsAwsEmulator - step name only does not count", () => {
  const doc = parseYaml(
    `on: pull_request
jobs:
  test:
    steps:
      - name: aws-emulator-run
        run: echo hi
`,
  );
  assertEquals(workflowRunsAwsEmulator(doc), false);
});

Deno.test("workflowRunsAwsEmulator - no jobs does not throw and returns false", () => {
  assertEquals(workflowRunsAwsEmulator({}), false);
  assertEquals(workflowRunsAwsEmulator(null), false);
  assertEquals(workflowRunsAwsEmulator("not a doc"), false);
});

/** A one-job workflow whose single `run: |` step body is `body`, parsed. */
function workflowRunBlock(body: string): unknown {
  const indented = body.split("\n").map((line) => `          ${line}`).join(
    "\n",
  );
  return parseYaml(
    `on: pull_request\njobs:\n  test:\n    steps:\n      - run: |\n${indented}\n`,
  );
}

Deno.test("workflowRunsAwsEmulator - if/then before aws-emulator-run counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock(
        `if [ -n "$X" ]; then aws-emulator-run -- ./test.sh; fi`,
      ),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - timeout with a duration before aws-emulator-run counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock("timeout 600 aws-emulator-run -- ./test.sh"),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - timeout with a -k option before aws-emulator-run counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock("timeout -k 5 600 aws-emulator-run -- ./test.sh"),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - quoted aws-emulator-run command word counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock(`"aws-emulator-run" -- ./test.sh`),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - time before aws-emulator-run counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock("time aws-emulator-run -- ./test.sh"),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - command aws-emulator-run counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock("command aws-emulator-run -- ./test.sh"),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - aws-emulator-run on the line after an if line counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock(
        `if [ -n "$X" ]; then\n  aws-emulator-run -- ./test.sh\nfi`,
      ),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - command -v aws-emulator-run does not count", () => {
  assertEquals(
    workflowRunsAwsEmulator(workflowRunBlock("command -v aws-emulator-run")),
    false,
  );
});

Deno.test("workflowRunsAwsEmulator - if command -v aws-emulator-run then echo does not count", () => {
  assertEquals(
    workflowRunsAwsEmulator(
      workflowRunBlock(
        "if command -v aws-emulator-run >/dev/null; then echo ok; fi",
      ),
    ),
    false,
  );
});

Deno.test("workflowRunsAwsEmulator - timeout wrapping echo aws-emulator-run does not count", () => {
  assertEquals(
    workflowRunsAwsEmulator(
      workflowRunBlock("timeout 600 echo aws-emulator-run"),
    ),
    false,
  );
});

Deno.test("workflowRunsAwsEmulator - double-quoted echo aws-emulator-run does not count", () => {
  assertEquals(
    workflowRunsAwsEmulator(workflowRunBlock(`echo "aws-emulator-run"`)),
    false,
  );
});

Deno.test("workflowRunsAwsEmulator - which aws-emulator-run does not count", () => {
  assertEquals(
    workflowRunsAwsEmulator(workflowRunBlock("which aws-emulator-run")),
    false,
  );
});

Deno.test("workflowRunsAwsEmulator - commented if/then aws-emulator-run does not count", () => {
  assertEquals(
    workflowRunsAwsEmulator(
      workflowRunBlock("# if true; then aws-emulator-run -- ./test.sh; fi"),
    ),
    false,
  );
});

Deno.test("checkAwsEmulatorInCI - CloudFormation template with AWS Emulator workflow, then without it", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "infra/cloudformation/bucket.yaml",
      `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Bucket:
    Type: AWS::S3::Bucket
`,
    );
    // quality.yml (pull_request) calls aws-emulator.yml (workflow_call only).
    const callerPath = ".github/workflows/quality.yml";
    await writeFile(
      root,
      callerPath,
      await Deno.readTextFile(
        new URL("../../../" + callerPath, import.meta.url),
      ),
    );
    const workflowPath = ".github/workflows/aws-emulator.yml";
    const workflowText = await Deno.readTextFile(
      new URL("../../../" + workflowPath, import.meta.url),
    );
    await writeFile(root, workflowPath, workflowText);
    const scriptPath = "infra/cloudformation/test-aws-emulator.sh";
    await writeFile(
      root,
      scriptPath,
      await Deno.readTextFile(
        new URL("../../../" + scriptPath, import.meta.url),
      ),
    );

    const withWorkflow = await checkAwsEmulatorInCI(root);
    assertEquals(withWorkflow.usesAws, true);
    assertEquals(withWorkflow.wiring, "official-server");

    await Deno.remove(`${root}/${workflowPath}`);
    const withoutWorkflow = await checkAwsEmulatorInCI(root);
    assertEquals(withoutWorkflow.usesAws, true);
    assertEquals(withoutWorkflow.wiring, "missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Emulator coverage must be an actual test invocation (Issue #5110 review)
// ---------------------------------------------------------------------------

const CFN_TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Bucket:
    Type: AWS::S3::Bucket
`;

const RUNNER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_SELF="\${BASH_SOURCE[0]}"
if [[ -z "\${AWS_EMULATOR_ACTIVE:-}" ]]; then
    exec aws-emulator-run --timeout 900 -- "\${SCRIPT_SELF}" "$@"
fi
`;

function workflowWithRun(run: string): string {
  return `on: pull_request
jobs:
  test:
    steps:
      - run: ${run}
`;
}

async function setupAwsRepo(
  root: string,
  run: string,
): Promise<void> {
  await writeFile(root, "infra/cloudformation/host.yaml", CFN_TEMPLATE);
  await writeFile(root, ".github/workflows/ci.yml", workflowWithRun(run));
}

Deno.test("checkAwsEmulatorInCI - install-only workflow is not emulator coverage", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "infra/cloudformation/host.yaml", CFN_TEMPLATE);
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request
jobs:
  test:
    steps:
      - run: |
          sudo env AWS_EMULATOR_VERSION=1 \\
            bash container/toolchains/aws-emulator.sh
          sudo install -m 0755 container/aws-emulator-run.sh /usr/local/bin/aws-emulator-run
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.wiring, "missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - ./script that execs aws-emulator-run counts", async () => {
  const root = await makeTempRepo();
  try {
    await setupAwsRepo(root, "./infra/cloudformation/test-aws-emulator.sh");
    await writeFile(
      root,
      "infra/cloudformation/test-aws-emulator.sh",
      RUNNER_SCRIPT,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "official-server");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - bash script that execs aws-emulator-run counts", async () => {
  const root = await makeTempRepo();
  try {
    await setupAwsRepo(root, "bash infra/cloudformation/test-aws-emulator.sh");
    await writeFile(
      root,
      "infra/cloudformation/test-aws-emulator.sh",
      RUNNER_SCRIPT,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "official-server");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - script that only checks for aws-emulator-run does not count", async () => {
  const root = await makeTempRepo();
  try {
    await setupAwsRepo(root, "./infra/cloudformation/test-aws-emulator.sh");
    await writeFile(
      root,
      "infra/cloudformation/test-aws-emulator.sh",
      `#!/usr/bin/env bash
# aws-emulator-run would go here
if ! command -v aws-emulator-run > /dev/null 2>&1; then
    echo aws-emulator-run is missing
fi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - script path with .. does not count", async () => {
  const parent = await makeTempRepo();
  try {
    const root = `${parent}/repo`;
    await Deno.mkdir(root);
    await setupAwsRepo(root, "bash ../outside/aws-test.sh");
    await writeFile(parent, "outside/aws-test.sh", RUNNER_SCRIPT);
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.wiring, "missing");
    // Positive control: the same script at an in-repo test-named path counts.
    await setupAwsRepo(root, "bash outside/aws-test.sh");
    await writeFile(root, "outside/aws-test.sh", RUNNER_SCRIPT);
    assertEquals(
      (await checkAwsEmulatorInCI(root)).wiring,
      "official-server",
    );
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - absolute and expanded script paths do not count", async () => {
  const outside = await makeTempRepo();
  try {
    await writeFile(outside, "aws-test.sh", RUNNER_SCRIPT);
    for (
      const run of [
        `bash ${outside}/aws-test.sh`,
        "bash ${{ github.workspace }}/x-test.sh",
        'bash "$DIR/aws-test.sh"',
      ]
    ) {
      const root = await makeTempRepo();
      try {
        await setupAwsRepo(root, JSON.stringify(run));
        await writeFile(root, "x-test.sh", RUNNER_SCRIPT);
        const result = await checkAwsEmulatorInCI(root);
        assertEquals(result.wiring, "missing", run);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - in-repo symlink to an outside script does not count", async () => {
  const root = await makeTempRepo();
  const outside = await makeTempRepo();
  try {
    await setupAwsRepo(root, "bash ci/aws-test.sh");
    await writeFile(outside, "aws-test.sh", RUNNER_SCRIPT);
    await Deno.mkdir(`${root}/ci`);
    await Deno.symlink(`${outside}/aws-test.sh`, `${root}/ci/aws-test.sh`);
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "missing");
    // Positive control: the same script as a regular in-repo file counts.
    await Deno.remove(`${root}/ci/aws-test.sh`);
    await writeFile(root, "ci/aws-test.sh", RUNNER_SCRIPT);
    assertEquals(
      (await checkAwsEmulatorInCI(root)).wiring,
      "official-server",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - nonexistent script does not count and does not throw", async () => {
  const root = await makeTempRepo();
  try {
    await setupAwsRepo(root, "./infra/missing.sh");
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - script over 1 MiB is not read", async () => {
  const root = await makeTempRepo();
  try {
    await setupAwsRepo(root, "./big-test.sh");
    await writeFile(
      root,
      "big-test.sh",
      "#" + "x".repeat(1024 * 1024) + "\n" + RUNNER_SCRIPT,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "missing");
    // Positive control: the same script under the cap counts.
    await writeFile(root, "big-test.sh", RUNNER_SCRIPT);
    assertEquals(
      (await checkAwsEmulatorInCI(root)).wiring,
      "official-server",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - timeout 900 ./ci/test.sh resolves the script and counts", async () => {
  const root = await makeTempRepo();
  try {
    await setupAwsRepo(root, "timeout 900 ./ci/test.sh");
    await writeFile(root, "ci/test.sh", RUNNER_SCRIPT);
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "official-server");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// `id -u` needs only --allow-run, unlike Deno.uid() which needs --allow-sys.
const IS_ROOT = new TextDecoder().decode(
  new Deno.Command("id", { args: ["-u"], stdout: "piped" }).outputSync().stdout,
).trim() === "0";

Deno.test({
  name:
    "checkAwsEmulatorInCI - unreadable repository script rejects, readable one counts (ignored as root, which reads any file)",
  ignore: IS_ROOT,
  fn: async () => {
    const root = await makeTempRepo();
    try {
      await setupAwsRepo(root, "./ci/t.sh");
      const script = `${root}/ci/t.sh`;
      await writeFile(
        root,
        "ci/t.sh",
        "#!/usr/bin/env bash\naws-emulator-run -- ./test.sh\n",
      );
      await Deno.chmod(script, 0o000);
      await assertRejects(
        () => checkAwsEmulatorInCI(root),
        Error,
        "ci/t.sh",
      );

      // Positive control: the same repo counts once the script is readable.
      await Deno.chmod(script, 0o644);
      const result = await checkAwsEmulatorInCI(root);
      assertEquals(result.wiring, "official-server");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// PR #5276 review: runner text that cannot run earns no credit
// ---------------------------------------------------------------------------

const RUNNER = "aws-emulator-run -- ./test.sh";

/** A one-job, one-step workflow document built directly (no YAML parse). */
function docWithStep(
  run: string,
  step: Record<string, unknown> = {},
  job: Record<string, unknown> = {},
): unknown {
  return {
    on: "pull_request",
    jobs: { test: { ...job, steps: [{ run, ...step }] } },
  };
}

const NOT_EXECUTED: [
  string,
  string,
  Record<string, unknown>,
  Record<string, unknown>,
][] = [
  ["a step with if: false", RUNNER, { if: false }, {}],
  ["a step with if: ${{ false }}", RUNNER, { if: "${{ false }}" }, {}],
  ["a step with if: '0'", RUNNER, { if: "0" }, {}],
  ["a job with if: false", RUNNER, {}, { if: false }],
  ["a false if branch", `if false; then ${RUNNER}; fi`, {}, {}],
  [
    "a false if branch on its own lines",
    `if false\nthen\n  ${RUNNER}\nfi`,
    {},
    {},
  ],
  ["a negated true if branch", `if ! true; then ${RUNNER}; fi`, {}, {}],
  [
    "the else of an if true",
    `if true; then echo ok; else ${RUNNER}; fi`,
    {},
    {},
  ],
  [
    "an elif after a taken true branch",
    `if true; then echo ok; elif [ -n "$X" ]; then ${RUNNER}; fi`,
    {},
    {},
  ],
  ["a while false body", `while false; do ${RUNNER}; done`, {}, {}],
  ["an until true body", `until true; do ${RUNNER}; done`, {}, {}],
  ["code after exit 0", `exit 0\n${RUNNER}`, {}, {}],
  [
    "code after an exit in an if true",
    `if true; then exit 0; fi\n${RUNNER}`,
    {},
    {},
  ],
  [
    "code after an exit in an elif true behind a false test",
    `if false; then echo a; elif true; then exit 0; fi\n${RUNNER}`,
    {},
    {},
  ],
  ["a false && chain", `false && ${RUNNER}`, {}, {}],
  ["a true || chain", `true || ${RUNNER}`, {}, {}],
  [
    "a brace group behind false &&",
    `false && {\n  ${RUNNER}\n}`,
    {},
    {},
  ],
  [
    "a brace group behind true ||",
    `true || {\n  ${RUNNER}\n}`,
    {},
    {},
  ],
  [
    "a one-line brace group behind false &&",
    `false && { ${RUNNER}; }`,
    {},
    {},
  ],
  [
    "a brace group on the line after a pending false &&",
    `false &&\n{\n  ${RUNNER}\n}`,
    {},
    {},
  ],
  [
    "a subshell group behind false &&",
    `false && (\n  ${RUNNER}\n)`,
    {},
    {},
  ],
  ["a one-line subshell behind true ||", `true || ( ${RUNNER} )`, {}, {}],
  [
    "an if compound behind false &&",
    `false && if true; then ${RUNNER}; fi`,
    {},
    {},
  ],
  ["code after true && exit 0", `true && exit 0\n${RUNNER}`, {}, {}],
  ["code after false || exit 0", `false || exit 0\n${RUNNER}`, {}, {}],
  ["code after : && exit 0 on one line", `: && exit 0; ${RUNNER}`, {}, {}],
  ["code after set -n", `set -n\n${RUNNER}`, {}, {}],
  ["code after set -o noexec", `set -o noexec\n${RUNNER}`, {}, {}],
  ["a step whose shell is bash -n", RUNNER, { shell: "bash -n {0}" }, {}],
  [
    "a job whose default shell is bash --noexec",
    RUNNER,
    {},
    { defaults: { run: { shell: "bash --noexec {0}" } } },
  ],
  [
    "a function body that is never called",
    `run_tests() {\n  ${RUNNER}\n}\necho done`,
    {},
    {},
  ],
  [
    "a function body with the brace on the next line",
    `function run_tests\n{\n  ${RUNNER}\n}`,
    {},
    {},
  ],
  ["a here-document body", `cat <<EOF\n${RUNNER}\nEOF`, {}, {}],
  [
    "a tab-stripped here-document body",
    `cat <<-'EOF'\n\t${RUNNER}\n\tEOF`,
    {},
    {},
  ],
];

for (const [label, run, step, job] of NOT_EXECUTED) {
  Deno.test(`workflowRunsAwsEmulator - does not credit ${label}`, () => {
    assertEquals(workflowRunsAwsEmulator(docWithStep(run, step, job)), false);
    // The same text with the construct removed is credited.
    assertEquals(workflowRunsAwsEmulator(docWithStep(RUNNER)), true);
  });
}

const EXECUTED: [
  string,
  string,
  Record<string, unknown>,
  Record<string, unknown>,
][] = [
  ["a plain invocation", RUNNER, {}, {}],
  [
    "a step if decided at run time",
    RUNNER,
    { if: "github.actor != 'dependabot[bot]'" },
    {},
  ],
  ["a job if decided at run time", RUNNER, {}, { if: "always()" }],
  ["a step with if: true", RUNNER, { if: true }, {}],
  ["an if on a runtime test", `if [ -n "$X" ]; then ${RUNNER}; fi`, {}, {}],
  [
    "the else of an if false",
    `if false; then echo no; else ${RUNNER}; fi`,
    {},
    {},
  ],
  [
    "an elif after a false branch",
    `if false; then echo no; elif true; then ${RUNNER}; fi`,
    {},
    {},
  ],
  ["a true && chain", `true && ${RUNNER}`, {}, {}],
  ["a brace group behind true &&", `true && {\n  ${RUNNER}\n}`, {}, {}],
  ["a brace group behind false ||", `false || {\n  ${RUNNER}\n}`, {}, {}],
  [
    "a brace group behind a runtime test",
    `[ -n "$X" ] && {\n  ${RUNNER}\n}`,
    {},
    {},
  ],
  ["a subshell group behind true &&", `true && (\n  ${RUNNER}\n)`, {}, {}],
  [
    "code after a skipped brace group",
    `false && {\n  echo x\n}\n${RUNNER}`,
    {},
    {},
  ],
  ["a false || chain", `false || ${RUNNER}`, {}, {}],
  [
    "code after a guarded exit",
    `[ -z "$X" ] && exit 0\n${RUNNER}`,
    {},
    {},
  ],
  [
    "code after an exit in an if on a runtime test",
    `if [ -z "$X" ]; then exit 0; fi\n${RUNNER}`,
    {},
    {},
  ],
  [
    "code after an exit in an elif true behind a runtime test",
    `if [ -n "$X" ]; then echo a; elif true; then exit 0; fi\n${RUNNER}`,
    {},
    {},
  ],
  ["a for loop body", `for t in a b; do ${RUNNER}; done`, {}, {}],
  ["code after a here-string", `cat <<< x\n${RUNNER}`, {}, {}],
  ["code after a here-document", `cat <<EOF\nx\nEOF\n${RUNNER}`, {}, {}],
  ["code after a function definition", `f() {\n  echo x\n}\n${RUNNER}`, {}, {}],
  ["code after false && exit 0", `false && exit 0\n${RUNNER}`, {}, {}],
  [
    "code after an exit behind a runtime test and true",
    `[ -z "$X" ] && true && exit 0\n${RUNNER}`,
    {},
    {},
  ],
  [
    "code after a skipped true then a runtime exit",
    `[ -z "$X" ] && true || exit 0\n${RUNNER}`,
    {},
    {},
  ],
  [
    "code after an exit chained to fi",
    `if [ -z "$X" ]; then echo; fi && exit 0\n${RUNNER}`,
    {},
    {},
  ],
  ["code after set -euo pipefail", `set -euo pipefail\n${RUNNER}`, {}, {}],
  ["code after set +n", `set +n\n${RUNNER}`, {}, {}],
  [
    "a step whose shell is bash with errexit",
    RUNNER,
    { shell: "bash --noprofile --norc -eo pipefail {0}" },
    {},
  ],
];

for (const [label, run, step, job] of EXECUTED) {
  Deno.test(`workflowRunsAwsEmulator - credits ${label}`, () => {
    assertEquals(workflowRunsAwsEmulator(docWithStep(run, step, job)), true);
  });
}

Deno.test("workflowRunsAwsEmulator - a repository script's unreachable runner earns no credit, a reachable one does", () => {
  const doc = docWithStep("./ci/t.sh");
  const read = (text: string) => (path: string) =>
    path === "./ci/t.sh" ? text : null;
  for (
    const text of [
      `exit 0\n${RUNNER}\n`,
      `if false; then ${RUNNER}; fi\n`,
      `false && ${RUNNER}\n`,
      `false && {\n  ${RUNNER}\n}\n`,
      `true || {\n  ${RUNNER}\n}\n`,
      `cat <<EOF\n${RUNNER}\nEOF\n`,
    ]
  ) {
    assertEquals(workflowRunsAwsEmulator(doc, read(text)), false, text);
  }
  assertEquals(workflowRunsAwsEmulator(doc, read(`${RUNNER}\n`)), true);
  for (
    const text of [
      `true && {\n  ${RUNNER}\n}\n`,
      `false || {\n  ${RUNNER}\n}\n`,
    ]
  ) {
    assertEquals(workflowRunsAwsEmulator(doc, read(text)), true, text);
  }
  assertEquals(
    workflowRunsAwsEmulator(
      doc,
      read(`[ -z "$X" ] && exit 0\n${RUNNER}\n`),
    ),
    true,
  );
});

Deno.test("workflowRunsAwsEmulator - compound conditions gate direct and repository-script runners", () => {
  const scriptDoc = docWithStep("bash ./test.sh");
  for (
    const [condition, expected] of [
      ["false && true", false],
      ["true && false", false],
      ["false || false", false],
      ['[ -n "$X" ] && false', false],
      ["true && true", true],
      ["false && true || true", true],
      ["true || false && false", false],
    ] as const
  ) {
    const run = `if ${condition}; then ${RUNNER}; fi`;
    assertEquals(workflowRunsAwsEmulator(docWithStep(run)), expected, run);
    const read = (path: string) => path === "./test.sh" ? run : null;
    assertEquals(workflowRunsAwsEmulator(scriptDoc, read), expected, run);
  }
});

Deno.test("workflowRunsAwsEmulator - a repository script after a guaranteed short-circuit exit earns no credit", () => {
  const doc = docWithStep("./ci/t.sh");
  const read = (text: string) => (path: string) =>
    path === "./ci/t.sh" ? text : null;
  assertEquals(
    workflowRunsAwsEmulator(doc, read(`true && exit 0\n${RUNNER}\n`)),
    false,
  );
  // Positive control: the exit behind a runtime test leaves the runner live.
  assertEquals(
    workflowRunsAwsEmulator(doc, read(`[ -n "$X" ] && exit 0\n${RUNNER}\n`)),
    true,
  );
});

Deno.test("workflowRunsAwsEmulator - a script run by a shell in a non-executing mode earns no credit", () => {
  const read = (path: string) => path === "./test.sh" ? `${RUNNER}\n` : null;
  for (
    const run of [
      "bash -n ./test.sh",
      "bash -xn ./test.sh",
      "sh -n ./test.sh",
      "bash --noexec ./test.sh",
      "bash -o noexec ./test.sh",
      "bash -c ./test.sh",
    ]
  ) {
    assertEquals(workflowRunsAwsEmulator(docWithStep(run), read), false, run);
  }
  for (
    const run of [
      "bash ./test.sh",
      "bash -e ./test.sh",
      "bash -eo pipefail ./test.sh",
      "bash --noprofile ./test.sh",
      "sh -x ./test.sh",
    ]
  ) {
    assertEquals(workflowRunsAwsEmulator(docWithStep(run), read), true, run);
  }
});

Deno.test("workflowRunsAwsEmulator - an unreachable step calling a script that runs the emulator earns no credit", () => {
  const read = () => `${RUNNER}\n`;
  assertEquals(
    workflowRunsAwsEmulator(docWithStep("exit 0\n./ci/t.sh"), read),
    false,
  );
  assertEquals(
    workflowRunsAwsEmulator(docWithStep("./ci/t.sh", { if: false }), read),
    false,
  );
  assertEquals(workflowRunsAwsEmulator(docWithStep("./ci/t.sh"), read), true);
});

Deno.test("checkAwsEmulatorInCI - a disabled or unreachable runner does not count as emulator coverage", async () => {
  for (
    const run of [
      "exit 0\n          aws-emulator-run -- ./test.sh",
      "if false; then aws-emulator-run -- ./test.sh; fi",
      "true && exit 0\n          aws-emulator-run -- ./test.sh",
      "bash -n ./test.sh",
    ]
  ) {
    const root = await makeTempRepo();
    try {
      await writeFile(root, "infra/cloudformation/host.yaml", CFN_TEMPLATE);
      await writeFile(
        root,
        "test.sh",
        "aws-emulator-run -- ./integration.sh\n",
      );
      await writeFile(
        root,
        ".github/workflows/ci.yml",
        `on: pull_request\njobs:\n  test:\n    steps:\n      - run: |\n          ${run}\n`,
      );
      const result = await checkAwsEmulatorInCI(root);
      assertEquals(result.usesAws, true);
      assertEquals(result.wiring, "missing", run);
      // Positive control: the same repo, running the script for real.
      await writeFile(
        root,
        ".github/workflows/ci.yml",
        "on: pull_request\njobs:\n  test:\n    steps:\n      - run: bash ./test.sh\n",
      );
      assertEquals(
        (await checkAwsEmulatorInCI(root)).wiring,
        "official-server",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
  const root = await makeTempRepo();
  try {
    await writeFile(root, "infra/cloudformation/host.yaml", CFN_TEMPLATE);
    await writeFile(root, "test.sh", "echo ok\n");
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request\njobs:\n  test:\n    steps:\n      - if: false\n        run: aws-emulator-run -- ./test.sh\n`,
    );
    assertEquals((await checkAwsEmulatorInCI(root)).wiring, "missing");
    // Positive control: the same step without the `if: false`.
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request\njobs:\n  test:\n    steps:\n      - run: aws-emulator-run -- ./test.sh\n`,
    );
    assertEquals((await checkAwsEmulatorInCI(root)).wiring, "official-server");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - a skipped brace group does not count as emulator coverage, directly or through a repository script", async () => {
  const cases: [string, boolean][] = [
    [`false && {\n  ${RUNNER}\n}`, false],
    [`true || {\n  ${RUNNER}\n}`, false],
    [`true && {\n  ${RUNNER}\n}`, true],
    [`false || {\n  ${RUNNER}\n}`, true],
    [`if true; then false; fi && ${RUNNER}`, false],
    [`if true; then true; fi || ${RUNNER}`, false],
    [`if true; then true; fi && ${RUNNER}`, true],
    [`if true; then false; fi || ${RUNNER}`, true],
    [`if false; then false; fi || ${RUNNER}`, false],
    [`if true; then false; else true; fi && ${RUNNER}`, false],
    [`false && { true; } && ${RUNNER}`, false],
    [`true || { false; } || ${RUNNER}`, false],
    [`false && { true; } || ${RUNNER}`, true],
    [`true || { false; } && ${RUNNER}`, true],
    [`true && { true; } && ${RUNNER}`, true],
    [`false || { false; } || ${RUNNER}`, true],
    [`false && { { true; }; } && ${RUNNER}`, false],
    [`true && { false; } && ${RUNNER}`, false],
    [`false || { true; } || ${RUNNER}`, false],
    [`[ -n "$X" ] && { exit 0; }; ${RUNNER}`, true],
  ];
  for (const [script, expected] of cases) {
    for (const viaScript of [false, true]) {
      const root = await makeTempRepo();
      try {
        await writeFile(root, "infra/cloudformation/host.yaml", CFN_TEMPLATE);
        let run = script;
        if (viaScript) {
          await writeFile(root, "test.sh", `${script}\n`);
          run = "bash ./test.sh";
        } else {
          await writeFile(root, "test.sh", "echo ok\n");
        }
        await writeFile(
          root,
          ".github/workflows/ci.yml",
          `on: pull_request\njobs:\n  test:\n    steps:\n      - run: |\n${
            run.split("\n").map((l) => `          ${l}`).join("\n")
          }\n`,
        );
        const result = await checkAwsEmulatorInCI(root);
        assertEquals(result.usesAws, true);
        assertEquals(
          result.wiring === "official-server",
          expected,
          `${viaScript ? "via script: " : ""}${script}`,
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  }
});

Deno.test("workflowRunsAwsEmulator - hostile long inputs finish with the right answer", () => {
  const spaces = " ".repeat(100_000);
  // A long run of `<` and of whitespace after `<<`, ending in a char the
  // here-document pattern rejects: no delimiter, so nothing is dropped.
  const heredocLike = `x ${"<".repeat(50_000)}${spaces}!\n${RUNNER}`;
  assertEquals(workflowRunsAwsEmulator(docWithStep(heredocLike)), true);
  // A long whitespace run inside `${{ }}` and a stray `}` for the `if:` pattern.
  assertEquals(
    workflowRunsAwsEmulator(
      docWithStep(RUNNER, { if: `\${{${spaces}false${spaces}}}}` }),
    ),
    true,
  );
  assertEquals(
    workflowRunsAwsEmulator(
      docWithStep(RUNNER, { if: `\${{${spaces}false${spaces}}}` }),
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// Issue #5112: wiring rules. Each refusal fixture is otherwise valid (a
// pull_request workflow with a real runner step), so only the probed rule
// refuses it, and each group has an allowed control.
// ---------------------------------------------------------------------------

const RUNNER_STEP = "aws-emulator-run -- ./test.sh";
const CARGO_TOML_AWS =
  '[package]\nname = "x"\n\n[dependencies]\naws-sdk-s3 = "1"\n';
const EMBEDDED_STEP =
  "# aws-emulator-embedded: version=1.2.3; justification=the Rust SDK tests need no Docker runner\ncargo test --workspace";
const FLOCI_SERVICE =
  "    services:\n      floci:\n        image: floci/floci:1.4.0\n";
/** A Floci job's test step: a test run whose failure fails the job. */
const FLOCI_TEST_STEP = "npm test";
const GAP_RECORD =
  "# aws-emulator-gap: version=2.1.0; behaviour=IAM policy simulation; evidence=ci/run-1.log; alternative=a real AWS sandbox account; recheck=2027-01-01\n";

/** Write a CloudFormation template (AWS usage) plus `files`, then run the check. */
async function checkRepoWith(
  files: Record<string, string>,
): Promise<AwsEmulatorCheckResult> {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "infra/cloudformation/host.yaml", CFN_TEMPLATE);
    // The runner COMMAND script RUNNER_STEP names must exist (see #5112).
    await writeFile(root, "test.sh", "echo ok\n");
    for (const [rel, text] of Object.entries(files)) {
      await writeFile(root, rel, text);
    }
    return await checkAwsEmulatorInCI(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** One `run: |` step whose body is `run`, with extra step keys (indented to the step). */
function stepYaml(run: string, keys: string[] = []): string {
  const body = run.split("\n").map((line) => `          ${line}`).join("\n");
  return [
    "      - run: |",
    body,
    ...keys.map((key) => `        ${key}`),
  ].join("\n") + "\n";
}

/** A workflow with one job `test` holding `steps`; `jobKeys` are extra job lines (indented 4). */
function prWorkflow(
  steps: string,
  jobKeys = "",
  on = "on: pull_request\n",
): string {
  return `${on}jobs:\n  test:\n    runs-on: ubuntu-latest\n${jobKeys}    steps:\n${steps}`;
}

function assertDiagnostic(
  result: AwsEmulatorCheckResult,
  fragment: string,
): void {
  assert(
    result.wiringDiagnostics.some((d) => d.includes(fragment)),
    `expected a diagnostic containing "${fragment}", got: ${
      result.wiringDiagnostics.join(" | ")
    }`,
  );
}

Deno.test("checkAwsEmulatorInCI - a direct runner step in a pull_request job is official-server with its command as evidence", async () => {
  const result = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml(RUNNER_STEP)),
  });
  assertEquals(result.usesAws, true);
  assertEquals(result.wiring, "official-server");
  assertEquals(result.wiringEvidence, [
    "`ci.yml` job `test`: `aws-emulator-run -- ./test.sh`",
  ]);
  assertEquals(result.wiringDiagnostics, []);
});

Deno.test("checkAwsEmulatorInCI - a repository script that runs the emulator is official-server, with the script call as evidence", async () => {
  const result = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh": "#!/usr/bin/env bash\naws-emulator-run -- ./test.sh\n",
  });
  assertEquals(result.wiring, "official-server");
  assertEquals(result.wiringEvidence, ["`ci.yml` job `test`: `./ci/t.sh`"]);
});

Deno.test("checkAwsEmulatorInCI - a workflow_call workflow called from a pull_request workflow is official-server", async () => {
  const caller =
    "on: pull_request\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n";
  const reusable = prWorkflow(stepYaml(RUNNER_STEP), "", "on: workflow_call\n");
  const called = await checkRepoWith({
    ".github/workflows/ci.yml": caller,
    ".github/workflows/reusable.yml": reusable,
  });
  assertEquals(called.wiring, "official-server");
  assertEquals(called.wiringEvidence, [
    "`reusable.yml` job `test`: `aws-emulator-run -- ./test.sh`",
  ]);
});

Deno.test("checkAwsEmulatorInCI - a workflow_call workflow that no pull_request workflow calls is not credited", async () => {
  const uncalled = await checkRepoWith({
    ".github/workflows/reusable.yml": prWorkflow(
      stepYaml(RUNNER_STEP),
      "",
      "on: workflow_call\n",
    ),
  });
  assertEquals(uncalled.wiring, "missing");
  assertDiagnostic(
    uncalled,
    "`reusable.yml`: does not run on pull_request and no pull_request workflow calls it",
  );
  // Control: the same file, once a pull_request workflow calls it.
  const called = await checkRepoWith({
    ".github/workflows/ci.yml":
      "on: pull_request\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n",
    ".github/workflows/reusable.yml": prWorkflow(
      stepYaml(RUNNER_STEP),
      "",
      "on: workflow_call\n",
    ),
  });
  assertEquals(called.wiring, "official-server");
});

Deno.test("checkAwsEmulatorInCI - a push-only workflow is not credited; the same workflow on pull_request is", async () => {
  const pushOnly = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(RUNNER_STEP),
      "",
      "on: push\n",
    ),
  });
  assertEquals(pushOnly.wiring, "missing");
  assertDiagnostic(pushOnly, "`ci.yml`: does not run on pull_request");
  const pullRequest = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml(RUNNER_STEP)),
  });
  assertEquals(pullRequest.wiring, "official-server");
});

Deno.test("checkAwsEmulatorInCI - a justified, pinned embedded marker with cargo test is official-embedded in a Rust repo", async () => {
  const result = await checkRepoWith({
    "Cargo.toml": CARGO_TOML_AWS,
    ".github/workflows/ci.yml": prWorkflow(stepYaml(EMBEDDED_STEP)),
  });
  assertEquals(result.wiring, "official-embedded");
  assertEquals(result.wiringEvidence, [
    "`ci.yml` job `test`: `cargo test --workspace`",
  ]);
});

Deno.test("checkAwsEmulatorInCI - an embedded marker is refused when unpinned, unjustified, without cargo test, or outside a Rust repo", async () => {
  const refusals: Array<[string, string, string]> = [
    [
      "unpinned version",
      "# aws-emulator-embedded: version=1.2; justification=x\ncargo test",
      "exact pin X.Y.Z",
    ],
    [
      "missing version",
      "# aws-emulator-embedded: justification=x\ncargo test",
      "exact pin X.Y.Z",
    ],
    [
      "empty justification",
      "# aws-emulator-embedded: version=1.2.3; justification=\ncargo test",
      "justification is empty",
    ],
    [
      "no cargo test",
      "# aws-emulator-embedded: version=1.2.3; justification=x\necho done",
      "no status-preserving cargo test",
    ],
    [
      "cargo test behind ||",
      "# aws-emulator-embedded: version=1.2.3; justification=x\ncargo test || true",
      "no status-preserving cargo test",
    ],
  ];
  for (const [label, run, fragment] of refusals) {
    const result = await checkRepoWith({
      "Cargo.toml": CARGO_TOML_AWS,
      ".github/workflows/ci.yml": prWorkflow(stepYaml(run)),
    });
    assertEquals(result.wiring, "missing", label);
    assertDiagnostic(result, fragment);
  }
  // A non-Rust repo (no Cargo.toml evidence): the valid marker earns nothing.
  const nonRust = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml(EMBEDDED_STEP)),
  });
  assertEquals(nonRust.wiring, "missing");
  assertDiagnostic(nonRust, "no Cargo.toml with AWS evidence");
});

Deno.test("checkAwsEmulatorInCI - a comment naming the runner, an echo of it, or a command -v lookup is missing", async () => {
  for (
    const run of [
      "# aws-emulator-run -- ./test.sh",
      "echo aws-emulator-run -- ./test.sh",
      "command -v aws-emulator-run",
    ]
  ) {
    const result = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(run)),
    });
    assertEquals(result.wiring, "missing", run);
  }
  const control = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml(RUNNER_STEP)),
  });
  assertEquals(control.wiring, "official-server");
});

Deno.test("checkAwsEmulatorInCI - an emulator service image with no runner step is missing; with one it is official-server", async () => {
  const service =
    "    services:\n      emulator:\n        image: localstack/localstack:3\n";
  const unused = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("echo hi"), service),
  });
  assertEquals(unused.wiring, "missing");
  const used = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml(RUNNER_STEP), service),
  });
  assertEquals(used.wiring, "official-server");
});

Deno.test("checkAwsEmulatorInCI - a statically disabled job is missing; an expression-guarded one is official-server", async () => {
  const disabled = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(RUNNER_STEP),
      "    if: false\n",
    ),
  });
  assertEquals(disabled.wiring, "missing");
  // A condition that can be true on a pull request keeps the credit (PR #5332
  // review: `github.ref == 'refs/heads/main'` never is, and is refused below).
  const guarded = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(RUNNER_STEP),
      "    if: github.actor != 'dependabot[bot]'\n",
    ),
  });
  assertEquals(guarded.wiring, "official-server");
});

Deno.test("checkAwsEmulatorInCI - a job or step if: that compares the ref with a branch or tag literal earns no pull_request credit", async () => {
  const refused: Array<[string, string]> = [
    ["github.ref == 'refs/heads/main'", "excludes pull_request"],
    ["${{ github.ref == 'refs/heads/main' }}", "excludes pull_request"],
    ["github.ref_name == 'main'", "excludes pull_request"],
    ["startsWith(github.ref, 'refs/tags/')", "excludes pull_request"],
    ["github.ref_type == 'tag'", "excludes pull_request"],
    [
      "github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')",
      "excludes pull_request",
    ],
  ];
  for (const [condition, fragment] of refused) {
    const onJob = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(
        stepYaml(RUNNER_STEP),
        `    if: ${condition}\n`,
      ),
    });
    assertEquals(onJob.wiring, "missing", `job: ${condition}`);
    assertDiagnostic(onJob, fragment);
    const onStep = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(
        stepYaml(RUNNER_STEP, [`if: ${condition}`]),
      ),
    });
    assertEquals(onStep.wiring, "missing", `step: ${condition}`);
  }
  // Controls: ref conditions that can be true on a pull request keep it.
  for (
    const condition of [
      "github.ref != 'refs/heads/main'",
      "startsWith(github.ref, 'refs/pull/')",
      "${{ !startsWith(github.ref, 'refs/tags/') }}",
      "github.ref_type == 'branch'",
      "github.ref == 'refs/heads/main' || github.event_name == 'pull_request'",
    ]
  ) {
    const result = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(
        stepYaml(RUNNER_STEP),
        `    if: ${condition}\n`,
      ),
    });
    assertEquals(result.wiring, "official-server", condition);
  }
});

Deno.test("checkAwsEmulatorInCI - continue-on-error, || true, !, a pipe and an if condition each refuse the credit with a diagnostic", async () => {
  const refusals: Array<[string, string, string]> = [
    [
      "step continue-on-error",
      prWorkflow(stepYaml(RUNNER_STEP, ["continue-on-error: true"])),
      "sets continue-on-error",
    ],
    [
      "job continue-on-error",
      prWorkflow(stepYaml(RUNNER_STEP), "    continue-on-error: true\n"),
      "job sets continue-on-error",
    ],
    [
      "|| true",
      prWorkflow(stepYaml(`${RUNNER_STEP} || true`)),
      "is not status-preserving",
    ],
    [
      "negated with !",
      prWorkflow(stepYaml(`! ${RUNNER_STEP}`)),
      "is not status-preserving",
    ],
    [
      "piped to tee",
      prWorkflow(stepYaml(`${RUNNER_STEP} | tee log`)),
      "is not status-preserving",
    ],
    [
      "backgrounded with a trailing &",
      prWorkflow(stepYaml(`${RUNNER_STEP} &`)),
      "is not status-preserving",
    ],
    [
      "as an if condition",
      prWorkflow(stepYaml(`if ${RUNNER_STEP}; then echo ok; fi`)),
      "is not status-preserving",
    ],
  ];
  for (const [label, workflow, fragment] of refusals) {
    const result = await checkRepoWith({
      ".github/workflows/ci.yml": workflow,
    });
    assertEquals(result.wiring, "missing", label);
    assertDiagnostic(result, fragment);
  }
  // Controls: an explicit `continue-on-error: false`, and a chain that keeps
  // the status (`&& true` does not swallow a failure).
  const explicitFalse = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(RUNNER_STEP, ["continue-on-error: false"]),
    ),
  });
  assertEquals(explicitFalse.wiring, "official-server");
  const andChain = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`${RUNNER_STEP} && echo ok`),
    ),
  });
  assertEquals(andChain.wiring, "official-server");
});

Deno.test("checkAwsEmulatorInCI - Floci only is floci-only, with a diagnostic naming the job", async () => {
  const result = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("echo hi"), FLOCI_SERVICE),
  });
  assertEquals(result.wiring, "floci-only");
  assertEquals(result.wiringEvidence, []);
  assertDiagnostic(result, "`ci.yml` job `test` runs floci/floci");
});

Deno.test("checkAwsEmulatorInCI - Floci with a valid gap record is floci-gap, with the record as evidence", async () => {
  const result = await checkRepoWith({
    ".github/workflows/ci.yml": GAP_RECORD +
      prWorkflow(stepYaml(FLOCI_TEST_STEP), FLOCI_SERVICE),
  });
  assertEquals(result.wiring, "floci-gap");
  assertEquals(result.wiringEvidence.length, 1);
  assert(result.wiringEvidence[0]!.includes("aws-emulator-gap: version=2.1.0"));
});

Deno.test("checkAwsEmulatorInCI - Floci with a gap record lacking recheck is floci-only and names recheck", async () => {
  const withoutRecheck = GAP_RECORD.replace("; recheck=2027-01-01", "");
  const result = await checkRepoWith({
    ".github/workflows/ci.yml": withoutRecheck +
      prWorkflow(stepYaml(FLOCI_TEST_STEP), FLOCI_SERVICE),
  });
  assertEquals(result.wiring, "floci-only");
  assertDiagnostic(result, "aws-emulator-gap record lacks recheck");
  // A version without a digit is not a version.
  const noDigit = GAP_RECORD.replace("version=2.1.0", "version=latest");
  const badVersion = await checkRepoWith({
    ".github/workflows/ci.yml": noDigit +
      prWorkflow(stepYaml(FLOCI_TEST_STEP), FLOCI_SERVICE),
  });
  assertEquals(badVersion.wiring, "floci-only");
  assertDiagnostic(badVersion, "aws-emulator-gap record lacks version");
});

Deno.test("checkAwsEmulatorInCI - an unparseable workflow is listed in unreadableWorkflows; a readable one is still judged", async () => {
  const mixed = await checkRepoWith({
    ".github/workflows/broken.yml": "jobs: [\n",
    ".github/workflows/ci.yml": prWorkflow(stepYaml(RUNNER_STEP)),
  });
  assertEquals(mixed.unreadableWorkflows, ["broken.yml"]);
  assertEquals(mixed.wiring, "official-server");
  assertEquals(mixed.workflowsLoaded, true);

  const onlyBroken = await checkRepoWith({
    ".github/workflows/broken.yml": "jobs: [\n",
  });
  assertEquals(onlyBroken.unreadableWorkflows, ["broken.yml"]);
  assertEquals(onlyBroken.wiring, "missing");
  assertEquals(onlyBroken.workflowsLoaded, false);
});

Deno.test("checkAwsEmulatorInCI - a trailing & after a runner is refused, but a plain trailing newline is not", async () => {
  // Pinned directly on the command list: the separator after the last command.
  const background = reachableCommands(RUNNER_STEP + " &");
  assertEquals(background.length, 1);
  assertEquals(background[0]?.next, "&");
  const plain = reachableCommands(RUNNER_STEP + "\n");
  assertEquals(plain[0]?.next, "");
  assertEquals(plain[0]?.sep, "");
  const condition = reachableCommands(
    `if ${RUNNER_STEP}; then echo ok; fi\nlast`,
  );
  assertEquals(condition[0]?.condition, true);
  assertEquals(condition[0]?.next, ";");
  assertEquals(condition.at(-1)?.words, ["last"]);
  assertEquals(condition.at(-1)?.sep, "\n");
  assertEquals(condition.at(-1)?.next, "");
});

Deno.test("terraformUsesAws - AWS providers, resources, data, required_providers, sources and registry modules are AWS", () => {
  const positives = [
    'provider "aws" {\n  region = "ap-southeast-2"\n}\n',
    'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n',
    'data "aws_iam_policy_document" "p" {\n}\n',
    'terraform {\n  required_providers {\n    aws = {\n      source = "hashicorp/aws"\n    }\n  }\n}\n',
    'module "x" {\n  source = "hashicorp/aws"\n}\n',
    'module "x" {\n  source = "registry.terraform.io/hashicorp/aws"\n}\n',
    'module "vpc" {\n  source = "terraform-aws-modules/vpc/aws"\n}\n',
    'module "vpc" {\n  source = "github.com/terraform-aws-modules//vpc"\n}\n',
    'module "net" {\n  source = "acme/network/aws"\n}\n',
  ];
  for (const text of positives) assert(terraformUsesAws(text), text);
  const negatives = [
    'provider "google" {\n  project = "x"\n}\n',
    'resource "azurerm_resource_group" "rg" {\n}\n',
    '# resource "aws_s3_bucket" "b" {}\n',
    '// provider "aws" {}\n',
    '/* data "aws_iam_role" "r" {} */\n',
    'module "local" {\n  source = "./modules/aws"\n}\n',
    'module "gcp" {\n  source = "terraform-google-modules/network/google"\n}\n',
    'module "git" {\n  source = "git::https://example.com/foo//bar"\n}\n',
  ];
  for (const text of negatives) assert(!terraformUsesAws(text), text);
});

Deno.test("terraformUsesAws - hostile long lines finish with the right answer, one per pattern", () => {
  // TF_AWS_BLOCK: `resource` then blanks, no quoted aws_ type.
  assertEquals(terraformUsesAws(`resource${" ".repeat(100_000)}x`), false);
  // TF_AWS_BLOCK: a long quoted aws_ type name.
  assertEquals(
    terraformUsesAws(`resource "aws_${"x".repeat(100_000)}"`),
    true,
  );
  // TF_AWS_PROVIDER: `provider` then blanks.
  assertEquals(terraformUsesAws(`provider${" ".repeat(100_000)}x`), false);
  // TF_AWS_REQUIRED_PROVIDER: `aws` then blanks.
  assertEquals(terraformUsesAws(`aws${" ".repeat(100_000)}x`), false);
  // TF_SOURCE_LINE: an unterminated source value.
  assertEquals(terraformUsesAws(`source = "${"a/".repeat(50_000)}`), false);
  // TF_AWS_SOURCE: many segments ending in /aws are not a provider source.
  assertEquals(
    terraformUsesAws(`source = "${"a/".repeat(50_000)}aws"`),
    false,
  );
  // TF_AWS_SOURCE: one long namespace over /aws is.
  assertEquals(
    terraformUsesAws(`source = "${"x".repeat(100_000)}/aws"`),
    true,
  );
});

Deno.test("checkAwsEmulatorInCI - a Terraform file counts only when it names AWS, and a .terraform cache never counts", async () => {
  const google = await makeTempRepo();
  try {
    await writeFile(google, "main.tf", 'provider "google" {\n}\n');
    const result = await checkAwsEmulatorInCI(google);
    assertEquals(result.usesAws, false);
  } finally {
    await Deno.remove(google, { recursive: true });
  }

  const cache = await makeTempRepo();
  try {
    await writeFile(
      cache,
      ".terraform/modules/vpc/main.tf",
      'resource "aws_vpc" "v" {\n}\n',
    );
    await writeFile(
      cache,
      ".terragrunt-cache/x/main.tf",
      'provider "aws" {\n}\n',
    );
    const result = await checkAwsEmulatorInCI(cache);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(cache, { recursive: true });
  }

  const aws = await makeTempRepo();
  try {
    await writeFile(aws, "main.tf", 'provider "aws" {\n}\n');
    const result = await checkAwsEmulatorInCI(aws);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["main.tf"]);
  } finally {
    await Deno.remove(aws, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Errexit-aware failure propagation (Issue #5112 review): whether a runner's
// failure fails the step depends on what runs after it and on `set -e`.
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - a runner followed by && and another line is refused; as the last && link it is credited", async () => {
  const refused = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`${RUNNER_STEP} && echo ok\necho after`),
    ),
  });
  assertEquals(refused.wiring, "missing");
  assertDiagnostic(refused, "is not status-preserving");
  const last = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`${RUNNER_STEP} && echo ok`),
    ),
  });
  assertEquals(last.wiring, "official-server");
});

Deno.test("checkAwsEmulatorInCI - a repository script without set -e that runs the runner then more lines is refused; with set -euo pipefail it is credited", async () => {
  const body = `aws-emulator-run -- ./test.sh\necho done\n`;
  const refused = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh": `#!/usr/bin/env bash\n${body}`,
  });
  assertEquals(refused.wiring, "missing");
  assertDiagnostic(refused, "whose emulator run is not status-preserving");
  for (
    const errexit of [
      "set -euo pipefail",
      "set -eo pipefail",
      "set -o errexit",
    ]
  ) {
    const credited = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${errexit}\n${body}`,
    });
    assertEquals(credited.wiring, "official-server", errexit);
  }
});

Deno.test("checkAwsEmulatorInCI - a runner started with exec is credited even when more lines follow it in the script", async () => {
  const result = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh":
      "#!/usr/bin/env bash\nexec aws-emulator-run -- ./test.sh\necho never-reached\n",
  });
  assertEquals(result.wiring, "official-server");
});

Deno.test("checkAwsEmulatorInCI - set +e before the runner refuses it when another command follows; set -e or the default shell keeps it", async () => {
  const refused = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`set +e\n${RUNNER_STEP}\necho after`),
    ),
  });
  assertEquals(refused.wiring, "missing");
  const explicit = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`set -e\n${RUNNER_STEP}\necho after`),
    ),
  });
  assertEquals(explicit.wiring, "official-server");
  const defaultShell = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`${RUNNER_STEP}\necho after`),
    ),
  });
  assertEquals(defaultShell.wiring, "official-server");
});

Deno.test("checkAwsEmulatorInCI - a step shell of bash {0} with a later command refuses the runner; exactly bash keeps errexit and credits it", async () => {
  const body = `${RUNNER_STEP}\necho after`;
  const refused = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(body, ["shell: bash {0}"]),
    ),
  });
  assertEquals(refused.wiring, "missing");
  const credited = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml(body, ["shell: bash"])),
  });
  assertEquals(credited.wiring, "official-server");
});

// ---------------------------------------------------------------------------
// Floci gap credit (Issue #5112 review): a gap credits floci-gap only in an
// applicable workflow with an enabled Floci job that is not continue-on-error.
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - a valid Floci gap in a disabled Floci job is floci-only, with the reason; the enabled job is floci-gap", async () => {
  const disabled = await checkRepoWith({
    ".github/workflows/ci.yml": GAP_RECORD +
      prWorkflow(stepYaml(FLOCI_TEST_STEP), "    if: false\n" + FLOCI_SERVICE),
  });
  assertEquals(disabled.wiring, "floci-only");
  assertDiagnostic(
    disabled,
    "no Floci job is enabled for pull_request without continue-on-error and runs a test step",
  );
  const continued = await checkRepoWith({
    ".github/workflows/ci.yml": GAP_RECORD +
      prWorkflow(
        stepYaml(FLOCI_TEST_STEP),
        "    continue-on-error: true\n" + FLOCI_SERVICE,
      ),
  });
  assertEquals(continued.wiring, "floci-only");
  const control = await checkRepoWith({
    ".github/workflows/ci.yml": GAP_RECORD +
      prWorkflow(stepYaml(FLOCI_TEST_STEP), FLOCI_SERVICE),
  });
  assertEquals(control.wiring, "floci-gap");
});

Deno.test("checkAwsEmulatorInCI - a valid Floci gap in a push-only workflow is floci-only, with the reason; on pull_request it is floci-gap", async () => {
  const pushOnly = await checkRepoWith({
    ".github/workflows/ci.yml": GAP_RECORD +
      prWorkflow(stepYaml(FLOCI_TEST_STEP), FLOCI_SERVICE, "on: push\n"),
  });
  assertEquals(pushOnly.wiring, "floci-only");
  assertDiagnostic(
    pushOnly,
    "aws-emulator-gap record is not credited: the workflow does not run on pull_request",
  );
  const control = await checkRepoWith({
    ".github/workflows/ci.yml": GAP_RECORD +
      prWorkflow(stepYaml(FLOCI_TEST_STEP), FLOCI_SERVICE),
  });
  assertEquals(control.wiring, "floci-gap");
});

// ---------------------------------------------------------------------------
// Pre-PR verifier findings (Issue #5112): Floci gap credit needs a test step,
// failure-preserving idioms, pull_request event conditions, the .tf size cap.
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - a gap record with an unused Floci image and no test step is floci-only; a Floci test step credits floci-gap", async () => {
  const unusedImage = await checkRepoWith({
    ".github/workflows/ci.yml": GAP_RECORD +
      prWorkflow(
        stepYaml("echo hello", ["continue-on-error: true"]),
        FLOCI_SERVICE,
      ),
  });
  assertEquals(unusedImage.wiring, "floci-only");
  assertDiagnostic(unusedImage, "runs a test step whose failure fails the job");
  const echoOnly = await checkRepoWith({
    ".github/workflows/ci.yml": GAP_RECORD +
      prWorkflow(stepYaml("echo hello"), FLOCI_SERVICE),
  });
  assertEquals(echoOnly.wiring, "floci-only");
  const control = await checkRepoWith({
    ".github/workflows/ci.yml": GAP_RECORD +
      prWorkflow(stepYaml("npm test"), FLOCI_SERVICE),
  });
  assertEquals(control.wiring, "floci-gap");
});

Deno.test("checkAwsEmulatorInCI - a gap record whose Floci test step ignores failure (continue-on-error, || true, push-only if) is floci-only", async () => {
  const fixtures: Array<[string, string]> = [
    [
      "step continue-on-error",
      stepYaml("npm test", ["continue-on-error: true"]),
    ],
    ["|| true", stepYaml("npm test || true")],
    [
      "step if excludes pull_request",
      stepYaml("npm test", ["if: github.event_name == 'push'"]),
    ],
  ];
  for (const [label, steps] of fixtures) {
    const result = await checkRepoWith({
      ".github/workflows/ci.yml": GAP_RECORD +
        prWorkflow(steps, FLOCI_SERVICE),
    });
    assertEquals(result.wiring, "floci-only", label);
  }
  const pushOnlyJob = await checkRepoWith({
    ".github/workflows/ci.yml": GAP_RECORD +
      prWorkflow(
        stepYaml("npm test"),
        "    if: github.event_name == 'push'\n" + FLOCI_SERVICE,
        "on: [push, pull_request]\n",
      ),
  });
  assertEquals(pushOnlyJob.wiring, "floci-only");
});

Deno.test("checkAwsEmulatorInCI - if ! runner; then ...; exit 1; fi with a later command is credited; exit 0 in the branch is refused", async () => {
  const credited = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(
        `if ! ${RUNNER_STEP}; then\n  echo "::error::tests failed"\n  exit 1\nfi\necho finished`,
        ["shell: bash {0}"],
      ),
    ),
  });
  assertEquals(credited.wiring, "official-server");
  const refused = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(
        `if ! ${RUNNER_STEP}; then\n  echo "tests failed"\n  exit 0\nfi\necho finished`,
      ),
    ),
  });
  assertEquals(refused.wiring, "missing");
  assertDiagnostic(refused, "is not status-preserving");
});

Deno.test("checkAwsEmulatorInCI - a script running runner || exit 1 then more lines is credited; runner || exit 0 is refused", async () => {
  const credited = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh":
      "#!/usr/bin/env bash\naws-emulator-run -- ./test.sh || exit 1\necho done\n",
  });
  assertEquals(credited.wiring, "official-server");
  const refused = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh":
      "#!/usr/bin/env bash\naws-emulator-run -- ./test.sh || exit 0\necho done\n",
  });
  assertEquals(refused.wiring, "missing");
});

Deno.test("checkAwsEmulatorInCI - a push-only job in a push and pull_request workflow earns no official credit; a pull_request-inclusive if does", async () => {
  const pushOnly = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(RUNNER_STEP),
      "    if: github.event_name == 'push'\n",
      "on: [push, pull_request]\n",
    ),
  });
  assertEquals(pushOnly.wiring, "missing");
  assertDiagnostic(pushOnly, "excludes pull_request events");
  const notPr = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(RUNNER_STEP, ["if: ${{ github.event_name != 'pull_request' }}"]),
      "",
      "on: [push, pull_request]\n",
    ),
  });
  assertEquals(notPr.wiring, "missing");
  const undecided = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(RUNNER_STEP),
      "    if: contains(fromJSON('[\"push\"]'), github.event_name)\n",
      "on: [push, pull_request]\n",
    ),
  });
  assertEquals(undecided.wiring, "missing");
  assertDiagnostic(
    undecided,
    "reads the event in a form this check cannot decide",
  );
  for (
    const condition of [
      "github.event_name == 'pull_request'",
      "github.event_name == 'push' || github.event_name == 'pull_request'",
      "${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}",
    ]
  ) {
    const credited = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(
        stepYaml(RUNNER_STEP),
        `    if: "${condition}"\n`,
        "on: [push, pull_request]\n",
      ),
    });
    assertEquals(credited.wiring, "official-server", condition);
  }
});

Deno.test("checkAwsEmulatorInCI - a .tf file over the 1 MiB cap is not read, so it is not evidence; a small one is", async () => {
  const root = await makeTempRepo();
  try {
    const aws = 'resource "aws_s3_bucket" "b" {}\n';
    await writeFile(root, "infra/big.tf", aws + "#".repeat(1024 * 1024));
    await writeFile(root, "infra/small/main.tf", aws);
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.awsEvidence, ["infra/small/main.tf"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - a manifest or CloudFormation candidate over the 1 MiB cap is not read, so it is not evidence; one at the cap still is (Issue #5360)", async () => {
  const MIB = 1024 * 1024;
  // Each kind carries AWS evidence in its head. The filler pads the file to an
  // exact size inside a comment or a string, so the file still parses.
  const kinds = [
    {
      slug: "pkg-json",
      file: "package.json",
      head: '{"dependencies":{"aws-sdk":"2.1.0"},"description":"',
      filler: "x",
      tail: '"}\n',
    },
    {
      slug: "cargo",
      file: "Cargo.toml",
      head: '[dependencies]\naws-sdk-s3 = "1"\n',
      filler: "#",
      tail: "\n",
    },
    {
      slug: "pom",
      file: "pom.xml",
      head:
        "<project><dependencies><dependency><groupId>software.amazon.awssdk</groupId></dependency></dependencies><!--",
      filler: "x",
      tail: "--></project>\n",
    },
    {
      slug: "requirements",
      file: "requirements.txt",
      head: "boto3==1.34.0\n",
      filler: "#",
      tail: "\n",
    },
    {
      slug: "cfn-yaml",
      file: "template.yaml",
      head: 'AWSTemplateFormatVersion: "2010-09-09"\n',
      filler: "#",
      tail: "\n",
    },
    {
      slug: "cfn-json",
      file: "template.json",
      head: '{"AWSTemplateFormatVersion":"2010-09-09","Description":"',
      filler: "x",
      tail: '"}\n',
    },
  ];
  const root = await makeTempRepo();
  try {
    const expected: string[] = [];
    for (const kind of kinds) {
      const bodyLength = kind.head.length + kind.tail.length;
      const build = (fillerLength: number) =>
        kind.head + kind.filler.repeat(fillerLength) + kind.tail;
      const big = `${kind.slug}/big/${kind.file}`;
      const atCap = `${kind.slug}/at-cap/${kind.file}`;
      const small = `${kind.slug}/small/${kind.file}`;
      await writeFile(root, big, build(MIB + 1 - bodyLength));
      await writeFile(root, atCap, build(MIB - bodyLength));
      await writeFile(root, small, build(0));
      assertEquals((await Deno.stat(`${root}/${big}`)).size, MIB + 1);
      assertEquals((await Deno.stat(`${root}/${atCap}`)).size, MIB);
      expected.push(atCap, small);
    }
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.awsEvidence, expected.sort());
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// PR #5332 review: a failure swallowed one level out, around a group or a
// compound, is not credited, and neither is `|| exit 1` after a negated
// runner. Each form is refused in the workflow and in a repository script,
// with a credited control beside it.
Deno.test("checkAwsEmulatorInCI - a runner whose group or compound is swallowed one level out, or a negated runner before || exit 1, earns no credit", async () => {
  const refusedBodies: Array<[string, string]> = [
    ["a brace group || true", `{ ${RUNNER_STEP}; } || true`],
    ["an if/fi || true", `if true; then ${RUNNER_STEP}; fi || true`],
    ["a subshell || true", `( ${RUNNER_STEP} ) || true`],
    ["a brace group piped to tee", `{ ${RUNNER_STEP}; } | tee log`],
    ["a for loop || true", `for i in 1; do ${RUNNER_STEP}; done || true`],
    [
      "a multi-line brace group || true",
      `{\n  ${RUNNER_STEP}\n} || true`,
    ],
    ["! runner || exit 1, then more", `! ${RUNNER_STEP} || exit 1\necho after`],
    // A subshell holding more than one command closes on its last `)` too.
    [
      "a multi-command subshell || true",
      `( cd infra; ${RUNNER_STEP}; cd .. ) || true`,
    ],
    [
      "a multi-command subshell with attached parens || true",
      `(cd infra; ${RUNNER_STEP}; echo done) || true`,
    ],
    [
      "a multi-command subshell piped to tee",
      `( ${RUNNER_STEP}; echo done ) | tee log`,
    ],
    [
      "a multi-command subshell backgrounded",
      `( ${RUNNER_STEP}; echo done ) &\nwait`,
    ],
    // errexit is ignored inside a compound on the left of `&&`.
    [
      "a brace group && echo ok, then more",
      `{ ${RUNNER_STEP}; } && echo ok\necho more`,
    ],
    [
      "an if/fi && echo ok, then more",
      `if true; then ${RUNNER_STEP}; fi && echo ok\necho more`,
    ],
    // A `)` attached to a quoted word closes the subshell too (PR #5332
    // review round 4).
    [
      "a subshell closed by a double-quoted word's ) || true",
      `(cd infra; ${RUNNER_STEP}; echo "done") || true`,
    ],
    [
      "a subshell closed by a single-quoted word's ) || true",
      `( ${RUNNER_STEP}; echo 'done') || true`,
    ],
    [
      "a subshell closed by a quoted word's ) piped to tee",
      `(${RUNNER_STEP}; echo "done") | tee log`,
    ],
    [
      'a runner after ( cd infra; echo "built") then exit 0',
      `( cd infra; echo "built")\nexit 0\n${RUNNER_STEP}`,
    ],
    // errexit is ignored inside a compound left of `&&`, so a runner that is
    // not its last command is lost even when the chain ends the body.
    [
      "a brace group whose runner is not last && echo ok",
      `{ ${RUNNER_STEP}; echo done; } && echo ok`,
    ],
    [
      "an if/fi whose runner is not last && echo ok",
      `if true; then ${RUNNER_STEP}; echo done; fi && echo ok`,
    ],
    // A group or subshell inside an `if` test is a condition (PR #5332
    // review round 5).
    [
      "a subshell as an if condition",
      `if ( ${RUNNER_STEP} ); then echo ok; fi\necho more`,
    ],
    [
      "a brace group as an if condition",
      `if { ${RUNNER_STEP}; }; then echo ok; fi\necho more`,
    ],
    [
      "a multi-line subshell as an if condition",
      `if (\n  cd infra\n  ${RUNNER_STEP}\n); then echo ok; else echo failed; fi`,
    ],
    // A `)` closing a `$(` or an array literal opened earlier in the same
    // command does not close the subshell.
    [
      "a swallowed subshell after cd $(git rev-parse --show-toplevel)",
      `(\n  cd $(git rev-parse --show-toplevel)\n  ${RUNNER_STEP}\n) || true`,
    ],
    [
      "a swallowed subshell after ROOT=$(git rev-parse --show-toplevel)",
      `(\n  ROOT=$(git rev-parse --show-toplevel)\n  ${RUNNER_STEP}\n) || true`,
    ],
    [
      "a swallowed subshell after an array literal",
      `(\n  args=(--foo bar)\n  ${RUNNER_STEP}\n) || true`,
    ],
    [
      "a subshell after echo started at $(date +%s) piped to tee",
      `(\n  echo started at $(date +%s)\n  ${RUNNER_STEP}\n) | tee log`,
    ],
    // A subshell that closes before an unconditional exit leaves the runner
    // after it unreachable.
    [
      "a runner after ( cd infra; make build ) then exit 0",
      `( cd infra; make build )\nexit 0\n${RUNNER_STEP}`,
    ],
  ];
  for (const [label, body] of refusedBodies) {
    const inWorkflow = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(inWorkflow.wiring, "missing", `workflow: ${label}`);
    const inScript = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    });
    assertEquals(inScript.wiring, "missing", `script: ${label}`);
  }
  // Controls: the same groups and compounds that keep the status are credited.
  const creditedBodies: Array<[string, string]> = [
    ["a brace group", `{ ${RUNNER_STEP}; }`],
    ["an if/fi", `if true; then ${RUNNER_STEP}; fi`],
    ["a brace group && echo ok", `{ ${RUNNER_STEP}; } && echo ok`],
    [
      "a multi-command subshell",
      `( cd infra; ${RUNNER_STEP}; cd .. )\necho after`,
    ],
    [
      "a multi-command subshell with attached parens",
      `(cd infra; ${RUNNER_STEP})`,
    ],
    [
      "a subshell after cd $(git rev-parse --show-toplevel), not swallowed",
      `(\n  cd $(git rev-parse --show-toplevel)\n  ${RUNNER_STEP}\n)\necho after`,
    ],
    ["a for loop under errexit", `for t in a b; do ${RUNNER_STEP}; done`],
    ["runner || exit 1, then more", `${RUNNER_STEP} || exit 1\necho after`],
    [
      "if ! runner; then exit 1; fi, then more",
      `if ! ${RUNNER_STEP}; then\n  exit 1\nfi\necho after`,
    ],
  ];
  for (const [label, body] of creditedBodies) {
    const inWorkflow = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(inWorkflow.wiring, "official-server", `workflow: ${label}`);
    const inScript = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    });
    assertEquals(inScript.wiring, "official-server", `script: ${label}`);
  }
});

// PR #5332 review round 5: a loop returns its last pass's status, so with
// errexit off a runner in a loop body is not kept by being the last command.
Deno.test("checkAwsEmulatorInCI - a runner in a loop body in a script without set -e earns no credit; with set -e or in a default workflow shell it does", async () => {
  for (
    const body of [
      `for t in a b; do ${RUNNER_STEP}; done`,
      `for t in a b\ndo\n  ${RUNNER_STEP}\ndone`,
      `while read -r t; do ${RUNNER_STEP}; done < list`,
    ]
  ) {
    const refused = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    });
    assertEquals(refused.wiring, "missing", `no set -e: ${body}`);
    const withErrexit = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    });
    assertEquals(withErrexit.wiring, "official-server", `set -e: ${body}`);
    const inWorkflow = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(inWorkflow.wiring, "official-server", `workflow: ${body}`);
  }
});

// PR #5332 review: an `EXIT` or `ERR` trap whose handler runs `exit 0`
// replaces the failing status, so the step passes when the tests fail. Each
// form is refused in the workflow and in a repository script, with credited
// controls for handlers that keep the status, resets and `exec`.
Deno.test("checkAwsEmulatorInCI - an EXIT or ERR trap whose handler may exit 0 earns no credit; a status-keeping handler, a reset or exec does", async () => {
  const refusedBodies: Array<[string, string]> = [
    ["trap 'exit 0' EXIT", `trap 'exit 0' EXIT\n${RUNNER_STEP}`],
    ['trap "exit 0" ERR', `trap "exit 0" ERR\n${RUNNER_STEP}`],
    [
      "trap -- 'echo done; exit 0' 0",
      `trap -- 'echo done; exit 0' 0\n${RUNNER_STEP}`,
    ],
    ["a lower-case exit condition", `trap 'exit 0' exit\n${RUNNER_STEP}`],
    [
      "a cleanup function that exits 0",
      `cleanup() {\n  rm -rf tmp\n  exit 0\n}\ntrap cleanup EXIT\n${RUNNER_STEP}`,
    ],
    [
      "a function-keyword handler on ERR",
      `function cleanup { exit 0; }\ntrap cleanup ERR\n${RUNNER_STEP}`,
    ],
    [
      "a handler calling a function that exits 0",
      `finish() { exit 0; }\ncleanup() {\n  echo bye\n  finish\n}\ntrap cleanup EXIT\n${RUNNER_STEP}`,
    ],
    [
      "runner || exit 1 under the trap",
      `trap 'exit 0' EXIT\n${RUNNER_STEP} || exit 1`,
    ],
    [
      "an ERR trap left by an EXIT reset",
      `trap 'exit 0' ERR\ntrap - EXIT\n${RUNNER_STEP}`,
    ],
  ];
  for (const [label, body] of refusedBodies) {
    const inWorkflow = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(inWorkflow.wiring, "missing", `workflow: ${label}`);
    const inScript = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    });
    assertEquals(inScript.wiring, "missing", `script: ${label}`);
  }
  // A trap in the step before it calls a script swallows the script's failure.
  const stepTrap = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml("trap 'exit 0' EXIT\n./ci/t.sh"),
    ),
    "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${RUNNER_STEP}\n`,
  });
  assertEquals(stepTrap.wiring, "missing", "a step trap before the script");
  const creditedBodies: Array<[string, string]> = [
    ["a tidy-up handler", `trap 'rm -rf tmp' EXIT\n${RUNNER_STEP}`],
    [
      "a cleanup function that exits with the saved status",
      `cleanup() {\n  rc=$?\n  rm -rf tmp\n  exit $rc\n}\ntrap cleanup EXIT\n${RUNNER_STEP}`,
    ],
    ["a bare exit", `trap 'echo done; exit' EXIT\n${RUNNER_STEP}`],
    ["exit $?", `trap 'exit $?' ERR\n${RUNNER_STEP}`],
    ["a non-zero exit", `trap 'exit 3' EXIT\n${RUNNER_STEP}`],
    ["trap - EXIT", `trap 'exit 0' EXIT\ntrap - EXIT\n${RUNNER_STEP}`],
    ["trap '' EXIT", `trap 'exit 0' EXIT\ntrap '' EXIT\n${RUNNER_STEP}`],
    ["another condition", `trap 'exit 0' INT TERM\n${RUNNER_STEP}`],
    ["trap -p", `trap -p\n${RUNNER_STEP}`],
    ["exec under the trap", `trap 'exit 0' EXIT\nexec ${RUNNER_STEP}`],
  ];
  for (const [label, body] of creditedBodies) {
    const inWorkflow = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(inWorkflow.wiring, "official-server", `workflow: ${label}`);
    const inScript = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    });
    assertEquals(inScript.wiring, "official-server", `script: ${label}`);
  }
});

// PR #5332 review round 6: a subshell closed by `)` and then redirections, or
// one holding a multi-line `$(`, is still swallowed by `|| true` or a pipe; a
// `set -e` inside a subshell ends with it; and an `&` in a redirection
// (`2>&1`, `>&2`, `&>`) is not a background `&`.
Deno.test("checkAwsEmulatorInCI - a swallowed subshell closed before redirections or holding a multi-line $( earns no credit; a redirected runner does", async () => {
  const multiLineSubst =
    `(\n  VERSION=$(\n    cat VERSION\n  )\n  ${RUNNER_STEP}\n  echo done\n)`;
  const refusedBodies: Array<[string, string]> = [
    [
      "a subshell ) 2>&1 | tee log",
      `( cd infra; ${RUNNER_STEP}; echo done ) 2>&1 | tee log`,
    ],
    [
      "a subshell ) > log 2>&1 || true",
      `( cd infra; ${RUNNER_STEP}; echo done ) > log 2>&1 || true`,
    ],
    [
      "an attached subshell) >log || true",
      `(cd infra; ${RUNNER_STEP}; echo done) >log || true`,
    ],
    ["a multi-line $( in a subshell || true", `${multiLineSubst} || true`],
    ["a runner |& tee log", `${RUNNER_STEP} |& tee log`],
    ["a runner 2>&1 | tee log", `${RUNNER_STEP} 2>&1 | tee log`],
  ];
  for (const [label, body] of refusedBodies) {
    const inWorkflow = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(inWorkflow.wiring, "missing", `workflow: ${label}`);
    const inScript = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    });
    assertEquals(inScript.wiring, "missing", `script: ${label}`);
  }
  // Without pipefail in a default workflow shell, a pipe swallows too.
  for (
    const body of [
      `( ${RUNNER_STEP}; echo done ) >/dev/null || true`,
      `( ${RUNNER_STEP}; echo done ) </dev/null | tee log`,
      `${multiLineSubst} | tee log`,
      // Backstops: a subshell never closed, and a `)` with none open.
      `(\n  ${RUNNER_STEP}\n  echo done`,
      `${RUNNER_STEP}\n)\necho x`,
    ]
  ) {
    const result = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(result.wiring, "missing", `workflow: ${body}`);
  }
  const credited: Array<[string, string, string]> = [
    ["a runner > log 2>&1", "workflow", `${RUNNER_STEP} > log 2>&1`],
    ["a runner 2>&1, then more", "workflow", `${RUNNER_STEP} 2>&1\necho more`],
    ["a runner &> test.log", "workflow", `${RUNNER_STEP} &> test.log`],
    ["a runner >&2, then more", "script", `${RUNNER_STEP} >&2\necho more`],
    [
      "a subshell >log, then more",
      "workflow",
      `( ${RUNNER_STEP}; echo done ) >log\necho more`,
    ],
    [
      "a multi-line $( before the runner",
      "workflow",
      `VERSION=$(\n  cat VERSION\n)\n${RUNNER_STEP}\necho done`,
    ],
    [
      "a multi-line array before the runner",
      "workflow",
      `args=(\n  --foo\n  bar\n)\n${RUNNER_STEP} "\${args[@]}"`,
    ],
    [
      "a case pattern closed by a spaced )",
      "workflow",
      `case "$1" in\n  ci )\n    echo ci\n    ;;\nesac\n${RUNNER_STEP}\necho more`,
    ],
  ];
  for (const [label, where, body] of credited) {
    const result = await checkRepoWith(
      where === "workflow"
        ? { ".github/workflows/ci.yml": prWorkflow(stepYaml(body)) }
        : {
          ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
          "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
        },
    );
    assertEquals(result.wiring, "official-server", `${where}: ${label}`);
  }
});

Deno.test("checkAwsEmulatorInCI - set -e inside a subshell ends with it; a top-level set -e keeps the runner credited", async () => {
  const refused = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh":
      `#!/usr/bin/env bash\n( set -e; make build )\n${RUNNER_STEP}\necho done\n`,
  });
  assertEquals(refused.wiring, "missing", "set -e only in a subshell");
  const multiLine = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh":
      `#!/usr/bin/env bash\n(\n  set -e\n  make build\n)\n${RUNNER_STEP}\necho done\n`,
  });
  assertEquals(multiLine.wiring, "missing", "set -e in a multi-line subshell");
  const credited = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh":
      `#!/usr/bin/env bash\nset -e\n( make build )\n${RUNNER_STEP}\necho done\n`,
  });
  assertEquals(credited.wiring, "official-server", "top-level set -e");
  const inside = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh": `#!/usr/bin/env bash\n( set -e; ${RUNNER_STEP}; echo done )\n`,
  });
  assertEquals(
    inside.wiring,
    "official-server",
    "runner inside the set -e subshell",
  );
});

// PR #5332 review: a `set -e` that runs only under a run-time condition leaves
// errexit off when the condition is false, so a runner followed by more
// commands loses its failure; a `set -e` certain to run is credited.
Deno.test("checkAwsEmulatorInCI - a set -e that runs only under a run-time condition does not credit a runner followed by more commands", async () => {
  const tail = `${RUNNER_STEP}\necho done`;
  const conditional: Array<[string, string]> = [
    ["if branch", `if [ "\${DEBUG:-}" = "1" ]; then set -ex; fi\n${tail}`],
    ["and chain", `[ -n "\${STRICT:-}" ] && set -e\n${tail}`],
    [
      "else branch",
      `if [ -n "\${LOOSE:-}" ]; then echo loose; else set -e; fi\n${tail}`,
    ],
    ["loop body", `while read -r line; do set -e; done < flags.txt\n${tail}`],
    ["or chain", `[ -z "\${LOOSE:-}" ] || set -e\n${tail}`],
    ["left of a pipe", `set -e | cat\n${tail}`],
    ["backgrounded", `set -e &\n${tail}`],
    [
      "elif true after a run-time test",
      `if [ -n "\${A:-}" ]; then echo a; elif true; then set -e; fi\n${tail}`,
    ],
    [
      "else after a run-time test",
      `if [ -n "\${A:-}" ]; then echo a; else set -e; fi\n${tail}`,
    ],
  ];
  for (const [label, body] of conditional) {
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    });
    assertEquals(script.wiring, "missing", `script, ${label}`);
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`set +e\n${body}`)),
    });
    assertEquals(step.wiring, "missing", `step after set +e, ${label}`);
  }
  // Controls: a set -e certain to run is credited in the same two shapes.
  const certain: Array<[string, string]> = [
    ["top level", `set -e\n${tail}`],
    ["if true", `if true; then set -e; fi\n${tail}`],
    ["true and", `true && set -e\n${tail}`],
    [
      "else after a false test",
      `if false; then echo a; else set -e; fi\n${tail}`,
    ],
    [
      "elif true after a false test",
      `if false; then echo a; elif true; then set -e; fi\n${tail}`,
    ],
  ];
  // A `set -e` after a backgrounded command runs in the current shell: only
  // the command before the `&` is backgrounded.
  certain.push(
    ["after a backgrounded command", `sleep 30 &\nset -e\n${tail}`],
    ["after a backgrounded command, one line", `sleep 30 & set -e\n${tail}`],
  );
  for (const [label, body] of certain) {
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    });
    assertEquals(script.wiring, "official-server", `script, ${label}`);
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`set +e\n${body}`)),
    });
    assertEquals(step.wiring, "official-server", `step, ${label}`);
  }
});

// PR #5332 review round 7: errexit switched on inside a subshell ends the
// subshell with the failure, but with errexit off outside it the body carries
// on, so a runner there is credited only when the subshell's failure fails the
// body.
Deno.test("checkAwsEmulatorInCI - a runner in a ( set -e; ... ) subshell followed by more commands, with errexit off outside, earns no credit", async () => {
  for (
    const [label, files] of [
      ["one-line subshell then a line, no top-level set -e", {
        ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
        "ci/t.sh":
          `#!/usr/bin/env bash\n( set -e; ${RUNNER_STEP}; echo done )\necho after\n`,
      }],
      ["multi-line subshell then two lines, no top-level set -e", {
        ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
        "ci/t.sh":
          `#!/usr/bin/env bash\n(\n  set -e\n  cd infra\n  ${RUNNER_STEP}\n)\necho cleaning up\nrm -rf tmp\n`,
      }],
      ["workflow step after set +e", {
        ".github/workflows/ci.yml": prWorkflow(
          stepYaml(`set +e\n( set -e; ${RUNNER_STEP}; echo done )\necho after`),
        ),
      }],
    ] as Array<[string, Record<string, string>]>
  ) {
    const result = await checkRepoWith(files);
    assertEquals(result.wiring, "missing", label);
  }
  // Controls: the subshell as the last command, and under a top-level set -e.
  const last = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh": `#!/usr/bin/env bash\n( set -e; ${RUNNER_STEP}; echo done )\n`,
  });
  assertEquals(last.wiring, "official-server", "subshell last");
  const topLevel = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh":
      `#!/usr/bin/env bash\nset -e\n( set -e; ${RUNNER_STEP}; echo done )\necho after\n`,
  });
  assertEquals(topLevel.wiring, "official-server", "top-level set -e");
});

// PR #5332 review round 8: every route that fails a `( )` subshell (errexit
// inside it, an explicit exit, `exec`) fails the body only when the
// subshell's own failure does; a loop body is never the last command.
Deno.test("checkAwsEmulatorInCI - a subshell's exit, exec or set -e fails the body only when the subshell's failure does", async () => {
  const bodies: Array<[string, string]> = [
    [
      "(a) a set -e subshell as a loop body",
      `for d in a b; do ( set -e; cd "$d"; ${RUNNER_STEP} ); done`,
    ],
    [
      "(a) the multi-line loop",
      `for d in a b\ndo\n  ( set -e; cd "$d"; ${RUNNER_STEP} )\ndone`,
    ],
    [
      "(b) runner || exit 1 in a subshell, then a line",
      `(\n  cd infra\n  ${RUNNER_STEP} || exit 1\n)\necho after`,
    ],
    [
      "(b) the same subshell as a loop body",
      `for d in a b; do (\n  cd infra\n  ${RUNNER_STEP} || exit 1\n); done`,
    ],
    [
      "(c) if ! runner; then exit 1; fi in a subshell, then a line",
      `(\n  cd infra\n  if ! ${RUNNER_STEP}; then\n    echo failed\n    exit 1\n  fi\n)\necho after`,
    ],
    [
      "(d) exec runner in a subshell, then a line",
      `( cd infra && exec ${RUNNER_STEP} )\necho after`,
    ],
  ];
  for (const [label, body] of bodies) {
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    });
    assertEquals(script.wiring, "missing", `script without set -e: ${label}`);
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`set +e\n${body}`)),
    });
    assertEquals(step.wiring, "missing", `step after set +e: ${label}`);
  }
  // Controls: the same subshells as the body's last command, or under errexit.
  const credited: Array<[string, Record<string, string>]> = [
    ["runner || exit 1 in the last subshell", {
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh":
        `#!/usr/bin/env bash\n(\n  cd infra\n  ${RUNNER_STEP} || exit 1\n)\n`,
    }],
    ["exec runner in the last subshell", {
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n( cd infra && exec ${RUNNER_STEP} )\n`,
    }],
    ["the set -e loop under a top-level set -e", {
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh":
        `#!/usr/bin/env bash\nset -e\nfor d in a b; do ( set -e; cd "$d"; ${RUNNER_STEP} ); done\necho after\n`,
    }],
    ["runner || exit 1 in a subshell in a default-shell step", {
      ".github/workflows/ci.yml": prWorkflow(
        stepYaml(`(\n  cd infra\n  ${RUNNER_STEP} || exit 1\n)\necho after`),
      ),
    }],
  ];
  for (const [label, files] of credited) {
    const result = await checkRepoWith(files);
    assertEquals(result.wiring, "official-server", label);
  }
});

// PR #5332 review round 9: only a loop around the subshell loses the
// subshell's failure; a loop inside a set -e subshell ends it on the first
// failing pass, so that subshell as the last command is credited.
Deno.test("checkAwsEmulatorInCI - a loop inside a set -e subshell that is the last command is credited; a loop around the subshell is not", async () => {
  const credited: Array<[string, string]> = [
    ["one line", `( set -e; for d in a b; do ${RUNNER_STEP}; done )`],
    [
      "multi-line",
      `(\n  set -e\n  for d in a b\n  do\n    ${RUNNER_STEP}\n  done\n)`,
    ],
    [
      "|| exit 1 in the loop",
      `( for d in a b; do ${RUNNER_STEP} || exit 1; done )`,
    ],
  ];
  for (const [label, body] of credited) {
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    });
    assertEquals(script.wiring, "official-server", `script: ${label}`);
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`set +e\n${body}`)),
    });
    assertEquals(step.wiring, "official-server", `step after set +e: ${label}`);
  }
  const refused: Array<[string, string]> = [
    ["no errexit in the subshell", `( for d in a b; do ${RUNNER_STEP}; done )`],
    [
      "a line after the subshell",
      `( set -e; for d in a b; do ${RUNNER_STEP}; done )\necho after`,
    ],
    [
      "then an && chain (errexit is ignored left of &&)",
      `( set -e; for d in a b; do ${RUNNER_STEP}; done ) && echo ok`,
    ],
    [
      "a subshell inside a loop inside a subshell",
      `( for d in a b; do ( set -e; ${RUNNER_STEP} ); done )`,
    ],
  ];
  for (const [label, body] of refused) {
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    });
    assertEquals(script.wiring, "missing", `script: ${label}`);
  }
});

// PR #5332 review round 10: a `( )` subshell that is an `if`, `elif`,
// `while` or `until` test never fails the body, whatever errexit is outside
// it: its exit only makes the test false. A brace group as the test, and a
// test inside the subshell, are still read as before.
Deno.test("checkAwsEmulatorInCI - an explicit exit in a subshell that is an if or while test earns no credit", async () => {
  const refused: Array<[string, string]> = [
    [
      "one-line if test",
      `if ( cd infra && ${RUNNER_STEP} || exit 1; ); then echo ok; else echo failed; fi`,
    ],
    [
      "multi-line if test",
      `if (\n  cd infra\n  ${RUNNER_STEP} || exit 1\n); then echo passed; else echo failed; fi`,
    ],
    [
      "if ! runner inside the test subshell",
      `if (\n  if ! ${RUNNER_STEP}; then exit 1; fi\n); then echo ok; fi`,
    ],
    [
      "while test",
      `while (\n  cd infra\n  ${RUNNER_STEP} || exit 1\n); do break; done`,
    ],
    [
      "until test",
      `until (\n  cd infra\n  ${RUNNER_STEP} || exit 1\n); do break; done`,
    ],
    [
      "elif test",
      `if false; then echo no\nelif (\n  cd infra\n  ${RUNNER_STEP} || exit 1\n); then echo ok; fi`,
    ],
  ];
  for (const [label, body] of refused) {
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(step.wiring, "missing", `default-shell step: ${label}`);
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -e\n${body}\n`,
    });
    assertEquals(script.wiring, "missing", `set -e script: ${label}`);
  }
  const credited: Array<[string, string]> = [
    [
      "a brace group as the test",
      `if { ${RUNNER_STEP} || exit 1; }; then echo ok; fi`,
    ],
    [
      "a test inside the subshell",
      `( if ! ${RUNNER_STEP}; then exit 1; fi )`,
    ],
  ];
  for (const [label, body] of credited) {
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(
      step.wiring,
      "official-server",
      `default-shell step: ${label}`,
    );
  }
});

// PR #5332 review round 10: the one-line `( …; runner || exit 1 )`, with the
// closing `)` spaced or attached, is the explicit-exit idiom.
Deno.test("checkAwsEmulatorInCI - a one-line subshell ending in runner || exit 1 is read as an explicit exit", async () => {
  const forms = [
    `( cd infra; ${RUNNER_STEP} || exit 1 )`,
    `(cd infra && ${RUNNER_STEP} || exit 1)`,
    `( cd infra; ${RUNNER_STEP} || exit 1 ) 2>&1`,
  ];
  for (const form of forms) {
    const last = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${form}\n`,
    });
    assertEquals(last.wiring, "official-server", `script's last line: ${form}`);
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`${form}\necho after`)),
    });
    assertEquals(step.wiring, "official-server", `default-shell step: ${form}`);
    const underSetE = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -e\n${form}\necho after\n`,
    });
    assertEquals(
      underSetE.wiring,
      "official-server",
      `set -e then a line: ${form}`,
    );
    const noSetE = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${form}\necho after\n`,
    });
    assertEquals(noSetE.wiring, "missing", `no set -e, then a line: ${form}`);
  }
  const ifForm = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh":
      `#!/usr/bin/env bash\n( if ! ${RUNNER_STEP}; then echo bad; exit 1; fi )\n`,
  });
  assertEquals(
    ifForm.wiring,
    "official-server",
    "one-line if ! runner subshell",
  );
});

// PR #5332 review round 11: an exit whose `)` closes anything but the
// tracked subshell around the runner (a nested subshell, a `$( )`, or a
// parenthesis opened earlier on the line with no frame) ends only that, so it
// is not the explicit-exit idiom; and a runner inside such a parenthesis is
// never credited.
Deno.test("checkAwsEmulatorInCI - an exit that ends only a nested subshell or substitution earns no credit", async () => {
  const R = RUNNER_STEP;
  const bodies: Array<[string, string]> = [
    [
      "(a) time ( … || exit 1 )",
      `time ( cd infra; ${R} || exit 1 )\necho done`,
    ],
    [
      "(b) LOG=$( … || exit 1)",
      `LOG=$(cd infra && ${R} 2>&1 || exit 1)\necho "$LOG" | tail -5`,
    ],
    ["(b) ; form", `LOG=$(cd infra; ${R} || exit 1)\necho "$LOG"`],
    [
      "(b) OUT=$( if ! … fi)",
      `OUT=$(cd infra; if ! ${R}; then exit 1; fi)\necho "$OUT"`,
    ],
    [
      "(c) (echo bad; exit 1) in the branch",
      `if ! ${R}; then\n  (echo bad; exit 1)\nfi\necho done`,
    ],
    [
      "(c) one line",
      `if ! ${R}; then (echo bad; exit 1); fi\necho done`,
    ],
    [
      "(c) MSG=$( … ) in the branch",
      `if ! ${R}; then\n  MSG=$(echo bad; exit 1)\nfi\necho done`,
    ],
    ["(d) echo $( … || exit 1)", `echo $(cd infra; ${R} || exit 1)\necho done`],
    ["(d) ! ( … )", `! ( cd infra; ${R} || exit 1 )\necho done`],
    ["echo $(cd infra; runner)", `echo $(cd infra; ${R})`],
  ];
  for (const [label, body] of bodies) {
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    });
    assertEquals(script.wiring, "missing", `script without set -e: ${label}`);
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`set +e\n${body}`)),
    });
    assertEquals(step.wiring, "missing", `step after set +e: ${label}`);
  }
  for (
    const body of [
      `echo $(cd infra; ${R} || exit 1)`,
      `echo $(cd infra; ${R})`,
      `! ( cd infra; ${R} || exit 1 )\necho done`,
    ]
  ) {
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(step.wiring, "missing", `default-shell step: ${body}`);
  }
  // Controls.
  const refusedControls = [
    `if ! ${R}; then\n  ( echo bad; exit 1 )\nfi\necho done`,
    `${R} || (echo failed; exit 1)\necho done`,
    `time ( cd infra; ${R} )\necho done`,
  ];
  for (const body of refusedControls) {
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    });
    assertEquals(script.wiring, "missing", `control: ${body}`);
  }
  for (
    const body of [
      `${R} || exit 1\necho done`,
      `if ! ${R}; then echo bad; exit 1; fi\necho done`,
      `( cd infra; ${R} || exit 1 )`,
      `(cd infra && ${R} || exit 1)`,
    ]
  ) {
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    });
    assertEquals(script.wiring, "official-server", `control: ${body}`);
  }
});

// PR #5332 review round 11: `fi)` and `done)` close the compound and then
// the subshell around it, as `fi )` and `done )` do.
Deno.test("checkAwsEmulatorInCI - a one-line subshell closed by fi) or done) is read like fi ) and done )", async () => {
  const R = RUNNER_STEP;
  const forms = [
    `(if ! ${R}; then echo bad; exit 1; fi)`,
    `( if ! ${R}; then echo bad; exit 1; fi)`,
    `(for d in a b; do ${R} || exit 1; done)`,
  ];
  for (const form of forms) {
    const last = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${form}\n`,
    });
    assertEquals(last.wiring, "official-server", `script's last line: ${form}`);
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`${form}\necho after`)),
    });
    assertEquals(step.wiring, "official-server", `default-shell step: ${form}`);
    const noSetE = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${form}\necho after\n`,
    });
    assertEquals(noSetE.wiring, "missing", `no set -e, then a line: ${form}`);
  }
  const ifInside = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`( cd infra; if [ -f t.sh ]; then ${R}; fi)\necho after`),
    ),
  });
  assertEquals(ifInside.wiring, "official-server", "if inside, closed by fi)");
});

// PR #5332 review round 12: a `$( … )` or `$(( … ))` that opens and closes
// inside the `then` branch is not a nested construct, so the `exit` after it
// still ends the shell and the idiom keeps its credit.
Deno.test("checkAwsEmulatorInCI - a balanced substitution before the exit keeps the if ! runner idiom credited", async () => {
  const R = RUNNER_STEP;
  const forms = [
    `if ! ${R}; then echo "failed at $(date)"; exit 1; fi`,
    `if ! ${R}; then\n  docker logs "$(docker ps -lq)"\n  exit 1\nfi`,
    `if ! ${R}; then echo "took $((SECONDS / 60)) min"; exit 1; fi`,
    `if ! ${R}; then cat $(pwd)/log.txt; exit 1; fi`,
    `if ! ${R}; then echo "(see the log)"; exit 1; fi`,
    `if ! ${R}; then echo "tests failed" >&2; exit 1; fi`,
    `if ! ${R}; then ( echo a ); exit 1; fi`,
  ];
  for (const form of forms) {
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`${form}\necho after`)),
    });
    assertEquals(step.wiring, "official-server", `default-shell step: ${form}`);
    const afterSetPlusE = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(
        stepYaml(`set +e\n${form}\necho after`),
      ),
    });
    assertEquals(
      afterSetPlusE.wiring,
      "official-server",
      `step after set +e: ${form}`,
    );
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${form}\necho after\n`,
    });
    assertEquals(
      script.wiring,
      "official-server",
      `script without set -e, then a line: ${form}`,
    );
  }
  // Inside a subshell the idiom ends only the subshell, so it is credited
  // where errexit outside the subshell (or the last line) carries the failure.
  const subshellForm =
    `( if ! ${R}; then echo "failed at $(date)"; exit 1; fi )`;
  const subshellStep = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`${subshellForm}\necho after`),
    ),
  });
  assertEquals(
    subshellStep.wiring,
    "official-server",
    "subshell, default shell",
  );
  const subshellLast = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh": `#!/usr/bin/env bash\n${subshellForm}\n`,
  });
  assertEquals(subshellLast.wiring, "official-server", "subshell, last line");
  const subshellNoErrexit = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh": `#!/usr/bin/env bash\n${subshellForm}\necho after\n`,
  });
  assertEquals(subshellNoErrexit.wiring, "missing", "subshell, no errexit");
  // The same idiom with an exit inside a parenthesis still open is refused.
  for (
    const form of [
      `if ! ${R}; then (echo bad; exit 1); fi`,
      `if ! ${R}; then MSG=$(echo bad; exit 1); fi`,
      `if ! ${R}; then ( echo bad; exit 1 ); fi`,
      `if ! ${R}; then echo "$(date)" (echo bad; exit 1); fi`,
    ]
  ) {
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${form}\necho after\n`,
    });
    assertEquals(script.wiring, "missing", `refused: ${form}`);
  }
});

// PR #5332 review round 12: `done)`, `fi)`, `esac)` and `})` that close a
// `$( … )` the walk tracks no frame for do not stray, so a runner before or
// after the line is still credited.
Deno.test("checkAwsEmulatorInCI - a compound closed inside a substitution does not hide the runner", async () => {
  const R = RUNNER_STEP;
  const lines = [
    'PKGS=$(for d in services/*; do basename "$d"; done)',
    'PKGS=$(for d in services/*; do\n  basename "$d"\ndone)',
    'MODE=$(case "$X" in\n  a) echo 1 ;;\n  *) echo 2 ;;\nesac)',
    "OUT=$({ echo a; echo b; })",
    "OUT=$({\n  echo a\n  echo b\n})",
  ];
  for (const line of lines) {
    const inStep = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`${line}\n${R}`)),
    });
    assertEquals(inStep.wiring, "official-server", `step: ${line}`);
    const inScript = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${line}\n${R}\n`,
    });
    assertEquals(inScript.wiring, "official-server", `script: ${line}`);
    const after = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${R} || exit 1\n${line}\n`,
    });
    assertEquals(after.wiring, "official-server", `after the runner: ${line}`);
  }
  // Inside an `if` block the `fi)` of a substitution must not pop the `if`.
  const insideIf = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`if true; then\n  X=$(if true; then echo a; fi)\n  ${R}\nfi`),
    ),
  });
  assertEquals(insideIf.wiring, "official-server", "X=$(if …; fi) in an if");
  // Control: a runner that really is in a subshell swallowed one level out is
  // still refused, so the credit comes from the substitution rule alone.
  const swallowed = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`( for d in a b; do ${R}; done ) || true`),
    ),
  });
  assertEquals(swallowed.wiring, "missing", "swallowed subshell");
});

// PR #5332 review round 12: the command that opens an untracked parenthesis
// or backtick substitution is inside it, and a `set` in it changes no errexit
// outside.
Deno.test("checkAwsEmulatorInCI - a runner that is the first command inside an untracked substitution earns no credit", async () => {
  const R = RUNNER_STEP;
  const bodies: Array<[string, string]> = [
    ["X=$( runner; echo done )", `X=$( ${R}; echo done )\necho "$X"`],
    [
      "OUT=$( runner 2>&1; echo rc )",
      `OUT=$( ${R} 2>&1; echo "rc=$?" )\necho "$OUT"`,
    ],
    ["echo done ) on the next line", `X=$( ${R};\necho done )\necho "$X"`],
    ["X=$( runner )", `X=$( ${R} )\necho "$X"`],
    ["time ( runner )", `time ( ${R} )\necho done`],
    ["backtick argument", `echo \`cd infra; ${R}\`\necho done`],
    ["backtick assignment", `X=\` ${R}; echo done \`\necho "$X"`],
  ];
  for (const [label, body] of bodies) {
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(step.wiring, "missing", `default-shell step: ${label}`);
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    });
    assertEquals(script.wiring, "missing", `set -euo pipefail: ${label}`);
  }
  // A `set -e` inside an untracked parenthesis does not turn errexit on.
  for (
    const body of [
      `X=$( set -e; cat VERSION )\n${R}\necho done`,
      `X=$(cd infra; set -e; make build)\n${R}\necho done`,
      `time ( set -e; cd infra )\n${R}\necho done`,
    ]
  ) {
    const script = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    });
    assertEquals(script.wiring, "missing", `set -e in a substitution: ${body}`);
  }
  // Controls: a tracked subshell's `set -e` still applies inside it only, and
  // a balanced earlier substitution does not make a later runner untracked.
  const tracked = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh": `#!/usr/bin/env bash\n( set -e; cd infra )\n${R}\necho done\n`,
  });
  assertEquals(tracked.wiring, "missing", "( set -e; … ) then a runner");
  const balanced = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`X=$(cat VERSION); echo \`date\`; ${R}\necho done`),
    ),
  });
  assertEquals(balanced.wiring, "official-server", "balanced substitutions");
});

// PR #5332 review round 13: a multi-line `$(` whose opening line ends in a
// keyword opens a frame, a backtick substitution is read in the `then` branch
// and across lines, and a `done)` closing a `$( … )` opened earlier on the
// line does not close the tracked subshell around it.
Deno.test("checkAwsEmulatorInCI - a runner inside a multi-line substitution or backtick earns no credit", async () => {
  const R = RUNNER_STEP;
  const refused: Array<[string, string]> = [
    ["$(for … do", `PKGS=$(for d in a b; do\n  ${R}\ndone)\necho "$PKGS"`],
    ["$(if … then", `X=$(if true; then\n  ${R}\nfi)\necho "$X"`],
    ["$(case", `MODE=$(case "$X" in\n  a) ${R} ;;\nesac)\necho "$MODE"`],
    ["multi-line backticks", `X=\`\n${R}\necho done\n\`\necho "$X"`],
    [
      "backtick exit in the then branch",
      `if ! ${R}; then echo \`echo bad; exit 1; echo x\`; fi\necho after`,
    ],
    [
      "backtick assignment exit in the then branch",
      `if ! ${R}; then\n  X=\`echo bad; exit 1; echo x\`\nfi\necho after`,
    ],
    [
      "backtick exit across lines in the then branch",
      `if ! ${R}; then\n  X=\`\n  exit 1\n  \`\nfi\necho after`,
    ],
  ];
  for (const [label, body] of refused) {
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(step.wiring, "missing", `default-shell step: ${label}`);
    const strict = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    });
    assertEquals(strict.wiring, "missing", `set -euo pipefail: ${label}`);
    const afterSetPlusE = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`set +e\n${body}`)),
    });
    assertEquals(afterSetPlusE.wiring, "missing", `after set +e: ${label}`);
  }
  // Controls: the same constructs, balanced and not holding the runner, keep a
  // plain runner after them credited, as does a backtick in the then branch
  // that closes before the exit.
  const credited = [
    `PKGS=$(for d in a b; do\n  basename "$d"\ndone)\n${R}`,
    `X=$(if true; then\n  echo a\nfi)\n${R}`,
    `X=\`\ndate\n\`\n${R}`,
    `if ! ${R}; then echo \`date\`; exit 1; fi\necho after`,
    `( for d in a; do X=$(for e in b; do echo $e; done); ${R}; done )`,
    `( if true; then X=$(if true; then echo a; fi); ${R} || exit 1; fi )`,
  ];
  for (const body of credited) {
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(step.wiring, "official-server", `credited: ${body}`);
  }
  // A `done)` that closes a `$( … )` opened earlier on the line must not close
  // the tracked subshell: the loop is judged like the same loop without it.
  const swallowed = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(
        `( for d in a; do X=$(for e in b; do echo $e; done); ${R}; done ) || true`,
      ),
    ),
  });
  assertEquals(swallowed.wiring, "missing", "swallowed subshell with a $( )");
});

// PR #5332 review round 14: a compound inside a `$( … )` the walk tracks no
// frame for does not touch the frame stack, and its closer, attached or
// spaced, goes to the parenthesis balance.
Deno.test("checkAwsEmulatorInCI - a compound inside an untracked substitution leaves the runner's credit alone", async () => {
  const R = RUNNER_STEP;
  // Credited: the runner is the last command, so its status is the body's.
  const credited = [
    'PKGS=$( for d in services/*; do basename "$d"; done )',
    'PKGS=$(for d in services/*; do basename "$d"; done )',
    "OUT=$( { echo a; echo b; } )",
    'PKGS=$(for d in a b; do\n  basename "$d"\ndone )',
    "X=$(cd a; if [ -f x ]; then echo y; fi )",
    "X=$(cd a; for f in *; do echo $f; done)",
    "X=$(cd a; ls | while read l; do echo $l; done)",
    "X=$(cd a; if true; then echo y; fi)",
    'MODE=$(cd a; case "$X" in a) echo 1 ;; esac )',
    "X=$( ls )",
  ];
  for (const line of credited) {
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`${line}\n${R}`)),
    });
    assertEquals(step.wiring, "official-server", `default step: ${line}`);
    const afterSetPlusE = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(
        stepYaml(`set +e\n${line}\n${R}`),
      ),
    });
    assertEquals(afterSetPlusE.wiring, "official-server", `set +e: ${line}`);
    for (const header of ["", "set -euo pipefail\n"]) {
      const script = await checkRepoWith({
        ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
        "ci/t.sh": `#!/usr/bin/env bash\n${header}${line}\n${R}\n`,
      });
      assertEquals(
        script.wiring,
        "official-server",
        `script (${header.trim() || "no set -e"}): ${line}`,
      );
    }
  }
  // Refused: the line leaks no frame, so a swallowed or never-reached runner
  // is still judged as such.
  const subst = "X=$(cd a; for f in *; do echo $f; done)";
  const refused: Array<[string, string]> = [
    ["swallowed by || true", `{ ${subst}; ${R}; } || true`],
    [
      "| while form",
      `{ X=$(cd a; ls | while read l; do echo $l; done); ${R}; } || true`,
    ],
    [
      "; if form",
      `{ X=$(cd a; if true; then echo y; fi); ${R}; } || true`,
    ],
    ["| tee log", `{ ${subst}; ${R}; } | tee log`],
    ["group on several lines", `{\n  ${subst}\n  ${R}\n} || true`],
    ["never reached", `${subst}\nexit 0\n${R}`],
    [
      "never reached after | while",
      `X=$(cd a; ls | while read l; do echo $l; done)\nexit 0\n${R}`,
    ],
    [
      "never reached after &&",
      `${subst} && for f in a; do :; done\nexit 0\n${R}`,
    ],
  ];
  for (const [label, body] of refused) {
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(step.wiring, "missing", `default step: ${label}`);
    const strict = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    });
    assertEquals(strict.wiring, "missing", `set -euo pipefail: ${label}`);
  }
  // Controls: the same group without a compound in the substitution.
  for (
    const body of [
      `{ X=$(cd a; ls); ${R}; } || true`,
      `{ X=$(for f in *; do echo $f; done); ${R}; } || true`,
    ]
  ) {
    const step = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(step.wiring, "missing", `control: ${body}`);
  }
});

// PR #5332 review round 15: an `exit` inside a one-line substitution ends the
// substitution only, and a `for`, C-style `for` or multi-pattern `case` header
// inside an untracked `$( … )` keeps the substitution's parenthesis balance.
Deno.test("checkAwsEmulatorInCI - an exit or a compound header inside an untracked substitution does not end the body or hide a swallowed runner", async () => {
  const R = RUNNER_STEP;
  const contexts = async (body: string) => {
    const wirings: Record<string, string> = {};
    wirings["default step"] = (await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    })).wiring;
    wirings["after set +e"] = (await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(`set +e\n${body}`)),
    })).wiring;
    for (const header of ["", "set -euo pipefail\n"]) {
      wirings[`script (${header.trim() || "no set -e"})`] =
        (await checkRepoWith({
          ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
          "ci/t.sh": `#!/usr/bin/env bash\n${header}${body}\n`,
        })).wiring;
    }
    return wirings;
  };
  const credited = [
    'VERSION=$(cat VERSION || { echo "no version" >&2; exit 1; })',
    "X=$(echo a; exit 0)",
    "X=$(cat a || (echo bad >&2; exit 1))",
    "X=$(cd a; if [ -f x ]; then exit 1; fi )",
    "X=`echo a; exit 1`",
    "X=$(cd a; for f in $(ls | sort); do echo $f; done)",
    "X=$(cd a; for ((i=0; i<3; i++)); do echo $i; done)",
    'X=$(cd a; case "$x" in a) echo 1 ;; b) echo 2 ;; esac)',
    'X=$(cd a; case "$x" in a|b) echo 1 ;; *) echo 2 ;; esac )',
    'X=$(cd a; case "$x" in\n  a) echo 1 ;;\n  b) echo $(date | tr a b) ;;\nesac)',
    "X=$(cd a; for f in `ls | sort`; do echo $f; done)",
  ];
  for (const line of credited) {
    for (
      const [context, wiring] of Object.entries(await contexts(`${line}\n${R}`))
    ) {
      assertEquals(wiring, "official-server", `${context}: ${line}`);
    }
  }
  // The runner stays swallowed or unreached when such a line comes first.
  const refused = [
    `{ X=$(cd a; for f in $(ls | sort); do echo $f; done); ${R}; } || true`,
    `{ X=$(cd a; for ((i=0; i<3; i++)); do echo $i; done); ${R}; } || true`,
    `{ X=$(cd a; case "$x" in a) echo 1 ;; b) echo 2 ;; esac); ${R}; } || true`,
    `{ X=$(cd a; case "$x" in\n  a) echo 1 ;;\n  b) echo 2 ;;\nesac); ${R}; } | tee log`,
    `X=$(cd a; for f in $(ls | sort); do echo $f; done)\nexit 0\n${R}`,
    `X=$(echo a; exit 0)\nexit 0\n${R}`,
  ];
  for (const body of refused) {
    for (const context of ["default step", "script (set -euo pipefail)"]) {
      const wiring = (await contexts(body))[context];
      assertEquals(wiring, "missing", `${context}: ${body}`);
    }
  }
});

// PR #5332 review round 7: a one-line `$( … )` holding `|`, `;` or `&&`, with
// more words after it, opens no frame, so later commands are still judged.
Deno.test("checkAwsEmulatorInCI - a one-line substitution with a separator inside it does not hide a later runner", async () => {
  for (
    const line of [
      "if [ $(ls | wc -l) -gt 0 ]; then echo found; fi",
      '[[ "$X" =~ ^(a|b)$ ]] && echo matched',
      "cd $(git rev-parse --show-toplevel | head -1)/infra",
      "echo started $(date | tr a b) now",
      "export A=$(cat VERSION | tr -d x) B=2",
      "test $(git status --porcelain | wc -l) -eq 0",
      "echo $(cd infra; pwd) done",
      "echo $(cd infra && pwd) done",
    ]
  ) {
    const inWorkflow = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(
        stepYaml(`${line}\n${RUNNER_STEP}`),
      ),
    });
    assertEquals(inWorkflow.wiring, "official-server", `workflow: ${line}`);
    const inScript = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh":
        `#!/usr/bin/env bash\nset -euo pipefail\n${line}\n${RUNNER_STEP}\n`,
    });
    assertEquals(inScript.wiring, "official-server", `script: ${line}`);
  }
  // A one-line substitution with a separator inside a swallowed subshell does
  // not close the subshell early.
  const swallowed = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`( X=$(cat V | tr -d x); ${RUNNER_STEP}; echo done ) || true`),
    ),
  });
  assertEquals(swallowed.wiring, "missing", "swallowed subshell");
});

// PR #5332 review: the Floci job's test step is read on whole command words.
// An install-only step beside a valid gap record earns nothing, and the common
// runners the matcher is meant to accept are credited.
Deno.test("checkAwsEmulatorInCI - a gap record whose Floci job only installs a test tool is floci-only; common test runners are floci-gap", async () => {
  for (
    const command of [
      "pip install pytest",
      "npm install --save-dev jest",
      "npm install typescript@latest",
      "npm ci",
      "yarn add mocha",
      "echo test",
      "./scripts/attestation.sh",
      // Probes and install-named targets or scripts (PR #5332 review round 3).
      "pytest --version",
      "npx jest --version",
      "make install-test-deps",
      "./scripts/check-install.sh",
      "mvn -B package -DskipTests",
      "./gradlew build -x test",
      "mvn -P test compile",
      "mvn --version",
      "pytest -V",
    ]
  ) {
    const result = await checkRepoWith({
      ".github/workflows/ci.yml": GAP_RECORD +
        prWorkflow(stepYaml(command), FLOCI_SERVICE),
    });
    assertEquals(result.wiring, "floci-only", command);
  }
  for (
    const command of [
      "npm test",
      "npm run test:aws",
      "yarn test",
      "pnpm run integration",
      "pytest -k aws",
      "python -m pytest tests/aws",
      "cargo test --workspace",
      "go test ./...",
      "mvn verify",
      "./gradlew check",
      "make check",
      "make test-aws",
      "tox -e aws",
      "npx jest",
      "./scripts/run-tests.sh",
      "bash ci/integration.sh",
      // Goal lists, lifecycle phases, wrappers and options with values (PR
      // #5332 review round 3).
      "mvn -B clean verify",
      "mvn clean test",
      "mvn -B package --file pom.xml",
      "./gradlew build",
      "cargo +stable test --workspace",
      "deno task test",
      "poetry run pytest",
      "uv run pytest",
      "bundle exec rspec",
      "npm --prefix app test",
      "make -C infra test",
      // `-V` is not a probe for every tool (PR #5332 review round 4).
      "mvn -B -V verify",
      "mvn -V -B clean verify",
      "ctest -V",
    ]
  ) {
    const result = await checkRepoWith({
      ".github/workflows/ci.yml": GAP_RECORD +
        prWorkflow(stepYaml(command), FLOCI_SERVICE),
    });
    assertEquals(result.wiring, "floci-gap", command);
  }
});

// Issue #5348: a backslash-newline joins lines only as an odd run of backslashes
// outside single quotes, and a `#` comment ends at its physical newline, so a
// backslash at the end of a comment is comment text.
const SHELL_CONTINUATION_CASES: [string, string, string[][]][] = [
  [
    "an even run of backslashes is not a continuation",
    "a \\\\\nb",
    [["a", "\\\\"], ["b"]],
  ],
  ["an odd run continues the line", "a \\\nb", [["a", "b"]]],
  [
    "three backslashes continue after an escaped pair",
    "a \\\\\\\nb",
    [["a", "\\\\b"]],
  ],
  [
    "a comment ends at its physical newline",
    "a # c \\\nb",
    [["a"], ["b"]],
  ],
  ["a CRLF continuation joins with no blank", "a\\\r\nb", [["ab"]]],
  [
    "an escaped backslash at the end of a comment",
    "a #c\\\\\nb",
    [["a"], ["b"]],
  ],
  [
    "a double-quoted word spanning a continuation",
    'echo "x \\\ny"',
    [["echo", '"x y"']],
  ],
];

for (const [label, script, expected] of SHELL_CONTINUATION_CASES) {
  Deno.test(`shellSegments - ${label} (Issue #5348)`, () => {
    assertEquals(shellSegments(script), expected);
  });
}

Deno.test("workflowRunsAwsEmulator - a line hidden by an escaped backslash runs its command (Issue #5348)", () => {
  assertEquals(
    workflowRunsAwsEmulator(
      workflowRunBlock("true \\\\\nexit 0\naws-emulator-run -- ./test.sh"),
    ),
    false,
  );
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock("true\naws-emulator-run -- ./test.sh"),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - a line hidden in a # comment that ends in a backslash runs its command (Issue #5348)", () => {
  assertEquals(
    workflowRunsAwsEmulator(
      workflowRunBlock("true # note \\\nexit 0\naws-emulator-run -- ./test.sh"),
    ),
    false,
  );
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock("true # note\naws-emulator-run -- ./test.sh"),
    ),
  );
});

// ---------------------------------------------------------------------------
// Issue #5112: the runner COMMAND must be the repository's test
// ---------------------------------------------------------------------------

const CONTROL_RUN = "aws-emulator-run -- deno task test";

Deno.test("workflowRunsAwsEmulator - a probe, no-op or ignored-failure COMMAND is not credited; a test COMMAND is", () => {
  const refused = [
    "echo ok",
    "aws --version",
    "curl -f http://127.0.0.1:4566/health",
    "sleep 1",
    "sh -c 'exit 0'",
    "bash -c 'deno task test || true'",
    "pytest --version",
  ];
  for (const command of refused) {
    assert(
      workflowRunsAwsEmulator(workflowRunBlock(CONTROL_RUN)),
      `control for ${command}`,
    );
    assertEquals(
      workflowRunsAwsEmulator(
        workflowRunBlock(`aws-emulator-run -- ${command}`),
      ),
      false,
      command,
    );
    assertEquals(
      workflowRunsAwsEmulator(
        workflowRunBlock(`aws-emulator-run --timeout 900 -- ${command}`),
      ),
      false,
      `--timeout ${command}`,
    );
  }
  for (
    const command of [
      "deno task test",
      "pytest -k aws",
      "cargo test",
      "./scripts/run-tests.sh",
    ]
  ) {
    assert(
      workflowRunsAwsEmulator(
        workflowRunBlock(`aws-emulator-run -- ${command}`),
      ),
      command,
    );
  }
});

Deno.test("checkAwsEmulatorInCI - a probe-only runner is missing and the diagnostic names the command", async () => {
  const root = await makeTempRepo();
  try {
    await setupAwsRepo(root, "aws-emulator-run -- aws --version");
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "missing");
    assert(
      result.wiringDiagnostics.some((d) =>
        d.includes("not a recognised repository test command") &&
        d.includes("aws --version")
      ),
      result.wiringDiagnostics.join("\n"),
    );
    await setupAwsRepo(root, CONTROL_RUN);
    assertEquals(
      (await checkAwsEmulatorInCI(root)).wiring,
      "official-server",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - a repository script COMMAND is credited only when it runs a kept test", async () => {
  const cases: [string, string, string][] = [
    ["runs the test", "set -euo pipefail\ndeno task test\n", "official-server"],
    ["only echoes", "echo ok\n", "missing"],
    ["ignores the failure", "deno task test || true\n", "missing"],
  ];
  for (const [label, script, wiring] of cases) {
    const root = await makeTempRepo();
    try {
      await setupAwsRepo(root, "aws-emulator-run -- ./ci/run.sh");
      await writeFile(root, "ci/run.sh", script);
      const result = await checkAwsEmulatorInCI(root);
      assertEquals(result.wiring, wiring, label);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("checkAwsEmulatorInCI - a self re-exec is credited only inside a test-named step script", async () => {
  const script = (assign: string, ref: string) =>
    `#!/usr/bin/env bash\nset -euo pipefail\n${assign}\nexec aws-emulator-run -- ${ref}\n`;
  const cases: [string, string, string, string, string][] = [
    [
      "BASH_SOURCE variable",
      "./ci/aws-test.sh",
      "ci/aws-test.sh",
      script('SELF="${BASH_SOURCE[0]}"', '"$SELF"'),
      "official-server",
    ],
    [
      "same script from a non-test step",
      "./ci/run.sh",
      "ci/run.sh",
      script('SELF="${BASH_SOURCE[0]}"', '"$SELF"'),
      "missing",
    ],
    [
      "variable not assigned from the script",
      "./ci/aws-test.sh",
      "ci/aws-test.sh",
      script("OTHER=/usr/bin/env", '"$OTHER"'),
      "missing",
    ],
    [
      "$0 form",
      "./ci/aws-test.sh",
      "ci/aws-test.sh",
      "set -e",
      "official-server",
    ],
    [
      "echo $0 evasion",
      "./ci/aws-test.sh",
      "ci/aws-test.sh",
      script('V="echo $0"', "$V"),
      "missing",
    ],
    [
      "true $0 evasion",
      "./ci/aws-test.sh",
      "ci/aws-test.sh",
      script('V="true $0"', "$V"),
      "missing",
    ],
    [
      "reassigned variable evasion",
      "./ci/aws-test.sh",
      "ci/aws-test.sh",
      script('SELF="$0"\nSELF=/bin/echo', '"$SELF"'),
      "missing",
    ],
    [
      "control: reassigned back to the script",
      "./ci/aws-test.sh",
      "ci/aws-test.sh",
      script('SELF=/bin/echo\nSELF="$0"', '"$SELF"'),
      "official-server",
    ],
    [
      "control: quoted $0 value",
      "./ci/aws-test.sh",
      "ci/aws-test.sh",
      script('V="$0"', "$V"),
      "official-server",
    ],
  ];
  for (const [label, step, file, text, wiring] of cases) {
    const root = await makeTempRepo();
    try {
      await setupAwsRepo(root, step);
      await writeFile(
        root,
        file,
        label === "$0 form" ? script("", '"$0"') : text,
      );
      const result = await checkAwsEmulatorInCI(root);
      assertEquals(result.wiring, wiring, label);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("workflowRunsAwsEmulator - hostile long self-reference scripts finish and are refused", () => {
  const doc = parseYaml(
    "on: pull_request\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: ./ci/aws-test.sh\n",
  );
  const read = (text: string) => (path: string) =>
    path === "./ci/aws-test.sh" ? text : null;
  const run = 'exec aws-emulator-run -- "$SELF"\n';
  for (
    const text of [
      `${" ".repeat(50_000)}!SELF="$0"\n${run}`,
      `export${" ".repeat(50_000)}!SELF="$0"\n${run}`,
      `SELF=${"$".repeat(50_000)}\n${run}`,
      `${"\n".repeat(50_000)}SELF=x\n${run}`,
    ]
  ) {
    assertEquals(workflowRunsAwsEmulator(doc, read(text)), false);
  }
  // Positive control through the same reader.
  assert(
    workflowRunsAwsEmulator(doc, read(`SELF="$0"\n${run}`)),
  );
  const hostileWord = `"${"$".repeat(50_000)}"`;
  assertEquals(
    workflowRunsAwsEmulator(
      doc,
      read(`SELF="$0"\nexec aws-emulator-run -- ${hostileWord}\n`),
    ),
    false,
  );
});

Deno.test("workflowRunsAwsEmulator - a variable that only mentions the script path is not a self re-exec", () => {
  const doc = parseYaml(
    "on: pull_request\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: ./ci/aws-test.sh\n",
  );
  const read = (text: string) => (path: string) =>
    path === "./ci/aws-test.sh" ? text : null;
  const run = 'exec aws-emulator-run -- "$V"\n';
  for (
    const value of [
      '"${SCRIPT_DIR}/${BASH_SOURCE[0]##*/}"',
      '"$(realpath "${BASH_SOURCE[0]}")"',
      '"${DIR}/${0##*/}"',
      '$(readlink -f "$0")',
      "$BASH_SOURCE   ",
    ]
  ) {
    assert(workflowRunsAwsEmulator(doc, read(`V=${value}\n${run}`)), value);
  }
  for (
    const value of [
      '"$(dirname "${BASH_SOURCE[0]}")/probe.sh"',
      '"$0.probe"',
      "$BASH_SOURCE/x",
      '"${0##*/}"',
      '"$A/$B/${0##*/}"',
      '"$(realpath "$0" x)"',
      "'$0'",
      '"echo $0"',
    ]
  ) {
    assertEquals(
      workflowRunsAwsEmulator(doc, read(`V=${value}\n${run}`)),
      false,
      value,
    );
  }
  // Hostile long values finish and are refused.
  for (
    const value of [
      `${"$".repeat(50_000)}x`,
      `$BASH_SOURCE${'"'.repeat(50_000)}x`,
      `${"${0".repeat(20_000)}x`,
      `${" ".repeat(50_000)}x`,
      `"$${"A".repeat(50_000)}/x"`,
      `"$(realpath ${" ".repeat(50_000)}x)"`,
      `"$(realpath ${"(".repeat(50_000)}"`,
      `"$A/${"${0##*/".repeat(10_000)}x`,
    ]
  ) {
    assertEquals(
      workflowRunsAwsEmulator(doc, read(`V=${value}\n${run}`)),
      false,
    );
  }
});

Deno.test("checkAwsEmulatorInCI - a runner COMMAND script is read one level only (step, script, runner, script is not followed)", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "ci/run.sh", "set -e\ndeno task test\n");
    // Direct in the step: credited.
    await setupAwsRepo(root, "aws-emulator-run -- ./ci/run.sh");
    assertEquals(
      (await checkAwsEmulatorInCI(root)).wiring,
      "official-server",
    );
    // Through a step script: the inner runner's script is not read.
    await setupAwsRepo(root, "./ci/aws-test.sh");
    await writeFile(
      root,
      "ci/aws-test.sh",
      "#!/usr/bin/env bash\nexec aws-emulator-run -- ./ci/run.sh\n",
    );
    assertEquals((await checkAwsEmulatorInCI(root)).wiring, "missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - a test-named runner COMMAND script must exist in the checkout", async () => {
  const root = await makeTempRepo();
  try {
    await setupAwsRepo(root, "aws-emulator-run -- ./scripts/run-tests.sh");
    assertEquals((await checkAwsEmulatorInCI(root)).wiring, "missing");
    await writeFile(root, "scripts/run-tests.sh", "echo ok\n");
    assertEquals(
      (await checkAwsEmulatorInCI(root)).wiring,
      "official-server",
    );
    // An absolute tool path is not a repository script: it keeps rule a's credit.
    await setupAwsRepo(
      root,
      "aws-emulator-run -- /usr/local/bin/pytest -k aws",
    );
    assertEquals(
      (await checkAwsEmulatorInCI(root)).wiring,
      "official-server",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - the in-script diagnostic names the script path and the COMMAND", async () => {
  const root = await makeTempRepo();
  try {
    await setupAwsRepo(root, "./ci/aws-test.sh");
    await writeFile(
      root,
      "ci/aws-test.sh",
      "#!/usr/bin/env bash\nexec aws-emulator-run -- aws --version\n",
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "missing");
    assert(
      result.wiringDiagnostics.some((d) =>
        d.includes(
          "through aws-emulator-run in `./ci/aws-test.sh`, which is not a recognised repository test command",
        ) && d.includes("aws --version")
      ),
      result.wiringDiagnostics.join("\n"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - an exec inside X=$(...) does not exec the runner (Issue #5378)", async () => {
  // No set -e: only `exec` makes the runner's status the script's status.
  const inScript = async (body: string) =>
    (await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\n`,
    })).wiring;
  assertEquals(
    await inScript(`exec ${RUNNER_STEP}\necho more`),
    "official-server",
    "exec runner",
  );
  assertEquals(
    await inScript(`${RUNNER_STEP}\necho more`),
    "missing",
    "runner, then more",
  );
  assertEquals(
    await inScript(`X=$(echo exec v) ${RUNNER_STEP}\necho more`),
    "missing",
    "exec inside the substitution",
  );
});

// Issue #5378 (pre-PR verifier): every caller of commandIndex /
// keptCommands reads the command after an `X=$(cat v)` assignment, each
// paired with an `echo` control that leaves the real command an argument.
Deno.test("checkAwsEmulatorInCI - each commandIndex caller reads the command after X=$(cat v); an echo control does not (Issue #5378)", async () => {
  const wiring = async (files: Record<string, string>) =>
    (await checkRepoWith(files)).wiring;
  const step = (body: string) => ({
    ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
  });
  const cases: Array<[string, Record<string, string>, string]> = [
    // segmentScriptPath: the step's script path follows the assignment.
    ["step script path", {
      ...step("X=$(cat v) ./ci/t.sh"),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${RUNNER_STEP}\n`,
    }, "official-server"],
    ["step script path, echo control", {
      ...step("X=$(cat v) echo ./ci/t.sh"),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${RUNNER_STEP}\n`,
    }, "missing"],
    // keptCommands on the runner COMMAND script.
    ["runner COMMAND script", {
      ...step("aws-emulator-run -- ./ci/run.sh"),
      "ci/run.sh": "#!/usr/bin/env bash\nX=$(cat v) npm test\n",
    }, "official-server"],
    ["runner COMMAND script, echo control", {
      ...step("aws-emulator-run -- ./ci/run.sh"),
      "ci/run.sh": "#!/usr/bin/env bash\nX=$(cat v) echo npm test\n",
    }, "missing"],
    // looksLikeTestCommand on the runner COMMAND itself.
    ["runner COMMAND after env X=$(cat v)", {
      ...step("aws-emulator-run -- env X=$(cat v) npm test"),
    }, "official-server"],
    ["runner COMMAND after env X=$(cat v), echo control", {
      ...step("aws-emulator-run -- env X=$(cat v) echo npm test"),
    }, "missing"],
    // commandIsSelfReference: the self re-exec behind env X=$(cat v).
    ["self re-exec", {
      ...step("./ci/aws-test.sh"),
      "ci/aws-test.sh":
        '#!/usr/bin/env bash\nset -euo pipefail\nexec aws-emulator-run -- env X=$(cat v) "$0"\n',
    }, "official-server"],
    ["self re-exec, echo control", {
      ...step("./ci/aws-test.sh"),
      "ci/aws-test.sh":
        '#!/usr/bin/env bash\nset -euo pipefail\nexec aws-emulator-run -- env X=$(cat v) echo "$0"\n',
    }, "missing"],
    // handlerExitsZero: the trap handler's exit follows the assignment.
    [
      "trap handler exit 0",
      step(`trap 'X=$(cat v) exit 0' EXIT\n${RUNNER_STEP}`),
      "missing",
    ],
    [
      "trap handler, echo control",
      step(`trap 'X=$(cat v) echo exit 0' EXIT\n${RUNNER_STEP}`),
      "official-server",
    ],
    // The errexit and trap scan: `set +e` and `trap` behind the assignment.
    ["set +e", step(`X=$(cat v) set +e\n${RUNNER_STEP}\necho done`), "missing"],
    [
      "set +e, echo control",
      step(`X=$(cat v) echo set +e\n${RUNNER_STEP}\necho done`),
      "official-server",
    ],
    [
      "trap exit 0",
      step(`X=$(cat v) trap 'exit 0' EXIT\n${RUNNER_STEP}`),
      "missing",
    ],
    [
      "trap exit 0, echo control",
      step(`X=$(cat v) echo trap 'exit 0' EXIT\n${RUNNER_STEP}`),
      "official-server",
    ],
    // The body's exit before the runner.
    [
      "exit 0 before the runner",
      step(`X=$(cat v) exit 0\n${RUNNER_STEP}`),
      "missing",
    ],
    [
      "exit 0, echo control",
      step(`X=$(cat v) echo exit 0\n${RUNNER_STEP}`),
      "official-server",
    ],
    // keptCommands on a Floci job's test step.
    ["Floci test step", {
      ".github/workflows/ci.yml": GAP_RECORD +
        prWorkflow(stepYaml("X=$(cat v) npm test"), FLOCI_SERVICE),
    }, "floci-gap"],
    ["Floci test step, echo control", {
      ".github/workflows/ci.yml": GAP_RECORD +
        prWorkflow(stepYaml("X=$(cat v) echo npm test"), FLOCI_SERVICE),
    }, "floci-only"],
  ];
  for (const [label, files, expected] of cases) {
    assertEquals(await wiring(files), expected, label);
  }
});

// Issue #5382: a `case` arm's pattern is not the command word.
Deno.test("reachableCommands - strips a case arm's pattern (Issue #5382)", () => {
  const cases: [string, string, string[][]][] = [
    [
      "one-line arm",
      "case $1 in\n  test) aws-emulator-run -- ./t.sh ;;\nesac",
      [["aws-emulator-run", "--", "./t.sh"]],
    ],
    ["three alternatives", "case $1 in\n  a|b|c) cmd ;;\nesac", [["cmd"]]],
    [
      "spaced close paren",
      "case $1 in\n  test ) cmd ;;\nesac",
      [["cmd"]],
    ],
    [
      "second arm",
      "case $1 in\n  a) x ;;\n  b) y ;;\nesac",
      [["x"], ["y"]],
    ],
    ["header on the same line", "case $1 in a) cmd ;; esac", [["cmd"]]],
    [
      "pattern alone on its line",
      "case $1 in\n  test)\n    cmd\n    ;;\nesac",
      [["cmd"]],
    ],
    [
      "control: multi-line body",
      "case $1 in\n  a)\n    echo x\n    cmd\n    ;;\nesac",
      [["echo", "x"], ["cmd"]],
    ],
    [
      "control: nested case",
      "case $1 in\n  a) case $2 in\n    b) cmd ;;\n  esac ;;\nesac",
      [["cmd"]],
    ],
  ];
  for (const [label, script, expected] of cases) {
    const found = reachableCommands(script);
    assertEquals(found.map((c) => c.words), expected, label);
  }
  const runner = reachableCommands(
    "case $1 in\n  test) aws-emulator-run -- ./t.sh ;;\nesac",
  )[0];
  assertEquals(commandIndex(runner?.words ?? []), 0);

  const alternatives = reachableCommands("case $1 in\n  a|b) cmd ;;\nesac");
  assertEquals(alternatives.map((c) => c.words), [["cmd"]]);
  assertEquals(alternatives[0]?.sep, ";;");

  const paren = reachableCommands("case $1 in\n  (test) cmd ;;\nesac");
  assertEquals(paren.map((c) => c.words), [["cmd"]]);
  assertEquals(paren[0]?.subshells, []);
});

Deno.test("checkAwsEmulatorInCI - a one-line case arm runs the runner in a step and a script (Issue #5382)", async () => {
  const bodies = [
    `case "$1" in\n  test) ${RUNNER_STEP} ;;\nesac`,
    `case "$1" in\n  a|test) ${RUNNER_STEP} ;;\nesac`,
    `case "$1" in\n  (test) ${RUNNER_STEP} ;;\nesac`,
    `case "$1" in test) ${RUNNER_STEP} ;; esac`,
  ];
  for (const body of bodies) {
    const inWorkflow = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml(body)),
    });
    assertEquals(inWorkflow.wiring, "official-server", `workflow: ${body}`);
    const inScript = await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    });
    assertEquals(inScript.wiring, "official-server", `script: ${body}`);
  }
  const control = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(
      stepYaml(`case "$1" in\n  test) echo ${RUNNER_STEP} ;;\nesac`),
    ),
  });
  assertEquals(control.wiring, "missing", "control");
});

Deno.test("checkAwsEmulatorInCI - failure-exit idioms inside a one-line case arm (Issue #5382)", async () => {
  const inScript = async (body: string) =>
    (await checkRepoWith({
      ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
      "ci/t.sh": `#!/usr/bin/env bash\n${body}\necho done\n`,
    })).wiring;
  assertEquals(
    await inScript(
      `case "$1" in\n  test) if ! ${RUNNER_STEP}; then exit 1; fi ;;\nesac`,
    ),
    "official-server",
    "if !",
  );
  assertEquals(
    await inScript(`case "$1" in\n  test) ${RUNNER_STEP} || exit 1 ;;\nesac`),
    "official-server",
    "|| exit",
  );
  assertEquals(
    await inScript(`case "$1" in\n  test) ! ${RUNNER_STEP} || exit 1 ;;\nesac`),
    "missing",
    "! cmd || exit",
  );
});
