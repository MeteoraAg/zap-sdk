import { LiteSVM } from "litesvm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { expect } from "chai";

import {
  startSvm,
  generateKpAndFund,
  sendV0Instructions,
  createToken,
  mintToken,
  getTokenBalance,
  setupDlmmProPoolAndRemoveLiquidity,
  zapOutDlmmPro,
} from "./helpers";

describe("Zap out DLMM Pro", () => {
  let svm: LiteSVM;
  let user: Keypair;
  let admin: Keypair;
  let tokenXMint: PublicKey;
  let tokenYMint: PublicKey;

  beforeEach(() => {
    svm = startSvm();

    user = generateKpAndFund(svm);
    admin = generateKpAndFund(svm);

    tokenXMint = createToken(svm, admin, admin.publicKey, null);
    tokenYMint = createToken(svm, admin, admin.publicKey, null);
    mintToken(svm, admin, tokenXMint, admin, admin.publicKey);
    mintToken(svm, admin, tokenYMint, admin, admin.publicKey);

    mintToken(svm, admin, tokenXMint, admin, user.publicKey);
    mintToken(svm, admin, tokenYMint, admin, user.publicKey);
  });

  for (const direction of ["x->y", "y->x"] as const) {
    it(`zap out ${direction} through DLMM Pro pool`, async () => {
      const [inputTokenMint, outputTokenMint] =
        direction === "x->y"
          ? [tokenXMint, tokenYMint]
          : [tokenYMint, tokenXMint];
      const { pool, removeLiquidityTx, estimatedAmountIn, estimatedAmountOut } =
        await setupDlmmProPoolAndRemoveLiquidity(
          svm,
          admin,
          user,
          tokenXMint,
          tokenYMint,
          inputTokenMint,
        );

      const userTokenInAccount = getAssociatedTokenAddressSync(
        inputTokenMint,
        user.publicKey,
      );
      const userTokenOutAccount = getAssociatedTokenAddressSync(
        outputTokenMint,
        user.publicKey,
      );
      const preUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
      const preUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

      const zapOutTx = await zapOutDlmmPro(
        svm,
        user.publicKey,
        inputTokenMint,
        pool,
        estimatedAmountIn,
      );

      sendV0Instructions(
        svm,
        [...removeLiquidityTx.instructions, ...zapOutTx.instructions],
        zapOutTx.addressLookupTableAccounts,
        [user],
      );

      const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
      const postUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

      // 100% of the removed input token is swapped, so the input balance must equal the starting balance.
      expect(postUserTokenInBalance.toString()).to.equal(
        preUserTokenInBalance.toString(),
      );
      // The swap pays out on top of the output token the removal itself returns.
      expect(
        postUserTokenOutBalance
          .sub(preUserTokenOutBalance)
          .gt(estimatedAmountOut),
      ).to.be.true;
    });
  }
});
