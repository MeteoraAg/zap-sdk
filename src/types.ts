import { Program, IdlTypes } from "@coral-xyz/anchor";
import {
  AccountMeta,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Zap } from "./idl/zap/idl";
import Decimal from "decimal.js";
import {
  SwapQuote,
  StrategyType,
  RemainingAccountInfo,
} from "@meteora-ag/dlmm";

export type ZapProgram = Program<Zap>;

///// ZAPOUT TYPES /////
export type ZapOutParameters = IdlTypes<Zap>["zapOutParameters"];

export type ZapOutParams = {
  userTokenInAccount: PublicKey;
  zapOutParams: ZapOutParameters;
  remainingAccounts: AccountMeta[];
  ammProgram: PublicKey;
  preInstructions: TransactionInstruction[];
  postInstructions: TransactionInstruction[];
};

export type ZapOutThroughDammV2Params = {
  user: PublicKey;
  poolAddress: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  amountIn: BN;
  minimumSwapAmountOut: BN;
  maxSwapAmount: BN;
  percentageToZapOut: number;
};

export type ZapOutThroughDlmmParams = {
  user: PublicKey;
  lbPairAddress: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  amountIn: BN;
  minimumSwapAmountOut: BN;
  maxSwapAmount: BN;
  percentageToZapOut: number;
};

export interface ZapOutThroughJupiterParams {
  user: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  jupiterSwapResponse: JupiterSwapInstructionResponse;
  maxSwapAmount: BN;
  percentageToZapOut: number;
}

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: any;
  priceImpactPct: string;
  routePlan: JupiterRoutePlan[];
  contextSlot: number;
  timeTaken: number;
  swapUsdValue: string;
  simplerRouteUsed: boolean;
  mostReliableAmmsQuoteReport: {
    info: Record<string, string>;
  };
  useIncurredSlippageForQuoting: any;
  otherRoutePlans: any;
  aggregatorVersion: any;
}

export interface JupiterRoutePlan {
  swapInfo: any;
  percent: number;
  bps: number;
}

export interface JupiterInstruction {
  programId: string;
  accounts: any[];
  data: string;
}

export interface JupiterSwapInstructionResponse {
  tokenLedgerInstruction: JupiterInstruction | null;
  computeBudgetInstructions: JupiterInstruction[];
  setupInstructions: JupiterInstruction[];
  swapInstruction: JupiterInstruction;
  cleanupInstruction: JupiterInstruction;
  otherInstructions: JupiterInstruction[];
  addressLookupTableAddresses: string[];
  prioritizationFeeLamports: number;
  computeUnitLimit: number;
  prioritizationType: {
    computeBudget: {
      microLamports: number;
      estimatedMicroLamports: number;
    };
  };
  simulationSlot: any;
  dynamicSlippageReport: any;
  simulationError: any;
  addressesByLookupTableAddress: any;
  blockhashWithMetadata: {
    blockhash: number[];
    lastValidBlockHeight: number;
    fetchedAt: {
      secs_since_epoch: number;
      nanos_since_epoch: number;
    };
  };
}

export type ProgramStrategyType = IdlTypes<Zap>["strategyType"];

//#region ZapIn Types

export type GetZapInDammV2DirectPoolParams = {
  user: PublicKey;
  inputTokenMint: PublicKey;
  amountIn: BN;
  pool: PublicKey;
  positionNftMint: PublicKey;
  maxSqrtPriceChangeBps: number;
  maxTransferAmountExtendPercentage: number;
  maxAccounts: number;
  slippageBps: number;
  dammV2Quote: {
    swapInAmount: BN;
    consumedInAmount: BN;
    swapOutAmount: BN;
    minSwapOutAmount: BN;
    totalFee: BN;
    priceImpact: Decimal;
  } | null;
  jupiterQuote: JupiterQuoteResponse | null;
};

export type GetZapInDammV2InDirectPoolParams = {
  user: PublicKey;
  inputTokenMint: PublicKey;
  amountIn: BN;
  pool: PublicKey;
  positionNftMint: PublicKey;
  maxSqrtPriceChangeBps: number;
  maxTransferAmountExtendPercentage: number;
  maxAccounts: number;
  slippageBps: number;
  jupiterQuoteToA: JupiterQuoteResponse | null;
  jupiterQuoteToB: JupiterQuoteResponse | null;
};

export type ZapInDammV2DirectSwapQuote = {
  inAmount: BN;
  outAmount: BN;
};

export type ZapInDammV2DirectPoolParam = {
  user: PublicKey;
  pool: PublicKey;
  position: PublicKey;
  positionNftAccount: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  tokenAProgram: PublicKey;
  tokenBProgram: PublicKey;
  isDirectPool: boolean;
  maxTransferAmount: BN;
  preSqrtPrice: BN;
  maxSqrtPriceChangeBps: number;
  amount: BN;
  preInstructions: TransactionInstruction[];
  swapTransactions: Transaction[];
  cleanUpInstructions: TransactionInstruction[];
  isTokenA?: boolean;
  swapQuote: ZapInDammV2DirectSwapQuote;
};

export enum SwapExternalType {
  swapToA,
  swapToB,
  swapToBoth,
}

export type ZapInDammV2IndirectSwapQuote = {
  inAmountA: BN;
  outAmountA: BN;
  inAmountB: BN;
  outAmountB: BN;
};

export type ZapInDammV2InDirectPoolParam = Omit<
  ZapInDammV2DirectPoolParam,
  "maxTransferAmount" | "swapQuote"
> & {
  swapType: SwapExternalType;
  maxTransferAmountA: BN;
  maxTransferAmountB: BN;
  swapQuote: ZapInDammV2IndirectSwapQuote;
};

export type ZapInDammV2Response = {
  setupTransaction?: Transaction;
  swapTransactions: Transaction[];
  ledgerTransaction: Transaction;
  zapInTransaction: Transaction;
  cleanUpTransaction: Transaction;
};

export enum DlmmDirectSwapQuoteRoute {
  Jupiter,
  Dlmm,
}

export interface SwapQuoteResult {
  inAmount: BN;
  outAmount: BN;
  route: DlmmDirectSwapQuoteRoute;
  originalQuote: JupiterQuoteResponse | SwapQuote;
}

export enum DlmmSwapType {
  XToY,
  YToX,
  NoSwap,
}

export enum DlmmSingleSided {
  X,
  Y,
}

export interface EstimateDlmmDirectSwapParams {
  amountIn: BN;
  inputTokenMint: PublicKey;
  lbPair: PublicKey;
  connection: Connection;
  swapSlippageBps: number;
  minDeltaId: number;
  maxDeltaId: number;
  strategy: StrategyType;
  singleSided?: DlmmSingleSided;
}

export interface DlmmDirectSwapEstimateContext {
  amountIn: BN;
  inputTokenMint: PublicKey;
  lbPair: PublicKey;
  swapSlippageBps: number;
  minDeltaId: number;
  maxDeltaId: number;
  strategy: StrategyType;
  singleSided?: DlmmSingleSided;
}

export interface DlmmDirectEstimateResult {
  swapType: DlmmSwapType;
  swapAmount: BN;
  expectedOutput: BN;
  postSwapX: BN;
  postSwapY: BN;
  quote: SwapQuoteResult | null;
}

export interface DlmmDirectSwapEstimate {
  result: DlmmDirectEstimateResult;
  context: DlmmDirectSwapEstimateContext;
}

export interface EstimateDlmmRebalanceSwapParams {
  position: PublicKey;
  lbPair: PublicKey;
  connection: Connection;
  minDeltaId: number;
  maxDeltaId: number;
  swapSlippageBps: number;
  strategy: StrategyType;
}

export interface DlmmDirectRebalanceEstimateContext {
  lbPair: PublicKey;
  position: PublicKey;
  swapSlippageBps: number;
  minDeltaId: number;
  maxDeltaId: number;
  strategy: StrategyType;
  singleSided?: DlmmSingleSided;
}

export interface DlmmDirectRebalanceEstimate {
  result: DlmmDirectEstimateResult;
  context: DlmmDirectRebalanceEstimateContext;
}

export interface EstimateDlmmIndirectSwapParams {
  amountIn: BN;
  inputTokenMint: PublicKey;
  lbPair: PublicKey;
  connection: Connection;
  swapSlippageBps: number;
  minDeltaId: number;
  maxDeltaId: number;
  strategy: StrategyType;
  singleSided?: DlmmSingleSided;
}

export interface DlmmIndirectSwapEstimateResult {
  swapToX: JupiterQuoteResponse | null;
  swapToY: JupiterQuoteResponse | null;
  swapAmountToX: BN;
  swapAmountToY: BN;
  postSwapX: BN;
  postSwapY: BN;
}

export interface DlmmIndirectSwapEstimateContext {
  amountIn: BN;
  inputTokenMint: PublicKey;
  lbPair: PublicKey;
  swapSlippageBps: number;
  minDeltaId: number;
  maxDeltaId: number;
  strategy: StrategyType;
  singleSided?: DlmmSingleSided;
}

export interface DlmmIndirectSwapEstimate {
  result: DlmmIndirectSwapEstimateResult;
  context: DlmmIndirectSwapEstimateContext;
}

export interface RebalanceDlmmPositionParams {
  lbPair: PublicKey;
  position: PublicKey;
  user: PublicKey;
  minDeltaId: number;
  maxDeltaId: number;
  liquiditySlippageBps: number;
  swapSlippageBps: number;
  strategy: StrategyType;
  favorXInActiveId: boolean;
  directSwapEstimate: DlmmDirectEstimateResult;
  maxAccounts?: number;
}

export interface RebalanceDlmmPositionResponse {
  setupTransaction?: Transaction;
  initBinArrayTransaction?: Transaction;
  rebalancePositionTransaction?: Transaction;
  swapTransaction?: Transaction;
  ledgerTransaction: Transaction;
  zapInTransaction: Transaction;
  cleanUpTransaction: Transaction;
  estimation: {
    currentBalances: {
      tokenX: BN;
      tokenY: BN;
    };
    afterSwap: {
      tokenX: BN;
      tokenY: BN;
    };
  };
}

export interface GetZapInDlmmIndirectParams {
  user: PublicKey;
  lbPair: PublicKey;
  inputTokenMint: PublicKey;
  amountIn: BN;
  maxActiveBinSlippage: number;
  minDeltaId: number;
  maxDeltaId: number;
  strategy: StrategyType;
  favorXInActiveId: boolean;
  maxAccounts: number;
  swapSlippageBps: number;
  maxTransferAmountExtendPercentage: number;
  indirectSwapEstimate: DlmmIndirectSwapEstimateResult;
  singleSided?: DlmmSingleSided;
}

export interface GetZapInDlmmDirectParams {
  user: PublicKey;
  lbPair: PublicKey;
  inputTokenMint: PublicKey;
  amountIn: BN;
  maxActiveBinSlippage: number;
  minDeltaId: number;
  maxDeltaId: number;
  strategy: StrategyType;
  favorXInActiveId: boolean;
  maxAccounts: number;
  swapSlippageBps: number;
  maxTransferAmountExtendPercentage: number;
  directSwapEstimate: DlmmDirectEstimateResult;
  singleSided?: DlmmSingleSided;
}

export type ZapInDlmmIndirectPoolParam = {
  user: PublicKey;
  lbPair: PublicKey;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  tokenXProgram: PublicKey;
  tokenYProgram: PublicKey;
  activeId: number;
  minDeltaId: number;
  maxDeltaId: number;
  maxActiveBinSlippage: number;
  favorXInActiveId: boolean;
  strategy: StrategyType;
  maxTransferAmountX: BN;
  maxTransferAmountY: BN;
  preInstructions: TransactionInstruction[];
  swapTransactions: Transaction[];
  cleanUpInstructions: TransactionInstruction[];
  binArrays: AccountMeta[];
  binArrayBitmapExtension: PublicKey | null;
  isDirectRoute: boolean;
  singleSided?: DlmmSingleSided;
};

export type ZapInDlmmDirectPoolParam = {
  user: PublicKey;
  lbPair: PublicKey;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  tokenXProgram: PublicKey;
  tokenYProgram: PublicKey;
  activeId: number;
  minDeltaId: number;
  maxDeltaId: number;
  maxActiveBinSlippage: number;
  favorXInActiveId: boolean;
  strategy: StrategyType;
  amount: BN;
  maxTransferAmount: BN;
  preInstructions: TransactionInstruction[];
  swapTransactions: Transaction[];
  cleanUpInstructions: TransactionInstruction[];
  binArrays: AccountMeta[];
  binArrayBitmapExtension: PublicKey | null;
  isDirectRoute: boolean;
  isTokenX: boolean;
  singleSided?: DlmmSingleSided;
};

export type ZapInDlmmResponse = {
  setupTransaction?: Transaction;
  swapTransactions: Transaction[];
  ledgerTransaction: Transaction;
  zapInTransaction: Transaction;
  cleanUpTransaction: Transaction;
};

//#endregion ZapIn Types
