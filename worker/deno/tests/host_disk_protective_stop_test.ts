import { assertEquals } from "@std/assert";
import { isHostDiskProtectiveStopText } from "../lib/host_disk_protective_stop.ts";

Deno.test("host disk protective stop - recognises park notes and floor-only reasons", () => {
  for (
    const message of [
      "Claude execution failed: Parked as infrastructure (Issue #4360).",
      "host disk below its floor — floor 46.0 GB; waiting for recovery",
      "HOST DISK BELOW ITS FLOOR",
    ]
  ) {
    assertEquals(isHostDiskProtectiveStopText(message), true, message);
  }
});

Deno.test("host disk protective stop - disk exhaustion and unrelated failures are not protective stops", () => {
  for (
    const message of [
      "",
      "No space left on device",
      "write failed: ENOSPC",
      "Read-only file system (os error 30)",
      "host disk is above its floor",
      "Claude execution failed: unexpected error",
    ]
  ) {
    assertEquals(isHostDiskProtectiveStopText(message), false, message);
  }
});
