import { Program, IdlTypes } from "@coral-xyz/anchor";
import {
  AccountMeta,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Zap } from "./idl/zap/idl";

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

export const StrategyType = {
  spot: { spot: {} },
  curve: { curve: {} },
  bidAsk: { bidAsk: {} },
} as const;

export type DlmmStrategyType = (typeof StrategyType)[keyof typeof StrategyType];

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
  swapTransaction: Transaction | null;
};

export enum SwapExternalType {
  swapToA,
  swapToB,
  swapToBoth,
}

export type ZapInDammV2InDirectPoolParam = Omit<
  ZapInDammV2DirectPoolParam,
  "maxTransferAmount"
> & {
  swapType: SwapExternalType;
  maxTransferAmountA: BN;
  maxTransferAmountB: BN;
};

export type ZapInDammV2Response = {
  setupTransaction: Transaction;
  swapTransaction: Transaction;
  initializeLedgerTx: Transaction;
  ledgerTransaction: Transaction;
  zapInTx: Transaction;
  closeLedgerTx: Transaction;
};
