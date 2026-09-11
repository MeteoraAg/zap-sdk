import { LiteSVM } from "litesvm";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { expect } from "chai";

import {
  startSvm,
  generateKpAndFund,
  signAndSendTransaction,
  createLiteSvmConnection,
  createToken,
  mintToken,
  createDammV2Pool,
  getDammV2Pool,
  createSeededDlmmPool,
  createDlmmPositionAndAddLiquidity,
  getDlmmPosition,
  getLbPair,
  swapDlmm,
  rebalanceDlmmPosition,
  mockJupiterFetch,
  DLMM_LIQUIDITY_AMOUNT,
  SQRT_PRICE_50A_50B,
} from "./helpers";
import { DLMM_PROGRAM_ID, JUP_V6_PROGRAM_ID } from "../src/constants";
import { DlmmDirectSwapQuoteRoute, DlmmSwapType } from "../src/types";

type TokenSide = "X" | "Y";

// Selling X into the pool pushes the price down and leaves the position with excess X,
// which the rebalance swaps back to Y. Selling Y does the mirror image.
const PRICE_MOVES = [
  {
    direction: "down",
    sold: "X" as TokenSide,
    swapType: DlmmSwapType.XToY,
    activeIdMoved: (before: number, after: number) => after < before,
  },
  {
    direction: "up",
    sold: "Y" as TokenSide,
    swapType: DlmmSwapType.YToX,
    activeIdMoved: (before: number, after: number) => after > before,
  },
];

const ROUTES = [
  {
    name: "DLMM pool",
    route: DlmmDirectSwapQuoteRoute.Dlmm,
    programId: DLMM_PROGRAM_ID,
  },
  {
    name: "Jupiter",
    route: DlmmDirectSwapQuoteRoute.Jupiter,
    programId: JUP_V6_PROGRAM_ID,
  },
];

describe("Rebalance DLMM position", () => {
  let svm: LiteSVM;
  let user: Keypair;
  let admin: Keypair;
  let tokenXMint: PublicKey;
  let tokenYMint: PublicKey;
  let restoreJupiterFetch: (() => void) | null = null;

  const binDelta = 34;
  const priceMoveAmount = new BN(14_300).mul(new BN(10 ** 9));

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

  // Jupiter quotes 1 lamport out, so the balancing swap goes through the DLMM pool.
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

    restoreJupiterFetch = mockJupiterFetch(
      svm,
      user.publicKey,
      inputTokenMint,
      [
        {
          outputMint: outputTokenMint,
          swapPool,
          outAmount: (inAmount) =>
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
              .swapOutAmount.mul(new BN(105))
              .div(new BN(100)),
        },
      ],
    ).restore;
  }

  for (const move of PRICE_MOVES) {
    for (const route of ROUTES) {
      it(`rebalance - price moves ${move.direction}, re-center with balancing swap via ${route.name}`, async () => {
        const lbPair = await createSeededDlmmPool(
          svm,
          admin,
          tokenXMint,
          tokenYMint,
        );
        const { position } = await createDlmmPositionAndAddLiquidity(
          svm,
          user,
          lbPair,
          DLMM_LIQUIDITY_AMOUNT,
          DLMM_LIQUIDITY_AMOUNT,
        );
        const { activeId: initialActiveId } = getLbPair(svm, lbPair);

        await swapDlmm(svm, admin, lbPair, mintOf(move.sold), priceMoveAmount);
        const { activeId } = getLbPair(svm, lbPair);
        expect(move.activeIdMoved(initialActiveId, activeId)).to.be.true;

        if (route.route === DlmmDirectSwapQuoteRoute.Dlmm) {
          mockJupiterLosing(move.sold);
        } else {
          await mockJupiterWinning(move.sold);
        }

        const result = await rebalanceDlmmPosition(
          svm,
          user.publicKey,
          lbPair,
          position,
          binDelta,
        );

        expect(result.estimate.result.swapType).to.equal(move.swapType);
        expect(result.estimate.result.quote?.route).to.equal(route.route);
        expect(result.rebalancePositionTransaction).to.not.be.undefined;
        expect(result.swapTransaction).to.not.be.undefined;
        expect(
          result.swapTransaction!.instructions.some((ix) =>
            ix.programId.equals(route.programId),
          ),
        ).to.be.true;

        const preTransactions = [
          result.setupTransaction,
          result.initBinArrayTransaction,
          result.rebalancePositionTransaction,
          result.swapTransaction,
        ];
        for (const transaction of preTransactions) {
          if (transaction) {
            signAndSendTransaction(svm, transaction, [user]);
          }
        }

        const tx = new Transaction()
          .add(result.ledgerTransaction)
          .add(result.zapInTransaction)
          .add(result.cleanUpTransaction);
        signAndSendTransaction(svm, tx, [user]);

        const { positionData } = await getDlmmPosition(svm, lbPair, position);
        expect(positionData.owner.equals(user.publicKey)).to.be.true;
        expect(positionData.lowerBinId).to.equal(activeId - binDelta);
        expect(positionData.upperBinId).to.equal(activeId + binDelta);
        expect(positionData.totalXAmountExcludeTransferFee.gt(new BN(0))).to.be
          .true;
        expect(positionData.totalYAmountExcludeTransferFee.gt(new BN(0))).to.be
          .true;
      });
    }
  }
});
