// Forwarding shim (Issue #3299 continuity gap — PR #3417 review): run.sh's
// root-level shim only helps a runner that restarts. A loop already running
// when the scripts/ move lands has this path baked into its `pass()` calls
// and never exits, so it keeps resolving this file long after the real
// helper moved. Kept here — calling the moved helper's own body, not a copy
// of it — until every installed runner has restarted onto scripts/run.sh.
import { runCli } from "./scripts/app_token.ts";

await runCli();
