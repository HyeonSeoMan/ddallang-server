import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { addParticipant, auth, createRoom, type Created } from '../s1/s1-helpers.js';

export {
  addParticipant,
  auth,
  bootS1 as bootS2,
  count,
  createRoom,
  endRoom,
  join,
  newKey,
  revision,
  type Created,
  type S1Env as S2Env,
} from '../s1/s1-helpers.js';

type Http = ReturnType<typeof request>;

export interface Idem {
  key: string;
  at: string;
}
/** 새 요청의 멱등 헤더: 새 키와 지금 시각. */
export const fresh = (offsetMs = 0): Idem => ({
  key: randomBytes(16).toString('base64url'),
  at: new Date(Date.now() + offsetMs).toISOString(),
});

const withIdem = (r: request.Test, idem?: Idem | false) => {
  if (idem === false) return r;
  const i = idem ?? fresh();
  return r.set('Idempotency-Key', i.key).set('Idempotency-First-Attempt-At', i.at);
};

export function postTx(
  http: Http,
  roomId: string,
  memberKey: string,
  body: unknown,
  idem?: Idem | false,
) {
  return withIdem(
    http
      .post(`/rooms/${roomId}/transactions`)
      .set(auth(memberKey))
      .send(body as object),
    idem,
  );
}
export function putTx(
  http: Http,
  roomId: string,
  memberKey: string,
  id: string,
  body: unknown,
  idem?: Idem | false,
) {
  return withIdem(
    http
      .put(`/rooms/${roomId}/transactions/${id}`)
      .set(auth(memberKey))
      .send(body as object),
    idem,
  );
}
export function delTx(
  http: Http,
  roomId: string,
  memberKey: string,
  id: string,
  idem?: Idem | false,
) {
  return withIdem(http.delete(`/rooms/${roomId}/transactions/${id}`).set(auth(memberKey)), idem);
}

export interface Setup {
  c: Created;
  /** Participant ID: A, B, C */
  p: { a: string; b: string; c: string };
}

/** 방 하나와 활성 참여자 3명(A, B, C). */
export async function setupRoom(http: Http, nickname = 'Host'): Promise<Setup> {
  const c = await createRoom(http, { nickname });
  const ids: string[] = [];
  for (const n of ['Aa', 'Bb', 'Cc'])
    ids.push((await addParticipant(http, c, n)).body.participant.id);
  return { c, p: { a: ids[0]!, b: ids[1]!, c: ids[2]! } };
}

export const validBody = (s: Setup, extra: Record<string, unknown> = {}) => ({
  payerId: s.p.a,
  payeeId: s.p.b,
  amount: 1000,
  ...extra,
});
