import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeSettlement, type BalanceInput } from '../../src/settlement/settlement-algorithm.js';
import { ac } from '../helpers/contract.js';

const people = (...b: number[]): BalanceInput[] =>
  b.map((balance, i) => ({ participantId: 'ABCDEFGHIJ'[i]!, order: i + 1, balance }));
const flat = (items: ReturnType<typeof computeSettlement>) =>
  items.map((i) => `${i.payerId}>${i.payeeId}:${i.amount}`);

describe('정산 알고리즘 (BE-S4-1)', () => {
  it(ac(['AC-SET-003-1', 'AC-SET-004-1'], 'S4 §6.2', 'A(−300) B(−100) C(+250) D(+150)'), () => {
    expect(flat(computeSettlement(people(-300, -100, 250, 150)))).toEqual([
      'A>C:250',
      'B>D:100',
      'A>D:50',
    ]);
  });

  it(
    ac(['AC-SET-003-2', 'AC-SET-004-4'], 'S4 §6.2', '매 반복 재정렬 결과(재정렬 없는 방식과 다름)'),
    () => {
      const r = computeSettlement(people(-300, -200, 250, 150, 100));
      expect(flat(r)).toEqual(['A>C:250', 'B>D:150', 'A>E:50', 'B>E:50']);
      expect(flat(r)).not.toEqual(['A>C:250', 'A>D:50', 'B>D:100', 'B>E:100']);
    },
  );

  it(
    ac(['AC-SET-003-3'], 'S4 §6.2', '잔액 동률이면 등록 순서가 빠른 참여자가 먼저(채무자·채권자)'),
    () => {
      expect(flat(computeSettlement(people(-100, -100, 100, 100)))).toEqual(['A>C:100', 'B>D:100']);
      const shuffled = [...people(-100, -100, 100, 100)].reverse();
      expect(flat(computeSettlement(shuffled))).toEqual(['A>C:100', 'B>D:100']);
    },
  );

  it(ac(['AC-SET-003-5'], 'S4 §6.2', '순손익 0인 참여자는 항목에 없다'), () => {
    const r = computeSettlement(people(0, -50, 50, 0));
    expect(flat(r)).toEqual(['B>C:50']);
  });

  it(
    ac(['AC-SET-003-6'], 'S4 §6.2', '최소 송금 횟수는 보장하지 않는다(−6 −4 +4 +3 +3은 4건)'),
    () => {
      expect(computeSettlement(people(-6, -4, 4, 3, 3))).toHaveLength(4);
    },
  );

  it(ac(['AC-SET-004-2'], 'S4 §6.3', '금액 동률은 지급자 order, 같으면 수취자 order'), () => {
    const r = computeSettlement([
      { participantId: 'x', order: 3, balance: -50 },
      { participantId: 'y', order: 1, balance: -50 },
      { participantId: 'p', order: 4, balance: 50 },
      { participantId: 'q', order: 2, balance: 50 },
    ]);
    expect(flat(r)).toEqual(['y>q:50', 'x>p:50']);
    const same = computeSettlement([
      { participantId: 'a', order: 1, balance: -100 },
      { participantId: 'd', order: 3, balance: 50 },
      { participantId: 'e', order: 2, balance: 50 },
    ]);
    expect(flat(same)).toEqual(['a>e:50', 'a>d:50']);
  });

  it(
    ac(
      ['AC-SET-003-4', 'AC-SET-003-7'],
      'S4 §6.2',
      '속성: 합 0·이행 뒤 0·중복 쌍 없음·항목 수 상한·입력 순서와 무관',
    ),
    () => {
      const arb = fc
        .array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { minLength: 1, maxLength: 10 })
        .map((xs) => {
          const sum = xs.reduce((a, b) => a + b, 0);
          return [...xs, -sum]; // 합 0
        });
      fc.assert(
        fc.property(arb, fc.integer({ min: 0, max: 1000 }), (xs, seed) => {
          const input = people(...xs.slice(0, 10)).slice(0, xs.length);
          const total = input.reduce((a, p) => a + p.balance, 0);
          if (total !== 0) return true; // 11명 이상으로 잘린 경우는 건너뛴다
          const items = computeSettlement(input);
          const bal = new Map(input.map((p) => [p.participantId, p.balance]));
          for (const i of items) {
            expect(i.amount).toBeGreaterThanOrEqual(1);
            bal.set(i.payerId, bal.get(i.payerId)! + i.amount);
            bal.set(i.payeeId, bal.get(i.payeeId)! - i.amount);
          }
          expect([...bal.values()].every((v) => v === 0)).toBe(true);
          const pairs = new Set(items.map((i) => `${i.payerId}>${i.payeeId}`));
          expect(pairs.size).toBe(items.length);
          const d = input.filter((p) => p.balance < 0).length;
          const c = input.filter((p) => p.balance > 0).length;
          expect(items.length).toBeLessThanOrEqual(d && c ? d + c - 1 : 0);
          const mixed = [...input].sort(
            (a, b) => ((a.order * 7919 + seed) % 13) - ((b.order * 7919 + seed) % 13),
          );
          expect(computeSettlement(mixed)).toEqual(items);
          return true;
        }),
        { numRuns: 300 },
      );
    },
  );

  it(
    ac(['AC-SET-003-4'], 'S4 §6.2', 'NFR-009: 약 10¹² 규모의 순손익도 정수로 정확히 계산한다'),
    () => {
      const big = 999_999_999 * 1000;
      const r = computeSettlement(people(-big, big));
      expect(r).toEqual([{ payerId: 'A', payeeId: 'B', amount: big }]);
    },
  );
});
