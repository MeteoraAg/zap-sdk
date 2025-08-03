import { Program, IdlTypes, IdlAccounts } from "@coral-xyz/anchor";
import { PoolState } from "@meteora-ag/cp-amm-sdk";
import DLMM from "@meteora-ag/dlmm";
import {
  AccountMeta,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Zap as ZapTypes } from "./idl/zap/idl";
import { CpAmm } from "./idl/damm-v2/idl";

export type ZapProgram = Program<ZapTypes>;

export type ZapOutParameters = IdlTypes<ZapTypes>["zapOutParameters"];

export type ZapOutParams = {
  userTokenInAccount: PublicKey;
  zapOutParams: ZapOutParameters;
  remainingAccounts: AccountMeta[];
  ammProgram: PublicKey;
  preInstructions?: TransactionInstruction[];
};

export type ZapOutThroughDammV2Params = {
  user: PublicKey;
  poolAddress: PublicKey;
  inputMint: PublicKey;
  inputTokenProgram: PublicKey;
  amountIn: BN;
  minimumSwapAmountOut: BN;
  maxSwapAmount: BN;
  percentageToZapOut: number;
};

export type ZapOutThroughDlmmParams = {
  user: PublicKey;
  poolAddress: PublicKey;
  inputTokenMint: PublicKey;
  minimumSwapAmountOut: BN;
  dlmm: DLMM;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
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

export type DammV2Pool = IdlAccounts<CpAmm>["pool"];
export type DammV2Position = IdlAccounts<CpAmm>["position"];
