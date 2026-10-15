/** Allocate a bill-level discount to lines in cents without losing/creating money. */
export function allocateBillDiscount(lines, discountAmount) {
  const toCents = value => Math.round((Number(value) + Number.EPSILON) * 100);
  const fromCents = cents => cents / 100;
  const amounts = lines.map(line => toCents(line));
  const subtotalCents = amounts.reduce((sum, value) => sum + value, 0);
  const discountCents = toCents(discountAmount);
  if (!Number.isFinite(Number(discountAmount)) || discountCents < 0 || discountCents > subtotalCents) {
    throw new RangeError('Discount must be between zero and the subtotal');
  }
  let allocatedCents = 0;
  return amounts.map((lineCents, index) => {
    const shareCents = index === amounts.length - 1
      ? discountCents - allocatedCents
      : (subtotalCents > 0 ? Math.round(discountCents * lineCents / subtotalCents) : 0);
    allocatedCents += shareCents;
    return {
      discount_amount: fromCents(shareCents),
      line_total: fromCents(lineCents - shareCents),
    };
  });
}
