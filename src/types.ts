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
import { PoolState } from "@meteora-ag/cp-amm-sdk";

export type ZapProgram = Program<Zap>;

/** Jupiter Swap API version used for quotes and swap instructions. */
export enum JupiterApiVersion {
  /** @deprecated `GET /swap/v1/quote` + `POST /swap/v1/swap-instructions`. Use V2; v1 will be removed in a future major version. */
  V1 = "v1",
  /** `GET /swap/v2/build` (default) */
  V2 = "v2",
}

export type ZapConfig = {
  jupiterApiUrl?: string;
  jupiterApiKey?: string;
  /** Defaults to `JupiterApiVersion.V2`. */
  jupiterApiVersion?: JupiterApiVersion;
};

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
  jupiterSwapResponse: Pick<JupiterSwapInstructionResponse, "swapInstruction">;
  maxSwapAmount: BN;
  percentageToZapOut: number;
}

export type GetJupiterQuoteParams = {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: BN;
  /** Wallet the swap is built for. Sent as `taker` under v2, unused under v1. */
  user: PublicKey;
  maxAccounts: number;
  slippageBps: number;
  /** Default false */
  dynamicSlippage?: boolean;
  /** Default true */
  onlyDirectRoutes?: boolean;
  /** Default true */
  restrictIntermediateTokens?: boolean;
  /** Default true */
  forJitoBundle?: boolean;
};

export type GetJupAndDammV2QuotesParams = {
  connection: Connection;
  user: PublicKey;
  inputTokenMint: PublicKey;
  poolState: PoolState;
  tokenADecimal: number;
  tokenBDecimal: number;
  dammV2SlippageBps: number;
  jupSlippageBps: number;
  maxAccounts: number;
  config?: ZapConfig;
};

/** Quote fields shared by v1 `/quote` and v2 `/build` responses. */
export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRoutePlan[];
  /** @deprecated v1 only */
  platformFee?: any;
  /** @deprecated v1 only */
  contextSlot?: number;
  /** @deprecated v1 only */
  timeTaken?: number;
  /** @deprecated v1 only */
  swapUsdValue?: string;
  /** @deprecated v1 only */
  simplerRouteUsed?: boolean;
  /** @deprecated v1 only */
  mostReliableAmmsQuoteReport?: {
    info: Record<string, string>;
  };
  /** @deprecated v1 only */
  useIncurredSlippageForQuoting?: any;
  /** @deprecated v1 only */
  otherRoutePlans?: any;
  /** @deprecated v1 only */
  aggregatorVersion?: any;
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

export interface JupiterInstructionLayout {
  /** Byte offset of amount_in (u64 LE) inside the instruction data */
  amountInOffset: (dataLength: number) => number;
  /** Index of the user transfer authority in the instruction accounts */
  userTransferAuthorityIndex: number;
}

export interface JupiterBlockhashWithMetadata {
  blockhash: number[];
  lastValidBlockHeight: number;
  fetchedAt: {
    secs_since_epoch: number;
    nanos_since_epoch: number;
  };
}

/** Instruction fields shared by v1 `/swap-instructions` and v2 `/build` responses. */
export interface JupiterSwapInstructions {
  computeBudgetInstructions: JupiterInstruction[];
  setupInstructions: JupiterInstruction[];
  swapInstruction: JupiterInstruction;
  cleanupInstruction: JupiterInstruction | null;
  otherInstructions: JupiterInstruction[];
  tipInstruction?: JupiterInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
  blockhashWithMetadata: JupiterBlockhashWithMetadata;
}

/** Response of v2 `GET /swap/v2/build`: quote and instructions in one object. */
export type JupiterBuildResponse = JupiterQuoteResponse &
  JupiterSwapInstructions;

/** @deprecated v1 `POST /swap/v1/swap-instructions` response. Use `JupiterBuildResponse` / `JupiterSwapInstructions`. */
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

//#region Zap In Types

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

export type GetZapInDammV2IndirectPoolParams = {
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

export enum ZapInDammV2PoolSwapRoute {
  Jupiter = "jupiter",
  DammV2 = "dammV2",
}

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
  swapInEstimate: {
    inAmount: BN;
    route: ZapInDammV2PoolSwapRoute;
  };
};

export enum SwapExternalType {
  swapToA,
  swapToB,
  swapToBoth,
}

export type ZapInDammV2IndirectPoolParam = Omit<
  ZapInDammV2DirectPoolParam,
  "maxTransferAmount" | "swapInEstimate"
> & {
  swapType: SwapExternalType;
  maxTransferAmountA: BN;
  maxTransferAmountB: BN;
  swapInEstimate: {
    inAmountA: BN;
    inAmountB: BN;
    routeA: ZapInDammV2PoolSwapRoute;
    routeB: ZapInDammV2PoolSwapRoute;
  };
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

export type SwapQuoteResult =
  | {
      inAmount: BN;
      outAmount: BN;
      route: DlmmDirectSwapQuoteRoute.Jupiter;
      originalQuote: JupiterQuoteResponse;
    }
  | {
      inAmount: BN;
      outAmount: BN;
      route: DlmmDirectSwapQuoteRoute.Dlmm;
      originalQuote: SwapQuote;
    };

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
  /** Wallet the swap is built for. Sent as Jupiter `taker` under v2. */
  user: PublicKey;
  amountIn: BN;
  inputTokenMint: PublicKey;
  lbPair: PublicKey;
  connection: Connection;
  swapSlippageBps: number;
  minDeltaId: number;
  maxDeltaId: number;
  strategy: StrategyType;
  singleSided?: DlmmSingleSided;
  config?: ZapConfig;
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
  /** Wallet the swap is built for. Sent as Jupiter `taker` under v2. */
  user: PublicKey;
  position: PublicKey;
  lbPair: PublicKey;
  connection: Connection;
  minDeltaId: number;
  maxDeltaId: number;
  swapSlippageBps: number;
  strategy: StrategyType;
  config?: ZapConfig;
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
  /** Wallet the swap is built for. Sent as Jupiter `taker` under v2. */
  user: PublicKey;
  amountIn: BN;
  inputTokenMint: PublicKey;
  lbPair: PublicKey;
  connection: Connection;
  swapSlippageBps: number;
  minDeltaId: number;
  maxDeltaId: number;
  strategy: StrategyType;
  singleSided?: DlmmSingleSided;
  config?: ZapConfig;
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

//#endregion Zap In Types
