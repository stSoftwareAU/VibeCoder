// Forwarding shim (Issue #3299 continuity gap — PR #3417 review): see
// app_token.ts in this directory for why this stays, kept in sync with it.
// This one matters most: it is the already-running loop's only way to raise
// the 12-failure escalation issue once its other helpers start 404ing.
import { runCli } from "./scripts/escalate.ts";

await runCli();
