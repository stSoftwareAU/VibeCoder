import type { TokenEconomizerStopRule } from "./token_economizer_plugin.ts";
/** Shared notification format used by the stop controller and report reader. */
export const TOKEN_ECONOMIZER_STOP_MARKER =
  "<!-- vibe-token-economizer-stop -->";
export function tokenEconomizerStopLine(rule: TokenEconomizerStopRule): string {
  return `TokenEconomizer trial stopped: ${rule}.`;
}
