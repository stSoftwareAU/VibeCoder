/**
 * Launcher harness boundary for the Apple supervisor. The actual supervisor
 * and probes have separate lifecycle tests and disposable runtime evidence;
 * generic launcher tests must not create networks or open host listeners.
 */
import { parseContainerLaunchPlanText } from "../../lib/container_launch.ts";

const [planFile, readyFile, , ownerText] = Deno.args;
const owner = Number(ownerText);
if (!planFile || !readyFile || !Number.isSafeInteger(owner) || owner <= 0) {
  throw new Error("plan, ready file and launcher PID required");
}
const plan = parseContainerLaunchPlanText(await Deno.readTextFile(planFile));
Deno.addSignalListener("SIGTERM", () => Deno.exit(0));
// Match the production supervisor's lifetime when a termination test kills
// the launcher before its cleanup runs. Otherwise this orphan holds the
// launcher's output pipes open and the serial suite never finishes.
const checkParent = () => {
  try {
    Deno.kill(owner, 0);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) Deno.exit(0);
    throw error;
  }
};
checkParent();
setInterval(checkParent, 200);
await Deno.writeTextFile(`${readyFile}.tmp`, `${plan.run.join("\0")}\0`, {
  mode: 0o600,
});
await Deno.rename(`${readyFile}.tmp`, readyFile);
await new Promise<void>(() => {});
