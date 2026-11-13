import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  accountHostDiskReservations,
  admitHostDiskLaunch,
  babysitterDipCreditBytes,
  type HostDiskReservation,
  parseHostDiskReservation,
  readLiveHostDiskReservations,
  removeHostDiskReservation,
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
    }),
    16 * GB,
  );
  // Drop of 40 GB is consumed 16 only; 40 + 16 < 80 -> not explained.
  assertEquals(
    babysitterDipCreditBytes({
      availableBytes: 40 * GB,
      floorBytes: floor,
      live: [res()],
    }),
    null,
  );
  assertEquals(
    babysitterDipCreditBytes({
      availableBytes: 85 * GB,
      floorBytes: floor,
      live: [res()],
    }),
    null,
  );
  assertEquals(
    babysitterDipCreditBytes({
      availableBytes: 70 * GB,
      floorBytes: floor,
      live: [],
    }),
    null,
  );
});
