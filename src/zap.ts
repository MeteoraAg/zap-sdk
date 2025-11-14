import {
  AccountMeta,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import ZapIDL from "./idl/zap/idl.json";
import { Zap as ZapTypes } from "./idl/zap/idl";
import {
  DlmmStrategyType,
  SwapExternalType,
  ZapInDammV2DirectPoolParam,
  ZapInDammV2InDirectPoolParam,
  ZapInDammV2Response,
  ZapOutParams,
  ZapOutThroughDammV2Params,
  ZapOutThroughDlmmParams,
  ZapOutThroughJupiterParams,
  ZapProgram,
} from "./types";

import {
  getDammV2Pool,
  getDammV2RemainingAccounts,
  createDammV2SwapPayload,
  getDlmmRemainingAccounts,
  createDlmmSwapPayload,
  getLbPairState,
  getOrCreateATAInstruction,
  getTokenAccountBalance,
  unwrapSOLInstruction,
  deriveLedgerAccount,
  deriveDammV2EventAuthority,
  deriveDammV2PoolAuthority,
  deriveDlmmEventAuthority,
  wrapSOLInstruction,
  convertUiAmountToLamports,
  convertLamportsToUiAmount,
  getJupiterQuote,
  getJupiterSwapInstruction,
  buildJupiterSwapTransaction,
} from "./helpers";
import {
  AMOUNT_IN_DAMM_V2_OFFSET,
  AMOUNT_IN_DLMM_OFFSET,
  AMOUNT_IN_JUP_V6_REVERSE_OFFSET,
  DAMM_V2_PROGRAM_ID,
  DLMM_PROGRAM_ID,
  JUP_V6_PROGRAM_ID,
  MEMO_PROGRAM_ID,
} from "./constants";
import {
  CpAmm,
  getAmountAFromLiquidityDelta,
  getAmountBFromLiquidityDelta,
  getPriceFromSqrtPrice,
  getTokenDecimals,
  getTokenProgram,
  Rounding,
} from "@meteora-ag/cp-amm-sdk";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import {
  getTokenProgramId,
  RemainingAccountInfo,
  U64_MAX,
} from "@meteora-ag/dlmm";
import Decimal from "decimal.js";
import {
  calculateDirectPoolSwapAmount,
  calculateIndirectPoolSwapAmount,
  getExtendMaxAmountTransfer,
  getJupAndDammV2Quotes,
} from "./helpers/zapin";

export class Zap {
  private connection: Connection;
  private zapProgram: ZapProgram;
  constructor(connection: Connection) {
    this.connection = connection;
    this.zapProgram = new Program(ZapIDL as ZapTypes, { connection });
  }

  /////// PRIVATE FUNDTIONS //////
  private async initializeLedgerAccount(
    owner: PublicKey,
    payer: PublicKey
  ): Promise<Transaction> {
    return await this.zapProgram.methods
      .initializeLedgerAccount()
      .accountsPartial({
        ledger: deriveLedgerAccount(owner),
        owner,
        payer,
      })
      .transaction();
  }

  private async closeLedgerAccount(
    owner: PublicKey,
    rentReceiver: PublicKey
  ): Promise<Transaction> {
    return await this.zapProgram.methods
      .closeLedgerAccount()
      .accountsPartial({
        ledger: deriveLedgerAccount(owner),
        owner,
        rentReceiver,
      })
      .transaction();
  }

  private async setLedgerBalance(
    owner: PublicKey,
    amount: BN,
    isTokenA: boolean
  ): Promise<Transaction> {
    return await this.zapProgram.methods
      .setLedgerBalance(amount, isTokenA)
      .accountsPartial({
        ledger: deriveLedgerAccount(owner),
        owner,
      })
      .transaction();
  }

  private async updateLedgerBalanceAfterSwap(
    owner: PublicKey,
    tokenAccount: PublicKey,
    preSourceTokenAccount: BN,
    maxTransferAmount: BN,
    isTokenA: boolean
  ): Promise<Transaction> {
    return this.zapProgram.methods
      .updateLedgerBalanceAfterSwap(
        preSourceTokenAccount,
        maxTransferAmount,
        isTokenA
      )
      .accountsPartial({
        ledger: deriveLedgerAccount(owner),
        tokenAccount,
        owner,
      })
      .transaction();
  }

  private async zapInDammV2(params: {
    user: PublicKey;
    pool: PublicKey;
    position: PublicKey;
    positionNftAccount: PublicKey;
    preSqrtPrice: BN;
    maxSqrtPriceChangeBps: number;
    tokenAMint: PublicKey;
    tokenBMint: PublicKey;
    tokenAVault: PublicKey;
    tokenBVault: PublicKey;
    tokenAProgram: PublicKey;
    tokenBProgram: PublicKey;
  }): Promise<Transaction> {
    const {
      user,
      pool,
      position,
      positionNftAccount,
      preSqrtPrice,
      maxSqrtPriceChangeBps,
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      tokenAProgram,
      tokenBProgram,
    } = params;

    // we don't need to handle init ata account if not exist here
    // because it already initialized in swap tx
    const tokenAAccount = getAssociatedTokenAddressSync(
      tokenAMint,
      user,
      false,
      tokenAProgram
    );
    const tokenBAccount = getAssociatedTokenAddressSync(
      tokenBMint,
      user,
      false,
      tokenAProgram
    );

    return await this.zapProgram.methods
      .zapInDammV2(preSqrtPrice, maxSqrtPriceChangeBps)
      .accountsPartial({
        ledger: deriveLedgerAccount(user),
        pool,
        poolAuthority: deriveDammV2PoolAuthority(),
        position,
        positionNftAccount,
        tokenAAccount,
        tokenBAccount,
        tokenAVault,
        tokenBVault,
        tokenAMint,
        tokenBMint,
        owner: user,
        tokenAProgram,
        tokenBProgram,
        dammProgram: DAMM_V2_PROGRAM_ID,
        dammEventAuthority: deriveDammV2EventAuthority(),
      })
      .transaction();
  }

  private async zapInDlmmForInitializedPosition(params: {
    user: PublicKey;
    lbPair: PublicKey;
    position: PublicKey;
    activeId: number;
    minDeltaId: number;
    maxDeltaId: number;
    maxActiveBinSlippage: number;
    favorXInActiveId: boolean;
    binArrayBitmapExtension: PublicKey;
    binArrays: AccountMeta[];
    strategy: DlmmStrategyType;
    remainingAccountInfo: RemainingAccountInfo;
  }): Promise<Transaction> {
    const {
      user,
      lbPair,
      position,
      activeId,
      minDeltaId,
      maxDeltaId,
      maxActiveBinSlippage,
      favorXInActiveId,
      binArrayBitmapExtension,
      binArrays,
      strategy,
      remainingAccountInfo,
    } = params;

    const lbPairState = await getLbPairState(this.connection, lbPair);

    const { tokenXMint, tokenYMint, reserveX, reserveY } = lbPairState;

    const binArrayBitmapExtensionData = await this.connection.getAccountInfo(
      binArrayBitmapExtension
    );

    const { tokenXProgram, tokenYProgram } = getTokenProgramId(lbPairState);

    // we don't need to handle init ata account if not exist here
    // because it already initialized in swap tx
    const userTokenX = getAssociatedTokenAddressSync(
      tokenXMint,
      user,
      false,
      tokenXProgram
    );
    const userTokenY = getAssociatedTokenAddressSync(
      tokenYMint,
      user,
      false,
      tokenYProgram
    );

    return await this.zapProgram.methods
      .zapInDlmmForInitializedPosition(
        activeId,
        minDeltaId,
        maxDeltaId,
        maxActiveBinSlippage,
        favorXInActiveId,
        strategy,
        remainingAccountInfo
      )
      .accountsPartial({
        ledger: deriveLedgerAccount(user),
        lbPair,
        position,
        binArrayBitmapExtension: binArrayBitmapExtensionData
          ? binArrayBitmapExtension
          : null,
        userTokenX,
        userTokenY,
        reserveX,
        reserveY,
        tokenXMint,
        tokenYMint,
        tokenXProgram,
        tokenYProgram,
        dlmmProgram: DLMM_PROGRAM_ID,
        owner: user,
        rentPayer: user,
        memoProgram: MEMO_PROGRAM_ID,
        dlmmEventAuthority: deriveDlmmEventAuthority(),
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(binArrays)
      .transaction();
  }

  private async zapInDlmmForUnInitializedPosition(params: {
    user: PublicKey;
    lbPair: PublicKey;
    position: PublicKey;
    activeId: number;
    binDelta: number;
    maxActiveBinSlippage: number;
    favorXInActiveId: boolean;
    binArrayBitmapExtension: PublicKey;
    binArrays: AccountMeta[];
    strategy: DlmmStrategyType;
    remainingAccountInfo: RemainingAccountInfo;
  }): Promise<Transaction> {
    const {
      user,
      lbPair,
      position,
      activeId,
      binDelta,
      maxActiveBinSlippage,
      favorXInActiveId,
      binArrayBitmapExtension,
      binArrays,
      strategy,
      remainingAccountInfo,
    } = params;

    const lbPairState = await getLbPairState(this.connection, lbPair);

    const { tokenXMint, tokenYMint, reserveX, reserveY } = lbPairState;

    const binArrayBitmapExtensionData = await this.connection.getAccountInfo(
      binArrayBitmapExtension
    );

    const { tokenXProgram, tokenYProgram } = getTokenProgramId(lbPairState);

    // we don't need to handle init ata account if not exist here
    // because it already initialized in swap tx
    const userTokenX = getAssociatedTokenAddressSync(
      tokenXMint,
      user,
      false,
      tokenXProgram
    );
    const userTokenY = getAssociatedTokenAddressSync(
      tokenYMint,
      user,
      false,
      tokenYProgram
    );

    return await this.zapProgram.methods
      .zapInDlmmForUninitializedPosition(
        binDelta,
        activeId,
        maxActiveBinSlippage,
        favorXInActiveId,
        strategy,
        remainingAccountInfo
      )
      .accountsPartial({
        ledger: deriveLedgerAccount(user),
        lbPair,
        position,
        binArrayBitmapExtension: binArrayBitmapExtensionData
          ? binArrayBitmapExtension
          : null,
        userTokenX,
        userTokenY,
        reserveX,
        reserveY,
        tokenXMint,
        tokenYMint,
        tokenXProgram,
        tokenYProgram,
        dlmmProgram: DLMM_PROGRAM_ID,
        owner: user,
        rentPayer: user,
        memoProgram: MEMO_PROGRAM_ID,
        dlmmEventAuthority: deriveDlmmEventAuthority(),
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(binArrays)
      .transaction();
  }

  /////// ZAPIN FUNCTION ////////

  async getZapInDammV2DirectPoolParams(
    user: PublicKey,
    amountIn: Decimal,
    pool: PublicKey,
    position: PublicKey,
    positionNftAccount: PublicKey,
    maxSqrtPriceChangeBps: number,
    maxTransferAmountExtendPercentage: number = 20,
    maxAccounts: number = 40,
    slippageBps: number = 50
  ): Promise<ZapInDammV2DirectPoolParam> {
    const poolState = await getDammV2Pool(this.connection, pool);
    const {
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      tokenAFlag,
      tokenBFlag,
    } = poolState;

    const tokenAProgram = getTokenProgram(tokenAFlag);
    const tokenBProgram = getTokenProgram(tokenBFlag);

    const preInstructions: TransactionInstruction[] = [];

    const userWrapSolAcc = getAssociatedTokenAddressSync(NATIVE_MINT, user);
    const warpSOL = wrapSOLInstruction(
      user,
      userWrapSolAcc,
      BigInt(amountIn.mul(LAMPORTS_PER_SOL).floor().toString())
    );
    preInstructions.push(...warpSOL);

    const tokenADecimal = await getTokenDecimals(
      this.connection,
      tokenAMint,
      tokenAProgram
    );

    const tokenBDecimal = await getTokenDecimals(
      this.connection,
      tokenBMint,
      tokenBProgram
    );

    const poolBalanceTokenA = getAmountAFromLiquidityDelta(
      poolState.sqrtPrice,
      poolState.sqrtMaxPrice,
      poolState.liquidity,
      Rounding.Down
    );
    const poolBalanceTokenB = getAmountBFromLiquidityDelta(
      poolState.sqrtMinPrice,
      poolState.sqrtPrice,
      poolState.liquidity,
      Rounding.Down
    );

    let amount;
    let swapTransaction: Transaction | null = null;
    let maxTransferAmount;

    const { dammV2Quote, jupiterQuote } = await getJupAndDammV2Quotes(
      this.connection,
      poolState,
      tokenADecimal,
      tokenBDecimal
    );

    if (
      jupiterQuote !== null &&
      new BN(jupiterQuote.outAmount).gte(dammV2Quote.swapOutAmount)
    ) {
      const price = convertLamportsToUiAmount(
        new Decimal(jupiterQuote.outAmount),
        tokenAMint.equals(NATIVE_MINT) ? tokenBDecimal : tokenADecimal
      );

      const swapAmount = calculateDirectPoolSwapAmount(
        amountIn,
        new Decimal(price),
        convertLamportsToUiAmount(
          new Decimal(poolBalanceTokenA.toString()),
          tokenADecimal
        ),
        convertLamportsToUiAmount(
          new Decimal(poolBalanceTokenB.toString()),
          tokenBDecimal
        ),
        tokenAMint.equals(NATIVE_MINT)
      );

      amount = amountIn.sub(swapAmount);

      const swapAmountInLamports = new BN(
        convertUiAmountToLamports(swapAmount, tokenADecimal).floor().toString()
      );

      const result = await buildJupiterSwapTransaction(
        user,
        NATIVE_MINT,
        tokenAMint.equals(NATIVE_MINT) ? tokenBMint : tokenAMint,
        swapAmountInLamports,
        maxAccounts,
        slippageBps
      );
      swapTransaction = result.transaction;
      maxTransferAmount = getExtendMaxAmountTransfer(
        result.quoteResponse!.outAmount,
        maxTransferAmountExtendPercentage
      );
    } else {
      amount = amountIn;
      maxTransferAmount = getExtendMaxAmountTransfer(
        dammV2Quote.swapOutAmount.toString(),
        maxTransferAmountExtendPercentage
      );
    }

    return {
      user,
      amount: new BN(amount.mul(LAMPORTS_PER_SOL).floor().toString()),
      pool,
      position,
      positionNftAccount,
      isDirectPool: true,
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      tokenAProgram,
      tokenBProgram,
      maxTransferAmount,
      preSqrtPrice: poolState.sqrtPrice,
      maxSqrtPriceChangeBps,
      preInstructions,
      swapTransaction,
    };
  }

  async getZapInDammV2IndirectPoolParams(
    user: PublicKey,
    amountIn: Decimal,
    pool: PublicKey,
    position: PublicKey,
    positionNftAccount: PublicKey,
    maxSqrtPriceChangeBps: number,
    maxTransferAmountExtendPercentage: number = 20,
    maxAccounts: number = 40,
    slippageBps: number = 50
  ): Promise<ZapInDammV2InDirectPoolParam | null> {
    const poolState = await getDammV2Pool(this.connection, pool);
    const {
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      tokenAFlag,
      tokenBFlag,
    } = poolState;

    const tokenAProgram = getTokenProgram(tokenAFlag);
    const tokenBProgram = getTokenProgram(tokenBFlag);

    const tokenADecimal = await getTokenDecimals(
      this.connection,
      tokenAMint,
      tokenAProgram
    );

    const tokenBDecimal = await getTokenDecimals(
      this.connection,
      tokenBMint,
      tokenBProgram
    );

    const preInstructions: TransactionInstruction[] = [];

    const { ataPubkey: userWrapSolAcc, ix: initializeWarpSOLAta } =
      await getOrCreateATAInstruction(
        this.connection,
        NATIVE_MINT,
        user,
        user,
        false,
        tokenAProgram
      );
    const warpSOL = wrapSOLInstruction(
      user,
      userWrapSolAcc,
      BigInt(amountIn.mul(LAMPORTS_PER_SOL).floor().toString())
    );
    initializeWarpSOLAta && preInstructions.push(initializeWarpSOLAta);
    preInstructions.push(...warpSOL);

    const poolBalanceTokenA = getAmountAFromLiquidityDelta(
      poolState.sqrtPrice,
      poolState.sqrtMaxPrice,
      poolState.liquidity,
      Rounding.Down
    );
    const poolBalanceTokenB = getAmountBFromLiquidityDelta(
      poolState.sqrtMinPrice,
      poolState.sqrtPrice,
      poolState.liquidity,
      Rounding.Down
    );

    const jupiterQuoteTokenA = await getJupiterQuote(
      NATIVE_MINT,
      poolState.tokenAMint,
      new BN(LAMPORTS_PER_SOL),
      maxAccounts,
      slippageBps,
      false,
      true,
      true,
      "https://lite-api.jup.ag"
    );

    const jupiterQuoteTokenB = await getJupiterQuote(
      NATIVE_MINT,
      poolState.tokenBMint,
      new BN(LAMPORTS_PER_SOL),
      maxAccounts,
      slippageBps,
      false,
      true,
      true,
      "https://lite-api.jup.ag"
    );

    if (jupiterQuoteTokenA && jupiterQuoteTokenB === null) {
      const { transaction: swapTransaction } =
        await buildJupiterSwapTransaction(
          user,
          NATIVE_MINT,
          tokenAMint,
          new BN(amountIn.mul(LAMPORTS_PER_SOL).floor().toString()),
          maxAccounts,
          slippageBps
        );

      return {
        user,
        pool,
        position,
        positionNftAccount,
        maxSqrtPriceChangeBps,
        amount: new BN(amountIn.mul(LAMPORTS_PER_SOL).floor().toString()),
        isDirectPool: false,
        tokenAMint,
        tokenBMint,
        tokenAVault,
        tokenBVault,
        tokenAProgram,
        tokenBProgram,
        preInstructions,
        maxTransferAmountA: getExtendMaxAmountTransfer(
          jupiterQuoteTokenA.outAmount,
          maxTransferAmountExtendPercentage
        ),
        swapType: SwapExternalType.swapToA,
        maxTransferAmountB: new BN(0),
        preSqrtPrice: poolState.sqrtPrice,
        swapTransaction: swapTransaction,
      };
    }

    if (jupiterQuoteTokenB && jupiterQuoteTokenA === null) {
      const { transaction: swapTransaction } =
        await buildJupiterSwapTransaction(
          user,
          NATIVE_MINT,
          tokenBMint,
          new BN(amountIn.mul(LAMPORTS_PER_SOL).floor().toString()),
          maxAccounts,
          slippageBps
        );

      return {
        user,
        pool,
        position,
        positionNftAccount,
        maxSqrtPriceChangeBps,
        amount: new BN(amountIn.mul(LAMPORTS_PER_SOL).floor().toString()),
        isDirectPool: false,
        tokenAMint,
        tokenBMint,
        tokenAVault,
        tokenBVault,
        tokenAProgram,
        tokenBProgram,
        preInstructions,
        maxTransferAmountA: new BN(0),
        maxTransferAmountB: getExtendMaxAmountTransfer(
          jupiterQuoteTokenB.outAmount,
          maxTransferAmountExtendPercentage
        ),
        swapType: SwapExternalType.swapToB,
        preSqrtPrice: poolState.sqrtPrice,
        swapTransaction: swapTransaction,
      };
    }

    if (jupiterQuoteTokenA && jupiterQuoteTokenB) {
      const priceA = convertLamportsToUiAmount(
        new Decimal(jupiterQuoteTokenA.outAmount),
        tokenADecimal
      );

      const priceB = convertLamportsToUiAmount(
        new Decimal(jupiterQuoteTokenB.outAmount),
        tokenBDecimal
      );

      const swapAmountToA = calculateIndirectPoolSwapAmount(
        amountIn,
        priceA,
        priceB,
        convertLamportsToUiAmount(
          new Decimal(poolBalanceTokenA.toString()),
          tokenADecimal
        ),
        convertLamportsToUiAmount(
          new Decimal(poolBalanceTokenB.toString()),
          tokenBDecimal
        )
      );

      const swapAmountToB = amountIn.sub(swapAmountToA);

      const swapAmountToAInLamports = new BN(
        convertUiAmountToLamports(swapAmountToA, tokenADecimal)
          .floor()
          .toString()
      );

      const swapAmountToBInLamports = new BN(
        convertUiAmountToLamports(swapAmountToB, tokenBDecimal)
          .floor()
          .toString()
      );

      const { transaction: swapToATransaction, quoteResponse: swapToAQuote } =
        await buildJupiterSwapTransaction(
          user,
          NATIVE_MINT,
          tokenAMint,
          swapAmountToAInLamports,
          maxAccounts,
          slippageBps
        );

      const { transaction: swapToBTransaction, quoteResponse: swapToBQuote } =
        await buildJupiterSwapTransaction(
          user,
          NATIVE_MINT,
          tokenBMint,
          swapAmountToBInLamports,
          maxAccounts,
          slippageBps
        );
      const swapTransaction = new Transaction()
        .add(swapToATransaction)
        .add(swapToBTransaction);

      return {
        user,
        pool,
        position,
        positionNftAccount,
        maxSqrtPriceChangeBps,
        amount: new BN(0),
        isDirectPool: false,
        tokenAMint,
        tokenBMint,
        tokenAVault,
        tokenBVault,
        tokenAProgram,
        tokenBProgram,
        preInstructions,
        maxTransferAmountA: getExtendMaxAmountTransfer(
          swapToAQuote!.outAmount,
          maxTransferAmountExtendPercentage
        ),
        maxTransferAmountB: getExtendMaxAmountTransfer(
          swapToBQuote!.outAmount,
          maxTransferAmountExtendPercentage
        ),
        swapType: SwapExternalType.swapToBoth,
        preSqrtPrice: poolState.sqrtPrice,
        swapTransaction: swapTransaction,
      };
    }
    // jupiterQuoteTokenA & jupiterQuoteTokenB both is null
    return null;
  }

  async buildZapInDammV2Transaction(
    params: ZapInDammV2DirectPoolParam | ZapInDammV2InDirectPoolParam
  ): Promise<ZapInDammV2Response> {
    const {
      user,
      pool,
      position,
      positionNftAccount,
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      tokenAProgram,
      tokenBProgram,
      isDirectPool,
      amount,
      preSqrtPrice,
      maxSqrtPriceChangeBps,
      preInstructions,
      swapTransaction,
    } = params;

    const initializeAtaIxs: TransactionInstruction[] = [];

    const [
      { ataPubkey: tokenAAccount, ix: initializeTokenAIx },
      { ataPubkey: tokenBAccount, ix: initializeTokenBIx },
    ] = await Promise.all([
      getOrCreateATAInstruction(
        this.connection,
        tokenAMint,
        user,
        user,
        false,
        tokenAProgram
      ),
      getOrCreateATAInstruction(
        this.connection,
        tokenBMint,
        user,
        user,
        false,
        tokenBProgram
      ),
    ]);

    initializeTokenAIx && initializeAtaIxs.push(initializeTokenAIx);
    initializeTokenBIx && initializeAtaIxs.push(initializeTokenBIx);

    // initialize ledger tx
    const initializeLedgerTx = await this.initializeLedgerAccount(user, user);

    // ledger transaction included: setLedgerBalanceTx and updateLedgerBalanceAfterSwap
    const ledgerTransaction = new Transaction();
    if (isDirectPool) {
      const isTokenA = tokenAMint.equals(NATIVE_MINT);
      const setLedgerBalanceTx = await this.setLedgerBalance(
        user,
        amount,
        isTokenA
      );

      ledgerTransaction.add(setLedgerBalanceTx);
      if (swapTransaction) {
        const tokenAccount = isTokenA ? tokenBAccount : tokenAAccount;
        const preTokenBalance = await getTokenAccountBalance(
          this.connection,
          tokenAccount
        );

        const updateLedgerBalanceAfterSwapTx =
          await this.updateLedgerBalanceAfterSwap(
            user,
            tokenAccount,
            new BN(preTokenBalance),
            (params as ZapInDammV2DirectPoolParam).maxTransferAmount,
            !isTokenA
          );
        ledgerTransaction.add(updateLedgerBalanceAfterSwapTx);
      }
    } else {
      const preTokenABalance = await getTokenAccountBalance(
        this.connection,
        tokenAAccount
      );

      const preTokenBBalance = await getTokenAccountBalance(
        this.connection,
        tokenBAccount
      );

      const updateLedgerBalanceTokenAAfterSwapTx =
        await this.updateLedgerBalanceAfterSwap(
          user,
          tokenAAccount,
          new BN(preTokenABalance),
          (params as ZapInDammV2InDirectPoolParam).maxTransferAmountA,
          true // is token A
        );

      const updateLedgerBalanceTokenBAfterSwapTx =
        await this.updateLedgerBalanceAfterSwap(
          user,
          tokenBAccount,
          new BN(preTokenBBalance),
          (params as ZapInDammV2InDirectPoolParam).maxTransferAmountB,
          false // isn't token A
        );
      const swapType = (params as ZapInDammV2InDirectPoolParam).swapType;

      if (swapType == SwapExternalType.swapToA) {
        ledgerTransaction.add(updateLedgerBalanceTokenAAfterSwapTx);
      } else if (swapType == SwapExternalType.swapToB) {
        ledgerTransaction.add(updateLedgerBalanceTokenBAfterSwapTx);
      } else {
        ledgerTransaction
          .add(updateLedgerBalanceTokenAAfterSwapTx)
          .add(updateLedgerBalanceTokenBAfterSwapTx);
      }
    }

    const zapInTx = await this.zapInDammV2({
      user,
      pool,
      position,
      positionNftAccount,
      preSqrtPrice,
      maxSqrtPriceChangeBps,
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      tokenAProgram,
      tokenBProgram,
    });

    const closeLedgerTx = await this.closeLedgerAccount(user, user);

    return {
      setupTransaction: new Transaction()
        .add(...initializeAtaIxs)
        .add(...preInstructions),
      swapTransaction: swapTransaction ?? new Transaction(),
      initializeLedgerTx,
      ledgerTransaction,
      zapInTx,
      closeLedgerTx,
    };
  }

  /////// ZAPOUT FUNTIONS ///////

  /**
   * Executes a generic zap out operation with custom parameters.
   *
   * @param params - Zap out operation parameters
   * @param params.userTokenInAccount - Token ledger account to zap out from
   * @param params.zapOutParams - Zap out parameters
   * @param params.remainingAccounts - Additional accounts needed for the operation
   * @param params.ammProgram - AMM program ID to interact with
   * @param params.preInstructions - Instructions to run before the zap out
   * @param params.postInstructions - Instructions to run after the zap out
   * @returns builder transaction
   */
  async zapOut(params: ZapOutParams): Promise<Transaction> {
    const {
      zapOutParams,
      userTokenInAccount,
      remainingAccounts,
      ammProgram,
      preInstructions,
      postInstructions,
    } = params;
    return this.zapProgram.methods
      .zapOut(zapOutParams)
      .accountsPartial({
        userTokenInAccount,
        ammProgram,
      })
      .remainingAccounts(remainingAccounts)
      .preInstructions(preInstructions)
      .postInstructions(postInstructions)
      .transaction();
  }

  /**
   * Performs a token swap using Jupiter V6 protocol as part of a zap out operation.
   * Swaps tokens from the input token ledger to the user's output token account.
   *
   * @param params - Jupiter V6 swap parameters from Jupiter API
   * @param params.user - Public key of the user performing the swap
   * @param params.inputMint - Token mint being swapped from
   * @param params.outputMint - Token mint being swapped to
   * @param params.jupiterSwapResponse - Jupiter swap instruction response
   * @param params.inputTokenProgram - Token program for the input token (defaults to SPL Token)
   * @param params.outputTokenProgram - Token program for the output token (defaults to SPL Token)
   * @param params.maxSwapAmount - Maximum amount of input token to swap
   * @param params.percentageToZapOut - Percentage of input token to zap out
   * @returns built transaction
   */
  async zapOutThroughJupiter(
    params: ZapOutThroughJupiterParams
  ): Promise<Transaction> {
    const {
      user,
      inputMint,
      outputMint,
      inputTokenProgram,
      outputTokenProgram,
      jupiterSwapResponse,
      maxSwapAmount,
      percentageToZapOut,
    } = params;

    const preInstructions: TransactionInstruction[] = [];
    const postInstructions: TransactionInstruction[] = [];

    const [
      { ataPubkey: inputTokenAccount, ix: inputTokenAccountIx },
      { ataPubkey: outputTokenAccount, ix: outputTokenAccountIx },
    ] = await Promise.all([
      getOrCreateATAInstruction(
        this.connection,
        inputMint,
        user,
        user,
        true,
        inputTokenProgram
      ),
      getOrCreateATAInstruction(
        this.connection,
        outputMint,
        user,
        user,
        true,
        outputTokenProgram
      ),
    ]);

    inputTokenAccountIx && preInstructions.push(inputTokenAccountIx);
    outputTokenAccountIx && preInstructions.push(outputTokenAccountIx);

    // DO NOT NEED WRAP AS THIS WILL BE HANDLED BY REMOVE LIQUIDITY'S SKIPUNWRAPSOL BOOLEAN

    let preUserTokenBalance;

    try {
      preUserTokenBalance = await getTokenAccountBalance(
        this.connection,
        inputTokenAccount
      );
    } catch {
      // assume there's no ATA and fallback preUserTokenBalance as 0. But if the error was due to general RPC error (e.g network error) we can actually over swap if
      // maxSwapAmount is > the actual in token amonut

      preUserTokenBalance = "0";
    }

    const remainingAccounts = jupiterSwapResponse.swapInstruction.accounts.map(
      (account) => {
        let pubkey =
          typeof account.pubkey === "string"
            ? new PublicKey(account.pubkey)
            : account.pubkey;
        // Ensure no account is marked as signer - the zap program handles signing
        return {
          pubkey: pubkey,
          isSigner: account.isSigner,
          isWritable: account.isWritable,
        };
      }
    );

    const payloadData = Buffer.from(
      jupiterSwapResponse.swapInstruction.data,
      "base64"
    );

    const offsetAmountIn = payloadData.length - AMOUNT_IN_JUP_V6_REVERSE_OFFSET;

    // NEED TO UNWRAP SOL SINCE WE SKIP THIS STEP IN REMOVE LIQUIDITY FOR ACCURATE SOL BALANCE CHECK
    if (inputMint.equals(NATIVE_MINT) || outputMint.equals(NATIVE_MINT)) {
      const unwrapInstructions = unwrapSOLInstruction(user, user);

      if (unwrapInstructions) {
        postInstructions.push(unwrapInstructions);
      }
    }

    return await this.zapOut({
      userTokenInAccount: inputTokenAccount,
      zapOutParams: {
        percentage: percentageToZapOut,
        offsetAmountIn,
        preUserTokenBalance: new BN(preUserTokenBalance),
        maxSwapAmount,
        payloadData,
      },
      remainingAccounts,
      ammProgram: JUP_V6_PROGRAM_ID,
      preInstructions,
      postInstructions,
    });
  }

  /**
   * Performs a token swap using Damms V2 protocol as part of a zap out operation.
   * Swaps tokens from the input token ledger to the user's output token account.
   *
   * @param params - Damms V2 swap parameters
   * @param params.user - Public key of the user performing the swap
   * @param params.poolAddress - Address of the pool to swap through
   * @param params.inputMint - Token mint being swapped from
   * @param params.inputTokenProgram - Token program for the input token (defaults to SPL Token)
   * @param params.amountIn - Amount of input token to swap
   * @param params.minimumSwapAmountOut - Minimum amount of output token to receive
   * @param params.maxSwapAmount - Maximum amount of input token to swap
   * @param params.percentageToZapOut - Percentage of input token to zap out
   */
  async zapOutThroughDammV2(
    params: ZapOutThroughDammV2Params
  ): Promise<Transaction> {
    const {
      user,
      poolAddress,
      inputMint,
      outputMint,
      inputTokenProgram,
      outputTokenProgram,
      amountIn,
      minimumSwapAmountOut,
      maxSwapAmount,
      percentageToZapOut,
    } = params;

    const poolState = await getDammV2Pool(this.connection, poolAddress);

    const preInstructions: TransactionInstruction[] = [];
    const postInstructions: TransactionInstruction[] = [];

    const [
      { ataPubkey: inputTokenAccount, ix: inputTokenAccountIx },
      { ataPubkey: outputTokenAccount, ix: outputTokenAccountIx },
    ] = await Promise.all([
      getOrCreateATAInstruction(
        this.connection,
        inputMint,
        user,
        user,
        true,
        inputTokenProgram
      ),
      getOrCreateATAInstruction(
        this.connection,
        outputMint,
        user,
        user,
        true,
        outputTokenProgram
      ),
    ]);

    inputTokenAccountIx && preInstructions.push(inputTokenAccountIx);
    outputTokenAccountIx && preInstructions.push(outputTokenAccountIx);

    // DO NOT NEED WRAP AS THIS WILL BE HANDLED BY REMOVE LIQUIDITY'S SKIPUNWRAPSOL BOOLEAN

    let preUserTokenBalance;

    try {
      preUserTokenBalance = await getTokenAccountBalance(
        this.connection,
        inputTokenAccount
      );
    } catch {
      // assume there's no ATA and fallback preUserTokenBalance as 0. But if the error was due to general RPC error (e.g network error) we can actually over swap if
      // maxSwapAmount is > the actual in token amonut

      preUserTokenBalance = "0";
    }

    const remainingAccounts = await getDammV2RemainingAccounts(
      poolAddress,
      user,
      inputTokenAccount,
      outputTokenAccount,
      getTokenProgram(poolState.tokenAFlag),
      getTokenProgram(poolState.tokenBFlag),
      poolState
    );

    const payloadData = createDammV2SwapPayload(amountIn, minimumSwapAmountOut);

    const offsetAmountIn = AMOUNT_IN_DAMM_V2_OFFSET;

    // NEED TO UNWRAP SOL SINCE WE SKIP THIS STEP IN REMOVE LIQUIDITY FOR ACCURATE SOL BALANCE CHECK
    if (inputMint.equals(NATIVE_MINT) || outputMint.equals(NATIVE_MINT)) {
      const unwrapInstructions = unwrapSOLInstruction(user, user);

      if (unwrapInstructions) {
        postInstructions.push(unwrapInstructions);
      }
    }

    return await this.zapOut({
      userTokenInAccount: inputTokenAccount,
      zapOutParams: {
        percentage: percentageToZapOut,
        offsetAmountIn,
        preUserTokenBalance: new BN(preUserTokenBalance),
        maxSwapAmount,
        payloadData,
      },
      remainingAccounts,
      ammProgram: DAMM_V2_PROGRAM_ID,
      preInstructions,
      postInstructions,
    });
  }

  /**
   * Performs a token swap using Dlmm protocol as part of a zap out operation.
   * Swaps tokens from the input token ledger to the user's output token account.
   *
   * @param params - Dlmm swap parameters
   * @param params.user - Public key of the user performing the swap
   * @param params.lbPairAddress - Address of the lbPair to swap through
   * @param params.inputMint - Token mint being swapped from
   * @param params.inputTokenProgram - Token program for the input token (defaults to SPL Token)
   * @param params.amountIn - Amount of input token to swap
   * @param params.minimumSwapAmountOut - Minimum amount of output token to receive
   * @param params.maxSwapAmount - Maximum amount of input token to swap
   * @param params.percentageToZapOut - Percentage of input token to zap out
   */
  async zapOutThroughDlmm(
    params: ZapOutThroughDlmmParams
  ): Promise<Transaction> {
    const {
      user,
      lbPairAddress,
      inputMint,
      outputMint,
      inputTokenProgram,
      outputTokenProgram,
      amountIn,
      minimumSwapAmountOut,
      maxSwapAmount,
      percentageToZapOut,
    } = params;

    const lbPairState = await getLbPairState(this.connection, lbPairAddress);

    const preInstructions: TransactionInstruction[] = [];
    const postInstructions: TransactionInstruction[] = [];

    const [
      { ataPubkey: inputTokenAccount, ix: inputTokenAccountIx },
      { ataPubkey: outputTokenAccount, ix: outputTokenAccountIx },
    ] = await Promise.all([
      getOrCreateATAInstruction(
        this.connection,
        inputMint,
        user,
        user,
        true,
        inputTokenProgram
      ),
      getOrCreateATAInstruction(
        this.connection,
        outputMint,
        user,
        user,
        true,
        outputTokenProgram
      ),
    ]);

    inputTokenAccountIx && preInstructions.push(inputTokenAccountIx);
    outputTokenAccountIx && preInstructions.push(outputTokenAccountIx);

    // DO NOT NEED WRAP AS THIS WILL BE HANDLED BY REMOVE LIQUIDITY'S SKIPUNWRAPSOL BOOLEAN

    let preUserTokenBalance;

    try {
      preUserTokenBalance = await getTokenAccountBalance(
        this.connection,
        inputTokenAccount
      );
    } catch {
      // assume there's no ATA and fallback preUserTokenBalance as 0. But if the error was due to general RPC error (e.g network error) we can actually over swap if
      // maxSwapAmount is > the actual in token amonut

      preUserTokenBalance = "0";
    }

    const { remainingAccounts, remainingAccountsInfo } =
      await getDlmmRemainingAccounts(
        this.connection,
        lbPairAddress,
        user,
        inputTokenAccount,
        outputTokenAccount,
        getTokenProgram(lbPairState.tokenMintXProgramFlag),
        getTokenProgram(lbPairState.tokenMintYProgramFlag),
        lbPairState
      );

    const payloadData = createDlmmSwapPayload(
      amountIn,
      minimumSwapAmountOut,
      remainingAccountsInfo
    );

    // NEED TO UNWRAP SOL SINCE WE SKIP THIS STEP IN REMOVE LIQUIDITY FOR ACCURATE SOL BALANCE CHECK
    if (inputMint.equals(NATIVE_MINT) || outputMint.equals(NATIVE_MINT)) {
      const unwrapInstructions = unwrapSOLInstruction(user, user);

      if (unwrapInstructions) {
        postInstructions.push(unwrapInstructions);
      }
    }

    return await this.zapOut({
      userTokenInAccount: inputTokenAccount,
      zapOutParams: {
        percentage: percentageToZapOut,
        offsetAmountIn: AMOUNT_IN_DLMM_OFFSET,
        preUserTokenBalance: new BN(preUserTokenBalance),
        maxSwapAmount,
        payloadData,
      },
      remainingAccounts,
      ammProgram: DLMM_PROGRAM_ID,
      preInstructions,
      postInstructions,
    });
  }
}
