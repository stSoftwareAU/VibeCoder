/**
 * Quality gate check: the Floci CloudFormation CI workflow (Issue #3369).
 *
 * `.github/workflows/floci.yml` runs VibeCoder's own CloudFormation templates
 * against a Floci service container. Its safety rests on a few statically
 * decidable properties, which these pure helpers verify so a regression fails
 * the unit test `worker/deno/tests/issue_3369_floci_workflow_test.ts`, which
 * runs in the quality gate, enforces them:
 *
 * - the service image is `floci/floci:<tag>@sha256:<digest>` (a tag beside the
 *   digest) and both the tag and the digest equal the Floci entry in
 *   `container/tools.json` (no drift between the worker image and CI, and no
 *   stale tag left in front of a new digest);
 * - the Docker socket is mounted and the first step tests for it with `-S`,
 *   emits `::error::` and exits 1 (shell comments are ignored);
 * - a step invokes `infra/cloudformation/test-floci.sh` in command position
 *   (an `echo` or a comment does not count);
 * - both `pull_request` and `push` triggers watch the templates and the
 *   workflow itself;
 * - `pull_request` also targets `milestone/*` branches (Issue #3360);
 * - the Floci service allows stubbed unsupported resource types;
 * - top-level `permissions.contents` is `read`;
 * - `actions/checkout` sets `persist-credentials: false`.
 *
 * No I/O: callers parse the YAML/JSON and pass the parsed values in.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** Image name of the Floci entry in `container/tools.json`. */
export const FLOCI_IMAGE_NAME = "docker.io/floci/floci";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const IMAGE_RE = /^floci\/floci:([^@/\s]+)@(sha256:[0-9a-f]{64})$/;
const TAG_RE = /^[^@/\s]+$/;
const DOCKER_SOCK = "/var/run/docker.sock";
const DOCKER_SOCK_VOLUME = `${DOCKER_SOCK}:${DOCKER_SOCK}`;
const SCRIPT_PATH = "infra/cloudformation/test-floci.sh";
const SOCKET_TEST_RE = /-S\s+"?\/var\/run\/docker\.sock"?/;
const STUB_ENV =
  "FLOCI_SERVICES_CLOUDFORMATION_ALLOW_STUB_UNSUPPORTED_RESOURCE_TYPES";
const REQUIRED_PATHS = [
  "infra/cloudformation/**",
  ".github/workflows/floci.yml",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return the Floci entry of a parsed `container/tools.json`. */
function flociEntry(toolsJson: unknown): Record<string, unknown> {
  if (!isObject(toolsJson) || !Array.isArray(toolsJson.images)) {
    throw new Error("tools.json has no images[] array");
  }
  const entry = toolsJson.images.find(
    (i: unknown) => isObject(i) && i.name === FLOCI_IMAGE_NAME,
  );
  if (!isObject(entry)) {
    throw new Error(`tools.json images[] has no ${FLOCI_IMAGE_NAME} entry`);
  }
  return entry;
}

/** Return the digest of the Floci image in a parsed `container/tools.json`. */
export function flociImageDigest(toolsJson: unknown): string {
  const digest = flociEntry(toolsJson).digest;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
    throw new Error(
      `${FLOCI_IMAGE_NAME} digest must be sha256: followed by 64 lowercase hex characters`,
    );
  }
  return digest;
}

/** Return the tag of the Floci image in a parsed `container/tools.json`. */
export function flociImageTag(toolsJson: unknown): string {
  const tag = flociEntry(toolsJson).tag;
  if (typeof tag !== "string" || !TAG_RE.test(tag)) {
    throw new Error(`${FLOCI_IMAGE_NAME} entry needs a non-empty tag`);
  }
  return tag;
}

/** Return the `run` text of a step, or "" when absent. */
function runOf(step: unknown): string {
  return isObject(step) && typeof step.run === "string" ? step.run : "";
}

/** Trimmed, non-empty, non-comment lines of a shell script. */
function codeLines(run: string): string[] {
  return run.split("\n").map((l) => l.trim()).filter((l) =>
    l !== "" && !l.startsWith("#")
  );
}

/** Whether a line runs the test script in command position. */
function runsScript(line: string): boolean {
  const tokens = line.split(/\s+/);
  const first = tokens[0] ?? "";
  if (first.endsWith(SCRIPT_PATH)) return true;
  return (first === "bash" || first === "sh") &&
    (tokens[1] ?? "").endsWith(SCRIPT_PATH);
}

/**
 * Check a parsed floci.yml against the expected tag and digest from
 * `container/tools.json`. Returns human-readable problems; an empty list means
 * the workflow is sound.
 */
export function checkFlociWorkflow(
  workflow: unknown,
  expectedDigest: string,
  expectedTag: string,
): string[] {
  if (!isObject(workflow)) {
    return ["workflow is not an object"];
  }
  const problems: string[] = [];
  const jobs = isObject(workflow.jobs) ? Object.values(workflow.jobs) : [];
  let seenImage: string | undefined;

  // (a) a job whose floci service image is `floci/floci:<tag>@<expected digest>`.
  let jobWithFloci: Record<string, unknown> | undefined;
  let service: Record<string, unknown> | undefined;
  for (const job of jobs) {
    if (!isObject(job) || !isObject(job.services)) continue;
    const floci = job.services.floci;
    if (isObject(floci) && typeof floci.image === "string") {
      seenImage ??= floci.image;
    }
    const match = isObject(floci) && typeof floci.image === "string"
      ? IMAGE_RE.exec(floci.image)
      : null;
    if (
      isObject(floci) && match?.[2] === expectedDigest &&
      match?.[1] === expectedTag
    ) {
      jobWithFloci = job;
      service = floci;
      break;
    }
  }
  if (!jobWithFloci || !service) {
    if (seenImage !== undefined && !IMAGE_RE.test(seenImage)) {
      problems.push(
        `services.floci.image must be floci/floci:<tag>@sha256:<digest> with both a tag and a digest, got ${seenImage}`,
      );
    } else {
      problems.push(
        `no job has services.floci.image floci/floci:${expectedTag}@${expectedDigest} (tag or digest drift from container/tools.json?)`,
      );
    }
  } else {
    // (b) docker socket volume.
    if (
      !Array.isArray(service.volumes) ||
      !service.volumes.includes(DOCKER_SOCK_VOLUME)
    ) {
      problems.push(
        `floci service volumes must include ${DOCKER_SOCK_VOLUME} (docker.sock mount)`,
      );
    }
    // (c) first step asserts the socket with an ::error:: annotation.
    const steps = Array.isArray(jobWithFloci.steps) ? jobWithFloci.steps : [];
    const firstRun = codeLines(runOf(steps[0])).join("\n");
    if (
      !SOCKET_TEST_RE.test(firstRun) || !firstRun.includes("::error::") ||
      !/\bexit\s+1\b/.test(firstRun)
    ) {
      problems.push(
        `first step must test -S ${DOCKER_SOCK}, emit ::error:: and exit 1 when it is missing`,
      );
    }
    // (f) Floci must stub resource types it does not support.
    const env = isObject(service.env) ? service.env : {};
    if (env[STUB_ENV] !== "true" && env[STUB_ENV] !== true) {
      problems.push(`floci service env ${STUB_ENV} must be "true"`);
    }
    // (g) checkout must not persist credentials.
    const checkout = steps.find((s: unknown) =>
      isObject(s) && typeof s.uses === "string" &&
      s.uses.startsWith("actions/checkout@")
    );
    if (
      !isObject(checkout) || !isObject(checkout.with) ||
      checkout.with["persist-credentials"] !== false
    ) {
      problems.push(
        "actions/checkout step must set with.persist-credentials: false",
      );
    }
  }

  // (d) some step invokes the test script.
  const invokesScript = jobs.some((job) =>
    isObject(job) && Array.isArray(job.steps) &&
    job.steps.some((s: unknown) => codeLines(runOf(s)).some(runsScript))
  );
  if (!invokesScript) {
    problems.push(`no step runs ${SCRIPT_PATH} (test-floci.sh)`);
  }

  // (e) trigger paths. YAML 1.1 parsers may read `on` as boolean true.
  const triggers = isObject(workflow.on)
    ? workflow.on
    : isObject((workflow as Record<string, unknown>)["true"])
    ? (workflow as Record<string, unknown>)["true"] as Record<string, unknown>
    : undefined;
  for (const event of ["pull_request", "push"]) {
    const trigger = isObject(triggers) ? triggers[event] : undefined;
    const paths = isObject(trigger) && Array.isArray(trigger.paths)
      ? trigger.paths
      : [];
    for (const required of REQUIRED_PATHS) {
      if (!paths.includes(required)) {
        problems.push(`on.${event}.paths must include ${required} (paths)`);
      }
    }
  }
  const prBranches = isObject(triggers) && isObject(triggers.pull_request) &&
      Array.isArray(triggers.pull_request.branches)
    ? triggers.pull_request.branches
    : [];
  if (!prBranches.includes("milestone/*")) {
    problems.push("on.pull_request.branches must include milestone/*");
  }

  // (h) least-privilege token.
  const permissions = workflow.permissions;
  if (!isObject(permissions) || permissions.contents !== "read") {
    problems.push("top-level permissions.contents must be read");
  }

  return problems;
}
