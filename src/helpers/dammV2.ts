import { PublicKey } from "@solana/web3.js";
import {
  CpAmm,
  derivePoolAuthority,
  PoolState,
  CP_AMM_PROGRAM_ID,
  getTokenProgram,
} from "@meteora-ag/cp-amm-sdk";
import { deriveZapAuthorityAddress } from "../pda";

function deriveDammV2EventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    CP_AMM_PROGRAM_ID
  )[0];
}

export function getSwapDammV2Accounts(
  pool: PublicKey,
  poolState: PoolState,
  inputTokenAccount: PublicKey,
  outputTokenAccount: PublicKey
): Array<{
  isSigner: boolean;
  isWritable: boolean;
  pubkey: PublicKey;
}> {
  const tokenAProgram = getTokenProgram(poolState.tokenAFlag);
  const tokenBProgram = getTokenProgram(poolState.tokenBFlag);
  const remainingAccounts = [
    {
      isSigner: false,
      isWritable: false,
      pubkey: derivePoolAuthority(),
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: pool,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: inputTokenAccount,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: outputTokenAccount,
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
      isSigner: false,
      isWritable: false,
      pubkey: deriveZapAuthorityAddress(),
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
      pubkey: CP_AMM_PROGRAM_ID, // set default referralTokenAccount to null
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: deriveDammV2EventAuthority(),
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: CP_AMM_PROGRAM_ID,
    },
  ];

  return remainingAccounts;
}
