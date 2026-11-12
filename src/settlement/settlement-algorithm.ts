export interface BalanceInput {
  participantId: string;
  /** 등록 순서(유일, 변하지 않는다) */
  order: number;
  /** 순손익(정수). 모든 참여자의 합은 0이다 */
  balance: bigint;
}

export interface SettlementItem {
  payerId: string;
  payeeId: string;
  amount: bigint;
}

interface Side {
  id: string;
  order: number;
  left: bigint;
}

/** 남은 값이 가장 큰 쪽, 같으면 order가 작은 쪽(정렬 안정성에 기대지 않는다). */
function pickMax(sides: Side[]): number {
  let best = 0;
  for (let i = 1; i < sides.length; i++) {
    const a = sides[i]!;
    const b = sides[best]!;
    if (a.left > b.left || (a.left === b.left && a.order < b.order)) best = i;
  }
  return best;
}

/**
 * S4 §6.2·§6.3: 순수 함수. 정수(bigint) 연산만 쓴다. 매 반복마다 남은 채무 최대·채권 최대(동률은 order) 짝을 `min`만큼 정산하고,
 * 금액 내림차순·지급자 order·수취자 order로 정렬한다. 입력 순서, ID, 닉네임에 의존하지 않는다.
 */
export function computeSettlement(input: readonly BalanceInput[]): SettlementItem[] {
  const orderOf = new Map(input.map((p) => [p.participantId, p.order]));
  const debtors: Side[] = [];
  const creditors: Side[] = [];
  for (const p of input) {
    if (p.balance < 0n) debtors.push({ id: p.participantId, order: p.order, left: -p.balance });
    else if (p.balance > 0)
      creditors.push({ id: p.participantId, order: p.order, left: p.balance });
  }
  const items: SettlementItem[] = [];
  while (debtors.length > 0 && creditors.length > 0) {
    const xi = pickMax(debtors);
    const yi = pickMax(creditors);
    const x = debtors[xi]!;
    const y = creditors[yi]!;
    const m = x.left < y.left ? x.left : y.left;
    items.push({ payerId: x.id, payeeId: y.id, amount: m });
    x.left -= m;
    y.left -= m;
    if (x.left === 0n) debtors.splice(xi, 1);
    if (y.left === 0n) creditors.splice(yi, 1);
  }
  return items.sort(
    (a, b) =>
      (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0) ||
      orderOf.get(a.payerId)! - orderOf.get(b.payerId)! ||
      orderOf.get(a.payeeId)! - orderOf.get(b.payeeId)!,
  );
}
