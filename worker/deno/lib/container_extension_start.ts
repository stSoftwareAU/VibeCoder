/**
 * The sandbox-start contract for a deployment's private extension
 * (Issue #981, parent #933).
 *
 * An extension's services — a Postgres server and a Jenkins in the worked
 * example — have to be **running** before the agent starts work. The
 * framework's half of that is one supervision contract, and these are the
 * three values it is written in:
 *
 *   1. {@link EXTENSION_PREFIX} — the one fixed path the operator's
 *      Containerfile copies the extension to, the same posture
 *      `/opt/vibe-tools/<id>` already takes for `container_tools`.
 *   2. {@link EXTENSION_START_ENV} — the declared start script's path,
 *      relative to that prefix, handed to the container by the launch plan
 *      when (and only when) the `container_extension` block declares one.
 *   3. {@link EXTENSION_START_ABORT_EXIT_STATUS} — what
 *      `container/entrypoint.sh` exits with when the start does not succeed,
 *      so the abort is reported as a failed run rather than disappearing into
 *      an empty launch loop.
 *
 * ## Why a status of its own
 *
 * The obvious alternative — exiting with whatever the operator's script
 * exited with — collides with statuses the fleet already reads: 75 is a
 * deliberate quota pause (`quota_pause.ts`), which resets the failure streak
 * and escalates nothing, and 125–127 are attributed to the container start
 * rather than the run. A start script exiting 75 would then be recorded as a
 * scheduled pause, which is precisely the silent failure this contract
 * exists to prevent. The entrypoint prints the script's own status and path
 * to the container log and exits with this framework-owned status instead.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

/**
 * The fixed in-container path an extension is copied to.
 *
 * A contract, not a setting: the operator's Containerfile copies their
 * extension here and the framework runs the declared start script from here.
 * `VIBE_EXTENSION_PREFIX` overrides it for the entrypoint's own tests, which
 * cannot write to `/opt` — production never sets it.
 */
export const EXTENSION_PREFIX = "/opt/vibe-extension";

/**
 * Environment variable naming the start script, relative to
 * {@link EXTENSION_PREFIX}.
 *
 * The same name the extension build records (`EXTENSION_START_BUILD_ARG` in
 * `container_extension_build.ts`), because it states the same contract path
 * on both sides of the image.
 */
export const EXTENSION_START_ENV = "VIBE_EXTENSION_START";

/**
 * Exit status `container/entrypoint.sh` uses when the extension start does
 * not succeed — the script is missing, is not executable, or exited non-zero.
 *
 * Distinct from every status the fleet already interprets: 0/1 from the
 * worker, 3 and 4 from its own commands, 75 the quota pause, 87 a wedged
 * container and 125–127 the runtime's container-start range. Recorded in
 * `launcher_failure_evidence.ts` so an escalation names it rather than
 * sending the reader to the container runtime.
 */
export const EXTENSION_START_ABORT_EXIT_STATUS = 76;
