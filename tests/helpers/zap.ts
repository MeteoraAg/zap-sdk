import { BN } from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";
import { PublicKey, Transaction } from "@solana/web3.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";

import { Zap } from "../../src/zap";
import {
  AMOUNT_IN_JUP_V6_REVERSE_OFFSET,
  JUP_V6_PROGRAM_ID,
} from "../../src/constants";
import { JupiterApiVersion, JupiterQuoteResponse } from "../../src/types";
import { getDammV2OutputMint, getDammV2Pool } from "./damm_v2";
import { getDlmmOutputMint, getLbPair } from "./dlmm";
import { getTokenBalance, getTokenProgram } from "./token";
import { TOKEN_DECIMALS } from "./token";
import { createLiteSvmConnection } from "./svm";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  encodeJupRouteData,
  getDammV2SwapLeg,
  getDlmmSwapLeg,
  getJupRemainingAccounts,
  JupiterSwapLeg,
} from "./jupiter";

function getDammV2Quote(
  svm: LiteSVM,
  pool: PublicKey,
  inputTokenMint: PublicKey,
  amountIn: BN,
) {
  const poolState = getDammV2Pool(svm, pool);
  const cpAmm = new CpAmm(createLiteSvmConnection(svm));

  try {
    return cpAmm.getQuote({
      inAmount: amountIn,
      inputTokenMint,
      slippage: 0.5,
      poolState: poolState as any,
      currentTime: 0,
      currentSlot: 0,
      tokenADecimal: TOKEN_DECIMALS,
      tokenBDecimal: TOKEN_DECIMALS,
    });
  } catch (e) {
    console.warn("getDammV2Quote failed:", e);
    return null;
  }
}

export async function zapOutDammV2(
  svm: LiteSVM,
  user: PublicKey,
  inputTokenMint: PublicKey,
  pool: PublicKey,
  amountIn: BN,
): Promise<Transaction> {
  const zap = new Zap(createLiteSvmConnection(svm), {
    jupiterApiVersion: JupiterApiVersion.V1,
  });
  const poolState = getDammV2Pool(svm, pool);
  const outputTokenMint = getDammV2OutputMint(poolState, inputTokenMint);

  const inputTokenProgram = getTokenProgram(svm, inputTokenMint);
  const outputTokenProgram = getTokenProgram(svm, outputTokenMint);

  const quote = getDammV2Quote(svm, pool, inputTokenMint, amountIn);

  return await zap.zapOutThroughDammV2({
    user,
    poolAddress: pool,
    inputMint: inputTokenMint,
    outputMint: outputTokenMint,
    inputTokenProgram,
    outputTokenProgram,
    amountIn,
    minimumSwapAmountOut: quote?.minSwapOutAmount ?? new BN(0),
    maxSwapAmount: amountIn,
    percentageToZapOut: 100,
  });
}

export async function zapInDammV2Direct(
  svm: LiteSVM,
  user: PublicKey,
  inputTokenMint: PublicKey,
  pool: PublicKey,
  positionNftMint: PublicKey,
  amountIn: BN,
  maxSlippageBps: number = 1000,
): Promise<{
  swapTransactions: Transaction[];
  ledgerTransaction: Transaction;
  zapInTransaction: Transaction;
  cleanUpTransaction: Transaction;
}> {
  const zap = new Zap(createLiteSvmConnection(svm), {
    jupiterApiVersion: JupiterApiVersion.V1,
  });

  const dammV2Quote = getDammV2Quote(svm, pool, inputTokenMint, amountIn);

  const params = await zap.getZapInDammV2DirectPoolParams({
    user,
    inputTokenMint,
    amountIn,
    pool,
    positionNftMint,
    maxSqrtPriceChangeBps: maxSlippageBps,
    maxTransferAmountExtendPercentage: 20,
    maxAccounts: 40,
    slippageBps: 300,
    dammV2Quote,
    jupiterQuote: null,
  });

  const result = await zap.buildZapInDammV2Transaction(params);

  return {
    swapTransactions: result.swapTransactions,
    ledgerTransaction: result.ledgerTransaction,
    zapInTransaction: result.zapInTransaction,
    cleanUpTransaction: result.cleanUpTransaction,
  };
}

export async function zapInDammV2Indirect(
  svm: LiteSVM,
  user: PublicKey,
  inputTokenMint: PublicKey,
  pool: PublicKey,
  positionNftMint: PublicKey,
  amountIn: BN,
  jupiterQuoteToA: JupiterQuoteResponse | null,
  jupiterQuoteToB: JupiterQuoteResponse | null,
  maxSlippageBps: number = 5000,
): Promise<{
  setupTransaction?: Transaction;
  swapTransactions: Transaction[];
  ledgerTransaction: Transaction;
  zapInTransaction: Transaction;
  cleanUpTransaction: Transaction;
}> {
  const zap = new Zap(createLiteSvmConnection(svm), {
    jupiterApiVersion: JupiterApiVersion.V1,
  });

  const params = await zap.getZapInDammV2IndirectPoolParams({
    user,
    inputTokenMint,
    amountIn,
    pool,
    positionNftMint,
    maxSqrtPriceChangeBps: maxSlippageBps,
    maxTransferAmountExtendPercentage: 20,
    maxAccounts: 40,
    slippageBps: 300,
    jupiterQuoteToA,
    jupiterQuoteToB,
  });

  if (!params) {
    throw new Error("getZapInDammV2IndirectPoolParams returned null");
  }

  return await zap.buildZapInDammV2Transaction(params);
}

// jup v6 aggregator with route_plan that swaps through DAMM V2 pool
export async function zapOutJupV6ThroughDammv2(
  svm: LiteSVM,
  user: PublicKey,
  inputTokenMint: PublicKey,
  pool: PublicKey,
): Promise<Transaction> {
  const poolState = getDammV2Pool(svm, pool);
  const outputTokenMint = getDammV2OutputMint(poolState, inputTokenMint);

  return await zapOutJupV6(
    svm,
    user,
    inputTokenMint,
    outputTokenMint,
    (userTokenInAccount, userTokenOutAccount) =>
      getDammV2SwapLeg(
        svm,
        pool,
        user,
        userTokenInAccount,
        userTokenOutAccount,
      ),
  );
}

// jup v6 aggregator with route_plan that swaps through DLMM pool
export async function zapOutJupV6ThroughDlmm(
  svm: LiteSVM,
  user: PublicKey,
  inputTokenMint: PublicKey,
  lbPair: PublicKey,
): Promise<Transaction> {
  const lbPairState = getLbPair(svm, lbPair);
  const outputTokenMint = getDlmmOutputMint(lbPairState, inputTokenMint);

  return await zapOutJupV6(
    svm,
    user,
    inputTokenMint,
    outputTokenMint,
    (userTokenInAccount, userTokenOutAccount) =>
      getDlmmSwapLeg(
        svm,
        lbPair,
        user,
        userTokenInAccount,
        userTokenOutAccount,
        inputTokenMint,
      ),
  );
}

// Hand-built Jupiter v6 `route` instruction with a single swap leg, wrapped in the zap program's zapOut.
async function zapOutJupV6(
  svm: LiteSVM,
  user: PublicKey,
  inputTokenMint: PublicKey,
  outputTokenMint: PublicKey,
  getSwapLeg: (
    userTokenInAccount: PublicKey,
    userTokenOutAccount: PublicKey,
  ) => JupiterSwapLeg | Promise<JupiterSwapLeg>,
): Promise<Transaction> {
  const zap = new Zap(createLiteSvmConnection(svm), {
    jupiterApiVersion: JupiterApiVersion.V1,
  });

  const inputTokenProgram = getTokenProgram(svm, inputTokenMint);
  const outputTokenProgram = getTokenProgram(svm, outputTokenMint);

  const userTokenInAccount = getAssociatedTokenAddressSync(
    inputTokenMint,
    user,
    true,
    inputTokenProgram,
  );
  const userTokenOutAccount = getAssociatedTokenAddressSync(
    outputTokenMint,
    user,
    true,
    outputTokenProgram,
  );

  const preUserTokenBalance = getTokenBalance(svm, userTokenInAccount);

  const leg = await getSwapLeg(userTokenInAccount, userTokenOutAccount);
  const remainingAccounts = getJupRemainingAccounts(
    user,
    userTokenInAccount,
    userTokenOutAccount,
    outputTokenMint,
    leg,
  );

  // amount_in is the placeholder right after the route plan; the zap program splices the real amount in.
  const payloadData = encodeJupRouteData(new BN(0), leg.swapEnum);

  return zap.zapOut({
    userTokenInAccount,
    zapOutParams: {
      percentage: 100,
      offsetAmountIn: payloadData.length - AMOUNT_IN_JUP_V6_REVERSE_OFFSET,
      preUserTokenBalance,
      maxSwapAmount: new BN("1000000000000"),
      payloadData,
    },
    remainingAccounts,
    ammProgram: JUP_V6_PROGRAM_ID,
    preInstructions: [],
    postInstructions: [],
  });
}

export async function zapOutDlmm(
  svm: LiteSVM,
  user: PublicKey,
  inputTokenMint: PublicKey,
  lbPair: PublicKey,
  amountIn: BN,
): Promise<Transaction> {
  const zap = new Zap(createLiteSvmConnection(svm), {
    jupiterApiVersion: JupiterApiVersion.V1,
  });
  const lbPairState = getLbPair(svm, lbPair);
  const outputTokenMint = getDlmmOutputMint(lbPairState, inputTokenMint);

  return await zap.zapOutThroughDlmm({
    user,
    lbPairAddress: lbPair,
    inputMint: inputTokenMint,
    outputMint: outputTokenMint,
    inputTokenProgram: getTokenProgram(svm, inputTokenMint),
    outputTokenProgram: getTokenProgram(svm, outputTokenMint),
    amountIn,
    minimumSwapAmountOut: new BN(0),
    maxSwapAmount: amountIn,
    percentageToZapOut: 100,
  });
}
