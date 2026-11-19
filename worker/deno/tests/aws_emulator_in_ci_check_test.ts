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
  cargoTomlUsesAws,
  checkAwsEmulatorInCI,
  isCfnTemplate,
  isFlociImage,
  makeRepoScriptReader,
  packageJsonUsesAws,
  pomXmlUsesAws,
  requirementsUsesAws,
  workflowRunsAwsEmulator,
  workflowRunsFloci,
} from "../lib/aws_emulator_in_ci_check.ts";
import { parse as parseYaml } from "@std/yaml/parse";

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
      `jobs:
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
    assertEquals(result.emulatorConfigured, true);
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
      `jobs:
  test:
    services:
      floci:
        image: floci/floci@sha256:${digest}
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, true);
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
      `jobs:
  test:
    container: floci/floci:latest
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, true);
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
      `jobs:
  test:
    container:
      image: floci/floci:latest
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, true);
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
      `jobs:
  test:
    steps:
      - uses: docker://floci/floci:1.0
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, true);
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
      `jobs:
  test:
    steps:
      - run: docker run -d -p 4566:4566 floci/floci:latest
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, true);
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
jobs:
  test:
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, false);
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
      `jobs:
  test:
    steps:
      - run: echo floci/floci
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, false);
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
      `jobs:
  test:
    container:
      image: floci/floci-proxy
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, false);
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
    assertEquals(result.emulatorConfigured, false);
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
      `jobs:
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
    `jobs:
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
    `jobs:
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
    `jobs:
  test:
    steps:
      - run: exec aws-emulator-run --timeout 900 -- ./t.sh
`,
  );
  assert(workflowRunsAwsEmulator(doc));
});

Deno.test("workflowRunsAwsEmulator - step runs aws-emulator-run wrapper", () => {
  const doc = parseYaml(
    `jobs:
  test:
    steps:
      - run: aws-emulator-run -- ./t.sh
`,
  );
  assert(workflowRunsAwsEmulator(doc));
});

Deno.test("workflowRunsAwsEmulator - path ending in aws-emulator-run in command position counts", () => {
  const doc = parseYaml(
    `jobs:
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
  assert(
    workflowRunsAwsEmulator(parseYaml(text), makeRepoScriptReader(repoRoot)),
  );
  // Without the script the install steps alone are not coverage.
  assertEquals(workflowRunsAwsEmulator(parseYaml(text)), false);
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
    `jobs:
  test:
    steps:
      - run: echo aws-emulator-run
`,
  );
  assertEquals(workflowRunsAwsEmulator(doc), false);
});

Deno.test("workflowRunsAwsEmulator - comment line naming aws-emulator-run does not count", () => {
  const doc = parseYaml(
    `jobs:
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
    `jobs:
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
    `jobs:\n  test:\n    steps:\n      - run: |\n${indented}\n`,
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
    assertEquals(withWorkflow.emulatorConfigured, true);

    await Deno.remove(`${root}/${workflowPath}`);
    const withoutWorkflow = await checkAwsEmulatorInCI(root);
    assertEquals(withoutWorkflow.usesAws, true);
    assertEquals(withoutWorkflow.emulatorConfigured, false);
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
  return `jobs:
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
      `jobs:
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
    assertEquals(result.emulatorConfigured, false);
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
    assertEquals(result.emulatorConfigured, true);
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
    assertEquals(result.emulatorConfigured, true);
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
    assertEquals(result.emulatorConfigured, false);
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
    assertEquals(result.emulatorConfigured, false);
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
        assertEquals(result.emulatorConfigured, false, run);
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
    assertEquals(result.emulatorConfigured, false);
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
    assertEquals(result.emulatorConfigured, false);
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
    assertEquals(result.emulatorConfigured, false);
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
    assertEquals(result.emulatorConfigured, true);
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
      assertEquals(result.emulatorConfigured, true);
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
  return { jobs: { test: { ...job, steps: [{ run, ...step }] } } };
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
    { if: "github.event_name == 'push'" },
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
      `cat <<EOF\n${RUNNER}\nEOF\n`,
    ]
  ) {
    assertEquals(workflowRunsAwsEmulator(doc, read(text)), false, text);
  }
  assertEquals(workflowRunsAwsEmulator(doc, read(`${RUNNER}\n`)), true);
  assertEquals(
    workflowRunsAwsEmulator(
      doc,
      read(`[ -z "$X" ] && exit 0\n${RUNNER}\n`),
    ),
    true,
  );
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
    ]
  ) {
    const root = await makeTempRepo();
    try {
      await writeFile(root, "infra/cloudformation/host.yaml", CFN_TEMPLATE);
      await writeFile(
        root,
        ".github/workflows/ci.yml",
        `jobs:\n  test:\n    steps:\n      - run: |\n          ${run}\n`,
      );
      const result = await checkAwsEmulatorInCI(root);
      assertEquals(result.usesAws, true);
      assertEquals(result.emulatorConfigured, false, run);
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
      `jobs:\n  test:\n    steps:\n      - if: false\n        run: aws-emulator-run -- ./t.sh\n`,
    );
    assertEquals((await checkAwsEmulatorInCI(root)).emulatorConfigured, false);
    // Positive control: the same step without the `if: false`.
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `jobs:\n  test:\n    steps:\n      - run: aws-emulator-run -- ./t.sh\n`,
    );
    assertEquals((await checkAwsEmulatorInCI(root)).emulatorConfigured, true);
  } finally {
    await Deno.remove(root, { recursive: true });
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
