import { LiteSVM } from "litesvm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
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
  getTokenProgram,
  createDammV2Pool,
  getDammV2Pool,
  createSeededDlmmPool,
  getDlmmPosition,
  getLbPair,
  zapInDlmmDirect,
  mockJupiterFetch,
  SQRT_PRICE_50A_50B,
} from "./helpers";
import {
  DlmmDirectSwapQuoteRoute,
  DlmmSingleSided,
  ZapInstructionsResponse,
} from "../src/types";

type TokenSide = "X" | "Y";

interface UserBalances {
  tokenX: BN;
  tokenY: BN;
}

function snapshotUserBalances(
  svm: LiteSVM,
  lbPair: PublicKey,
  user: PublicKey,
): UserBalances {
  const lbPairState = getLbPair(svm, lbPair);
  const userTokenX = getAssociatedTokenAddressSync(
    lbPairState.tokenXMint,
    user,
    true,
    getTokenProgram(svm, lbPairState.tokenXMint),
  );
  const userTokenY = getAssociatedTokenAddressSync(
    lbPairState.tokenYMint,
    user,
    true,
    getTokenProgram(svm, lbPairState.tokenYMint),
  );
  return {
    tokenX: getTokenBalance(svm, userTokenX),
    tokenY: getTokenBalance(svm, userTokenY),
  };
}

function balanceOf(balances: UserBalances, side: TokenSide): BN {
  return side === "X" ? balances.tokenX : balances.tokenY;
}

describe("Zap in DLMM direct", () => {
  let svm: LiteSVM;
  let user: Keypair;
  let admin: Keypair;
  let tokenXMint: PublicKey;
  let tokenYMint: PublicKey;
  let restoreJupiterFetch: (() => void) | null = null;

  const binDelta = 34;
  const zapInAmount = new BN("1000000000");

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

  function mintOf(side: TokenSide): PublicKey {
    return side === "X" ? tokenXMint : tokenYMint;
  }

  function otherSide(side: TokenSide): TokenSide {
    return side === "X" ? "Y" : "X";
  }

  // Jupiter quotes 1 lamport out, so the DLMM pool always wins the direct swap route.
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

  // Jupiter routes through a DAMM V2 pool and quotes twice what that pool pays, so
  // Jupiter always wins over the DLMM pool quote.
  async function mockJupiterWinning(inputSide: TokenSide) {
    const inputTokenMint = mintOf(inputSide);
    const outputTokenMint = mintOf(otherSide(inputSide));
    const swapPool = await createDammV2Pool({
      svm,
      creator: admin,
      tokenAMint: inputTokenMint,
      tokenBMint: outputTokenMint,
      sqrtPrice: SQRT_PRICE_50A_50B,
    });

    const cpAmm = new CpAmm(createLiteSvmConnection(svm));
    const quote = cpAmm.getQuote({
      inAmount: zapInAmount,
      inputTokenMint,
      slippage: 0.5,
      poolState: getDammV2Pool(svm, swapPool) as any,
      currentTime: Number(svm.getClock().unixTimestamp),
      currentSlot: Number(svm.getClock().slot),
      tokenADecimal: 9,
      tokenBDecimal: 9,
    });

    restoreJupiterFetch = mockJupiterFetch(
      svm,
      user.publicKey,
      inputTokenMint,
      [
        {
          outputMint: outputTokenMint,
          swapPool,
          outAmount: quote.swapOutAmount.mul(new BN(2)),
        },
      ],
    ).restore;
  }

  // Send the zap-in instructions packed into as few v0 transactions as fit, each with the maximum
  // compute limit. `legacy` sends legacy transactions instead, without the lookup tables.
  function sendZapIn(
    result: {
      position: Keypair;
    } & ZapInstructionsResponse,
    { legacy = false }: { legacy?: boolean } = {},
  ) {
    const signers = [user, result.position];
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

  async function expectPosition(
    lbPair: PublicKey,
    position: PublicKey,
    range: { minDeltaId: number; maxDeltaId: number },
  ) {
    const { activeId } = getLbPair(svm, lbPair);
    const { positionData } = await getDlmmPosition(svm, lbPair, position);

    expect(positionData.owner.equals(user.publicKey)).to.be.true;
    expect(positionData.lowerBinId).to.equal(activeId + range.minDeltaId);
    expect(positionData.upperBinId).to.equal(activeId + range.maxDeltaId);
    return positionData;
  }

  // Zaps `inputSide` into a two-sided position and checks the position holds both tokens.
  async function expectTwoSidedZapIn(
    inputSide: TokenSide,
    { legacy = false }: { legacy?: boolean } = {},
  ) {
    const lbPair = await createSeededDlmmPool(
      svm,
      admin,
      tokenXMint,
      tokenYMint,
    );
    mockJupiterLosing(inputSide);

    const result = await zapInDlmmDirect(
      svm,
      user.publicKey,
      mintOf(inputSide),
      lbPair,
      zapInAmount,
      { binDelta },
    );

    // Direct route: the pre-swap is a DLMM swap on the pool itself, not a Jupiter route.
    expect(result.estimate.result.quote?.route).to.equal(
      DlmmDirectSwapQuoteRoute.Dlmm,
    );

    sendZapIn(result, { legacy });

    const positionData = await expectPosition(
      lbPair,
      result.position.publicKey,
      { minDeltaId: -binDelta, maxDeltaId: binDelta },
    );
    expect(positionData.totalXAmountExcludeTransferFee.gt(new BN(0))).to.be
      .true;
    expect(positionData.totalYAmountExcludeTransferFee.gt(new BN(0))).to.be
      .true;
  }

  for (const inputSide of ["X", "Y"] as const) {
    it(`zap in direct - token${inputSide} into tokenX-tokenY pool`, async () => {
      await expectTwoSidedZapIn(inputSide);
    });
  }

  // The instructions must also work for a client that sends legacy transactions without lookup tables.
  it("zap in direct - tokenX into tokenX-tokenY pool, sent as legacy transactions", async () => {
    await expectTwoSidedZapIn("X", { legacy: true });
  });

  for (const side of ["X", "Y"] as const) {
    const singleSided = side === "X" ? DlmmSingleSided.X : DlmmSingleSided.Y;
    const range =
      side === "X"
        ? { minDeltaId: 0, maxDeltaId: binDelta }
        : { minDeltaId: -binDelta, maxDeltaId: 0 };
    const other = otherSide(side);

    async function expectSingleSidedPosition(
      lbPair: PublicKey,
      position: PublicKey,
    ) {
      const positionData = await expectPosition(lbPair, position, range);
      const deposited =
        side === "X"
          ? positionData.totalXAmountExcludeTransferFee
          : positionData.totalYAmountExcludeTransferFee;
      const rest =
        side === "X"
          ? positionData.totalYAmountExcludeTransferFee
          : positionData.totalXAmountExcludeTransferFee;
      expect(deposited.gt(new BN(0))).to.be.true;
      expect(deposited.gt(rest)).to.be.true;
    }

    it(`zap in direct - token${side} into single-sided token${side} position`, async () => {
      const lbPair = await createSeededDlmmPool(
        svm,
        admin,
        tokenXMint,
        tokenYMint,
      );
      mockJupiterLosing(side);

      const pre = snapshotUserBalances(svm, lbPair, user.publicKey);

      const result = await zapInDlmmDirect(
        svm,
        user.publicKey,
        mintOf(side),
        lbPair,
        zapInAmount,
        { binDelta, singleSided },
      );

      sendZapIn(result);

      // The other token is untouched and at most the input amount is deposited.
      const post = snapshotUserBalances(svm, lbPair, user.publicKey);
      expect(balanceOf(post, other).eq(balanceOf(pre, other))).to.be.true;
      const spent = balanceOf(pre, side).sub(balanceOf(post, side));
      expect(spent.gt(new BN(0))).to.be.true;
      expect(spent.lte(zapInAmount)).to.be.true;

      await expectSingleSidedPosition(lbPair, result.position.publicKey);
    });

    it(`zap in direct - token${other} into single-sided token${side} position (cross-side via Jupiter)`, async () => {
      const lbPair = await createSeededDlmmPool(
        svm,
        admin,
        tokenXMint,
        tokenYMint,
      );
      await mockJupiterWinning(other);

      const pre = snapshotUserBalances(svm, lbPair, user.publicKey);

      const result = await zapInDlmmDirect(
        svm,
        user.publicKey,
        mintOf(other),
        lbPair,
        zapInAmount,
        { binDelta, singleSided },
      );

      expect(result.estimate.result.quote?.route).to.equal(
        DlmmDirectSwapQuoteRoute.Jupiter,
      );

      sendZapIn(result);

      // The whole input is swapped exact-in and none of it is deposited directly.
      const post = snapshotUserBalances(svm, lbPair, user.publicKey);
      expect(
        balanceOf(pre, other).sub(balanceOf(post, other)).toString(),
      ).to.equal(zapInAmount.toString());

      await expectSingleSidedPosition(lbPair, result.position.publicKey);
    });

    it(`zap in direct - token${other} into single-sided token${side} position (cross-side via DLMM fallback)`, async () => {
      const lbPair = await createSeededDlmmPool(
        svm,
        admin,
        tokenXMint,
        tokenYMint,
      );
      mockJupiterLosing(other);

      const pre = snapshotUserBalances(svm, lbPair, user.publicKey);

      const result = await zapInDlmmDirect(
        svm,
        user.publicKey,
        mintOf(other),
        lbPair,
        zapInAmount,
        { binDelta, singleSided },
      );

      expect(result.estimate.result.quote?.route).to.equal(
        DlmmDirectSwapQuoteRoute.Dlmm,
      );

      sendZapIn(result);

      // The whole input is swapped exact-in and none of it is deposited directly.
      const post = snapshotUserBalances(svm, lbPair, user.publicKey);
      expect(
        balanceOf(pre, other).sub(balanceOf(post, other)).toString(),
      ).to.equal(zapInAmount.toString());

      await expectSingleSidedPosition(lbPair, result.position.publicKey);
    });
  }
});
