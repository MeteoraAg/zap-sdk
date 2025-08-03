import { Connection, PublicKey } from "@solana/web3.js";
import { DammV2Pool } from "../types";
import { createDammV2Program } from "./createProgram";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { deriveDammV2EventAuthority, deriveDammV2PoolAuthority } from "./pda";
import { DAMM_V2_PROGRAM_ID } from "../constants";

export async function getDammV2Pool(
  connection: Connection,
  poolAddress: PublicKey
): Promise<DammV2Pool> {
  const program = createDammV2Program(connection);
  const account = await connection.getAccountInfo(poolAddress);
  if (!account) {
    throw new Error(`Pool account not found: ${poolAddress.toString()}`);
  }
  return program.coder.accounts.decode("pool", Buffer.from(account.data));
}

export async function getDammV2RemainingAccounts(
  connection: Connection,
  poolAddress: PublicKey,
  user: PublicKey,
  userInputTokenAccount: PublicKey,
  userTokenOutAccount: PublicKey,
  tokenAProgram = TOKEN_PROGRAM_ID,
  tokenBProgram = TOKEN_PROGRAM_ID
): Promise<
  Array<{
    isSigner: boolean;
    isWritable: boolean;
    pubkey: PublicKey;
  }>
> {
  const poolState = await getDammV2Pool(connection, poolAddress);
  const remainingAccounts = [
    {
      isSigner: false,
      isWritable: false,
      pubkey: deriveDammV2PoolAuthority(),
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
