import { LiteSVM } from "litesvm";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { expect } from "chai";

import {
  startSvm,
  generateKpAndFund,
  signAndSendTransaction,
  createToken,
  mintToken,
  getTokenBalance,
  getTokenProgram,
  setupDlmmPoolAndRemoveLiquidity,
  zapOutDlmm,
  zapOutJupV6ThroughDlmm,
  createLiteSvmConnection,
  mockJupiterFetch,
  JUPITER_API_VERSION_CASES,
} from "./helpers";
import { Zap } from "../src/zap";
import {
  getJupiterInstructionLayout,
  getJupiterQuote,
  getJupiterSwapInstruction,
} from "../src/helpers/jupiter";

describe("Zap out DLMM", () => {
  let svm: LiteSVM;
  let user: Keypair;
  let admin: Keypair;
  let tokenXMint: PublicKey;
  let tokenYMint: PublicKey;
  let restoreJupiterFetch: (() => void) | null = null;

  afterEach(() => {
    if (restoreJupiterFetch) {
      restoreJupiterFetch();
      restoreJupiterFetch = null;
    }
  });

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
    it(`zap out ${direction} through DLMM pool`, async () => {
      const inputTokenMint = direction === "x->y" ? tokenXMint : tokenYMint;
      const {
        lbPair,
        removeLiquidityTx,
        userTokenInAccount,
        userTokenOutAccount,
        preUserTokenInBalance,
        preUserTokenOutBalance,
        estimatedAmountIn,
      } = await setupDlmmPoolAndRemoveLiquidity(
        svm,
        admin,
        user,
        tokenXMint,
        tokenYMint,
        inputTokenMint,
      );

      const zapOutTx = await zapOutDlmm(
        svm,
        user.publicKey,
        inputTokenMint,
        lbPair,
        estimatedAmountIn,
      );

      const finalTransaction = new Transaction()
        .add(removeLiquidityTx)
        .add(zapOutTx);

      signAndSendTransaction(svm, finalTransaction, [user]);

      const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
      const postUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

      expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
      expect(postUserTokenInBalance.toString()).to.equal(
        preUserTokenInBalance.toString(),
      );
    });

    it(`zap out ${direction} through Jupiter`, async () => {
      const inputTokenMint = direction === "x->y" ? tokenXMint : tokenYMint;
      const {
        lbPair,
        removeLiquidityTx,
        userTokenInAccount,
        userTokenOutAccount,
        preUserTokenInBalance,
        preUserTokenOutBalance,
      } = await setupDlmmPoolAndRemoveLiquidity(
        svm,
        admin,
        user,
        tokenXMint,
        tokenYMint,
        inputTokenMint,
      );

      const zapOutTx = await zapOutJupV6ThroughDlmm(
        svm,
        user.publicKey,
        inputTokenMint,
        lbPair,
      );

      const finalTransaction = new Transaction()
        .add(removeLiquidityTx)
        .add(zapOutTx);

      signAndSendTransaction(svm, finalTransaction, [user]);

      const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
      const postUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

      expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
      expect(postUserTokenInBalance.toString()).to.equal(
        preUserTokenInBalance.toString(),
      );
    });
  }

  for (const {
    version,
    discriminator,
    amountInOffset,
  } of JUPITER_API_VERSION_CASES) {
    for (const direction of ["x->y", "y->x"] as const) {
      it(`zapOutThroughJupiter ${direction} with Jupiter API ${version}`, async () => {
        const inputTokenMint = direction === "x->y" ? tokenXMint : tokenYMint;
        const outputTokenMint = direction === "x->y" ? tokenYMint : tokenXMint;
        const {
          lbPair,
          removeLiquidityTx,
          userTokenInAccount,
          userTokenOutAccount,
          preUserTokenInBalance,
          preUserTokenOutBalance,
          estimatedAmountIn,
        } = await setupDlmmPoolAndRemoveLiquidity(
          svm,
          admin,
          user,
          tokenXMint,
          tokenYMint,
          inputTokenMint,
        );

        const config = { jupiterApiVersion: version };
        restoreJupiterFetch = mockJupiterFetch(
          svm,
          user.publicKey,
          inputTokenMint,
          [
            {
              outputMint: outputTokenMint,
              swapPool: lbPair,
              outAmount: new BN(1),
              poolType: "dlmm",
            },
          ],
        ).restore;

        const quoteResponse = await getJupiterQuote(
          {
            inputMint: inputTokenMint,
            outputMint: outputTokenMint,
            amount: estimatedAmountIn,
            user: user.publicKey,
            maxAccounts: 50,
            slippageBps: 50,
          },
          config,
        );
        expect(quoteResponse).to.not.be.null;

        const swapInstructionResponse = await getJupiterSwapInstruction(
          user.publicKey,
          quoteResponse!,
          config,
        );

        const data = Buffer.from(
          swapInstructionResponse.swapInstruction.data,
          "base64",
        );
        expect([...data.subarray(0, 8)]).to.deep.equal(discriminator);
        expect(
          getJupiterInstructionLayout(data).amountInOffset(data.length),
        ).to.equal(amountInOffset(data.length));

        const zap = new Zap(createLiteSvmConnection(svm), config);
        const zapOutTx = await zap.zapOutThroughJupiter({
          user: user.publicKey,
          inputMint: inputTokenMint,
          outputMint: outputTokenMint,
          inputTokenProgram: getTokenProgram(svm, inputTokenMint),
          outputTokenProgram: getTokenProgram(svm, outputTokenMint),
          jupiterSwapResponse: swapInstructionResponse,
          maxSwapAmount: new BN("1000000000000"),
          percentageToZapOut: 100,
        });

        const finalTransaction = new Transaction()
          .add(removeLiquidityTx)
          .add(zapOutTx);

        signAndSendTransaction(svm, finalTransaction, [user]);

        const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
        const postUserTokenOutBalance = getTokenBalance(
          svm,
          userTokenOutAccount,
        );

        expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
        // 100% of the removed input token is swapped, so the input balance must equal the starting balance.
        expect(postUserTokenInBalance.toString()).to.equal(
          preUserTokenInBalance.toString(),
        );
      });
    }
  }
});
