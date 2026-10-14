import { markerValue } from "./issue_routing_classifier.ts";
import type { RoutingDecision } from "./issue_routing_types.ts";

/**
 * Visible routing line plus the hidden machine-readable marker, written as
 * `<!-- issue-routing owner=… subject=… kind=… -->`. The marker is lowercase
 * so the uppercase env-var scanner does not read it as a `VIBE_*` name.
 */
export function formatRoutingAuditBlock(decision: RoutingDecision): string {
  const reason = decision.reason.replace(/\s+/g, " ").trim();
  return `Routing: owner \`${decision.owner_repository}\`, subject ` +
    `\`${decision.subject_repository}\`, kind ${decision.issue_kind} ` +
    `(${reason})\n` +
    `<!-- issue-routing owner=${
      markerValue(decision.owner_repository)
    } subject=${markerValue(decision.subject_repository)} kind=${
      markerValue(decision.issue_kind)
    } -->`;
}
