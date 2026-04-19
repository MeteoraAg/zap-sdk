import { LiteSVM } from "litesvm";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  CollectFeeMode,
  getAmountAFromLiquidityDelta,
  getAmountBFromLiquidityDelta,
  Rounding,
} from "@meteora-ag/cp-amm-sdk";

import {
  startSvm,
  generateKpAndFund,
  signAndSendTransaction,
  createToken,
  mintToken,
  createDammV2Pool,
  createPositionAndAddLiquidity,
  removeLiquidity,
  getTokenBalance,
  getTokenProgram,
  getDammV2Pool,
  getDammV2Position,
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

    user = generateKpAndFund(svm);
    admin = generateKpAndFund(svm);

    tokenAMint = createToken(svm, admin, admin.publicKey, null);
    tokenBMint = createToken(svm, admin, admin.publicKey, null);
    mintToken(svm, admin, tokenAMint, admin, admin.publicKey);
    mintToken(svm, admin, tokenBMint, admin, admin.publicKey);

    mintToken(svm, admin, tokenAMint, admin, user.publicKey);
    mintToken(svm, admin, tokenBMint, admin, user.publicKey);
  });

  it("zap out a->b through DAMM V2 pool", async () => {
    const inputTokenMint = tokenAMint;
    const {
      pool,
      removeLiquidityTx,
      userTokenInAccount,
      userTokenOutAccount,
      preUserTokenInBalance,
      preUserTokenOutBalance,
      estimatedAmountIn,
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
      estimatedAmountIn,
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

  it("zap out b->a through DAMM V2 pool", async () => {
    const inputTokenMint = tokenBMint;
    const {
      pool,
      removeLiquidityTx,
      userTokenInAccount,
      userTokenOutAccount,
      preUserTokenInBalance,
      preUserTokenOutBalance,
      estimatedAmountIn,
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
      estimatedAmountIn,
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

  it("zap out a->b through Jupiter", async () => {
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

  it("zap out b->a through Jupiter", async () => {
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
  const positionState = getDammV2Position(svm, userPosition);
  const collectFeeMode = poolState.collectFeeMode as CollectFeeMode;

  const amountARemoved = getAmountAFromLiquidityDelta(
    poolState.sqrtPrice,
    poolState.sqrtMaxPrice,
    positionState.unlockedLiquidity,
    Rounding.Down,
    collectFeeMode,
    poolState.tokenAAmount,
    poolState.liquidity,
  );
  const amountBRemoved = getAmountBFromLiquidityDelta(
    poolState.sqrtMinPrice,
    poolState.sqrtPrice,
    positionState.unlockedLiquidity,
    Rounding.Down,
    collectFeeMode,
    poolState.tokenBAmount,
    poolState.liquidity,
  );

  const isInputTokenA = poolState.tokenAMint.equals(inputTokenMint);
  const estimatedAmountIn = isInputTokenA ? amountARemoved : amountBRemoved;

  const outputTokenMint = isInputTokenA
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
    estimatedAmountIn,
  };
}
