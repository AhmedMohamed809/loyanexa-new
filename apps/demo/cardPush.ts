// apps/demo/cardPush.ts
//
// The card-edit half of live pass updates (BUILD.md §9.3). Split out of
// server.ts for the same reason stamp.ts / cardEdit.ts / passkit.ts are:
// apps/demo/test/cardPush.test.ts exercises the fan-out logic against the
// real local Postgres with a stub "send one push" function, never a real
// ApnsClient and never Apple's servers.
//
// Added 2026-08-03 alongside the `.pkpass` cache-key fix
// (apps/demo/pkpassCache.ts): fixing the cache alone means a device's
// *next* poll picks up the new design, but that poll only happens when the
// device happens to ask — potentially a long time after the merchant's
// edit. A design edit currently triggers no push at all. This module is
// what wakes every device holding one of the card's passes immediately, the
// same way a stamp already does (server.ts's pushApnsUpdate, fired after a
// stamp lands) — "change your colours and see it on the card" only actually
// works once this fires.

import { prisma } from '../../packages/db/src/index.ts';
import type { Device } from '@prisma/client';

/** Every device registered for any pass issued against `cardId` — the fan-out list a card design edit must wake. */
export async function devicesForCard(cardId: string): Promise<Device[]> {
  const passes = await prisma.pass.findMany({ where: { cardId }, select: { serial: true } });
  if (passes.length === 0) return [];
  const serials = passes.map((p) => p.serial);
  return prisma.device.findMany({ where: { passSerial: { in: serials } } });
}

export interface CardPushOutcome {
  ok: boolean;
  /** True when the push failed because Apple reports the pass gone from this device (410) — the caller should prune the Device row, same as server.ts's pushApnsUpdate does per-pass. */
  gone?: boolean;
}

/**
 * Pushes a live-update wake-up to every device registered for any of
 * `cardId`'s passes, via `sendOne` — the caller's actual APNs send
 * (server.ts wires this to `ApnsClient#sendPush`; tests inject a stub, so
 * nothing in this module ever touches a network). A `gone` outcome prunes
 * the Device row, mirroring server.ts's own pushApnsUpdate. One card can
 * have many passes and each pass many devices, so every push is fired
 * concurrently — the caller is already responsible for calling this only
 * after its own response has been sent (BUILD.md §18 item 6), same rule
 * pushPassUpdate follows after a stamp.
 */
export async function pushCardDevices(
  cardId: string,
  sendOne: (device: Device) => Promise<CardPushOutcome>
): Promise<void> {
  const devices = await devicesForCard(cardId);
  await Promise.all(
    devices.map(async (device) => {
      const result = await sendOne(device);
      if (!result.ok && result.gone) {
        await prisma.device
          .delete({ where: { deviceId_passSerial: { deviceId: device.deviceId, passSerial: device.passSerial } } })
          .catch(() => {}); // already gone / raced with an unregister — fine either way
      }
    })
  );
}
