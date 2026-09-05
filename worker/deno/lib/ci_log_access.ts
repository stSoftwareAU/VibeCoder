/**
 * Vendor-neutral CI-log access diagnosis (Issue #986, replacing #3583).
 *
 * A CI log that cannot be fetched because of credentials or a wrong job
 * path is not the same as a CI log that says nothing useful. The first is
 * an operator problem the worker can name; the second is a diagnosis
 * problem. Issue #3583 made the worker escalate the first to a human
 * rather than attempt a fix on no evidence, and that property is worth
 * keeping.
 *
 * What is *not* worth keeping is where it lived: the classification was
 * keyed on one particular provider id and carried that vendor's own
 * remediation prose. Core does not know what CI a deployment runs, so it
 * cannot write that sentence — see `docs/PRIVATE-EXTENSIONS.md`.
 *
 * What core *can* read is the HTTP status a provider reports, which means
 * the same thing everywhere: 401 the credentials are wrong, 403 they are
 * right and insufficient, 404 the thing addressed does not exist. The
 * remediation names the provider and its configured target and stops
 * there; the provider's own error text carries the vendor detail.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

/** An access failure worth escalating rather than diagnosing around. */
export interface CiLogAccessDiagnosis {
  /** Access failure class. */
  status: "unauthorised" | "forbidden" | "not-found";
  /** The HTTP status the provider reported. */
  httpStatus: number;
  /** One line naming what failed. */
  summary: string;
  /** One line naming what a human should do about it. */
  remediation: string;
}

/**
 * Recover a diagnosis from a provider's failure string.
 *
 * The `CiLogProvider` interface carries failures as plain strings, so the
 * dispatcher classifies them back into the classes that warrant escalation.
 * Returns `undefined` for anything that is not an access problem — a
 * malformed response, a 5xx, an unmatched check — so those keep the
 * tolerant "continue without an excerpt" behaviour they have always had.
 */
export function classifyCiLogAccessError(
  error: string,
  providerId: string,
  target: string,
): CiLogAccessDiagnosis | undefined {
  const match = /HTTP (\d{3})/.exec(error);
  if (!match) return undefined;
  const httpStatus = Number.parseInt(match[1]!, 10);

  switch (httpStatus) {
    case 401:
      return {
        status: "unauthorised",
        httpStatus,
        summary:
          `The '${providerId}' CI log provider was refused (HTTP 401): its credentials are wrong, expired, or not set.`,
        remediation:
          `Re-issue the credentials the '${providerId}' provider reads and restart the worker.`,
      };
    case 403:
      return {
        status: "forbidden",
        httpStatus,
        summary:
          `The '${providerId}' CI log provider authenticated but was denied (HTTP 403): its credentials lack read access to '${target}'.`,
        remediation:
          `Grant the '${providerId}' provider's account read access to '${target}'.`,
      };
    case 404:
      return {
        status: "not-found",
        httpStatus,
        summary:
          `The '${providerId}' CI log provider found nothing at '${target}' (HTTP 404).`,
        remediation:
          `Check the target configured for the '${providerId}' provider in this repository's \`ciProviders\` entry, and that the build still exists.`,
      };
    default:
      return undefined;
  }
}

/** Render a diagnosis as a Markdown block for an issue or PR comment. */
export function formatCiLogAccessDiagnosis(
  diagnosis: CiLogAccessDiagnosis,
): string {
  return [
    `**CI log access:** ${diagnosis.status} (HTTP ${diagnosis.httpStatus})`,
    "",
    diagnosis.summary,
    "",
    `**What to do:** ${diagnosis.remediation}`,
  ].join("\n");
}
