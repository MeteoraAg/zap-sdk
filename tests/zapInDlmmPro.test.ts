import { LiteSVM } from "litesvm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import {
  StrategyType,
  buildLiquidityShape,
  findNftAccount,
} from "@meteora-ag/dlmm-pro-sdk";
import BN from "bn.js";
import { expect } from "chai";

import {
  startSvm,
  generateKpAndFund,
  sendInstructions,
  sendV0Instructions,
  createLiteSvmConnection,
  createToken,
  mintToken,
  getTokenBalance,
  createDammV2Pool,
  getDammV2Pool,
  createSeededDlmmProPool,
  getDlmmProPool,
  getDlmmProPositionRanges,
  zapInDlmmProDirect,
  zapInDlmmProIndirect,
  mockJupiterFetch,
  DLMM_PRO_TICK_SPACING,
  SQRT_PRICE_50A_50B,
} from "./helpers";
import {
  DlmmProDirectSwapQuoteRoute,
  DlmmProLeftoverParameters,
  DlmmProPositionRangeParameters,
  DlmmSwapType,
  ZapInstructionsResponse,
} from "../src/types";

type TokenSide = "X" | "Y";

// The pool starts at tick 0. A Curve shape around it takes both tokens, as one range per tick
// from -8 to 9 whose weights rise from 1 at the edges to 9 at the price.
const TWO_SIDED_RANGES = buildLiquidityShape({
  strategy: StrategyType.Curve,
  minTickId: -8,
  maxTickId: 8,
  tickSpacing: DLMM_PRO_TICK_SPACING,
  currentTickId: 0,
}).ranges;
// A range above the price takes only token X.
const TOKEN_X_RANGES: DlmmProPositionRangeParameters[] = [
  { tickLowerId: 10, tickUpperId: 30, weight: 1 },
];
// Relative inner bounds are a distance from the pool tick at execution. At 150 ticks they land in
// tick arrays that neither the shape nor the outer bounds touch.
const LEFTOVER: DlmmProLeftoverParameters = {
  rangeX: { innerTickId: 150, outerTickId: 300 },
  rangeY: { innerTickId: 150, outerTickId: -300 },
  isInnerTickRelative: true,
};

describe("Zap in DLMM Pro", () => {
  let svm: LiteSVM;
  let user: Keypair;
  let admin: Keypair;
  let tokenXMint: PublicKey;
  let tokenYMint: PublicKey;
  let tokenCMint: PublicKey;
  let pool: PublicKey;
  let restoreJupiterFetch: (() => void) | null = null;

  const zapInAmount = new BN("1000000000");

  afterEach(() => {
    if (restoreJupiterFetch) {
      restoreJupiterFetch();
      restoreJupiterFetch = null;
    }
  });

  beforeEach(async () => {
    svm = startSvm();

    user = generateKpAndFund(svm);
    admin = generateKpAndFund(svm);

    tokenXMint = createToken(svm, admin, admin.publicKey, null);
    tokenYMint = createToken(svm, admin, admin.publicKey, null);
    tokenCMint = createToken(svm, admin, admin.publicKey, null);
    for (const mint of [tokenXMint, tokenYMint, tokenCMint]) {
      mintToken(svm, admin, mint, admin, admin.publicKey);
      mintToken(svm, admin, mint, admin, user.publicKey);
    }

    pool = await createSeededDlmmProPool(svm, admin, tokenXMint, tokenYMint);
  });

  function mintOf(side: TokenSide): PublicKey {
    return side === "X" ? tokenXMint : tokenYMint;
  }

  function otherSide(side: TokenSide): TokenSide {
    return side === "X" ? "Y" : "X";
  }

  function userBalance(mint: PublicKey): BN {
    return getTokenBalance(
      svm,
      getAssociatedTokenAddressSync(mint, user.publicKey),
    );
  }

  // One DAMM V2 pool per output token stands in for the Jupiter route to it. `quoteMultiplier`
  // scales the quote against what the pool pays.
  async function mockJupiterRoutes(
    inputTokenMint: PublicKey,
    outputTokenMints: PublicKey[],
    quoteMultiplier = 1,
  ) {
    const cpAmm = new CpAmm(createLiteSvmConnection(svm));
    const routes = [];
    for (const outputMint of outputTokenMints) {
      const swapPool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint: inputTokenMint,
        tokenBMint: outputMint,
        sqrtPrice: SQRT_PRICE_50A_50B,
      });
      routes.push({
        outputMint,
        swapPool,
        outAmount: (inAmount: BN) =>
          cpAmm
            .getQuote({
              inAmount,
              inputTokenMint,
              slippage: 0.5,
              poolState: getDammV2Pool(svm, swapPool) as any,
              currentTime: Number(svm.getClock().unixTimestamp),
              currentSlot: Number(svm.getClock().slot),
              tokenADecimal: 9,
              tokenBDecimal: 9,
            })
            .swapOutAmount.muln(quoteMultiplier),
      });
    }
    restoreJupiterFetch = mockJupiterFetch(
      svm,
      user.publicKey,
      inputTokenMint,
      routes,
    ).restore;
  }

  // Jupiter quotes 1 lamport out, so the DLMM Pro pool always wins the direct swap route.
  function mockJupiterLosing(inputSide: TokenSide) {
    restoreJupiterFetch = mockJupiterFetch(
      svm,
      user.publicKey,
      mintOf(inputSide),
      [
        {
          outputMint: mintOf(otherSide(inputSide)),
          swapPool: PublicKey.default,
          outAmount: new BN(1),
        },
      ],
    ).restore;
  }

  // Send the zap-in instructions packed into as few v0 transactions as fit, each with the maximum
  // compute limit. `legacy` sends legacy transactions instead, without the lookup tables.
  function sendZapIn(
    result: { nftMint: Keypair } & ZapInstructionsResponse,
    { legacy = false }: { legacy?: boolean } = {},
  ) {
    const signers = [user, result.nftMint];
    if (legacy) {
      sendInstructions(svm, result.instructions, signers, 1_400_000);
    } else {
      sendV0Instructions(
        svm,
        result.instructions,
        result.addressLookupTableAccounts,
        signers,
        1_400_000,
      );
    }
  }

  // The position is the user's, and its first ranges are `ranges`, each with liquidity in
  // proportion to its weight. Returns the multiplier and any range opened after them.
  async function expectPosition(
    nftMint: PublicKey,
    ranges: DlmmProPositionRangeParameters[],
  ) {
    expect(
      getTokenBalance(svm, findNftAccount(nftMint, user.publicKey)).toNumber(),
    ).to.equal(1);

    const positions = await getDlmmProPositionRanges(svm, nftMint);
    const multiplier = positions[0].unlockedLiquidity.divn(ranges[0].weight);
    expect(multiplier.gtn(0)).to.be.true;
    ranges.forEach((range, i) => {
      expect(positions[i].tickLowerId).to.equal(range.tickLowerId);
      expect(positions[i].tickUpperId).to.equal(range.tickUpperId);
      expect(positions[i].unlockedLiquidity.toString()).to.equal(
        multiplier.muln(range.weight).toString(),
      );
    });
    return { multiplier, leftoverRanges: positions.slice(ranges.length) };
  }

  describe("direct", () => {
    // Zaps `amountIn` of `inputSide` into the two-sided shape, swapping through the pool itself.
    async function expectTwoSidedZapIn(
      inputSide: TokenSide,
      {
        legacy = false,
        amountIn = zapInAmount,
      }: { legacy?: boolean; amountIn?: BN } = {},
    ) {
      mockJupiterLosing(inputSide);
      const inputMint = mintOf(inputSide);
      const outputMint = mintOf(otherSide(inputSide));
      const preInput = userBalance(inputMint);
      const preOutput = userBalance(outputMint);

      // The swap is the only one on the pool, so the zap in reaches exactly the estimate.
      const result = await zapInDlmmProDirect(
        svm,
        user.publicKey,
        inputMint,
        pool,
        amountIn,
        TWO_SIDED_RANGES,
        { getMinMultiplier: (multiplier) => multiplier },
      );
      const estimate = result.estimate.result;

      expect(estimate.quote?.route).to.equal(
        DlmmProDirectSwapQuoteRoute.DlmmPro,
      );

      sendZapIn(result, { legacy });

      const { multiplier, leftoverRanges } = await expectPosition(
        result.nftMint.publicKey,
        TWO_SIDED_RANGES,
      );
      expect(multiplier.toString()).to.equal(estimate.multiplier.toString());
      expect(leftoverRanges).to.be.empty;
      expect((await getDlmmProPool(svm, pool)).tickCurrentId).to.equal(
        estimate.currentTickId,
      );

      // The swap is sized so that neither token is left over, up to 0.01% of the input.
      const tolerance = amountIn.divn(10_000);
      const unusedInput = amountIn.sub(preInput.sub(userBalance(inputMint)));
      const unusedOutput = userBalance(outputMint).sub(preOutput);
      expect(unusedInput.gten(0) && unusedInput.lt(tolerance)).to.be.true;
      expect(unusedOutput.gten(0) && unusedOutput.lt(tolerance)).to.be.true;

      return estimate;
    }

    for (const inputSide of ["X", "Y"] as const) {
      it(`zap in direct - token${inputSide} into a two-sided position`, async () => {
        await expectTwoSidedZapIn(inputSide);
      });
    }

    // Half of the input swapped at once would push the pool price out of the shape, which would
    // then take none of the swap output. The swap is sized at the price it moves the pool to.
    it("zap in direct - tokenX into a two-sided position, with a swap that moves the pool price", async () => {
      const estimate = await expectTwoSidedZapIn("X", {
        amountIn: new BN("50000000000000"),
      });

      const { tickLowerId } = TWO_SIDED_RANGES[0];
      expect(estimate.currentTickId).to.be.within(tickLowerId, -2);
    });

    // The instructions must also work for a client that sends legacy transactions without lookup tables.
    it("zap in direct - tokenX into a two-sided position, sent as legacy transactions", async () => {
      await expectTwoSidedZapIn("X", { legacy: true });
    });

    it("zap in direct - tokenX into a single-sided tokenX position", async () => {
      mockJupiterLosing("X");
      const preX = userBalance(tokenXMint);
      const preY = userBalance(tokenYMint);

      const result = await zapInDlmmProDirect(
        svm,
        user.publicKey,
        tokenXMint,
        pool,
        zapInAmount,
        TOKEN_X_RANGES,
      );

      expect(result.estimate.result.swapType).to.equal(DlmmSwapType.NoSwap);

      sendZapIn(result);

      await expectPosition(result.nftMint.publicKey, TOKEN_X_RANGES);
      expect(userBalance(tokenYMint).eq(preY)).to.be.true;
      const spent = preX.sub(userBalance(tokenXMint));
      expect(spent.lte(zapInAmount)).to.be.true;
      expect(spent.gt(zapInAmount.subn(10))).to.be.true;
    });

    it("zap in direct - tokenY into a single-sided tokenX position (cross-side via the pool)", async () => {
      mockJupiterLosing("Y");
      const preX = userBalance(tokenXMint);
      const preY = userBalance(tokenYMint);

      const result = await zapInDlmmProDirect(
        svm,
        user.publicKey,
        tokenYMint,
        pool,
        zapInAmount,
        TOKEN_X_RANGES,
        { getMinMultiplier: (multiplier) => multiplier },
      );

      expect(result.estimate.result.swapAmount.eq(zapInAmount)).to.be.true;

      sendZapIn(result);

      // The whole input is swapped exact-in and none of it is deposited directly.
      await expectPosition(result.nftMint.publicKey, TOKEN_X_RANGES);
      expect(preY.sub(userBalance(tokenYMint)).eq(zapInAmount)).to.be.true;
      const unusedX = userBalance(tokenXMint).sub(preX);
      expect(unusedX.gten(0) && unusedX.ltn(10)).to.be.true;
    });

    // Jupiter quotes twice what its route pays, so it wins over the pool and the swap is sized too
    // small: token Y runs out first and half of the token X kept for the shape is left over.
    describe("via Jupiter", () => {
      async function zapInTokenX(leftover?: DlmmProLeftoverParameters) {
        await mockJupiterRoutes(tokenXMint, [tokenYMint], 2);
        const preX = userBalance(tokenXMint);

        const result = await zapInDlmmProDirect(
          svm,
          user.publicKey,
          tokenXMint,
          pool,
          zapInAmount,
          TWO_SIDED_RANGES,
          { leftover },
        );

        expect(result.estimate.result.quote?.route).to.equal(
          DlmmProDirectSwapQuoteRoute.Jupiter,
        );

        sendZapIn(result);

        const { multiplier, leftoverRanges } = await expectPosition(
          result.nftMint.publicKey,
          TWO_SIDED_RANGES,
        );
        expect(multiplier.lt(result.estimate.result.multiplier)).to.be.true;

        return {
          leftoverRanges,
          unusedX: zapInAmount.sub(preX.sub(userBalance(tokenXMint))),
        };
      }

      it("zap in direct - the leftover stays with the user", async () => {
        const { leftoverRanges, unusedX } = await zapInTokenX();

        expect(leftoverRanges).to.be.empty;
        expect(unusedX.gt(zapInAmount.divn(4))).to.be.true;
      });

      it("zap in direct - the leftover goes into its single-sided range", async () => {
        const { leftoverRanges, unusedX } = await zapInTokenX(LEFTOVER);

        // Only the token X range is opened, 150 ticks from the first tick above the pool tick.
        expect(leftoverRanges).to.have.lengthOf(1);
        expect(leftoverRanges[0].tickLowerId).to.equal(151);
        expect(leftoverRanges[0].tickUpperId).to.equal(
          LEFTOVER.rangeX.outerTickId,
        );
        expect(leftoverRanges[0].unlockedLiquidity.gtn(0)).to.be.true;

        // All of the input is swapped or deposited, up to rounding.
        expect(unusedX.gten(0) && unusedX.ltn(100)).to.be.true;
      });
    });
  });

  describe("indirect", () => {
    it("zap in indirect - tokenC into a two-sided position (proportional split)", async () => {
      await mockJupiterRoutes(tokenCMint, [tokenXMint, tokenYMint]);
      const preX = userBalance(tokenXMint);
      const preY = userBalance(tokenYMint);
      const preC = userBalance(tokenCMint);

      const result = await zapInDlmmProIndirect(
        svm,
        user.publicKey,
        tokenCMint,
        pool,
        zapInAmount,
        TWO_SIDED_RANGES,
        { getMinMultiplier: (multiplier) => multiplier.muln(99).divn(100) },
      );

      const { swapAmountToX, swapAmountToY, postSwapX, postSwapY } =
        result.estimate.result;
      expect(swapAmountToX.gtn(0) && swapAmountToY.gtn(0)).to.be.true;
      expect(swapAmountToX.add(swapAmountToY).eq(zapInAmount)).to.be.true;

      sendZapIn(result);

      await expectPosition(result.nftMint.publicKey, TWO_SIDED_RANGES);
      expect(preC.sub(userBalance(tokenCMint)).eq(zapInAmount)).to.be.true;

      // The split leaves neither output over, up to 0.01% of it.
      const unusedX = userBalance(tokenXMint).sub(preX);
      const unusedY = userBalance(tokenYMint).sub(preY);
      expect(unusedX.gten(0) && unusedX.lt(postSwapX.divn(10_000))).to.be.true;
      expect(unusedY.gten(0) && unusedY.lt(postSwapY.divn(10_000))).to.be.true;
    });

    it("zap in indirect - tokenC into a single-sided tokenX position", async () => {
      await mockJupiterRoutes(tokenCMint, [tokenXMint]);
      const preY = userBalance(tokenYMint);

      const result = await zapInDlmmProIndirect(
        svm,
        user.publicKey,
        tokenCMint,
        pool,
        zapInAmount,
        TOKEN_X_RANGES,
      );

      expect(result.estimate.result.swapAmountToX.eq(zapInAmount)).to.be.true;
      expect(result.estimate.result.swapToY).to.be.null;

      sendZapIn(result);

      await expectPosition(result.nftMint.publicKey, TOKEN_X_RANGES);
      expect(userBalance(tokenYMint).eq(preY)).to.be.true;
    });
  });
});
