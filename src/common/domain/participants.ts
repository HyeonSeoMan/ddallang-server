import type { DbTx } from '../db/database.service.js';
import { ApiError } from '../errors/api-error.js';
import { newId } from '../ids/ids.js';
import { nicknameKey } from '../validation/index.js';
import { PARTICIPANT_LIMIT } from './limits.js';

/**
 * 새 참여자 하나(입장·직접 추가 공통, S1 §3.3 8·9번): 닉네임 중복(비활성·직접 추가 포함 한 범위) → 한도(10명,
 * 상태·신원 무관) → 다음 `order`. 방 잠금 안에서 호출해야 한다(같은 닉네임·마지막 슬롯·`order` 경쟁, S1 §7 1~3).
 */
export async function createParticipant(
  tx: DbTx,
  roomId: string,
  nickname: string,
  options: { identityKeyHash?: string; nicknameTakenMessage?: string; limitMessage?: string } = {},
) {
  const key = nicknameKey(nickname);
  const taken = await tx.participant.findUnique({
    where: { roomId_nicknameKey: { roomId, nicknameKey: key } },
    select: { id: true },
  });
  if (taken) throw new ApiError('NICKNAME_TAKEN', { message: options.nicknameTakenMessage }); // 8번이 9번보다 앞이다
  const count = await tx.participant.count({ where: { roomId } });
  if (count >= PARTICIPANT_LIMIT) {
    throw new ApiError('PARTICIPANT_LIMIT_EXCEEDED', {
      message: options.limitMessage,
      details: [{ limit: PARTICIPANT_LIMIT }],
    }); // 9번
  }
  const max = await tx.participant.aggregate({ where: { roomId }, _max: { order: true } });
  return tx.participant.create({
    data: {
      id: newId(),
      roomId,
      nickname,
      nicknameKey: key,
      order: (max._max.order ?? 0) + 1,
      identityKeyHash: options.identityKeyHash ?? null,
    },
  });
}
