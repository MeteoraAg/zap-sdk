import { BN } from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";
import { PublicKey, Transaction } from "@solana/web3.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";

import { Zap } from "../../src/zap";
import { JUP_V6_PROGRAM_ID } from "../../src/constants";
import { JupiterQuoteResponse } from "../../src/types";
import { getDammV2Pool } from "./damm_v2";
import { getTokenBalance, getTokenProgram } from "./token";
import { TOKEN_DECIMALS } from "./token";
import { createLiteSvmConnection } from "./svm";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getJupRemainingAccounts, JUP_ROUTE_DISC } from "./jupiter";

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
  const zap = new Zap(createLiteSvmConnection(svm));
  const poolState = getDammV2Pool(svm, pool);

  const outputTokenMint = poolState.tokenAMint.equals(inputTokenMint)
    ? poolState.tokenBMint
    : poolState.tokenAMint;

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
  const zap = new Zap(createLiteSvmConnection(svm));

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
  const zap = new Zap(createLiteSvmConnection(svm));

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
  const zap = new Zap(createLiteSvmConnection(svm));
  const poolState = getDammV2Pool(svm, pool);
  const outputTokenMint = poolState.tokenAMint.equals(inputTokenMint)
    ? poolState.tokenBMint
    : poolState.tokenAMint;

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

  const remainingAccounts = getJupRemainingAccounts(
    svm,
    pool,
    user,
    userTokenInAccount,
    userTokenOutAccount,
    outputTokenMint,
  );

  const routeStepPlanCount = Buffer.alloc(4);
  routeStepPlanCount.writeUInt32LE(1, 0);
  const routeStepPlanBuffer = Buffer.alloc(4);
  routeStepPlanBuffer.writeUint8(77, 0); // MeteoraDammV2 = enum index 77
  routeStepPlanBuffer.writeUint8(100, 1); // percent
  routeStepPlanBuffer.writeUint8(0, 2); // inputIndex
  routeStepPlanBuffer.writeUint8(1, 3); // outputIndex

  const inAmount = new BN(0).toArrayLike(Buffer, "le", 8);
  const quotedOutAmount = new BN(0).toArrayLike(Buffer, "le", 8);
  const slippageBps = new BN(9900).toArrayLike(Buffer, "le", 2);
  const platformFee = Buffer.from([0]);

  const payloadData = Buffer.concat([
    Buffer.from(JUP_ROUTE_DISC),
    routeStepPlanCount,
    routeStepPlanBuffer,
    inAmount,
    quotedOutAmount,
    slippageBps,
    platformFee,
  ]);

  return zap.zapOut({
    userTokenInAccount,
    zapOutParams: {
      percentage: 100,
      offsetAmountIn:
        JUP_ROUTE_DISC.length +
        routeStepPlanCount.length +
        routeStepPlanBuffer.length,
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
