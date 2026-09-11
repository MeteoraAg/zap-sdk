import { LiteSVM } from "litesvm";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
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
  getTokenBalance,
  getTokenProgram,
  createDammV2Pool,
  getDammV2Pool,
  createSeededDlmmPool,
  getDlmmPosition,
  getLbPair,
  zapInDlmmIndirect,
  mockJupiterFetch,
  JupiterMockRoute,
  SQRT_PRICE_50A_50B,
} from "./helpers";
import { JUP_V6_PROGRAM_ID } from "../src/constants";
import { DlmmSingleSided } from "../src/types";

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

function usesProgram(transaction: Transaction, programId: PublicKey): boolean {
  return transaction.instructions.some((ix) => ix.programId.equals(programId));
}

describe("Zap in DLMM indirect", () => {
  let svm: LiteSVM;
  let user: Keypair;
  let admin: Keypair;
  let tokenXMint: PublicKey;
  let tokenYMint: PublicKey;
  let tokenCMint: PublicKey;
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
    tokenCMint = createToken(svm, admin, admin.publicKey, null);
    mintToken(svm, admin, tokenXMint, admin, admin.publicKey);
    mintToken(svm, admin, tokenYMint, admin, admin.publicKey);
    mintToken(svm, admin, tokenCMint, admin, admin.publicKey);

    mintToken(svm, admin, tokenXMint, admin, user.publicKey);
    mintToken(svm, admin, tokenYMint, admin, user.publicKey);
    mintToken(svm, admin, tokenCMint, admin, user.publicKey);
  });

  function mintOf(side: TokenSide): PublicKey {
    return side === "X" ? tokenXMint : tokenYMint;
  }

  // One DAMM V2 pool per pool token stands in for the Jupiter leg from token C to it.
  async function mockJupiterLegs(sides: TokenSide[]) {
    const cpAmm = new CpAmm(createLiteSvmConnection(svm));
    const routes: JupiterMockRoute[] = [];
    for (const side of sides) {
      const outputMint = mintOf(side);
      const swapPool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint: tokenCMint,
        tokenBMint: outputMint,
        sqrtPrice: SQRT_PRICE_50A_50B,
      });
      const quote = cpAmm.getQuote({
        inAmount: zapInAmount,
        inputTokenMint: tokenCMint,
        slippage: 0.5,
        poolState: getDammV2Pool(svm, swapPool) as any,
        currentTime: Number(svm.getClock().unixTimestamp),
        currentSlot: Number(svm.getClock().slot),
        tokenADecimal: 9,
        tokenBDecimal: 9,
      });
      routes.push({ outputMint, swapPool, outAmount: quote.swapOutAmount });
    }
    restoreJupiterFetch = mockJupiterFetch(
      svm,
      user.publicKey,
      tokenCMint,
      routes,
    ).restore;
  }

  // Send setup and swap transactions, then ledger + zap in + clean up in one transaction.
  function sendZapIn(result: {
    position: Keypair;
    setupTransaction?: Transaction;
    swapTransactions: Transaction[];
    ledgerTransaction: Transaction;
    zapInTransaction: Transaction;
    cleanUpTransaction: Transaction;
  }) {
    if (result.setupTransaction) {
      signAndSendTransaction(svm, result.setupTransaction, [user]);
    }
    for (const swapTransaction of result.swapTransactions) {
      signAndSendTransaction(svm, swapTransaction, [user]);
    }

    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(result.ledgerTransaction)
      .add(result.zapInTransaction)
      .add(result.cleanUpTransaction);
    signAndSendTransaction(svm, tx, [user, result.position]);
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

  it("zap in indirect - tokenC into tokenX-tokenY pool (proportional split)", async () => {
    const lbPair = await createSeededDlmmPool(
      svm,
      admin,
      tokenXMint,
      tokenYMint,
    );
    await mockJupiterLegs(["X", "Y"]);

    const result = await zapInDlmmIndirect(
      svm,
      user.publicKey,
      tokenCMint,
      lbPair,
      zapInAmount,
      { binDelta },
    );

    // Both sides are bought through Jupiter, one swap per pool token.
    expect(result.swapTransactions.length).to.equal(2);
    for (const swapTransaction of result.swapTransactions) {
      expect(usesProgram(swapTransaction, JUP_V6_PROGRAM_ID)).to.be.true;
    }

    sendZapIn(result);

    const positionData = await expectPosition(
      lbPair,
      result.position.publicKey,
      { minDeltaId: -binDelta, maxDeltaId: binDelta },
    );
    expect(positionData.totalXAmountExcludeTransferFee.gt(new BN(0))).to.be
      .true;
    expect(positionData.totalYAmountExcludeTransferFee.gt(new BN(0))).to.be
      .true;
  });

  // A single-sided position sits entirely on one side of the active bin and only takes
  // that side's token, the DLMM counterpart of a DAMM V2 pool priced at its bound.
  for (const side of ["X", "Y"] as const) {
    const singleSided = side === "X" ? DlmmSingleSided.X : DlmmSingleSided.Y;
    const range =
      side === "X"
        ? { minDeltaId: 0, maxDeltaId: binDelta }
        : { minDeltaId: -binDelta, maxDeltaId: 0 };
    const other: TokenSide = side === "X" ? "Y" : "X";

    it(`zap in indirect - tokenC into single-sided token${side} position`, async () => {
      const lbPair = await createSeededDlmmPool(
        svm,
        admin,
        tokenXMint,
        tokenYMint,
      );
      await mockJupiterLegs([side]);

      const pre = snapshotUserBalances(svm, lbPair, user.publicKey);

      const result = await zapInDlmmIndirect(
        svm,
        user.publicKey,
        tokenCMint,
        lbPair,
        zapInAmount,
        { binDelta, singleSided },
      );

      // Only the deposited side is bought.
      expect(result.swapTransactions.length).to.equal(1);
      expect(usesProgram(result.swapTransactions[0], JUP_V6_PROGRAM_ID)).to.be
        .true;

      sendZapIn(result);

      // The other pool token is never touched.
      const post = snapshotUserBalances(svm, lbPair, user.publicKey);
      expect(balanceOf(post, other).eq(balanceOf(pre, other))).to.be.true;

      // Only the deposited token goes in, but shares in the active bin claim a slice of
      // both reserves, so the other side is small rather than zero.
      const positionData = await expectPosition(
        lbPair,
        result.position.publicKey,
        range,
      );
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
    });
  }
});
