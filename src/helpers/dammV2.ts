import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DAMM_V2_PROGRAM_ID, DAMM_V2_SWAP_DISCRIMINATOR } from "../constants";
import { CpAmm, derivePoolAuthority, PoolState } from "@meteora-ag/cp-amm-sdk";
import { deriveDammV2EventAuthority } from "./pda";
import BN from "bn.js";

export async function getDammV2Pool(
  connection: Connection,
  poolAddress: PublicKey
): Promise<PoolState> {
  const cpAmmClient = new CpAmm(connection);
  return await cpAmmClient.fetchPoolState(poolAddress);
}

export async function getDammV2RemainingAccounts(
  poolAddress: PublicKey,
  user: PublicKey,
  userInputTokenAccount: PublicKey,
  userTokenOutAccount: PublicKey,
  tokenAProgram = TOKEN_PROGRAM_ID,
  tokenBProgram = TOKEN_PROGRAM_ID,
  poolState: PoolState
): Promise<
  Array<{
    isSigner: boolean;
    isWritable: boolean;
    pubkey: PublicKey;
  }>
> {
  const remainingAccounts = [
    {
      isSigner: false,
      isWritable: false,
      pubkey: derivePoolAuthority(),
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: poolAddress,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: userInputTokenAccount,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: userTokenOutAccount,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: poolState.tokenAVault,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: poolState.tokenBVault,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: poolState.tokenAMint,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: poolState.tokenBMint,
    },
    {
      isSigner: true,
      isWritable: false,
      pubkey: user,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: tokenAProgram,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: tokenBProgram,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: DAMM_V2_PROGRAM_ID,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: deriveDammV2EventAuthority(),
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: DAMM_V2_PROGRAM_ID,
    },
  ];

  return remainingAccounts;
}

/**
 * Creates payload data for DAMM V2 swap instruction
 * @param amountIn - The input amount for the swap
 * @param minimumSwapAmountOut - The minimum amount out for the swap
 * @returns Buffer containing the payload data
 */
export function createDammV2SwapPayload(
  amountIn: BN,
  minimumSwapAmountOut: BN
): Buffer {
  return Buffer.concat([
    Buffer.from(DAMM_V2_SWAP_DISCRIMINATOR),
    amountIn.toArrayLike(Buffer, "le", 8),
    minimumSwapAmountOut.toArrayLike(Buffer, "le", 8),
  ]);
}
