/** Worker-authored wording for a deliberate stop at the host-disk floor. */
const HOST_DISK_PROTECTIVE_STOP_PATTERN =
  /Parked as infrastructure \(Issue #4360\)|host disk below its floor/i;

/** Whether `message` contains a protective host-disk stop. */
export function isHostDiskProtectiveStopText(message: string): boolean {
  return HOST_DISK_PROTECTIVE_STOP_PATTERN.test(message);
}
