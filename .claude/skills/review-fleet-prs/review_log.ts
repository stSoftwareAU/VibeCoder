// Forwarding shim (Issue #3299 continuity gap — PR #3417 review): see
// app_token.ts in this directory for why this stays, kept in sync with it.
import { stateDir } from "./scripts/review_log.ts";

console.log(stateDir());
