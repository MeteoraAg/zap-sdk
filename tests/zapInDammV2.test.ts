import { LiteSVM } from "litesvm";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { CollectFeeMode, derivePositionAddress } from "@meteora-ag/cp-amm-sdk";

import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { Zap } from "../src/zap";
import {
  startSvm,
  generateKpAndFund,
  signAndSendTransaction,
  createLiteSvmConnection,
  createToken,
  mintToken,
  createDammV2Pool,
  createDammV2PoolWithConfig,
  createPosition,
  getTokenBalance,
  getTokenProgram,
  getDammV2Pool,
  getDammV2Position,
  zapInDammV2Direct,
  zapInDammV2Indirect,
  buildJupiterQuoteResponse,
  mockJupiterFetch,
  SQRT_MAX_PRICE,
  SQRT_MIN_PRICE,
  SQRT_PRICE_70A_30B,
  SQRT_PRICE_50A_50B,
} from "./helpers";

interface UserBalances {
  tokenA: BN;
  tokenB: BN;
}

function snapshotUserBalances(
  svm: LiteSVM,
  pool: PublicKey,
  user: PublicKey,
): UserBalances {
  const poolState = getDammV2Pool(svm, pool);
  const tokenAProgram = getTokenProgram(svm, poolState.tokenAMint);
  const tokenBProgram = getTokenProgram(svm, poolState.tokenBMint);
  const userTokenA = getAssociatedTokenAddressSync(
    poolState.tokenAMint,
    user,
    true,
    tokenAProgram,
  );
  const userTokenB = getAssociatedTokenAddressSync(
    poolState.tokenBMint,
    user,
    true,
    tokenBProgram,
  );
  return {
    tokenA: getTokenBalance(svm, userTokenA),
    tokenB: getTokenBalance(svm, userTokenB),
  };
}

describe("Zap in DAMM V2", () => {
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

  describe("zap in direct", () => {
    it("zap in direct - tokenA into tokenA-tokenB pool", async () => {
      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_PRICE_70A_30B,
      });

      const poolState = getDammV2Pool(svm, pool);
      const inputTokenMint = poolState.tokenAMint;

      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");
      const { ledgerTransaction, zapInTransaction, cleanUpTransaction } =
        await zapInDammV2Direct(
          svm,
          user.publicKey,
          inputTokenMint,
          pool,
          positionNftMint,
          zapInAmount,
        );

      const tx = new Transaction()
        .add(ledgerTransaction)
        .add(zapInTransaction)
        .add(cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;
    });

    it("zap in direct - tokenB into tokenA-tokenB pool", async () => {
      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_PRICE_70A_30B,
      });

      const poolState = getDammV2Pool(svm, pool);
      const inputTokenMint = poolState.tokenBMint;

      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");
      const { ledgerTransaction, zapInTransaction, cleanUpTransaction } =
        await zapInDammV2Direct(
          svm,
          user.publicKey,
          inputTokenMint,
          pool,
          positionNftMint,
          zapInAmount,
        );

      const tx = new Transaction()
        .add(ledgerTransaction)
        .add(zapInTransaction)
        .add(cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;
    });

    it("zap in direct - tokenA into single-sided tokenA pool", async () => {
      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_MIN_PRICE,
        liquidity: new BN("1844674407370955161600"),
      });

      const poolState = getDammV2Pool(svm, pool);
      const inputTokenMint = poolState.tokenAMint;

      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");
      const pre = snapshotUserBalances(svm, pool, user.publicKey);

      const { ledgerTransaction, zapInTransaction, cleanUpTransaction } =
        await zapInDammV2Direct(
          svm,
          user.publicKey,
          inputTokenMint,
          pool,
          positionNftMint,
          zapInAmount,
        );

      const tx = new Transaction()
        .add(ledgerTransaction)
        .add(zapInTransaction)
        .add(cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const post = snapshotUserBalances(svm, pool, user.publicKey);

      // single-sided A pool: user's tokenB must be exactly unchanged (no swap)
      expect(post.tokenB.eq(pre.tokenB)).to.be.true;

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;
    });

    it("zap in direct - tokenB into single-sided tokenA pool (cross-side via Jupiter)", async () => {
      const swapPool = await createDammV2PoolWithConfig({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        configIndex: new BN(0),
        sqrtPrice: SQRT_PRICE_50A_50B,
      });

      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_MIN_PRICE,
        liquidity: new BN("1844674407370955161600"),
      });

      const poolState = getDammV2Pool(svm, pool);
      const inputTokenMint = poolState.tokenBMint;
      const outputTokenMint = poolState.tokenAMint;

      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");

      const cpAmm = new CpAmm(createLiteSvmConnection(svm));
      const swapQuote = cpAmm.getQuote({
        inAmount: zapInAmount,
        inputTokenMint,
        slippage: 0.5,
        poolState: getDammV2Pool(svm, swapPool) as any,
        currentTime: 0,
        currentSlot: 0,
        tokenADecimal: 9,
        tokenBDecimal: 9,
      });
      const estimatedOut = swapQuote.swapOutAmount;

      restoreJupiterFetch = mockJupiterFetch(
        svm,
        user.publicKey,
        inputTokenMint,
        [{ outputMint: outputTokenMint, swapPool, outAmount: estimatedOut }],
      ).restore;

      const zap = new Zap(createLiteSvmConnection(svm));

      const jupiterQuote = buildJupiterQuoteResponse(
        inputTokenMint,
        outputTokenMint,
        new BN("1000000000"),
        estimatedOut,
      );

      const params = await zap.getZapInDammV2DirectPoolParams({
        user: user.publicKey,
        inputTokenMint,
        amountIn: zapInAmount,
        pool,
        positionNftMint,
        maxSqrtPriceChangeBps: 5000,
        maxTransferAmountExtendPercentage: 20,
        maxAccounts: 40,
        slippageBps: 300,
        dammV2Quote: null,
        jupiterQuote,
      });

      const result = await zap.buildZapInDammV2Transaction(params);

      if (result.setupTransaction) {
        signAndSendTransaction(svm, result.setupTransaction, [user]);
      }
      for (const swapTx of result.swapTransactions) {
        signAndSendTransaction(svm, swapTx, [user]);
      }

      const tx = new Transaction()
        .add(result.ledgerTransaction)
        .add(result.zapInTransaction)
        .add(result.cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;
    });

    it("zap in direct - tokenB into single-sided tokenB pool", async () => {
      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_MAX_PRICE,
        liquidity: new BN("1844674407370955161600"),
      });

      const poolState = getDammV2Pool(svm, pool);
      const inputTokenMint = poolState.tokenBMint;

      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");
      const pre = snapshotUserBalances(svm, pool, user.publicKey);

      const { ledgerTransaction, zapInTransaction, cleanUpTransaction } =
        await zapInDammV2Direct(
          svm,
          user.publicKey,
          inputTokenMint,
          pool,
          positionNftMint,
          zapInAmount,
        );

      const tx = new Transaction()
        .add(ledgerTransaction)
        .add(zapInTransaction)
        .add(cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const post = snapshotUserBalances(svm, pool, user.publicKey);

      // single-sided B pool: user's tokenA must be exactly unchanged (no swap)
      expect(post.tokenA.eq(pre.tokenA)).to.be.true;

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;
    });

    it("zap in direct - tokenA into single-sided tokenB pool (cross-side via Jupiter)", async () => {
      const swapPool = await createDammV2PoolWithConfig({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        configIndex: new BN(1),
        sqrtPrice: SQRT_PRICE_50A_50B,
      });

      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_MAX_PRICE,
        liquidity: new BN("1844674407370955161600"),
      });

      const poolState = getDammV2Pool(svm, pool);
      const inputTokenMint = poolState.tokenAMint;
      const outputTokenMint = poolState.tokenBMint;

      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");

      const cpAmm = new CpAmm(createLiteSvmConnection(svm));
      const swapQuote = cpAmm.getQuote({
        inAmount: zapInAmount,
        inputTokenMint,
        slippage: 0.5,
        poolState: getDammV2Pool(svm, swapPool) as any,
        currentTime: 0,
        currentSlot: 0,
        tokenADecimal: 9,
        tokenBDecimal: 9,
      });
      const estimatedOut = swapQuote.swapOutAmount;

      restoreJupiterFetch = mockJupiterFetch(
        svm,
        user.publicKey,
        inputTokenMint,
        [{ outputMint: outputTokenMint, swapPool, outAmount: estimatedOut }],
      ).restore;

      const zap = new Zap(createLiteSvmConnection(svm));

      const jupiterQuote = buildJupiterQuoteResponse(
        inputTokenMint,
        outputTokenMint,
        new BN("1000000000"),
        estimatedOut,
      );

      const params = await zap.getZapInDammV2DirectPoolParams({
        user: user.publicKey,
        inputTokenMint,
        amountIn: zapInAmount,
        pool,
        positionNftMint,
        maxSqrtPriceChangeBps: 5000,
        maxTransferAmountExtendPercentage: 20,
        maxAccounts: 40,
        slippageBps: 300,
        dammV2Quote: null,
        jupiterQuote,
      });

      const result = await zap.buildZapInDammV2Transaction(params);

      if (result.setupTransaction) {
        signAndSendTransaction(svm, result.setupTransaction, [user]);
      }
      for (const swapTx of result.swapTransactions) {
        signAndSendTransaction(svm, swapTx, [user]);
      }

      const tx = new Transaction()
        .add(result.ledgerTransaction)
        .add(result.zapInTransaction)
        .add(result.cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;
    });

    it("zap in direct - tokenA into compounding fee pool", async () => {
      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_PRICE_70A_30B,
        collectFeeMode: CollectFeeMode.Compounding,
        compoundingFeeBps: 5000,
      });

      const poolState = getDammV2Pool(svm, pool);
      const inputTokenMint = poolState.tokenAMint;

      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");
      const { ledgerTransaction, zapInTransaction, cleanUpTransaction } =
        await zapInDammV2Direct(
          svm,
          user.publicKey,
          inputTokenMint,
          pool,
          positionNftMint,
          zapInAmount,
        );

      const tx = new Transaction()
        .add(ledgerTransaction)
        .add(zapInTransaction)
        .add(cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;
    });

    it("zap in direct - tokenA into compounding fee pool (50A-50B)", async () => {
      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_PRICE_50A_50B,
        collectFeeMode: CollectFeeMode.Compounding,
        compoundingFeeBps: 5000,
      });

      const poolState = getDammV2Pool(svm, pool);
      const inputTokenMint = poolState.tokenAMint;

      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");
      const { ledgerTransaction, zapInTransaction, cleanUpTransaction } =
        await zapInDammV2Direct(
          svm,
          user.publicKey,
          inputTokenMint,
          pool,
          positionNftMint,
          zapInAmount,
        );

      const tx = new Transaction()
        .add(ledgerTransaction)
        .add(zapInTransaction)
        .add(cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;
    });

    it("zap in direct - tokenB into compounding fee pool", async () => {
      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_PRICE_50A_50B,
        collectFeeMode: CollectFeeMode.Compounding,
        compoundingFeeBps: 5000,
      });

      const poolState = getDammV2Pool(svm, pool);
      const inputTokenMint = poolState.tokenBMint;

      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");
      const { ledgerTransaction, zapInTransaction, cleanUpTransaction } =
        await zapInDammV2Direct(
          svm,
          user.publicKey,
          inputTokenMint,
          pool,
          positionNftMint,
          zapInAmount,
        );

      const tx = new Transaction()
        .add(ledgerTransaction)
        .add(zapInTransaction)
        .add(cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;
    });
  });
  describe("zap in indirect", () => {
    it("zap in indirect - tokenC into tokenA-tokenB pool (proportional split)", async () => {
      const tokenCMint = createToken(svm, admin, admin.publicKey, null);
      mintToken(svm, admin, tokenCMint, admin, admin.publicKey);
      mintToken(svm, admin, tokenCMint, admin, user.publicKey);

      const swapPoolA = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint: tokenCMint,
        tokenBMint: tokenAMint,
        sqrtPrice: SQRT_PRICE_50A_50B,
      });
      const swapPoolB = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint: tokenCMint,
        tokenBMint,
        sqrtPrice: SQRT_PRICE_50A_50B,
      });

      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_PRICE_70A_30B,
      });

      const poolState = getDammV2Pool(svm, pool);
      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");

      const oneToken = new BN("1000000000");
      const cpAmm = new CpAmm(createLiteSvmConnection(svm));
      const quoteA = cpAmm.getQuote({
        inAmount: oneToken,
        inputTokenMint: tokenCMint,
        slippage: 0.5,
        poolState: getDammV2Pool(svm, swapPoolA) as any,
        currentTime: 0,
        currentSlot: 0,
        tokenADecimal: 9,
        tokenBDecimal: 9,
      });
      const quoteB = cpAmm.getQuote({
        inAmount: oneToken,
        inputTokenMint: tokenCMint,
        slippage: 0.5,
        poolState: getDammV2Pool(svm, swapPoolB) as any,
        currentTime: 0,
        currentSlot: 0,
        tokenADecimal: 9,
        tokenBDecimal: 9,
      });

      restoreJupiterFetch = mockJupiterFetch(svm, user.publicKey, tokenCMint, [
        {
          outputMint: poolState.tokenAMint,
          swapPool: swapPoolA,
          outAmount: quoteA.swapOutAmount
            .mul(new BN("2000000000"))
            .div(oneToken),
        },
        {
          outputMint: poolState.tokenBMint,
          swapPool: swapPoolB,
          outAmount: quoteB.swapOutAmount
            .mul(new BN("2000000000"))
            .div(oneToken),
        },
      ]).restore;

      const jupiterQuoteToA = buildJupiterQuoteResponse(
        tokenCMint,
        poolState.tokenAMint,
        oneToken,
        quoteA.swapOutAmount,
      );
      const jupiterQuoteToB = buildJupiterQuoteResponse(
        tokenCMint,
        poolState.tokenBMint,
        oneToken,
        quoteB.swapOutAmount,
      );

      const {
        setupTransaction,
        swapTransactions,
        ledgerTransaction,
        zapInTransaction,
        cleanUpTransaction,
      } = await zapInDammV2Indirect(
        svm,
        user.publicKey,
        tokenCMint,
        pool,
        positionNftMint,
        zapInAmount,
        jupiterQuoteToA,
        jupiterQuoteToB,
      );

      expect(swapTransactions.length).to.equal(2);
      if (setupTransaction) {
        signAndSendTransaction(svm, setupTransaction, [user]);
      }
      for (const swapTx of swapTransactions) {
        signAndSendTransaction(svm, swapTx, [user]);
      }

      const tx = new Transaction()
        .add(ledgerTransaction)
        .add(zapInTransaction)
        .add(cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;
    });

    it("zap in indirect - tokenC into single-sided tokenA pool", async () => {
      const tokenCMint = createToken(svm, admin, admin.publicKey, null);
      mintToken(svm, admin, tokenCMint, admin, admin.publicKey);
      mintToken(svm, admin, tokenCMint, admin, user.publicKey);

      const swapPool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint: tokenCMint,
        tokenBMint: tokenAMint,
        sqrtPrice: SQRT_PRICE_50A_50B,
      });

      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_MIN_PRICE,
        liquidity: new BN("1844674407370955161600"),
      });

      const poolState = getDammV2Pool(svm, pool);
      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");

      const cpAmm = new CpAmm(createLiteSvmConnection(svm));
      const swapQuote = cpAmm.getQuote({
        inAmount: zapInAmount,
        inputTokenMint: tokenCMint,
        slippage: 0.5,
        poolState: getDammV2Pool(svm, swapPool) as any,
        currentTime: 0,
        currentSlot: 0,
        tokenADecimal: 9,
        tokenBDecimal: 9,
      });
      const estimatedOut = swapQuote.swapOutAmount;

      restoreJupiterFetch = mockJupiterFetch(svm, user.publicKey, tokenCMint, [
        {
          outputMint: poolState.tokenAMint,
          swapPool,
          outAmount: estimatedOut,
        },
      ]).restore;

      const jupiterQuoteToA = buildJupiterQuoteResponse(
        tokenCMint,
        poolState.tokenAMint,
        new BN("1000000000"),
        estimatedOut,
      );

      const {
        setupTransaction,
        swapTransactions,
        ledgerTransaction,
        zapInTransaction,
        cleanUpTransaction,
      } = await zapInDammV2Indirect(
        svm,
        user.publicKey,
        tokenCMint,
        pool,
        positionNftMint,
        zapInAmount,
        jupiterQuoteToA,
        null,
      );

      const pre = snapshotUserBalances(svm, pool, user.publicKey);

      if (setupTransaction) {
        signAndSendTransaction(svm, setupTransaction, [user]);
      }
      for (const swapTx of swapTransactions) {
        signAndSendTransaction(svm, swapTx, [user]);
      }

      const tx = new Transaction()
        .add(ledgerTransaction)
        .add(zapInTransaction)
        .add(cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const post = snapshotUserBalances(svm, pool, user.publicKey);

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;

      expect(post.tokenB.eq(pre.tokenB)).to.be.true;
    });

    it("zap in indirect - tokenC into single-sided tokenB pool", async () => {
      const tokenCMint = createToken(svm, admin, admin.publicKey, null);
      mintToken(svm, admin, tokenCMint, admin, admin.publicKey);
      mintToken(svm, admin, tokenCMint, admin, user.publicKey);

      const swapPool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint: tokenCMint,
        tokenBMint,
        sqrtPrice: SQRT_PRICE_50A_50B,
      });

      const pool = await createDammV2Pool({
        svm,
        creator: admin,
        tokenAMint,
        tokenBMint,
        sqrtPrice: SQRT_MAX_PRICE,
        liquidity: new BN("1844674407370955161600"),
      });

      const poolState = getDammV2Pool(svm, pool);
      const { positionNftMint } = await createPosition(svm, user, pool);

      const zapInAmount = new BN("1000000000");

      const cpAmm = new CpAmm(createLiteSvmConnection(svm));
      const swapQuote = cpAmm.getQuote({
        inAmount: zapInAmount,
        inputTokenMint: tokenCMint,
        slippage: 0.5,
        poolState: getDammV2Pool(svm, swapPool) as any,
        currentTime: 0,
        currentSlot: 0,
        tokenADecimal: 9,
        tokenBDecimal: 9,
      });
      const estimatedOut = swapQuote.swapOutAmount;

      restoreJupiterFetch = mockJupiterFetch(svm, user.publicKey, tokenCMint, [
        {
          outputMint: poolState.tokenBMint,
          swapPool,
          outAmount: estimatedOut,
        },
      ]).restore;

      const jupiterQuoteToB = buildJupiterQuoteResponse(
        tokenCMint,
        poolState.tokenBMint,
        new BN("1000000000"),
        estimatedOut,
      );

      const {
        setupTransaction,
        swapTransactions,
        ledgerTransaction,
        zapInTransaction,
        cleanUpTransaction,
      } = await zapInDammV2Indirect(
        svm,
        user.publicKey,
        tokenCMint,
        pool,
        positionNftMint,
        zapInAmount,
        null,
        jupiterQuoteToB,
      );

      const pre = snapshotUserBalances(svm, pool, user.publicKey);

      if (setupTransaction) {
        signAndSendTransaction(svm, setupTransaction, [user]);
      }
      for (const swapTx of swapTransactions) {
        signAndSendTransaction(svm, swapTx, [user]);
      }

      const tx = new Transaction()
        .add(ledgerTransaction)
        .add(zapInTransaction)
        .add(cleanUpTransaction);
      signAndSendTransaction(svm, tx, [user]);

      const post = snapshotUserBalances(svm, pool, user.publicKey);

      const position = derivePositionAddress(positionNftMint);
      const positionState = getDammV2Position(svm, position);
      expect(positionState.unlockedLiquidity.gt(new BN(0))).to.be.true;

      expect(post.tokenA.eq(pre.tokenA)).to.be.true;
    });
  });
});
