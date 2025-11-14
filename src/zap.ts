import {
  AccountMeta,
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import invariant from "invariant";
import { BN, Program } from "@coral-xyz/anchor";
import ZapIDL from "./idl/zap/idl.json";
import { Zap as ZapTypes } from "./idl/zap/idl";
import {
  GetZapInDammV2DirectPoolParams,
  GetZapInDammV2InDirectPoolParams,
  SwapExternalType,
  ZapInDammV2DirectPoolParam,
  ZapInDammV2InDirectPoolParam,
  ZapInDammV2Response,
  ZapOutParams,
  ZapOutThroughDammV2Params,
  ZapOutThroughDlmmParams,
  ZapOutThroughJupiterParams,
  ZapProgram,
  SwapEstimate,
  RebalanceDlmmPositionParams,
  RebalanceDlmmPositionResponse,
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
  buildJupiterSwapTransaction,
  estimateBalancedSwap,
  getJupiterSwapInstruction,
  toProgramStrategyType,
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
  getTokenDecimals,
  getTokenProgram,
  Rounding,
} from "@meteora-ag/cp-amm-sdk";
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import DLMM, {
  getTokenProgramId,
  RemainingAccountInfo,
  getAndCapMaxActiveBinSlippage,
  BASIS_POINT_MAX,
  getBinArraysRequiredByPositionRange,
  deriveBinArrayBitmapExtension,
  MAX_ACTIVE_BIN_SLIPPAGE,
  StrategyType,
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
  public zapProgram: ZapProgram;
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

  private async resetOrInitializeLedgerAccount(
    user: PublicKey
  ): Promise<Transaction> {
    const ledgerAccount = deriveLedgerAccount(user);
    const accountInfo = await this.connection.getAccountInfo(ledgerAccount);
    if (accountInfo) {
      const closeLedger = await this.closeLedgerAccount(user, user);
      const reInitializeLedger = await this.initializeLedgerAccount(user, user);
      return new Transaction().add(closeLedger).add(reInitializeLedger);
    }

    return await this.initializeLedgerAccount(user, user);
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
    binArrays: AccountMeta[];
    strategy: StrategyType;
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
      binArrays,
      strategy,
      remainingAccountInfo,
    } = params;

    const lbPairState = await getLbPairState(this.connection, lbPair);

    const { tokenXMint, tokenYMint, reserveX, reserveY } = lbPairState;

    const [binArrayBitmapExtension] = deriveBinArrayBitmapExtension(
      lbPair,
      DLMM_PROGRAM_ID
    );

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
        toProgramStrategyType(strategy),
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
    strategy: StrategyType;
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
        toProgramStrategyType(strategy),
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
    params: GetZapInDammV2DirectPoolParams
  ): Promise<ZapInDammV2DirectPoolParam> {
    const {
      user,
      pool,
      inputTokenMint,
      amountIn,
      position,
      positionNftAccount,
      maxAccounts,
      maxSqrtPriceChangeBps,
      slippageBps,
      dammV2Quote,
      jupiterQuote,
      maxTransferAmountExtendPercentage,
    } = params;
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

    invariant(
      inputTokenMint.equals(tokenAMint) || inputTokenMint.equals(tokenBMint),
      "Invalid input token mint"
    );

    if (tokenAMint.equals(NATIVE_MINT) || tokenBMint.equals(NATIVE_MINT)) {
      const { ataPubkey: userWrapSolAcc, ix: initializeUserWrapSOLAta } =
        await getOrCreateATAInstruction(
          this.connection,
          inputTokenMint,
          user,
          user,
          false,
          TOKEN_PROGRAM_ID
        );
      initializeUserWrapSOLAta &&
        preInstructions.push(initializeUserWrapSOLAta);

      const wrapSOL = wrapSOLInstruction(
        user,
        userWrapSolAcc,
        BigInt(amountIn.mul(LAMPORTS_PER_SOL).floor().toString())
      );

      preInstructions.push(...wrapSOL);
    }

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

    const inputTokenDecimal = inputTokenMint.equals(tokenAMint)
      ? tokenADecimal
      : tokenBDecimal;

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
    let swapTransactions: Transaction[] = [];
    let maxTransferAmount;

    if (
      jupiterQuote !== null &&
      new BN(jupiterQuote.outAmount).gte(dammV2Quote.swapOutAmount)
    ) {
      const price = convertLamportsToUiAmount(
        new Decimal(jupiterQuote.outAmount),
        tokenAMint.equals(inputTokenMint) ? tokenBDecimal : tokenADecimal
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
        tokenAMint.equals(inputTokenMint)
      );

      amount = amountIn.sub(swapAmount);

      const swapAmountInLamports = new BN(
        convertUiAmountToLamports(swapAmount, tokenADecimal).floor().toString()
      );

      const result = await buildJupiterSwapTransaction(
        user,
        inputTokenMint,
        tokenAMint.equals(inputTokenMint) ? tokenBMint : tokenAMint,
        swapAmountInLamports,
        maxAccounts,
        slippageBps
      );
      swapTransactions = [result.transaction];
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

    const cleanUpInstructions: TransactionInstruction[] = [];
    if (
      inputTokenMint.equals(NATIVE_MINT) ||
      tokenAMint.equals(NATIVE_MINT) ||
      tokenBMint.equals(NATIVE_MINT)
    ) {
      const closewrapSol = unwrapSOLInstruction(user, user, false);
      closewrapSol && cleanUpInstructions.push(closewrapSol);
    }

    return {
      user,
      amount: new BN(
        convertUiAmountToLamports(amount, inputTokenDecimal).floor().toString()
      ),
      pool,
      position,
      positionNftAccount,
      isDirectPool: true,
      isTokenA: tokenAMint.equals(inputTokenMint),
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
      swapTransactions,
      cleanUpInstructions,
    };
  }

  async getZapInDammV2IndirectPoolParams(
    params: GetZapInDammV2InDirectPoolParams
  ): Promise<ZapInDammV2InDirectPoolParam | null> {
    const {
      user,
      inputTokenMint,
      pool,
      position,
      positionNftAccount,
      amountIn,
      maxAccounts,
      maxSqrtPriceChangeBps,
      maxTransferAmountExtendPercentage,
      slippageBps,
      jupiterQuoteToA,
      jupiterQuoteToB,
    } = params;
    const poolState = await getDammV2Pool(this.connection, pool);
    const {
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      tokenAFlag,
      tokenBFlag,
    } = poolState;

    invariant(
      !inputTokenMint.equals(tokenAMint) && !inputTokenMint.equals(tokenBMint),
      "Invalid input token mint"
    );

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

    const inputTokenDecimal = await getTokenDecimals(
      this.connection,
      inputTokenMint,
      TOKEN_PROGRAM_ID
    );

    const preInstructions: TransactionInstruction[] = [];

    if (inputTokenMint.equals(NATIVE_MINT)) {
      const { ataPubkey: userWrapSolAcc, ix: initializeWrapSOLAta } =
        await getOrCreateATAInstruction(
          this.connection,
          inputTokenMint,
          user,
          user,
          false,
          TOKEN_PROGRAM_ID
        );
      const wrapSOL = wrapSOLInstruction(
        user,
        userWrapSolAcc,
        BigInt(amountIn.mul(LAMPORTS_PER_SOL).floor().toString())
      );
      initializeWrapSOLAta && preInstructions.push(initializeWrapSOLAta);
      preInstructions.push(...wrapSOL);
    }

    const cleanUpInstructions: TransactionInstruction[] = [];
    if (
      inputTokenMint.equals(NATIVE_MINT) ||
      tokenAMint.equals(NATIVE_MINT) ||
      tokenBMint.equals(NATIVE_MINT)
    ) {
      const closewrapSol = unwrapSOLInstruction(user, user, false);
      closewrapSol && cleanUpInstructions.push(closewrapSol);
    }

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

    if (jupiterQuoteToA && jupiterQuoteToB === null) {
      const amountInLamports = convertUiAmountToLamports(
        amountIn,
        inputTokenDecimal
      );
      const { transaction: swapTransaction } =
        await buildJupiterSwapTransaction(
          user,
          inputTokenMint,
          tokenAMint,
          new BN(amountInLamports.floor().toString()),
          maxAccounts,
          slippageBps
        );

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
        maxTransferAmountA: getExtendMaxAmountTransfer(
          jupiterQuoteToA.outAmount,
          maxTransferAmountExtendPercentage
        ),
        swapType: SwapExternalType.swapToA,
        maxTransferAmountB: new BN(0),
        preSqrtPrice: poolState.sqrtPrice,
        preInstructions,
        swapTransactions: [swapTransaction],
        cleanUpInstructions,
      };
    }

    if (jupiterQuoteToB && jupiterQuoteToA === null) {
      const amountInLamports = convertUiAmountToLamports(
        amountIn,
        inputTokenDecimal
      );
      const { transaction: swapTransaction } =
        await buildJupiterSwapTransaction(
          user,
          inputTokenMint,
          tokenBMint,
          new BN(amountInLamports.floor().toString()),
          maxAccounts,
          slippageBps
        );

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
        maxTransferAmountA: new BN(0),
        maxTransferAmountB: getExtendMaxAmountTransfer(
          jupiterQuoteToB.outAmount,
          maxTransferAmountExtendPercentage
        ),
        swapType: SwapExternalType.swapToB,
        preSqrtPrice: poolState.sqrtPrice,
        preInstructions,
        swapTransactions: [swapTransaction],
        cleanUpInstructions,
      };
    }

    if (jupiterQuoteToA && jupiterQuoteToB) {
      const priceA = convertLamportsToUiAmount(
        new Decimal(jupiterQuoteToA.outAmount),
        tokenADecimal
      );

      const priceB = convertLamportsToUiAmount(
        new Decimal(jupiterQuoteToB.outAmount),
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
        convertUiAmountToLamports(swapAmountToA, inputTokenDecimal)
          .floor()
          .toString()
      );

      const swapAmountToBInLamports = new BN(
        convertUiAmountToLamports(swapAmountToB, inputTokenDecimal)
          .floor()
          .toString()
      );

      const { transaction: swapToATransaction, quoteResponse: swapToAQuote } =
        await buildJupiterSwapTransaction(
          user,
          inputTokenMint,
          tokenAMint,
          swapAmountToAInLamports,
          maxAccounts,
          slippageBps
        );

      const { transaction: swapToBTransaction, quoteResponse: swapToBQuote } =
        await buildJupiterSwapTransaction(
          user,
          inputTokenMint,
          tokenBMint,
          swapAmountToBInLamports,
          maxAccounts,
          slippageBps
        );
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
        swapTransactions: [swapToATransaction, swapToBTransaction],
        cleanUpInstructions,
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
      swapTransactions,
      cleanUpInstructions,
    } = params;

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

    const setupTransaction = new Transaction();
    initializeTokenAIx && setupTransaction.add(initializeTokenAIx);
    initializeTokenBIx && setupTransaction.add(initializeTokenBIx);

    if (preInstructions.length > 0) {
      setupTransaction.add(...preInstructions);
    }

    const ledgerTransaction = new Transaction();
    const resetOrInitializeLedgerTx = await this.resetOrInitializeLedgerAccount(
      user
    );
    ledgerTransaction.add(resetOrInitializeLedgerTx);

    if (isDirectPool) {
      const isTokenA = params.isTokenA!;
      const setLedgerBalanceTx = await this.setLedgerBalance(
        user,
        amount,
        isTokenA
      );

      ledgerTransaction.add(setLedgerBalanceTx);
      if (swapTransactions.length > 0) {
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
      setupTransaction,
      swapTransactions,
      ledgerTransaction,
      zapInTx,
      closeLedgerTx,
      cleanUpTransaction:
        cleanUpInstructions.length > 0
          ? new Transaction().add(...cleanUpInstructions)
          : new Transaction(),
    };
  }

  /**
   * High level method for DLMM position rebalancing
   * Consist of remove liquidity, zap out through Jupiter or DLMM, and zap back in to rebalance the position
   *
   * @param params - Rebalancing DLMM position parameters
   * @param params.lbPairAddress - The DLMM pool address
   * @param params.positionAddress - The position address
   * @param params.user - Public key of the user performing the rebalance
   * @param params.minDeltaId - The delta between the id of the rebalanced min bin id and the active bin id (relative to active bin)
   * @param params.maxDeltaId - The delta between the id of the rebalanced max bin id and the active bin id (relative to active bin)
   * @param params.swapSlippagePercentage - The maximum slippage percentage for the swap operation
   * @param params.liquiditySlippagePercentage - The maximum slippage percentage for the rebalance liquidity operation
   * @param params.strategy - The strategy to use for the rebalance
   * @param params.favorXInActiveId - Whether to favor token X in the active bin
   * @returns Response containing transactions and estimation details
   */
  async rebalanceDlmmPosition(
    params: RebalanceDlmmPositionParams
  ): Promise<RebalanceDlmmPositionResponse> {
    const {
      lbPairAddress,
      positionAddress,
      user,
      minDeltaId,
      maxDeltaId,
      swapSlippagePercentage,
      liquiditySlippagePercentage,
      strategy,
      favorXInActiveId,
    } = params;

    const dlmm = await DLMM.create(this.connection, lbPairAddress);
    const position = await dlmm.getPosition(positionAddress);
    const transactions: Transaction[] = [];

    // remove liquidity from existing position
    const removeLiquidityTxs = await dlmm.removeLiquidity({
      user,
      position: positionAddress,
      fromBinId: position.positionData.lowerBinId,
      toBinId: position.positionData.upperBinId,
      bps: new BN(BASIS_POINT_MAX), // remove all liquidity
      shouldClaimAndClose: false,
    });
    transactions.push(...removeLiquidityTxs);

    // swap tokens to balance if needed
    const tokenXAmount = new BN(position.positionData.totalXAmount);
    const tokenYAmount = new BN(position.positionData.totalYAmount);
    const swapEstimate = await this.estimateBalancedSwapThroughJupiterAndDlmm({
      lbPairAddress,
      tokenXAmount,
      tokenYAmount,
      slippage: swapSlippagePercentage,
    });
    const { tokenXProgram, tokenYProgram } = getTokenProgramId(dlmm.lbPair);
    if (swapEstimate.swapDirection !== "noSwap") {
      const isXToY = swapEstimate.swapDirection === "xToY";
      const inputMint = isXToY
        ? dlmm.lbPair.tokenXMint
        : dlmm.lbPair.tokenYMint;
      const outputMint = isXToY
        ? dlmm.lbPair.tokenYMint
        : dlmm.lbPair.tokenXMint;
      const inputTokenProgram = isXToY ? tokenXProgram : tokenYProgram;
      const outputTokenProgram = isXToY ? tokenYProgram : tokenXProgram;

      let zapOutTx: Transaction;
      if (swapEstimate.quote?.route === "jupiter") {
        const jupiterQuote = swapEstimate.quote.originalQuote;
        const jupiterSwapResponse = await getJupiterSwapInstruction(
          user,
          jupiterQuote
        );

        zapOutTx = await this.zapOutThroughJupiter({
          user,
          inputMint,
          outputMint,
          inputTokenProgram,
          outputTokenProgram,
          jupiterSwapResponse,
          maxSwapAmount: swapEstimate.swapAmount,
          percentageToZapOut: 100,
        });
      } else {
        zapOutTx = await this.zapOutThroughDlmm({
          user,
          lbPairAddress,
          inputMint,
          outputMint,
          inputTokenProgram,
          outputTokenProgram,
          amountIn: swapEstimate.swapAmount,
          minimumSwapAmountOut: swapEstimate.expectedOutput,
          maxSwapAmount: swapEstimate.swapAmount,
          percentageToZapOut: 100,
        });
      }
      transactions.push(zapOutTx);
    }

    const userTokenX = getAssociatedTokenAddressSync(
      dlmm.lbPair.tokenXMint,
      user,
      false,
      tokenXProgram
    );
    const userTokenY = getAssociatedTokenAddressSync(
      dlmm.lbPair.tokenYMint,
      user,
      false,
      tokenYProgram
    );
    const preTokenXBalance = await this.connection.getTokenAccountBalance(
      userTokenX
    );
    const preTokenYBalance = await this.connection.getTokenAccountBalance(
      userTokenY
    );

    const tokenXAmountAfterSwap = BN.min(
      swapEstimate.swapDirection === "xToY"
        ? tokenXAmount.sub(swapEstimate.swapAmount)
        : swapEstimate.swapDirection === "yToX"
        ? tokenXAmount.add(swapEstimate.expectedOutput)
        : tokenXAmount,
      new BN(preTokenXBalance.value.amount)
    );
    const tokenYAmountAfterSwap = BN.min(
      swapEstimate.swapDirection === "xToY"
        ? tokenYAmount.add(swapEstimate.expectedOutput)
        : swapEstimate.swapDirection === "yToX"
        ? tokenYAmount.sub(swapEstimate.swapAmount)
        : tokenYAmount,
      new BN(preTokenYBalance.value.amount)
    );

    // initialize ledger if needed and update balances
    const ledgerAddress = deriveLedgerAccount(user);
    const ledgerAccountInfo = await this.connection.getAccountInfo(
      ledgerAddress
    );
    const ledgerTx = new Transaction();
    if (!ledgerAccountInfo) {
      // initialize ledger account when it already exists will cause an error
      const initLedgerTx = await this.initializeLedgerAccount(user, user);
      ledgerTx.add(...initLedgerTx.instructions);
    }
    const updateLedgerXTx = await this.updateLedgerBalanceAfterSwap(
      user,
      userTokenX,
      tokenXAmountAfterSwap,
      tokenXAmountAfterSwap,
      true
    );
    ledgerTx.add(...updateLedgerXTx.instructions);
    const updateLedgerYTx = await this.updateLedgerBalanceAfterSwap(
      user,
      userTokenY,
      tokenYAmountAfterSwap,
      tokenYAmountAfterSwap,
      false
    );
    ledgerTx.add(...updateLedgerYTx.instructions);
    transactions.push(ledgerTx);

    const maxActiveBinSlippage = getAndCapMaxActiveBinSlippage(
      liquiditySlippagePercentage * 100,
      dlmm.lbPair.binStep,
      MAX_ACTIVE_BIN_SLIPPAGE
    );
    // should we move this into zapInDlmmForInitializedPosition method instead?
    const binArrays = getBinArraysRequiredByPositionRange(
      lbPairAddress,
      new BN(dlmm.lbPair.activeId + minDeltaId), // minBinId
      new BN(dlmm.lbPair.activeId + maxDeltaId), // maxBinId
      DLMM_PROGRAM_ID
    ).map((item) => ({
      pubkey: item.key,
      isSigner: false,
      isWritable: true,
    }));
    // build zap in transaction with compute budget
    const zapInTx = await this.zapInDlmmForInitializedPosition({
      user,
      lbPair: lbPairAddress,
      position: positionAddress,
      activeId: dlmm.lbPair.activeId,
      minDeltaId,
      maxDeltaId,
      maxActiveBinSlippage,
      favorXInActiveId,
      binArrays,
      strategy,
      remainingAccountInfo: { slices: [] },
    });
    // TODO: Set proper compute unit limit using more accurate calculation
    zapInTx.instructions.unshift(
      // based on 1 tx that consumed 462_610. Add 20% for safety and round up to nearest 100,000
      // 462_610 * 1.2 = 555_132 => 600_000
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })
    );
    transactions.push(zapInTx);

    // close ledger account
    const closeLedgerTx = await this.closeLedgerAccount(user, user);
    transactions.push(closeLedgerTx);

    return {
      transactions, // TODO: optimize to reduce # of transactions
      estimation: {
        currentBalances: {
          tokenX: tokenXAmount,
          tokenY: tokenYAmount,
        },
        afterSwap: {
          tokenX: tokenXAmountAfterSwap,
          tokenY: tokenYAmountAfterSwap,
        },
        swap: {
          direction: swapEstimate.swapDirection,
          amount: swapEstimate.swapAmount,
          expectedOutput: swapEstimate.expectedOutput,
          route: swapEstimate.quote?.route ?? null,
        },
      },
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

  /**
   * Estimates a balanced swap operation to find the optimal swap route between Jupiter and DLMM.
   * This method calculates the optimal swap amount to achieve equal value (1:1 ratio) between token X and token Y amounts.
   *
   * @param params - Estimation parameters
   * @param params.lbPairAddress - Address of the DLMM pair to estimate against
   * @param params.tokenXAmount - Amount of token X available
   * @param params.tokenYAmount - Amount of token Y available
   * @param params.slippage - Slippage tolerance as a decimal (e.g., 0.01 for 1%)
   * @returns Swap calculation result with optimal routing information
   */
  async estimateBalancedSwapThroughJupiterAndDlmm(params: {
    lbPairAddress: PublicKey;
    tokenXAmount: BN;
    tokenYAmount: BN;
    slippage: number;
  }): Promise<SwapEstimate> {
    const { lbPairAddress, tokenXAmount, tokenYAmount, slippage } = params;

    const dlmm = await DLMM.create(this.connection, lbPairAddress);
    const activeBin = await dlmm.getActiveBin();

    const swapEstimate = await estimateBalancedSwap(
      tokenXAmount,
      tokenYAmount,
      dlmm,
      activeBin,
      slippage
    );

    return swapEstimate;
  }
}
