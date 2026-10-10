/**
 * Quality gate check: the Floci CloudFormation CI workflow (Issue #3369).
 *
 * `.github/workflows/floci.yml` runs VibeCoder's own CloudFormation templates
 * against a Floci service container. Its safety rests on a few statically
 * decidable properties, which these pure helpers verify so a regression fails
 * the quality gate rather than a CI run:
 *
 * - the service image is pinned to the same digest as `container/tools.json`
 *   (no drift between the worker image and CI);
 * - the Docker socket is mounted and the first step asserts it is present;
 * - the job runs `infra/cloudformation/test-floci.sh`;
 * - both `pull_request` and `push` triggers watch the templates and the
 *   workflow itself.
 *
 * No I/O: callers parse the YAML/JSON and pass the parsed values in.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** Image name of the Floci entry in `container/tools.json`. */
export const FLOCI_IMAGE_NAME = "docker.io/floci/floci";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const DOCKER_SOCK = "/var/run/docker.sock";
const DOCKER_SOCK_VOLUME = `${DOCKER_SOCK}:${DOCKER_SOCK}`;
const SCRIPT_PATH = "infra/cloudformation/test-floci.sh";
const REQUIRED_PATHS = [
  "infra/cloudformation/**",
  ".github/workflows/floci.yml",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return the digest of the Floci image in a parsed `container/tools.json`. */
export function flociImageDigest(toolsJson: unknown): string {
  if (!isObject(toolsJson) || !Array.isArray(toolsJson.images)) {
    throw new Error("tools.json has no images[] array");
  }
  const entry = toolsJson.images.find(
    (i: unknown) => isObject(i) && i.name === FLOCI_IMAGE_NAME,
  );
  if (!isObject(entry)) {
    throw new Error(`tools.json images[] has no ${FLOCI_IMAGE_NAME} entry`);
  }
  const digest = entry.digest;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
    throw new Error(
      `${FLOCI_IMAGE_NAME} digest must be sha256: followed by 64 lowercase hex characters`,
    );
  }
  return digest;
}

/** Return the `run` text of a step, or "" when absent. */
function runOf(step: unknown): string {
  return isObject(step) && typeof step.run === "string" ? step.run : "";
}

/**
 * Check a parsed floci.yml against the expected digest. Returns human-readable
 * problems; an empty list means the workflow is sound.
 */
export function checkFlociWorkflow(
  workflow: unknown,
  expectedDigest: string,
): string[] {
  if (!isObject(workflow)) {
    return ["workflow is not an object"];
  }
  const problems: string[] = [];
  const jobs = isObject(workflow.jobs) ? Object.values(workflow.jobs) : [];
  const expectedImage = `floci/floci@${expectedDigest}`;

  // (a) a job whose floci service image is pinned to the expected digest.
  let jobWithFloci: Record<string, unknown> | undefined;
  let service: Record<string, unknown> | undefined;
  for (const job of jobs) {
    if (!isObject(job) || !isObject(job.services)) continue;
    const floci = job.services.floci;
    if (isObject(floci) && floci.image === expectedImage) {
      jobWithFloci = job;
      service = floci;
      break;
    }
  }
  if (!jobWithFloci || !service) {
    problems.push(
      `no job has services.floci.image exactly ${expectedImage} (digest drift from container/tools.json?)`,
    );
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
    const firstRun = runOf(steps[0]);
    if (!firstRun.includes(DOCKER_SOCK) || !firstRun.includes("::error::")) {
      problems.push(
        `first step must check ${DOCKER_SOCK} and emit ::error:: when it is missing`,
      );
    }
  }

  // (d) some step invokes the test script.
  const invokesScript = jobs.some((job) =>
    isObject(job) && Array.isArray(job.steps) &&
    job.steps.some((s: unknown) => runOf(s).includes(SCRIPT_PATH))
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

  return problems;
}
