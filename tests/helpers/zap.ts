import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import {
  DAMM_V2_PROGRAM_ID,
  DAMM_V2_SWAP_DISCRIMINATOR,
  AMOUNT_IN_DAMM_V2_OFFSET,
} from "../../src/constants";
import { Zap } from "../../src/idl/zap/idl";
import ZapIDL from "../../src/idl/zap/idl.json";
import { getDammV2Pool, getDammV2RemainingAccounts } from "./damm_v2";
import { getTokenBalance, getTokenProgram } from "./token";

export type ZapProgram = Program<Zap>;

export function createZapProgram(): ZapProgram {
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(
    new Connection(clusterApiUrl("devnet")),
    wallet,
    {},
  );
  return new Program<Zap>(ZapIDL as Zap, provider);
}

export async function zapOutDammV2(
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

  const remainingAccounts = getDammV2RemainingAccounts(
    svm,
    pool,
    user,
    userTokenInAccount,
    userTokenOutAccount,
  );

  const minAmountOutBuffer = new BN(10).toArrayLike(Buffer, "le", 8);
  const amount = new BN(0).toArrayLike(Buffer, "le", 8);
  const payloadData = Buffer.concat([
    Buffer.from(DAMM_V2_SWAP_DISCRIMINATOR),
    amount,
    minAmountOutBuffer,
  ]);

  return await zapProgram.methods
    .zapOut({
      percentage: 100,
      offsetAmountIn: AMOUNT_IN_DAMM_V2_OFFSET,
      preUserTokenBalance,
      maxSwapAmount: new BN("1000000000000"),
      payloadData,
    })
    .accountsPartial({
      userTokenInAccount,
      ammProgram: DAMM_V2_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .transaction();
}
