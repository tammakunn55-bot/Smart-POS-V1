export function isValidCashAmount(value, { allowZero = true } = {}) {
  const n = Number(value);
  return Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) && Math.round(n * 100) === n * 100;
}

export function calculateExpectedCash(openingCash, movements = []) {
  let total = Number(openingCash);
  if (!Number.isFinite(total) || total < 0) throw new TypeError('openingCash must be a non-negative number');
  for (const movement of movements) {
    const amount = Number(movement.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new TypeError('movement amount must be positive');
    if (['cash_in', 'sale_cash', 'customer_payment_cash'].includes(movement.movement_type)) total += amount;
    else if (['cash_out', 'refund_cash'].includes(movement.movement_type)) total -= amount;
  }
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

export function reconcileCash(expectedCash, countedCash) {
  if (!isValidCashAmount(expectedCash) || !isValidCashAmount(countedCash)) throw new TypeError('cash values must be non-negative amounts with at most 2 decimal places');
  const expected = Math.round(Number(expectedCash) * 100) / 100;
  const counted = Math.round(Number(countedCash) * 100) / 100;
  return { expected_cash: expected, counted_cash: counted, cash_difference: Math.round((counted - expected) * 100) / 100 };
}
