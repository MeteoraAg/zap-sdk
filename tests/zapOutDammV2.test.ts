import { LiteSVM } from "litesvm";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { expect } from "chai";

import {
  startSvm,
  generateKpAndFund,
  sendInstructions,
  sendV0Instructions,
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
import { DEFAULT_JUPITER_API_VERSION } from "../src/constants";

describe("Zap out DAMM V2", () => {
  let svm: LiteSVM;
  let user: Keypair;
  let admin: Keypair;
  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;
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

    tokenAMint = createToken(svm, admin, admin.publicKey, null);
    tokenBMint = createToken(svm, admin, admin.publicKey, null);
    mintToken(svm, admin, tokenAMint, admin, admin.publicKey);
    mintToken(svm, admin, tokenBMint, admin, admin.publicKey);

    mintToken(svm, admin, tokenAMint, admin, user.publicKey);
    mintToken(svm, admin, tokenBMint, admin, user.publicKey);
  });

  // Zaps out the removed liquidity through the DAMM V2 pool, sends the instructions as
  // `transactionType` transactions and checks the whole input is swapped to the output token.
  async function expectZapOutThroughPool(
    direction: "a->b" | "b->a",
    transactionType: "v0" | "legacy",
  ) {
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

    const instructions = [
      ...removeLiquidityTx.instructions,
      ...zapOutTx.instructions,
    ];
    if (transactionType === "legacy") {
      sendInstructions(svm, instructions, [user]);
    } else {
      sendV0Instructions(
        svm,
        instructions,
        zapOutTx.addressLookupTableAccounts,
        [user],
      );
    }

    const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
    const postUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

    expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
    expect(postUserTokenInBalance.toString()).to.equal(
      preUserTokenInBalance.toString(),
    );
  }

  // The instructions must also work for a client that sends legacy transactions without lookup tables.
  it("zap out a->b through DAMM V2 pool, sent as legacy transactions", async () => {
    await expectZapOutThroughPool("a->b", "legacy");
  });

  for (const direction of ["a->b", "b->a"] as const) {
    it(`zap out ${direction} through DAMM V2 pool`, async () => {
      await expectZapOutThroughPool(direction, "v0");
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

      sendV0Instructions(
        svm,

        [...removeLiquidityTx.instructions, ...zapOutTx.instructions],

        zapOutTx.addressLookupTableAccounts,

        [user],
      );

      const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
      const postUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

      expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
      expect(postUserTokenInBalance.toString()).to.equal(
        preUserTokenInBalance.toString(),
      );
    });
  }

  // The swap is quoted and built under the SDK default Jupiter API version.
  const { discriminator, amountInOffset } = JUPITER_API_VERSION_CASES.find(
    ({ version }) => version === DEFAULT_JUPITER_API_VERSION,
  )!;

  for (const direction of ["a->b", "b->a"] as const) {
    it(`zapOutThroughJupiter ${direction}`, async () => {
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

      restoreJupiterFetch = mockJupiterFetch(
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
      ).restore;

      const quoteResponse = await getJupiterQuote({
        inputMint: inputTokenMint,
        outputMint: outputTokenMint,
        amount: estimatedAmountIn,
        user: user.publicKey,
        queryParams: { maxAccounts: 50, slippageBps: 50 },
      });
      expect(quoteResponse).to.not.be.null;

      const swapInstructionResponse = await getJupiterSwapInstruction(
        user.publicKey,
        quoteResponse!,
      );

      const data = Buffer.from(
        swapInstructionResponse.swapInstruction.data,
        "base64",
      );
      expect([...data.subarray(0, 8)]).to.deep.equal(discriminator);
      expect(
        getJupiterInstructionLayout(data).amountInOffset(data.length),
      ).to.equal(amountInOffset(data.length));

      const zap = new Zap(createLiteSvmConnection(svm));
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

      sendV0Instructions(
        svm,

        [...removeLiquidityTx.instructions, ...zapOutTx.instructions],

        zapOutTx.addressLookupTableAccounts,

        [user],
      );

      const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
      const postUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

      expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
      // 100% of the removed input token is swapped, so the input balance must end exactly where it started.
      // A wrong amount_in offset makes the program splice into the wrong bytes and swap a different amount.
      expect(postUserTokenInBalance.toString()).to.equal(
        preUserTokenInBalance.toString(),
      );
    });
  }
});
