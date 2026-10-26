/** Test-only negative control, with no agent, credential mounts or inherited secrets. */
import { appleRawProbes } from "./lib/apple_egress_controls.ts";
console.log(JSON.stringify(await appleRawProbes((name) => Deno.env.get(name))));
