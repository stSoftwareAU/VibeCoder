/**
 * Tests for the CI workflow trigger classifier (Issue #2585).
 *
 * `classifyWorkflow()` is a pure function over parsed workflow YAML. It
 * decides whether a workflow is test/lint/scan, deploy/publish/release,
 * or genuinely ambiguous, with a confidence level and the evidence used.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { classifyWorkflow } from "../lib/workflow_classifier.ts";

function parse(yaml: string): unknown {
  return parseYaml(yaml);
}

Deno.test("classifyWorkflow - npm publish workflow is deploy (high)", () => {
  const yaml = `
name: Publish
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm publish --access public
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "deploy");
  assertEquals(result.confidence, "high");
  assert(
    result.evidence.some((e) => e.includes("npm publish")),
    `evidence should name the signature: ${JSON.stringify(result.evidence)}`,
  );
});

Deno.test("classifyWorkflow - gh release workflow is deploy (high)", () => {
  const yaml = `
name: GitHub Release
on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: softprops/action-gh-release@v2
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "deploy");
  assertEquals(result.confidence, "high");
  assert(
    result.evidence.some((e) => e.includes("softprops/action-gh-release")),
  );
});

Deno.test("classifyWorkflow - deploy-pages workflow is deploy", () => {
  const yaml = `
name: Pages
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/deploy-pages@v4
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "deploy");
});

Deno.test("classifyWorkflow - aws-actions workflow is deploy", () => {
  const yaml = `
name: Deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
      - run: aws s3 sync ./dist s3://bucket
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "deploy");
});

Deno.test("classifyWorkflow - docker push workflow is deploy", () => {
  const yaml = `
name: Docker
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: docker push ghcr.io/org/app:latest
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "deploy");
});

Deno.test("classifyWorkflow - actionlint workflow is test", () => {
  const yaml = `
name: Actionlint
on:
  pull_request:
  push:
    branches: [main]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: actionlint
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "test");
  assertEquals(result.confidence, "high");
  assert(result.evidence.some((e) => e.includes("actionlint")));
});

Deno.test("classifyWorkflow - markdown-lint workflow is test", () => {
  const yaml = `
name: Markdown Lint
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx markdownlint-cli2 "**/*.md"
      - run: eslint .
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "test");
});

Deno.test("classifyWorkflow - deno test/lint/check workflow is test", () => {
  const yaml = `
name: Quality
on: [push, pull_request]
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - run: deno lint
      - run: deno check **/*.ts
      - run: deno test
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "test");
});

Deno.test("classifyWorkflow - cargo clippy/test workflow is test", () => {
  const yaml = `
name: Rust CI
on: pull_request
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: cargo fmt --check
      - run: cargo clippy -- -D warnings
      - run: cargo test
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "test");
});

Deno.test("classifyWorkflow - mixed test and deploy is ambiguous", () => {
  const yaml = `
name: CI and Release
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: deno test
  release:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "ambiguous");
  assertEquals(result.confidence, "medium");
  // Evidence should cite both the test and deploy signatures it matched.
  assert(result.evidence.some((e) => e.includes("npm publish")));
  assert(result.evidence.some((e) => e.includes("deno test")));
});

Deno.test("classifyWorkflow - no recognised signatures is ambiguous (low)", () => {
  const yaml = `
name: Mystery
on: push
jobs:
  do:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/do-something.sh
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "ambiguous");
  assertEquals(result.confidence, "low");
  assertEquals(result.evidence.length, 0);
});

Deno.test("classifyWorkflow - non-record input is ambiguous (low)", () => {
  assertEquals(classifyWorkflow(null).category, "ambiguous");
  assertEquals(classifyWorkflow(null).confidence, "low");
  assertEquals(classifyWorkflow("just a string").category, "ambiguous");
  assertEquals(classifyWorkflow(42).category, "ambiguous");
  assertEquals(classifyWorkflow([1, 2, 3]).category, "ambiguous");
});

Deno.test("classifyWorkflow - empty jobs is ambiguous (low)", () => {
  const yaml = `
name: Empty
on: push
jobs: {}
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "ambiguous");
  assertEquals(result.confidence, "low");
});

Deno.test("classifyWorkflow - evidence is deduplicated", () => {
  const yaml = `
name: Repeated
on: pull_request
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: deno test
  b:
    runs-on: ubuntu-latest
    steps:
      - run: deno test
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "test");
  const denoTestEvidence = result.evidence.filter((e) =>
    e.includes("deno test")
  );
  assertEquals(
    denoTestEvidence.length,
    1,
    "duplicate evidence should collapse",
  );
});

Deno.test("classifyWorkflow - cargo publish is deploy not test", () => {
  // `cargo publish` is a publisher signature even though `cargo` also
  // appears in test signatures — deploy signatures take precedence.
  const yaml = `
name: Crate Publish
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: cargo publish
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "deploy");
});

Deno.test("classifyWorkflow - gitleaks/semgrep scan workflow is test", () => {
  const yaml = `
name: Security Scan
on: [push, pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: gitleaks/gitleaks-action@v2
      - run: semgrep ci
`;
  const result = classifyWorkflow(parse(yaml));
  assertEquals(result.category, "test");
});
