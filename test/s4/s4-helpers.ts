import { api, idem, makeRoom, newKey, type ApiRes, type Room } from '../s5/s5-helpers.js';
import type { Instance } from '../helpers/instances.js';

export { api, idem, makeRoom, newKey };
export type { ApiRes, Room };

export const endReq = (i: Instance, r: Room, h = idem(), key = r.key, body?: unknown) =>
  api(i, 'POST', `/rooms/${r.roomId}/end`, key, body, h);

export const settlementOf = (i: Instance, r: Room, key = r.key) =>
  api(i, 'GET', `/rooms/${r.roomId}/settlement`, key);

/**
 * S5 §6.4의 갱신 한 주기: 일반 참여자는 5개(방·참여자·순손익·목록 첫 페이지·정산), 방장은 대기 중인 이어받기 요청 목록을
 * 더한 6개(S5-C2)를 같은 주기로 시작해 모두 성공시킨다. 방장 여부는 클라이언트가 직전 방 조회로 아는 값이다(기본: 방장 키).
 */
export async function resync(i: Instance, r: Room, key = r.key, isHost = key === r.key) {
  const base = `/rooms/${r.roomId}`;
  const res = await Promise.all([
    api(i, 'GET', base, key),
    api(i, 'GET', `${base}/participants`, key),
    api(i, 'GET', `${base}/balances`, key),
    api(i, 'GET', `${base}/transactions`, key),
    api(i, 'GET', `${base}/settlement`, key),
    ...(isHost ? [api(i, 'GET', `${base}/claims`, key)] : []),
  ]);
  if (res.some((x) => x.status !== 200)) throw new Error('재동기화 실패');
  return {
    room: res[0]!.body,
    settlement: res[4]!.body.settlement,
    claims: isHost ? res[5]!.body.claims : undefined,
    all: res,
  };
}

export const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)]!;
