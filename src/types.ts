import { PoolState, VestingState } from "@meteora-ag/cp-amm-sdk";
import DLMM from "@meteora-ag/dlmm";
import { AccountMeta, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export enum ActionType {
  SwapDammV2,
  SwapDlmm,
}
export type ZapOutParams = {
  actionType: number;
  payloadData: Buffer<ArrayBufferLike>;
  tokenLedgerAccount: PublicKey;
  remainingAccounts: AccountMeta[];
  ammProgram: PublicKey;
};

export type ZapOutSwapDammV2Params = {
  user: PublicKey;
  poolAddress: PublicKey;
  poolState: PoolState;
  inputTokenMint: PublicKey;
  outputTokenMint: PublicKey;
  outputTokenProgram: PublicKey;
  minimumSwapAmountOut: BN;
};

export type ZapOutSwapDlmmParams = {
  user: PublicKey;
  poolAddress: PublicKey;
  inputTokenMint: PublicKey;
  minimumSwapAmountOut: BN;
  dlmm: DLMM;
  outputTokenMint: PublicKey;
  outputTokenProgram: PublicKey;
};

export type RemoveDammV2LiquidityWithZapOutParams = {
  user: PublicKey;
  poolAddress: PublicKey;
  poolState: PoolState;
  position: PublicKey;
  positionNftAccount: PublicKey;
  liquidityDelta: BN;
  outputTokenMint: PublicKey;
  tokenAAmountThreshold: BN;
  tokenBAmountThreshold: BN;
  minimumSwapAmountOut: BN;
  vestings: Array<{
    account: PublicKey;
    vestingState: VestingState;
  }>;
};

export type RemoveDlmmLiquidityWithZapOutParams = {
  user: PublicKey;
  poolAddress: PublicKey;
  position: PublicKey;
  fromBinId: number;
  toBinId: number;
  outputTokenMint: PublicKey;
  bps: BN;
  minimumSwapAmountOut: BN;
};
