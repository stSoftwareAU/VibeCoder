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
import { reachableCommands } from "../lib/shell_command_words.ts";

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
      - run: exec aws-emulator-run --timeout 900 -- ./t.sh
`,
  );
  assert(workflowRunsAwsEmulator(doc));
});

Deno.test("workflowRunsAwsEmulator - step runs aws-emulator-run wrapper", () => {
  const doc = parseYaml(
    `on: pull_request
jobs:
  test:
    steps:
      - run: aws-emulator-run -- ./t.sh
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
      - run: /usr/local/bin/aws-emulator-run -- ./t.sh
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
      workflowRunBlock(`if [ -n "$X" ]; then aws-emulator-run -- ./t.sh; fi`),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - timeout with a duration before aws-emulator-run counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock("timeout 600 aws-emulator-run -- ./t.sh"),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - timeout with a -k option before aws-emulator-run counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock("timeout -k 5 600 aws-emulator-run -- ./t.sh"),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - quoted aws-emulator-run command word counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock(`"aws-emulator-run" -- ./t.sh`),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - time before aws-emulator-run counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock("time aws-emulator-run -- ./t.sh"),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - command aws-emulator-run counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock("command aws-emulator-run -- ./t.sh"),
    ),
  );
});

Deno.test("workflowRunsAwsEmulator - aws-emulator-run on the line after an if line counts", () => {
  assert(
    workflowRunsAwsEmulator(
      workflowRunBlock(
        `if [ -n "$X" ]; then\n  aws-emulator-run -- ./t.sh\nfi`,
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
      workflowRunBlock("# if true; then aws-emulator-run -- ./t.sh; fi"),
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
    await setupAwsRepo(root, "bash ../outside/run.sh");
    await writeFile(parent, "outside/run.sh", RUNNER_SCRIPT);
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.wiring, "missing");
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - absolute and expanded script paths do not count", async () => {
  const outside = await makeTempRepo();
  try {
    await writeFile(outside, "run.sh", RUNNER_SCRIPT);
    for (
      const run of [
        `bash ${outside}/run.sh`,
        "bash ${{ github.workspace }}/x.sh",
        'bash "$DIR/run.sh"',
      ]
    ) {
      const root = await makeTempRepo();
      try {
        await setupAwsRepo(root, JSON.stringify(run));
        await writeFile(root, "x.sh", RUNNER_SCRIPT);
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
    await setupAwsRepo(root, "bash ci/run.sh");
    await writeFile(outside, "run.sh", RUNNER_SCRIPT);
    await Deno.mkdir(`${root}/ci`);
    await Deno.symlink(`${outside}/run.sh`, `${root}/ci/run.sh`);
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "missing");
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
    await setupAwsRepo(root, "./big.sh");
    await writeFile(
      root,
      "big.sh",
      "#" + "x".repeat(1024 * 1024) + "\n" + RUNNER_SCRIPT,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.wiring, "missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - timeout 900 ./ci/t.sh resolves the script and counts", async () => {
  const root = await makeTempRepo();
  try {
    await setupAwsRepo(root, "timeout 900 ./ci/t.sh");
    await writeFile(root, "ci/t.sh", RUNNER_SCRIPT);
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
        "#!/usr/bin/env bash\naws-emulator-run -- ./t.sh\n",
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

const RUNNER = "aws-emulator-run -- ./t.sh";

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
      "exit 0\n          aws-emulator-run -- ./t.sh",
      "if false; then aws-emulator-run -- ./t.sh; fi",
      "true && exit 0\n          aws-emulator-run -- ./t.sh",
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
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request\njobs:\n  test:\n    steps:\n      - if: false\n        run: aws-emulator-run -- ./t.sh\n`,
    );
    assertEquals((await checkAwsEmulatorInCI(root)).wiring, "missing");
    // Positive control: the same step without the `if: false`.
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `on: pull_request\njobs:\n  test:\n    steps:\n      - run: aws-emulator-run -- ./t.sh\n`,
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

const RUNNER_STEP = "aws-emulator-run -- ./t.sh";
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
    "`ci.yml` job `test`: `aws-emulator-run -- ./t.sh`",
  ]);
  assertEquals(result.wiringDiagnostics, []);
});

Deno.test("checkAwsEmulatorInCI - a repository script that runs the emulator is official-server, with the script call as evidence", async () => {
  const result = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh": "#!/usr/bin/env bash\naws-emulator-run -- ./t.sh\n",
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
    "`reusable.yml` job `test`: `aws-emulator-run -- ./t.sh`",
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
      "# aws-emulator-run -- ./t.sh",
      "echo aws-emulator-run -- ./t.sh",
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
  const body = `aws-emulator-run -- ./t.sh\necho done\n`;
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
      "#!/usr/bin/env bash\nexec aws-emulator-run -- ./t.sh\necho never-reached\n",
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
      "#!/usr/bin/env bash\naws-emulator-run -- ./t.sh || exit 1\necho done\n",
  });
  assertEquals(credited.wiring, "official-server");
  const refused = await checkRepoWith({
    ".github/workflows/ci.yml": prWorkflow(stepYaml("./ci/t.sh")),
    "ci/t.sh":
      "#!/usr/bin/env bash\naws-emulator-run -- ./t.sh || exit 0\necho done\n",
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
    ]
  ) {
    const result = await checkRepoWith({
      ".github/workflows/ci.yml": GAP_RECORD +
        prWorkflow(stepYaml(command), FLOCI_SERVICE),
    });
    assertEquals(result.wiring, "floci-gap", command);
  }
});
