import { CpAmm, PoolState } from "@meteora-ag/cp-amm-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { getJupiterQuote } from "../jupiter";
import { JupiterQuoteResponse } from "../../types";

// SOL is token A
// (amount - x) / A = x * p / B
// x = amount * B / (p * A + B)

// SOL is token B
// x * p / A = (amount -x ) / B
// x = amount * A / (p * B + A)
export function calculateDirectPoolSwapAmount(
  amount: Decimal,
  currentPrice: Decimal,
  poolBalanceTokenA: Decimal,
  poolBalanceTokenB: Decimal,
  isInputTokenA: boolean
): Decimal {
  if (isInputTokenA) {
    const numerator = amount.mul(poolBalanceTokenB);
    const denominator = currentPrice
      .mul(poolBalanceTokenA)
      .add(poolBalanceTokenB);

    return numerator.div(denominator);
  }
  const numerator = amount.mul(poolBalanceTokenA);
  const denominator = currentPrice
    .mul(poolBalanceTokenB)
    .add(poolBalanceTokenA);

  return numerator.div(denominator);
}

// x * p1 / A = (amount - x) * p2 / B
// x = amount * p2 * A / (p1 * B + p2 * A)
export function calculateIndirectPoolSwapAmount(
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

export async function getJupAndDammV2Quotes(
  connection: Connection,
  poolState: PoolState,
  tokenADecimal: number,
  tokenBDecimal: number
): Promise<{
  dammV2Quote: {
    swapInAmount: BN;
    consumedInAmount: BN;
    swapOutAmount: BN;
    minSwapOutAmount: BN;
    totalFee: BN;
    priceImpact: Decimal;
  };
  jupiterQuote: JupiterQuoteResponse | null;
}> {
  const currentSlot = await connection.getSlot();
  const currentTime =
    (await connection.getBlockTime(currentSlot)) ?? new Date().getTime() / 1000;
  const dammV2 = new CpAmm(connection);

  const dammV2Quote = dammV2.getQuote({
    inAmount: new BN(LAMPORTS_PER_SOL),
    inputTokenMint: NATIVE_MINT,
    slippage: 50,
    poolState,
    currentSlot,
    currentTime,
    tokenADecimal,
    tokenBDecimal,
  });

  const jupiterQuote = await getJupiterQuote(
    NATIVE_MINT,
    poolState.tokenAMint.equals(NATIVE_MINT)
      ? poolState.tokenBMint
      : poolState.tokenAMint,

    new BN(LAMPORTS_PER_SOL),
    40,
    50,
    false,
    true,
    true,
    "https://lite-api.jup.ag"
  );
  return {
    dammV2Quote,
    jupiterQuote,
  };
}

export function getExtendMaxAmountTransfer(
  amount: string,
  percentage: number
): BN {
  const extendAmount = new Decimal(amount)
    .mul(percentage)
    .div(100)
    .floor()
    .toString();

  return new BN(amount).add(new BN(extendAmount));
}
