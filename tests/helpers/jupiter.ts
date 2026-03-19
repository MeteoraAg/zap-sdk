import { BN } from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { derivePoolAuthority } from "@meteora-ag/cp-amm-sdk";

import { DAMM_V2_PROGRAM_ID, JUP_V6_PROGRAM_ID } from "../../src/constants";
import { getDammV2Pool } from "./damm_v2";
import { createZapProgram } from "./zap";
import { getTokenBalance, getTokenProgram } from "./token";

export const JUP_ROUTE_DISC = [229, 23, 203, 151, 122, 227, 173, 42];

function deriveJupV6EventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    JUP_V6_PROGRAM_ID,
  )[0];
}

function deriveDammV2EventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DAMM_V2_PROGRAM_ID,
  )[0];
}

export function getJupRemainingAccounts(
  svm: LiteSVM,
  pool: PublicKey,
  user: PublicKey,
  userTokenInAccount: PublicKey,
  userTokenOutAccount: PublicKey,
  outputMint: PublicKey,
  tokenAProgram = TOKEN_PROGRAM_ID,
  tokenBProgram = TOKEN_PROGRAM_ID,
): Array<{
  isSigner: boolean;
  isWritable: boolean;
  pubkey: PublicKey;
}> {
  const poolState = getDammV2Pool(svm, pool);

  return [
    // Jupiter accounts
    {
      isSigner: false,
      isWritable: false,
      pubkey: TOKEN_PROGRAM_ID,
    },
    {
      pubkey: user,
      isSigner: true,
      isWritable: false,
    },
    {
      pubkey: userTokenInAccount,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: userTokenOutAccount,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: JUP_V6_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: outputMint,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: JUP_V6_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: deriveJupV6EventAuthority(),
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: JUP_V6_PROGRAM_ID,
    },
    // DAMM V2 swap accounts
    {
      pubkey: DAMM_V2_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: derivePoolAuthority(),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: pool,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: userTokenInAccount,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: userTokenOutAccount,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: poolState.tokenAVault,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: poolState.tokenBVault,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: poolState.tokenAMint,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: poolState.tokenBMint,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: user,
      isSigner: true,
      isWritable: false,
    },
    {
      pubkey: tokenAProgram,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: tokenBProgram,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: DAMM_V2_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
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
}

// jup v6 aggregator with route_plan that swaps through DAMM V2 pool
export async function zapOutJupV6ThroughDammv2(
  svm: LiteSVM,
  user: PublicKey,
  inputTokenMint: PublicKey,
  pool: PublicKey,
): Promise<Transaction> {
  const zapProgram = createZapProgram();
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

  return await zapProgram.methods
    .zapOut({
      percentage: 100,
      offsetAmountIn:
        JUP_ROUTE_DISC.length +
        routeStepPlanCount.length +
        routeStepPlanBuffer.length,
      preUserTokenBalance,
      maxSwapAmount: new BN("1000000000000"),
      payloadData,
    })
    .accountsPartial({
      userTokenInAccount,
      ammProgram: JUP_V6_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .transaction();
}
