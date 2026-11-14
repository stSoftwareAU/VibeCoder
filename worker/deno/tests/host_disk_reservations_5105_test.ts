import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  accountHostDiskReservations,
  admitHostDiskLaunch,
  babysitterDipCreditBytes,
  type HostDiskReservation,
  parseHostDiskReservation,
  readLiveHostDiskReservations,
  RELEASED_RESERVATION_CREDIT_MAX_MS,
  removeHostDiskReservation,
  RESERVATION_SIGHTING_GRACE_MS,
  ReservationSightings,
  writeHostDiskReservation,
} from "../lib/host_disk_reservations.ts";

const GB = 1_000_000_000;

function res(over: Partial<HostDiskReservation> = {}): HostDiskReservation {
  return {
    holder: "babysitter",
    id: "repair-one",
    bytes: 16 * GB,
    availableAtAdmission: 100 * GB,
    admittedAt: 1000,
    expiresAt: 5000,
    ...over,
  };
}

Deno.test("parse accepts a valid body", () => {
  assertEquals(parseHostDiskReservation(JSON.stringify(res())), res());
});

Deno.test("parse rejects each malformed field", () => {
  const bad: Record<string, unknown>[] = [
    { holder: "worker" },
    { id: "Bad_ID" },
    { id: 5 },
    { bytes: 0 },
    { bytes: "16" },
    { bytes: 1.5 },
    { availableAtAdmission: -1 },
    { availableAtAdmission: "x" },
    { admittedAt: 0 },
    { admittedAt: "now" },
    { expiresAt: 1000 },
    { expiresAt: "later" },
  ];
  for (const o of bad) {
    assertEquals(
      parseHostDiskReservation(JSON.stringify({ ...res(), ...o })),
      null,
      JSON.stringify(o),
    );
  }
  assertEquals(parseHostDiskReservation("not json"), null);
  assertEquals(parseHostDiskReservation("[]"), null);
  const { bytes: _b, ...missing } = res();
  assertEquals(parseHostDiskReservation(JSON.stringify(missing)), null);
});

Deno.test("write then read round trip, with invalid write rejected", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/nested/host-disk-reservations`;
    const path = await writeHostDiskReservation(dir, res());
    assertEquals(path, `${dir}/repair-one.json`);
    assertEquals(await readLiveHostDiskReservations(dir, 2000), [res()]);
    await assertRejects(
      () => writeHostDiskReservation(dir, res({ bytes: -1 })),
      Error,
      "bytes",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("expired, malformed and mismatched files are not live", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeHostDiskReservation(dir, res({ id: "valid", admittedAt: 2000 }));
    await writeHostDiskReservation(
      dir,
      res({ id: "early", admittedAt: 1500 }),
    );
    await writeHostDiskReservation(
      dir,
      res({ id: "expired", expiresAt: 1500 }),
    );
    await Deno.writeTextFile(`${dir}/broken.json`, "{nope");
    await Deno.writeTextFile(
      `${dir}/other.json`,
      JSON.stringify(res({ id: "someone-else" })),
    );
    const live = await readLiveHostDiskReservations(dir, 1600);
    assertEquals(live.map((r) => r.id), ["early", "valid"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("missing dir yields no reservations", async () => {
  const root = await Deno.makeTempDir();
  try {
    assertEquals(await readLiveHostDiskReservations(`${root}/absent`, 1), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("remove of a missing file does not throw", async () => {
  const root = await Deno.makeTempDir();
  try {
    await removeHostDiskReservation(`${root}/gone.json`);
    const p = await writeHostDiskReservation(root, res());
    await removeHostDiskReservation(p);
    assertEquals(await readLiveHostDiskReservations(root, 2000), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("account: none, partial, capped", () => {
  assertEquals(accountHostDiskReservations([], 50 * GB), {
    reservedBytes: 0,
    consumedBytes: 0,
    outstandingBytes: 0,
  });
  assertEquals(accountHostDiskReservations([res()], 90 * GB), {
    reservedBytes: 16 * GB,
    consumedBytes: 10 * GB,
    outstandingBytes: 6 * GB,
  });
  assertEquals(accountHostDiskReservations([res()], 50 * GB), {
    reservedBytes: 16 * GB,
    consumedBytes: 16 * GB,
    outstandingBytes: 0,
  });
});

Deno.test("admit: outstanding reservation flips the decision", () => {
  const base = {
    availableBytes: 100 * GB,
    floorBytes: 80 * GB,
    requestBytes: 10 * GB,
  };
  assertEquals(admitHostDiskLaunch({ ...base, live: [] }), { admit: true });
  const refused = admitHostDiskLaunch({
    ...base,
    live: [res({ bytes: 16 * GB, availableAtAdmission: 100 * GB })],
  });
  assertEquals(refused.admit, false);
  if (!refused.admit) {
    assert(refused.reason.includes("(Issue #5105)"));
    assert(refused.reason.includes("80.0 GB"));
    assert(refused.reason.includes("16.0 GB"));
    assert(refused.reason.includes("100.0 GB"));
  }
});

Deno.test("dip credit", () => {
  const floor = 80 * GB;
  // Admitted at 100, now 70: consumed 16 (capped), 70 + 16 >= 80 -> explained.
  assertEquals(
    babysitterDipCreditBytes({
      availableBytes: 70 * GB,
      floorBytes: floor,
      live: [res()],
      workerGrowthBytes: 0,
    }),
    16 * GB,
  );
  // Drop of 40 GB is consumed 16 only; 40 + 16 < 80 -> not explained.
  assertEquals(
    babysitterDipCreditBytes({
      availableBytes: 40 * GB,
      floorBytes: floor,
      live: [res()],
      workerGrowthBytes: 0,
    }),
    null,
  );
  assertEquals(
    babysitterDipCreditBytes({
      availableBytes: 85 * GB,
      floorBytes: floor,
      live: [res()],
      workerGrowthBytes: 0,
    }),
    null,
  );
  assertEquals(
    babysitterDipCreditBytes({
      availableBytes: 70 * GB,
      floorBytes: floor,
      live: [],
      workerGrowthBytes: 0,
    }),
    null,
  );
});

Deno.test("dip credit takes the worker's own growth off the drop", () => {
  const floor = 80 * GB;
  const at = (workerGrowthBytes: number | undefined) =>
    babysitterDipCreditBytes({
      availableBytes: 70 * GB,
      floorBytes: floor,
      live: [res()],
      workerGrowthBytes,
    });
  // Drop 30, worker 10: the babysitter can have taken 20, capped at 16.
  assertEquals(at(10 * GB), 16 * GB);
  // Drop 30, worker 18: 12 left for the babysitter; 70 + 12 >= 80.
  assertEquals(at(18 * GB), 12 * GB);
  // Drop 30, worker 25: 5 left; 70 + 5 < 80 -> not explained.
  assertEquals(at(25 * GB), null);
  // Unknown worker growth credits nothing.
  assertEquals(at(undefined), null);
});

Deno.test("dip credit never applies below half the floor", () => {
  const big = res({ bytes: 60 * GB });
  const credit = (availableBytes: number) =>
    babysitterDipCreditBytes({
      availableBytes,
      floorBytes: 80 * GB,
      live: [big],
      workerGrowthBytes: 0,
    });
  assertEquals(credit(39 * GB), null);
  assertEquals(credit(40 * GB), 60 * GB);
});

Deno.test("ReservationSightings measures worker growth from first sight", () => {
  const now = Date.parse("2026-11-13T00:00:00Z");
  const r = res({ admittedAt: now - 60_000, expiresAt: now + 3_600_000 });
  const s = new ReservationSightings();
  const growth = (
    live: HostDiskReservation[],
    footprint: number | undefined,
    at: number,
  ) => s.observe(live, footprint, at, 0).workerGrowthBytes;
  assertEquals(growth([r], 5 * GB, now), 0);
  assertEquals(growth([r], 12 * GB, now + 60_000), 7 * GB);
  // Unknown footprint is unknown growth.
  assertEquals(growth([r], undefined, now + 120_000), undefined);
  // A released reservation is held, so its growth origin stays.
  assertEquals(growth([], 12 * GB, now + 180_000), 7 * GB);
  // A new reservation with the same id restarts it.
  const again = { ...r, admittedAt: now + 170_000 };
  assertEquals(growth([again], 20 * GB, now + 190_000), 0);
});

Deno.test("ReservationSightings credits nothing for a reservation first seen past the grace", () => {
  const now = Date.parse("2026-11-13T00:00:00Z");
  const late = res({
    admittedAt: now - RESERVATION_SIGHTING_GRACE_MS - 1,
    expiresAt: now + 3_600_000,
  });
  const s = new ReservationSightings();
  assertEquals(s.observe([late], 5 * GB, now, 0).workerGrowthBytes, undefined);
  assertEquals(
    s.observe([late], 5 * GB, now + 60_000, 0).workerGrowthBytes,
    undefined,
  );
  // A late-seen reservation that vanishes is never held as released.
  assertEquals(s.observe([], 5 * GB, now + 120_000, 0).released, []);
  // Control: seen within the grace.
  const timely = res({
    admittedAt: now - RESERVATION_SIGHTING_GRACE_MS,
    expiresAt: now + 3_600_000,
  });
  assertEquals(
    new ReservationSightings().observe([timely], 5 * GB, now, 0)
      .workerGrowthBytes,
    0,
  );
});

Deno.test("ReservationSightings holds a vanished reservation until a launcher reading measured after it went", () => {
  const now = Date.parse("2026-11-13T00:00:00Z");
  const r = res({ admittedAt: now - 60_000, expiresAt: now + 3_600_000 });
  const s = new ReservationSightings();
  assertEquals(s.tracking, false);
  assertEquals(s.observe([r], 5 * GB, now, now - 120_000).released, []);
  assert(s.tracking, "a live, seen reservation is tracked");
  // The file is gone; the adopted launcher reading predates it: still held,
  // with the growth origin of the vanished reservation.
  const gone = s.observe([], 9 * GB, now + 30_000, now - 120_000);
  assertEquals(gone.released, [r]);
  assertEquals(gone.workerGrowthBytes, 4 * GB);
  assert(s.tracking, "a released reservation is tracked");
  // A reading measured exactly at the moment it went is not after it.
  assertEquals(s.observe([], 9 * GB, now + 60_000, now + 30_000).released, [r]);
  // The fresh reading arrives: forgotten.
  const fresh = s.observe([], 9 * GB, now + 90_000, now + 60_000);
  assertEquals(fresh.released, []);
  assertEquals(fresh.workerGrowthBytes, undefined);
  assertEquals(s.tracking, false);
});

Deno.test("ReservationSightings stops holding a released reservation once the refresh age passes", () => {
  const now = Date.parse("2026-11-13T00:00:00Z");
  const r = res({ admittedAt: now - 60_000, expiresAt: now + 3_600_000 });
  const s = new ReservationSightings();
  s.observe([r], 5 * GB, now, 0);
  s.observe([], 5 * GB, now + 1_000, 0);
  assertEquals(
    s.observe([], 5 * GB, now + 1_000 + RELEASED_RESERVATION_CREDIT_MAX_MS, 0)
      .released,
    [r],
  );
  assertEquals(
    s.observe([], 5 * GB, now + 2_000 + RELEASED_RESERVATION_CREDIT_MAX_MS, 0)
      .released,
    [],
  );
});
