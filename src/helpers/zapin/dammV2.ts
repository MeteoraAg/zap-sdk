import { CpAmm, getTokenDecimals, PoolState } from "@meteora-ag/cp-amm-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { getJupiterQuote } from "../jupiter";
import { JupiterQuoteResponse, ZapConfig } from "../../types";
import {
  convertUiAmountToLamports,
  convertLamportsToUiAmount,
} from "../common";

// SOL is token A
// (amount - x) / A = x * p / B
// x = amount * B / (p * A + B)

// SOL is token B
// x * p / A = (amount -x ) / B
// x = amount * A / (p * B + A)
export function calculateDirectPoolSwapAmount(
  amount: BN,
  amountDecimals: number,
  currentPrice: Decimal,
  poolBalanceTokenA: Decimal,
  poolBalanceTokenB: Decimal,
  isInputTokenA: boolean
): BN {
  const amountDecimal = convertLamportsToUiAmount(
    new Decimal(amount.toString()),
    amountDecimals
  );

  let swapAmountDecimal: Decimal;
  if (isInputTokenA) {
    const numerator = amountDecimal.mul(poolBalanceTokenB);
    const denominator = currentPrice
      .mul(poolBalanceTokenA)
      .add(poolBalanceTokenB);

    swapAmountDecimal = numerator.div(denominator);
  } else {
    const numerator = amountDecimal.mul(poolBalanceTokenA);
    const denominator = currentPrice
      .mul(poolBalanceTokenB)
      .add(poolBalanceTokenA);

    swapAmountDecimal = numerator.div(denominator);
  }

  return new BN(
    convertUiAmountToLamports(swapAmountDecimal, amountDecimals)
      .floor()
      .toString()
  );
}

// x * p1 / A = (amount - x) * p2 / B
// x = amount * p2 * A / (p1 * B + p2 * A)
export function calculateIndirectPoolSwapAmount(
  amount: BN,
  amountDecimals: number,
  price1: Decimal, // in terms of tokenA per inputToken
  price2: Decimal, // in terms of tokenB per inputToken
  poolBalanceTokenA: Decimal,
  poolBalanceTokenB: Decimal
): BN {
  const amountDecimal = convertLamportsToUiAmount(
    new Decimal(amount.toString()),
    amountDecimals
  );

  const numerator = amountDecimal.mul(price2).mul(poolBalanceTokenA);
  const denominator = price1
    .mul(poolBalanceTokenB)
    .add(price2.mul(poolBalanceTokenA));

  const swapAmountDecimal = numerator.div(denominator);

  return new BN(
    convertUiAmountToLamports(swapAmountDecimal, amountDecimals)
      .floor()
      .toString()
  );
}

export async function getJupAndDammV2Quotes(
  connection: Connection,
  inputTokenMint: PublicKey,
  poolState: PoolState,
  tokenADecimal: number,
  tokenBDecimal: number,
  dammV2SlippageBps: number,
  jupSlippageBps: number,
  maxAccounts: number,
  config: ZapConfig = {}
): Promise<{
  dammV2Quote: {
    swapInAmount: BN;
    consumedInAmount: BN;
    swapOutAmount: BN;
    minSwapOutAmount: BN;
    totalFee: BN;
    priceImpact: Decimal;
  } | null;
  jupiterQuote: JupiterQuoteResponse | null;
}> {
  const currentSlot = await connection.getSlot();
  const currentTime =
    (await connection.getBlockTime(currentSlot)) ?? new Date().getTime() / 1000;
  const dammV2 = new CpAmm(connection);

  const inputTokenDecimal = await getTokenDecimals(
    connection,
    inputTokenMint,
    TOKEN_PROGRAM_ID
  );
  const ONE_TOKEN = convertUiAmountToLamports(
    new Decimal(1),
    inputTokenDecimal
  );

  let dammV2Quote = null;
  try {
    dammV2Quote = dammV2.getQuote({
      inAmount: new BN(ONE_TOKEN.floor().toString()),
      inputTokenMint,
      slippage: dammV2SlippageBps,
      poolState,
      currentSlot,
      currentTime,
      tokenADecimal,
      tokenBDecimal,
    });
  } catch (error) {
    // dammV2 quote can fail, for example if the pool has no liquidity
    console.error("Error getting DAMM v2 quote:", error);
  }

  const jupiterQuote = await getJupiterQuote(
    inputTokenMint,
    poolState.tokenAMint.equals(inputTokenMint)
      ? poolState.tokenBMint
      : poolState.tokenAMint,

    new BN(ONE_TOKEN.floor().toString()),
    maxAccounts,
    jupSlippageBps,
    false,
    true,
    true,
    config
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
