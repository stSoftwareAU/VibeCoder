/** Runtime assertions shared by the actual supervisor fixture and its negatives. */
export interface SupervisorWorkerEvidence {
  denied: boolean;
  privateReadable: boolean;
  privateMounted: boolean;
  socketWritable: boolean;
  secretMatches: number;
  capEff: string;
  noNewPrivileges: string;
  seccomp: string;
}
export function assertSupervisorWorkerEvidence(
  value: SupervisorWorkerEvidence,
): void {
  if (
    value.denied !== true || value.privateReadable !== false ||
    value.privateMounted !== false ||
    value.socketWritable !== false || value.secretMatches !== 0 ||
    value.capEff !== "0000000000000000" || value.noNewPrivileges !== "1" ||
    value.seccomp !== "2"
  ) {
    throw new Error("Supervisor worker boundary evidence failed");
  }
}
