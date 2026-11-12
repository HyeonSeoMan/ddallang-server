import { randomBytes } from 'node:crypto';
import type { Instance } from '../helpers/instances.js';
import { newKey } from '../s1/s1-helpers.js';

export { newKey };
export type Body = { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ApiRes {
  status: number;
  body: Body;
  headers: Headers;
}

export const idem = () => ({
  key: randomBytes(16).toString('base64url'),
  at: new Date().toISOString(),
});

export async function api(
  i: Instance,
  method: string,
  path: string,
  key: string,
  body?: unknown,
  h?: { key: string; at: string },
): Promise<ApiRes> {
  const res = await i.fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(h ? { 'Idempotency-Key': h.key, 'Idempotency-First-Attempt-At': h.at } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Body,
    headers: res.headers,
  };
}

export interface Room {
  key: string;
  roomId: string;
  hostId: string;
  inviteCode: string;
  p: string[];
}

export async function makeRoom(i: Instance, participants = 3): Promise<Room> {
  const key = newKey();
  const created = await api(i, 'POST', '/rooms', key, {
    name: 'Live',
    unit: '원',
    nickname: 'Host',
  });
  const roomId = created.body.room.id as string;
  const p: string[] = [];
  for (let n = 0; n < participants; n++)
    p.push(
      (await api(i, 'POST', `/rooms/${roomId}/participants`, key, { nickname: `P${n}` })).body
        .participant.id as string,
    );
  return {
    key,
    roomId,
    hostId: created.body.me.id as string,
    inviteCode: created.body.room.inviteCode as string,
    p,
  };
}

export async function joinRoom(
  i: Instance,
  r: Room,
  nickname: string,
): Promise<{ key: string; memberId: string }> {
  const key = newKey();
  const res = await api(i, 'POST', `/invites/${r.inviteCode}/members`, key, { nickname });
  return { key, memberId: res.body.me.id as string };
}

export const createTx = (i: Instance, r: Room, amount: number, h = idem()) =>
  api(
    i,
    'POST',
    `/rooms/${r.roomId}/transactions`,
    r.key,
    { payerId: r.p[0], payeeId: r.p[1], amount },
    h,
  );
