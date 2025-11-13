import Decimal from "decimal.js";

// (amount - x) / A = x * p / B
// x = amount * B / (p * A + B)
// TODO: check naming function
export function calculateSwapAmountDirectPool(
  amount: Decimal,
  currentPrice: Decimal,
  poolBalanceTokenA: Decimal,
  poolBalanceTokenB: Decimal
): Decimal {
  const numerator = amount.mul(poolBalanceTokenB);
  const denominator = currentPrice
    .mul(poolBalanceTokenA)
    .add(poolBalanceTokenB);

  return numerator.div(denominator);
}

// x * p1 / A = (amount - x) * p2 / B
// x = amount * p2 * A / (p1 * B + p2 * A)
// TODO: check naming function
export function calculateSwapAmountForIndirectPool(
  amount: Decimal,
  price1: Decimal, // sol/tokenA
  price2: Decimal, // sol tokenB
  poolBalanceTokenA: Decimal,
  poolBalanceTokenB: Decimal
): Decimal {
  const numerator = amount.mul(price2).mul(poolBalanceTokenA);
  const denominator = price1
    .mul(poolBalanceTokenB)
    .add(price2.mul(poolBalanceTokenA));

  return numerator.div(denominator);
}
