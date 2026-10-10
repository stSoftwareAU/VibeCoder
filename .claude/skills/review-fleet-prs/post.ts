// Forwarding shim (Issue #3299 continuity gap — PR #3417 review): see
// app_token.ts in this directory for why this stays, kept in sync with it.
import { main } from "./scripts/post.ts";

await main();
