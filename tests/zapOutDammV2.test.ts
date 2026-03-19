import { LiteSVM } from "litesvm";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import {
  startSvm,
  signAndSendTransaction,
  createToken,
  mintToken,
  createDammV2Pool,
  createPositionAndAddLiquidity,
  removeLiquidity,
  getTokenBalance,
  getTokenProgram,
  getDammV2Pool,
  zapOutDammV2,
  zapOutJupV6ThroughDammv2,
} from "./helpers";

describe("Zap out DAMM V2", () => {
  let svm: LiteSVM;
  let user: Keypair;
  let admin: Keypair;
  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;

  beforeEach(() => {
    svm = startSvm();

    user = Keypair.generate();
    admin = Keypair.generate();
    svm.airdrop(user.publicKey, BigInt(LAMPORTS_PER_SOL));
    svm.airdrop(admin.publicKey, BigInt(LAMPORTS_PER_SOL));

    tokenAMint = createToken(svm, admin, admin.publicKey, null);
    tokenBMint = createToken(svm, admin, admin.publicKey, null);
    mintToken(svm, admin, tokenAMint, admin, admin.publicKey);
    mintToken(svm, admin, tokenBMint, admin, admin.publicKey);

    mintToken(svm, admin, tokenAMint, admin, user.publicKey);
    mintToken(svm, admin, tokenBMint, admin, user.publicKey);
  });

  it("zap a->b through DAMM V2 pool", async () => {
    const inputTokenMint = tokenAMint;
    const {
      pool,
      removeLiquidityTx,
      userTokenInAccount,
      userTokenOutAccount,
      preUserTokenInBalance,
      preUserTokenOutBalance,
    } = await setupPoolAndRemoveLiquidity(
      svm,
      admin,
      user,
      tokenAMint,
      tokenBMint,
      inputTokenMint,
    );

    const zapOutTx = await zapOutDammV2(
      svm,
      user.publicKey,
      inputTokenMint,
      pool,
    );

    const finalTransaction = new Transaction()
      .add(removeLiquidityTx)
      .add(zapOutTx);

    signAndSendTransaction(svm, finalTransaction, [user]);

    const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
    const postUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

    expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
    expect(postUserTokenInBalance.lte(preUserTokenInBalance)).to.be.true;
  });

  it("zap b->a through DAMM V2 pool", async () => {
    const inputTokenMint = tokenBMint;
    const {
      pool,
      removeLiquidityTx,
      userTokenInAccount,
      userTokenOutAccount,
      preUserTokenInBalance,
      preUserTokenOutBalance,
    } = await setupPoolAndRemoveLiquidity(
      svm,
      admin,
      user,
      tokenAMint,
      tokenBMint,
      inputTokenMint,
    );

    const zapOutTx = await zapOutDammV2(
      svm,
      user.publicKey,
      inputTokenMint,
      pool,
    );

    const finalTransaction = new Transaction()
      .add(removeLiquidityTx)
      .add(zapOutTx);

    signAndSendTransaction(svm, finalTransaction, [user]);

    const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
    const postUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

    expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
    expect(postUserTokenInBalance.lte(preUserTokenInBalance)).to.be.true;
  });

  it("zap a->b through Jupiter", async () => {
    const inputTokenMint = tokenAMint;
    const {
      pool,
      removeLiquidityTx,
      userTokenInAccount,
      userTokenOutAccount,
      preUserTokenInBalance,
      preUserTokenOutBalance,
    } = await setupPoolAndRemoveLiquidity(
      svm,
      admin,
      user,
      tokenAMint,
      tokenBMint,
      inputTokenMint,
    );

    const zapOutTx = await zapOutJupV6ThroughDammv2(
      svm,
      user.publicKey,
      inputTokenMint,
      pool,
    );

    const finalTransaction = new Transaction()
      .add(removeLiquidityTx)
      .add(zapOutTx);

    signAndSendTransaction(svm, finalTransaction, [user]);

    const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
    const postUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

    expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
    expect(postUserTokenInBalance.lte(preUserTokenInBalance)).to.be.true;
  });

  it("zap b->a through Jupiter", async () => {
    const inputTokenMint = tokenBMint;
    const {
      pool,
      removeLiquidityTx,
      userTokenInAccount,
      userTokenOutAccount,
      preUserTokenInBalance,
      preUserTokenOutBalance,
    } = await setupPoolAndRemoveLiquidity(
      svm,
      admin,
      user,
      tokenAMint,
      tokenBMint,
      inputTokenMint,
    );

    const zapOutTx = await zapOutJupV6ThroughDammv2(
      svm,
      user.publicKey,
      inputTokenMint,
      pool,
    );

    const finalTransaction = new Transaction()
      .add(removeLiquidityTx)
      .add(zapOutTx);

    signAndSendTransaction(svm, finalTransaction, [user]);

    const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
    const postUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

    expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
    expect(postUserTokenInBalance.lte(preUserTokenInBalance)).to.be.true;
  });
});

async function setupPoolAndRemoveLiquidity(
  svm: LiteSVM,
  admin: Keypair,
  user: Keypair,
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
  inputTokenMint: PublicKey,
) {
  const pool = await createDammV2Pool({
    svm,
    creator: admin,
    tokenAMint,
    tokenBMint,
  });

  const userPosition = await createPositionAndAddLiquidity(svm, user, pool);

  const tokenAAccount = getAssociatedTokenAddressSync(
    tokenAMint,
    user.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );
  const tokenBAccount = getAssociatedTokenAddressSync(
    tokenBMint,
    user.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );

  const removeLiquidityTx = await removeLiquidity(
    svm,
    user.publicKey,
    pool,
    userPosition,
    tokenAAccount,
    tokenBAccount,
  );

  const poolState = getDammV2Pool(svm, pool);
  const outputTokenMint = poolState.tokenAMint.equals(inputTokenMint)
    ? poolState.tokenBMint
    : poolState.tokenAMint;

  const inputTokenProgram = getTokenProgram(svm, inputTokenMint);
  const outputTokenProgram = getTokenProgram(svm, outputTokenMint);

  const userTokenInAccount = getAssociatedTokenAddressSync(
    inputTokenMint,
    user.publicKey,
    true,
    inputTokenProgram,
  );
  const userTokenOutAccount = getAssociatedTokenAddressSync(
    outputTokenMint,
    user.publicKey,
    true,
    outputTokenProgram,
  );

  const preUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
  const preUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

  return {
    pool,
    removeLiquidityTx,
    userTokenInAccount,
    userTokenOutAccount,
    preUserTokenInBalance,
    preUserTokenOutBalance,
  };
}
