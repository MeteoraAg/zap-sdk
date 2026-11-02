import { LiteSVM } from "litesvm";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { expect } from "chai";

import {
  startSvm,
  generateKpAndFund,
  sendV0Instructions,
  createToken,
  mintToken,
  getTokenBalance,
  getTokenProgram,
  setupDlmmPoolAndRemoveLiquidity,
  zapOutDlmm,
  zapOutJupV6ThroughDlmm,
  createLiteSvmConnection,
  getAccount,
  mockJupiterFetch,
  JUPITER_API_VERSION_CASES,
} from "./helpers";
import { Zap } from "../src/zap";
import {
  getJupiterInstructionLayout,
  getJupiterQuote,
  getJupiterSwapInstruction,
} from "../src/helpers/jupiter";
import { isCreateAtaInstruction } from "../src/helpers/token";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DEFAULT_JUPITER_API_VERSION } from "../src/constants";

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

  for (const direction of ["x->y", "y->x"] as const) {
    it(`zapOutThroughJupiter ${direction}`, async () => {
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

      // The route passes through token D, so Jupiter's setup creates the user's token D account.
      const tokenDMint = createToken(svm, admin, admin.publicKey, null);
      const userTokenD = getAssociatedTokenAddressSync(
        tokenDMint,
        user.publicKey,
        true,
        getTokenProgram(svm, tokenDMint),
      );

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
            intermediateMints: [tokenDMint],
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

      // Jupiter's setup repeats the input and output accounts the zap creates, and only token D is added.
      const createdAccounts = zapOutTx.instructions
        .filter(isCreateAtaInstruction)
        .map((ix) => ix.keys[1].pubkey.toBase58());
      expect(new Set(createdAccounts).size).to.equal(createdAccounts.length);
      expect(createdAccounts).to.include(userTokenD.toBase58());

      sendV0Instructions(
        svm,

        [...removeLiquidityTx.instructions, ...zapOutTx.instructions],

        zapOutTx.addressLookupTableAccounts,

        [user],
      );

      expect(getAccount(svm, userTokenD)).to.not.be.null;

      const postUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
      const postUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

      expect(postUserTokenOutBalance.gt(preUserTokenOutBalance)).to.be.true;
      // 100% of the removed input token is swapped, so the input balance must equal the starting balance.
      expect(postUserTokenInBalance.toString()).to.equal(
        preUserTokenInBalance.toString(),
      );
    });
  }
});
