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
  setupPoolAndRemoveLiquidity,
  zapOutDammV2,
  zapOutJupV6ThroughDammv2,
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

  for (const direction of ["a->b", "b->a"] as const) {
    it(`zap out ${direction} through DAMM V2 pool`, async () => {
      const inputTokenMint = direction === "a->b" ? tokenAMint : tokenBMint;
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

    it(`zap out ${direction} through Jupiter`, async () => {
      const inputTokenMint = direction === "a->b" ? tokenAMint : tokenBMint;
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
  }

  for (const {
    version,
    discriminator,
    amountInOffset,
  } of JUPITER_API_VERSION_CASES) {
    for (const direction of ["a->b", "b->a"] as const) {
      it(`zapOutThroughJupiter ${direction} with Jupiter API ${version}`, async () => {
        const inputTokenMint = direction === "a->b" ? tokenAMint : tokenBMint;
        const outputTokenMint = direction === "a->b" ? tokenBMint : tokenAMint;
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

        const config = { jupiterApiVersion: version };
        const jupiterFetch = mockJupiterFetch(
          svm,
          user.publicKey,
          inputTokenMint,
          [
            {
              outputMint: outputTokenMint,
              swapPool: pool,
              outAmount: new BN(1),
            },
          ],
        );
        try {
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
        } finally {
          jupiterFetch.restore();
        }

        const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
        const postUserTokenOutBalance = getTokenBalance(
          svm,
          userTokenOutAccount,
        );

        expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
        // 100% of the removed input token is swapped, so the input balance must end exactly where it started.
        // A wrong amount_in offset makes the program splice into the wrong bytes and swap a different amount.
        expect(postUserTokenInBalance.toString()).to.equal(
          preUserTokenInBalance.toString(),
        );
      });
    }
  }
});
