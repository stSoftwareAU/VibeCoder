/**
 * Launcher harness boundary for the Apple supervisor. The actual supervisor
 * and probes have separate lifecycle tests and disposable runtime evidence;
 * generic launcher tests must not create networks or open host listeners.
 */
import { parseContainerLaunchPlanText } from "../../lib/container_launch.ts";

const [planFile, readyFile] = Deno.args;
if (!planFile || !readyFile) throw new Error("plan and ready files required");
const plan = parseContainerLaunchPlanText(await Deno.readTextFile(planFile));
Deno.addSignalListener("SIGTERM", () => Deno.exit(0));
await Deno.writeTextFile(readyFile, `${plan.run.join("\0")}\0`);
await new Promise<void>(() => {});
