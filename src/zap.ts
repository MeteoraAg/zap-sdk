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
  RebalanceDlmmPositionParams,
  RebalanceDlmmPositionResponse,
  GetZapInDlmmIndirectParams,
  GetZapInDlmmDirectParams,
  ZapInDlmmIndirectPoolParam,
  ZapInDlmmDirectPoolParam,
  ZapInDlmmResponse,
  DlmmSwapType,
  DlmmDirectSwapQuoteRoute,
  DlmmSingleSided,
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
  wrapSOLInstruction,
  deriveLedgerAccount,
  deriveDammV2EventAuthority,
  deriveDammV2PoolAuthority,
  deriveDlmmEventAuthority,
  convertLamportsToUiAmount,
  buildJupiterSwapTransaction,
  toProgramStrategyType,
  filterOutCloseSplTokenAccountInstructions,
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
  derivePositionAddress,
  derivePositionNftAccount,
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
  buildLiquidityStrategyParameters,
  getLiquidityStrategyParameterBuilder,
} from "@meteora-ag/dlmm";
import Decimal from "decimal.js";
import {
  calculateDirectPoolSwapAmount,
  calculateIndirectPoolSwapAmount,
  getExtendMaxAmountTransfer,
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
    tokenAAccount: PublicKey;
    tokenBAccount: PublicKey;
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
      tokenAAccount,
      tokenBAccount,
    } = params;

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

  private async zapInDlmmForUninitializedPosition(params: {
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
        minDeltaId,
        maxDeltaId,
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

  //#region Zap In
  /**
   * Get the parameters for building a DAMM v2 zap in transaction through a direct route
   * Direct route means the input token matches either tokenA or tokenB in the pool
   * so we can swap directly using the pool when it's the optimal route
   *
   * @param params.user - The user's public key
   * @param params.pool - The pool's public key
   * @param params.amountIn - The amount of input token
   * @param params.inputTokenMint - The input token mint
   * @param params.positionNftMint - The position NFT mint account's public key
   * @param params.maxAccounts - The maximum number of accounts for the Jupiter swap query
   * @param params.maxSqrtPriceChangeBps - The maximum sqrt price change in basis points
   * @param params.slippageBps - The swap slippage tolerance in basis points
   * @param params.dammV2Quote - The DAMM V2 swap quote
   * @param params.jupiterQuote - The Jupiter swap quote
   * @param params.maxTransferAmountExtendPercentage - The percentage to extend the max transfer amount after the swap
   * @returns The zap-in transaction parameters for a DAMM V2 direct pool
   * @throws if input token mint matches either tokenA or tokenB in the pool
   * @throws if failed to get both Jupiter and DAMM v2 swap quotes
   */
  async getZapInDammV2DirectPoolParams(
    params: GetZapInDammV2DirectPoolParams
  ): Promise<ZapInDammV2DirectPoolParam> {
    const {
      user,
      pool,
      inputTokenMint,
      amountIn,
      positionNftMint,
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

    invariant(
      inputTokenMint.equals(tokenAMint) || inputTokenMint.equals(tokenBMint),
      "Invalid input token mint"
    );

    const position = derivePositionAddress(positionNftMint);
    const positionNftAccount = derivePositionNftAccount(positionNftMint);

    const tokenAProgram = getTokenProgram(tokenAFlag);
    const tokenBProgram = getTokenProgram(tokenBFlag);

    const preInstructions: TransactionInstruction[] = [];
    if (tokenAMint.equals(NATIVE_MINT) || tokenBMint.equals(NATIVE_MINT)) {
      const { ataPubkey: userWrapSolAcc, ix: initializeUserWrapSOLAta } =
        await getOrCreateATAInstruction(
          this.connection,
          NATIVE_MINT,
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
        BigInt(amountIn.toString())
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
    let swapInAmount: BN;
    let swapOutAmount: BN;

    if (dammV2Quote === null && jupiterQuote === null) {
      throw new Error("No Jupiter or DAMM v2 quote found, unable to proceed");
    }

    if (
      jupiterQuote !== null &&
      (dammV2Quote === null ||
        new BN(jupiterQuote.outAmount).gte(dammV2Quote.swapOutAmount))
    ) {
      const price = convertLamportsToUiAmount(
        new Decimal(jupiterQuote.outAmount),
        tokenAMint.equals(inputTokenMint) ? tokenBDecimal : tokenADecimal
      );

      swapInAmount = calculateDirectPoolSwapAmount(
        amountIn,
        inputTokenDecimal,
        price,
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

      amount = amountIn.sub(swapInAmount);

      const result = await buildJupiterSwapTransaction(
        user,
        inputTokenMint,
        tokenAMint.equals(inputTokenMint) ? tokenBMint : tokenAMint,
        swapInAmount,
        maxAccounts,
        slippageBps
      );
      swapOutAmount = new BN(result.quoteResponse.outAmount);
      swapTransactions = [result.transaction];
      maxTransferAmount = getExtendMaxAmountTransfer(
        result.quoteResponse.outAmount,
        maxTransferAmountExtendPercentage
      );
    } else {
      amount = amountIn;
      swapInAmount = dammV2Quote!.consumedInAmount;
      swapOutAmount = new BN(dammV2Quote!.swapOutAmount);
      maxTransferAmount = getExtendMaxAmountTransfer(
        dammV2Quote!.swapOutAmount.toString(), // we know dammV2Quote is not null here
        maxTransferAmountExtendPercentage
      );
    }

    const cleanUpInstructions: TransactionInstruction[] = [];
    if (tokenAMint.equals(NATIVE_MINT) || tokenBMint.equals(NATIVE_MINT)) {
      const closewrapSol = unwrapSOLInstruction(user, user, false);
      closewrapSol && cleanUpInstructions.push(closewrapSol);
    }

    return {
      user,
      amount,
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
      swapQuote: {
        inAmount: swapInAmount,
        outAmount: swapOutAmount,
      },
    };
  }

  /**
   * Get the parameters for building a DAMM v2 zap in transaction through an indirect route
   * Indirect route means the input token does not match either tokenA or tokenB in the pool
   * so we swap the input token to tokenA and tokenB through Jupiter
   *
   * @param params.user - The user's public key
   * @param params.pool - The pool's public key
   * @param params.amountIn - The amount of input token
   * @param params.inputTokenMint - The input token mint
   * @param params.positionNftMint - The position NFT mint account's public key
   * @param params.maxAccounts - The maximum number of accounts for the Jupiter swap query
   * @param params.maxSqrtPriceChangeBps - The maximum sqrt price change in basis points
   * @param params.slippageBps - The swap slippage tolerance in basis points
   * @param params.jupiterQuoteToA - The Jupiter quote for swapping to tokenA
   * @param params.jupiterQuoteToB - The Jupiter quote for swapping to tokenB
   * @param params.maxTransferAmountExtendPercentage - The percentage to extend the max transfer amount after the swap
   * @returns The zap-in transaction parameters for a DAMM V2 indirect pool
   * @throws if input token mint matches either tokenA or tokenB in the pool
   * @throws if no Jupiter quote provided for both tokens
   */
  async getZapInDammV2IndirectPoolParams(
    params: GetZapInDammV2InDirectPoolParams
  ): Promise<ZapInDammV2InDirectPoolParam | null> {
    const {
      user,
      inputTokenMint,
      pool,
      positionNftMint,
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

    const position = derivePositionAddress(positionNftMint);
    const positionNftAccount = derivePositionNftAccount(positionNftMint);

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
        BigInt(amountIn.toString())
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
      const { transaction: swapTransaction } =
        await buildJupiterSwapTransaction(
          user,
          inputTokenMint,
          tokenAMint,
          amountIn,
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
        swapQuote: {
          inAmountA: new BN(jupiterQuoteToA.inAmount),
          outAmountA: new BN(jupiterQuoteToA.outAmount),
          inAmountB: new BN(0),
          outAmountB: new BN(0),
        },
      };
    }

    if (jupiterQuoteToB && jupiterQuoteToA === null) {
      const { transaction: swapTransaction } =
        await buildJupiterSwapTransaction(
          user,
          inputTokenMint,
          tokenBMint,
          amountIn,
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
        swapQuote: {
          inAmountA: new BN(0),
          outAmountA: new BN(0),
          inAmountB: new BN(jupiterQuoteToB.inAmount),
          outAmountB: new BN(jupiterQuoteToB.outAmount),
        },
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
        inputTokenDecimal,
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

      const { transaction: swapToATransaction, quoteResponse: swapToAQuote } =
        await buildJupiterSwapTransaction(
          user,
          inputTokenMint,
          tokenAMint,
          swapAmountToA,
          maxAccounts,
          slippageBps
        );

      const { transaction: swapToBTransaction, quoteResponse: swapToBQuote } =
        await buildJupiterSwapTransaction(
          user,
          inputTokenMint,
          tokenBMint,
          swapAmountToB,
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
          swapToAQuote.outAmount,
          maxTransferAmountExtendPercentage
        ),
        maxTransferAmountB: getExtendMaxAmountTransfer(
          swapToBQuote.outAmount,
          maxTransferAmountExtendPercentage
        ),
        swapType: SwapExternalType.swapToBoth,
        preSqrtPrice: poolState.sqrtPrice,
        swapTransactions: [swapToATransaction, swapToBTransaction],
        cleanUpInstructions,
        swapQuote: {
          inAmountA: new BN(swapToAQuote.inAmount),
          outAmountA: new BN(swapToAQuote.outAmount),
          inAmountB: new BN(swapToBQuote.inAmount),
          outAmountB: new BN(swapToBQuote.outAmount),
        },
      };
    }
    // jupiterQuoteTokenA & jupiterQuoteTokenB both is null
    throw new Error(
      "No Jupiter quote found for both tokens, unable to proceed"
    );
  }

  /**
   * Build DAMM v2 zap-in transaction
   *
   * @param params.user - The user's public key
   * @param params.pool - The pool's public key
   * @param params.position - The position's public key
   * @param params.positionNftAccount - The position NFT account's public key
   * @param params.tokenAMint - The token A mint
   * @param params.tokenBMint - The token B mint
   * @param params.tokenAVault - The token A vault
   * @param params.tokenBVault - The token B vault
   * @param params.tokenAProgram - The token A program
   * @param params.tokenBProgram - The token B program
   * @param params.isDirectPool - Whether this is a direct pool route
   * @param params.amount - The amount to deposit
   * @param params.preSqrtPrice - The sqrt price before the operation
   * @param params.maxSqrtPriceChangeBps - The maximum sqrt price change in basis points
   * @param params.preInstructions - Instructions to run before the zap in
   * @param params.swapTransactions - Swap transactions to execute
   * @param params.cleanUpInstructions - Instructions to run after the zap in
   * @returns Response containing transaction components
   */
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

    const zapInTransaction = await this.zapInDammV2({
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
      tokenAAccount,
      tokenBAccount,
    });

    const cleanUpTransaction = new Transaction();
    const closeLedgerTransaction = await this.closeLedgerAccount(user, user);
    cleanUpTransaction.add(closeLedgerTransaction);
    if (cleanUpInstructions.length > 0) {
      cleanUpTransaction.add(...cleanUpInstructions);
    }
    return {
      setupTransaction:
        setupTransaction.instructions.length > 0 ? setupTransaction : undefined,
      swapTransactions,
      ledgerTransaction,
      zapInTransaction,
      cleanUpTransaction,
    };
  }

  /**
   * Get the parameters for building a DLMM zap in transaction through a direct route
   * Direct route means the input token matches either tokenX or tokenY in the pool
   * so we can use the pool directly for swaps when it's the optimal route
   *
   * @param params.user - The user's public key
   * @param params.lbPair - The DLMM pool's public key
   * @param params.amountIn - The amount of input token
   * @param params.inputTokenMint - The input token mint
   * @param params.minDeltaId - The bin delta relative to the active bin for the lower bin position
   * @param params.maxDeltaId - The bin delta relative to the active bin for the upper bin position
   * @param params.strategy - The liquidity distribution strategy
   * @param params.favorXInActiveId - Whether to favor token X in the active bin
   * @param params.maxAccounts - The maximum number of accounts for the Jupiter swap query
   * @param params.swapSlippageBps - The swap slippage tolerance in basis points
   * @param params.maxTransferAmountExtendPercentage - The percentage to extend the max transfer amount after the swap
   * @param params.maxActiveBinSlippage - The maximum active bin slippage
   * @param params.directSwapEstimate - The result from the direct swap estimate
   * @param params.singleSided - Optional single-sided deposit mode (X or Y only) - default is non-single-sided
   * @returns The zap-in transaction parameters for a DLMM direct pool
   * @throws if input token mint does not match either tokenX or tokenY in the pool
   */
  async getZapInDlmmDirectParams(
    params: GetZapInDlmmDirectParams
  ): Promise<ZapInDlmmDirectPoolParam> {
    const {
      user,
      lbPair,
      amountIn,
      inputTokenMint,
      minDeltaId,
      maxDeltaId,
      strategy,
      favorXInActiveId,
      maxAccounts,
      swapSlippageBps,
      maxTransferAmountExtendPercentage,
      maxActiveBinSlippage,
      directSwapEstimate,
      singleSided,
    } = params;

    const dlmm = await DLMM.create(this.connection, lbPair);
    const { tokenXMint, tokenYMint, activeId } = dlmm.lbPair;

    invariant(
      inputTokenMint.equals(tokenXMint) || inputTokenMint.equals(tokenYMint),
      "Input token must be tokenX or tokenY for direct route"
    );

    const { tokenXProgram, tokenYProgram } = getTokenProgramId(dlmm.lbPair);
    const isTokenX = inputTokenMint.equals(tokenXMint);

    const preInstructions: TransactionInstruction[] = [];
    if (inputTokenMint.equals(NATIVE_MINT)) {
      const { ataPubkey: userWrapSolAcc, ix: initializeWrapSolIx } =
        await getOrCreateATAInstruction(
          this.connection,
          NATIVE_MINT,
          user,
          user,
          false,
          TOKEN_PROGRAM_ID
        );
      const wrapSOL = wrapSOLInstruction(
        user,
        userWrapSolAcc,
        BigInt(amountIn.toString())
      );
      initializeWrapSolIx && preInstructions.push(initializeWrapSolIx);
      preInstructions.push(...wrapSOL);
    }

    const swapTransactions: Transaction[] = [];
    let maxTransferAmount: BN;

    if (
      directSwapEstimate.swapType !== DlmmSwapType.NoSwap &&
      directSwapEstimate.quote
    ) {
      const swapQuote = directSwapEstimate.quote;
      if (swapQuote.route === DlmmDirectSwapQuoteRoute.Jupiter) {
        const { transaction: swapTx } = await buildJupiterSwapTransaction(
          user,
          directSwapEstimate.swapType === DlmmSwapType.XToY
            ? tokenXMint
            : tokenYMint,
          directSwapEstimate.swapType === DlmmSwapType.XToY
            ? tokenYMint
            : tokenXMint,
          directSwapEstimate.swapAmount,
          maxAccounts,
          swapSlippageBps
        );
        swapTransactions.push(swapTx);
      } else {
        const swapForY = directSwapEstimate.swapType === DlmmSwapType.XToY;
        const binArrays = await dlmm.getBinArrayForSwap(swapForY);
        const swapTx = await dlmm.swap({
          inToken: swapForY ? tokenXMint : tokenYMint,
          outToken: swapForY ? tokenYMint : tokenXMint,
          inAmount: directSwapEstimate.swapAmount,
          minOutAmount: directSwapEstimate.expectedOutput,
          lbPair: lbPair,
          user,
          binArraysPubkey: binArrays.map((item) => item.publicKey),
        });

        // Remove close account instructions if swapping involves native SOL
        // The wrapped SOL account will be needed by the zap instruction
        if (tokenXMint.equals(NATIVE_MINT) || tokenYMint.equals(NATIVE_MINT)) {
          swapTx.instructions = swapTx.instructions.filter((ix) => {
            // Filter out CloseAccount instructions (discriminator = 9 for SPL Token)
            if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
              return ix.data[0] !== 9;
            }
            return true;
          });
        }
        swapTransactions.push(swapTx);
      }
      maxTransferAmount = getExtendMaxAmountTransfer(
        directSwapEstimate.expectedOutput.toString(),
        maxTransferAmountExtendPercentage
      );
    } else {
      maxTransferAmount = new BN(0);
    }

    const amount = isTokenX
      ? directSwapEstimate.postSwapX
      : directSwapEstimate.postSwapY;

    const cleanUpInstructions: TransactionInstruction[] = [];
    if (
      inputTokenMint.equals(NATIVE_MINT) ||
      tokenXMint.equals(NATIVE_MINT) ||
      tokenYMint.equals(NATIVE_MINT)
    ) {
      const closewrapSol = unwrapSOLInstruction(user, user, false);
      closewrapSol && cleanUpInstructions.push(closewrapSol);
    }

    const binArrays = getBinArraysRequiredByPositionRange(
      lbPair,
      new BN(activeId + minDeltaId),
      new BN(activeId + maxDeltaId),
      DLMM_PROGRAM_ID
    ).map((item) => ({
      pubkey: item.key,
      isSigner: false,
      isWritable: true,
    }));

    const [binArrayBitmapExtension] = deriveBinArrayBitmapExtension(
      lbPair,
      DLMM_PROGRAM_ID
    );

    const binArrayBitmapExtensionData = await this.connection.getAccountInfo(
      binArrayBitmapExtension
    );

    return {
      user,
      lbPair,
      tokenXMint,
      tokenYMint,
      tokenXProgram,
      tokenYProgram,
      activeId,
      minDeltaId,
      maxDeltaId,
      maxActiveBinSlippage,
      favorXInActiveId,
      strategy,
      isTokenX,
      isDirectRoute: true,
      amount,
      maxTransferAmount,
      preInstructions,
      swapTransactions,
      cleanUpInstructions,
      binArrays,
      binArrayBitmapExtension: binArrayBitmapExtensionData
        ? binArrayBitmapExtension
        : null,
      singleSided,
    };
  }

  /**
   * Get the parameters for building a DLMM zap in transaction through an indirect route
   * Indirect route means the input token does not match either tokenX or tokenY in the pool
   * so we swap the input token to tokenX and tokenY through Jupiter when needed
   *
   * @param params.user - The user's public key
   * @param params.lbPair - The DLMM pool's public key
   * @param params.amountIn - The amount of input token
   * @param params.inputTokenMint - The input token mint
   * @param params.minDeltaId - The bin delta relative to the active bin for the lower bin position
   * @param params.maxDeltaId - The bin delta relative to the active bin for the upper bin position
   * @param params.strategy - The liquidity distribution strategy
   * @param params.favorXInActiveId - Whether to favor token X in the active bin
   * @param params.indirectSwapEstimate - The result from the indirect swap estimate
   * @param params.maxAccounts - The maximum number of accounts for the Jupiter swap query
   * @param params.swapSlippageBps - The swap slippage tolerance in basis points
   * @param params.maxTransferAmountExtendPercentage - The percentage to extend the max transfer amount after the swap
   * @param params.maxActiveBinSlippage - The maximum active bin slippage
   * @param params.singleSided - Optional single-sided deposit mode (X or Y only) - default is non-single-sided
   * @returns The zap-in transaction parameters for a DLMM indirect pool
   * @throws if input token mint matches either tokenX or tokenY in the pool
   */
  async getZapInDlmmIndirectParams(
    params: GetZapInDlmmIndirectParams
  ): Promise<ZapInDlmmIndirectPoolParam> {
    const {
      user,
      lbPair,
      amountIn,
      inputTokenMint,
      minDeltaId,
      maxDeltaId,
      strategy,
      favorXInActiveId,
      indirectSwapEstimate,
      maxAccounts,
      swapSlippageBps,
      maxTransferAmountExtendPercentage,
      maxActiveBinSlippage,
      singleSided,
    } = params;

    const dlmm = await DLMM.create(this.connection, lbPair);
    const { tokenXMint, tokenYMint, activeId } = dlmm.lbPair;

    invariant(
      !inputTokenMint.equals(tokenXMint) && !inputTokenMint.equals(tokenYMint),
      "Input token must not be tokenX or tokenY for indirect route"
    );

    const { tokenXProgram, tokenYProgram } = getTokenProgramId(dlmm.lbPair);

    const preInstructions: TransactionInstruction[] = [];

    if (inputTokenMint.equals(NATIVE_MINT)) {
      const { ataPubkey: userWrapSolAcc, ix: initializeWrapSolIx } =
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
        BigInt(amountIn.toString())
      );
      initializeWrapSolIx && preInstructions.push(initializeWrapSolIx);
      preInstructions.push(...wrapSOL);
    }

    const cleanUpInstructions: TransactionInstruction[] = [];
    if (
      inputTokenMint.equals(NATIVE_MINT) ||
      tokenXMint.equals(NATIVE_MINT) ||
      tokenYMint.equals(NATIVE_MINT)
    ) {
      const closewrapSol = unwrapSOLInstruction(user, user, false);
      closewrapSol && cleanUpInstructions.push(closewrapSol);
    }

    let maxTransferAmountX: BN;
    let maxTransferAmountY: BN;
    const swapTransactions: Transaction[] = [];

    const swapAmountToXInLamports = indirectSwapEstimate.swapAmountToX;
    const swapAmountToYInLamports = indirectSwapEstimate.swapAmountToY;

    if (
      !indirectSwapEstimate.swapAmountToX.isZero() &&
      indirectSwapEstimate.swapToX !== null
    ) {
      const { transaction: swapToXTransaction } =
        await buildJupiterSwapTransaction(
          user,
          inputTokenMint,
          tokenXMint,
          swapAmountToXInLamports,
          maxAccounts,
          swapSlippageBps
        );
      swapTransactions.push(swapToXTransaction);
    }

    if (
      !indirectSwapEstimate.swapAmountToY.isZero() &&
      indirectSwapEstimate.swapToY !== null
    ) {
      const { transaction: swapToYTransaction } =
        await buildJupiterSwapTransaction(
          user,
          inputTokenMint,
          tokenYMint,
          swapAmountToYInLamports,
          maxAccounts,
          swapSlippageBps
        );
      swapTransactions.push(swapToYTransaction);
    }

    maxTransferAmountX = getExtendMaxAmountTransfer(
      indirectSwapEstimate.postSwapX.toString(),
      maxTransferAmountExtendPercentage
    );
    maxTransferAmountY = getExtendMaxAmountTransfer(
      indirectSwapEstimate.postSwapY.toString(),
      maxTransferAmountExtendPercentage
    );

    const binArrays = getBinArraysRequiredByPositionRange(
      lbPair,
      new BN(activeId + minDeltaId),
      new BN(activeId + maxDeltaId),
      DLMM_PROGRAM_ID
    ).map((item) => ({
      pubkey: item.key,
      isSigner: false,
      isWritable: true,
    }));

    const [binArrayBitmapExtension] = deriveBinArrayBitmapExtension(
      lbPair,
      DLMM_PROGRAM_ID
    );

    const binArrayBitmapExtensionData = await this.connection.getAccountInfo(
      binArrayBitmapExtension
    );

    return {
      user,
      lbPair: lbPair,
      tokenXMint,
      tokenYMint,
      tokenXProgram,
      tokenYProgram,
      activeId,
      minDeltaId,
      maxDeltaId,
      maxActiveBinSlippage,
      favorXInActiveId,
      strategy,
      maxTransferAmountX,
      maxTransferAmountY,
      preInstructions,
      swapTransactions,
      cleanUpInstructions,
      binArrays,
      binArrayBitmapExtension: binArrayBitmapExtensionData
        ? binArrayBitmapExtension
        : null,
      isDirectRoute: false,
      singleSided,
    };
  }

  /**
   * Builds a DLMM zap-in transaction
   *
   * @param params.user - The user's public key
   * @param params.lbPair - The DLMM pool's public key
   * @param params.position - The position's public key
   * @param params.tokenXMint - The token X mint
   * @param params.tokenYMint - The token Y mint
   * @param params.tokenXProgram - The token X program
   * @param params.tokenYProgram - The token Y program
   * @param params.activeId - The active bin ID
   * @param params.minDeltaId - The bin delta relative to the active bin for the lower bin position
   * @param params.maxDeltaId - The bin delta relative to the active bin for the upper bin position
   * @param params.maxActiveBinSlippage - The maximum active bin slippage
   * @param params.favorXInActiveId - Whether to favor token X in the active bin
   * @param params.strategy - The liquidity distribution strategy
   * @param params.preInstructions - Instructions to run before the zap in
   * @param params.swapTransactions - Swap transactions to execute
   * @param params.cleanUpInstructions - Instructions to run after the zap in
   * @param params.binArrays - The bin arrays required for the position
   * @param params.binArrayBitmapExtension - The bin array bitmap extension account if it exists
   * @param params.isDirectRoute - Whether this is a direct route
   * @param params.singleSided - Optional single-sided deposit mode (X or Y only) - default is non-single-sided
   * @returns Response containing transaction components
   */
  async buildZapInDlmmTransaction(
    params: (ZapInDlmmIndirectPoolParam | ZapInDlmmDirectPoolParam) & {
      position: PublicKey;
    }
  ): Promise<ZapInDlmmResponse> {
    const {
      user,
      lbPair,
      position,
      tokenXMint,
      tokenYMint,
      tokenXProgram,
      tokenYProgram,
      activeId,
      minDeltaId,
      maxDeltaId,
      maxActiveBinSlippage,
      favorXInActiveId,
      strategy,
      preInstructions,
      swapTransactions,
      cleanUpInstructions,
      binArrays,
      binArrayBitmapExtension,
      isDirectRoute,
      singleSided,
    } = params;

    const [
      { ataPubkey: tokenXAccount, ix: initializeTokenXIx },
      { ataPubkey: tokenYAccount, ix: initializeTokenYIx },
    ] = await Promise.all([
      getOrCreateATAInstruction(
        this.connection,
        tokenXMint,
        user,
        user,
        false,
        tokenXProgram
      ),
      getOrCreateATAInstruction(
        this.connection,
        tokenYMint,
        user,
        user,
        false,
        tokenYProgram
      ),
    ]);

    const setupTransaction = new Transaction();
    initializeTokenXIx && setupTransaction.add(initializeTokenXIx);
    initializeTokenYIx && setupTransaction.add(initializeTokenYIx);

    if (preInstructions.length > 0) {
      setupTransaction.add(...preInstructions);
    }

    const ledgerTransaction = new Transaction();
    const resetOrInitializeLedgerTx = await this.resetOrInitializeLedgerAccount(
      user
    );
    ledgerTransaction.add(resetOrInitializeLedgerTx);

    if (isDirectRoute) {
      const { isTokenX, amount, maxTransferAmount } =
        params as ZapInDlmmDirectPoolParam;

      // For single-sided deposits, only update ledger for the deposited token
      if (singleSided !== undefined) {
        const singleSidedX = singleSided === DlmmSingleSided.X;

        if (swapTransactions.length > 0) {
          const swappedTokenAccount = singleSidedX
            ? tokenXAccount
            : tokenYAccount;
          const preSwappedTokenBalance = await getTokenAccountBalance(
            this.connection,
            swappedTokenAccount
          );
          const updateLedgerBalanceAfterSwapTx =
            await this.updateLedgerBalanceAfterSwap(
              user,
              swappedTokenAccount,
              new BN(preSwappedTokenBalance),
              maxTransferAmount,
              singleSidedX
            );

          ledgerTransaction.add(updateLedgerBalanceAfterSwapTx);
        } else {
          const setLedgerBalanceTx = await this.setLedgerBalance(
            user,
            amount,
            singleSidedX
          );

          ledgerTransaction.add(setLedgerBalanceTx);
        }
      } else {
        const setLedgerBalanceTx = await this.setLedgerBalance(
          user,
          amount,
          isTokenX
        );
        ledgerTransaction.add(setLedgerBalanceTx);

        if (swapTransactions.length > 0) {
          const swappedTokenAccount = isTokenX ? tokenYAccount : tokenXAccount;
          const preSwappedTokenBalance = await getTokenAccountBalance(
            this.connection,
            swappedTokenAccount
          );

          const updateLedgerBalanceAfterSwapTx =
            await this.updateLedgerBalanceAfterSwap(
              user,
              swappedTokenAccount,
              new BN(preSwappedTokenBalance),
              maxTransferAmount,
              !isTokenX
            );

          ledgerTransaction.add(updateLedgerBalanceAfterSwapTx);
        }
      }
    } else {
      const { maxTransferAmountX, maxTransferAmountY } =
        params as ZapInDlmmIndirectPoolParam;

      if (singleSided !== undefined) {
        const singleSidedX = singleSided === DlmmSingleSided.X;
        const swappedTokenAccount = singleSidedX
          ? tokenXAccount
          : tokenYAccount;
        const preSwappedTokenBalance = await getTokenAccountBalance(
          this.connection,
          swappedTokenAccount
        );
        const updateLedgerBalanceAfterSwapTx =
          await this.updateLedgerBalanceAfterSwap(
            user,
            swappedTokenAccount,
            new BN(preSwappedTokenBalance),
            singleSidedX ? maxTransferAmountX : maxTransferAmountY,
            singleSidedX
          );

        ledgerTransaction.add(updateLedgerBalanceAfterSwapTx);
      } else {
        const preTokenXBalance = await getTokenAccountBalance(
          this.connection,
          tokenXAccount
        );
        const preTokenYBalance = await getTokenAccountBalance(
          this.connection,
          tokenYAccount
        );
        const updateLedgerBalanceTokenXAfterSwapTx =
          await this.updateLedgerBalanceAfterSwap(
            user,
            tokenXAccount,
            new BN(preTokenXBalance),
            maxTransferAmountX,
            true
          );
        const updateLedgerBalanceTokenYAfterSwapTx =
          await this.updateLedgerBalanceAfterSwap(
            user,
            tokenYAccount,
            new BN(preTokenYBalance),
            maxTransferAmountY,
            false
          );

        ledgerTransaction.add(updateLedgerBalanceTokenXAfterSwapTx);
        ledgerTransaction.add(updateLedgerBalanceTokenYAfterSwapTx);
      }
    }

    const dlmm = await DLMM.create(this.connection, lbPair);
    const { remainingAccountsInfo: remainingAccountInfo } =
      await getDlmmRemainingAccounts(
        this.connection,
        lbPair,
        user,
        tokenXAccount,
        tokenYAccount,
        tokenXProgram,
        tokenYProgram,
        dlmm.lbPair
      );

    const zapInTransaction = await this.zapInDlmmForUninitializedPosition({
      user,
      lbPair,
      position,
      activeId,
      minDeltaId,
      maxDeltaId,
      maxActiveBinSlippage,
      favorXInActiveId,
      binArrayBitmapExtension:
        binArrayBitmapExtension ||
        deriveBinArrayBitmapExtension(lbPair, DLMM_PROGRAM_ID)[0],
      binArrays,
      strategy,
      remainingAccountInfo,
    });

    const cleanUpTransaction = new Transaction();
    const closeLedgerTransaction = await this.closeLedgerAccount(user, user);
    cleanUpTransaction.add(closeLedgerTransaction);
    if (cleanUpInstructions.length > 0) {
      cleanUpTransaction.add(...cleanUpInstructions);
    }

    return {
      setupTransaction:
        setupTransaction.instructions.length > 0 ? setupTransaction : undefined,
      swapTransactions,
      ledgerTransaction,
      zapInTransaction,
      cleanUpTransaction,
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
   * @param params.minDeltaId - The minimum delta of bins for the rebalanced position relative to the active bin
   * @param params.maxDeltaId - The maximum delta of bins for the rebalanced position relative to the active bin
   * @param params.liquiditySlippageBps - The maximum slippage in basis points for the rebalance liquidity operation (percentage * 100)
   * @param params.swapSlippageBps - The maximum slippage in basis points for the swap operation (percentage * 100)
   * @param params.strategy - The strategy to use for the rebalance
   * @param params.favorXInActiveId - Whether to favor token X in the active bin
   * @param params.directSwapEstimate - The estimate of the direct swap operation
   * @param params.maxAccounts - The maximum number of accounts to use for the swap operation
   * @returns Response containing transactions and estimation details
   */
  async rebalanceDlmmPosition(
    params: RebalanceDlmmPositionParams
  ): Promise<RebalanceDlmmPositionResponse> {
    const {
      lbPair,
      position,
      user,
      minDeltaId,
      maxDeltaId,
      liquiditySlippageBps,
      swapSlippageBps,
      strategy,
      favorXInActiveId,
      directSwapEstimate,
      maxAccounts = 50,
    } = params;

    const dlmm = await DLMM.create(this.connection, lbPair);
    const userPosition = await dlmm.getPosition(position);
    const { tokenXProgram, tokenYProgram } = getTokenProgramId(dlmm.lbPair);

    const [
      { ataPubkey: userTokenX, ix: userTokenXIx },
      { ataPubkey: userTokenY, ix: userTokenYIx },
    ] = await Promise.all([
      getOrCreateATAInstruction(
        this.connection,
        dlmm.lbPair.tokenXMint,
        user,
        user,
        true,
        tokenXProgram
      ),
      getOrCreateATAInstruction(
        this.connection,
        dlmm.lbPair.tokenYMint,
        user,
        user,
        true,
        tokenYProgram
      ),
    ]);

    const setupTransaction = new Transaction();
    userTokenXIx && setupTransaction.add(userTokenXIx);
    userTokenYIx && setupTransaction.add(userTokenYIx);

    const strategyParamBuilder = getLiquidityStrategyParameterBuilder(strategy);
    const { x0, y0, deltaX, deltaY } = buildLiquidityStrategyParameters(
      new BN(0),
      new BN(0),
      new BN(minDeltaId),
      new BN(maxDeltaId),
      new BN(dlmm.lbPair.binStep),
      favorXInActiveId,
      new BN(dlmm.lbPair.activeId),
      strategyParamBuilder
    );
    const { rebalancePosition, simulationResult } =
      await dlmm.simulateRebalancePosition(
        position,
        userPosition.positionData,
        true,
        true,
        [
          // we are not depositing any liquidity, but we're still providing this
          // so the rebalancePosition will properly initialize any uninitialized bins
          {
            x0,
            y0,
            deltaX,
            deltaY,
            minDeltaId: new BN(minDeltaId),
            maxDeltaId: new BN(maxDeltaId),
            favorXInActiveBin: favorXInActiveId,
          },
        ],
        [
          {
            minBinId: new BN(userPosition.positionData.lowerBinId),
            maxBinId: new BN(userPosition.positionData.upperBinId),
            bps: new BN(BASIS_POINT_MAX), // remove all liquidity
          },
        ]
      );

    const maxActiveBinSlippage = getAndCapMaxActiveBinSlippage(
      liquiditySlippageBps / 100,
      dlmm.lbPair.binStep,
      MAX_ACTIVE_BIN_SLIPPAGE
    );

    const {
      initBinArrayInstructions,
      rebalancePositionInstruction: _rebalancePositionInstruction,
    } = await dlmm.rebalancePosition(
      { simulationResult, rebalancePosition },
      new BN(maxActiveBinSlippage)
    );

    let rebalancePositionInstruction: TransactionInstruction[] =
      _rebalancePositionInstruction;
    if (
      dlmm.lbPair.tokenXMint.equals(NATIVE_MINT) ||
      dlmm.lbPair.tokenYMint.equals(NATIVE_MINT)
    ) {
      // rebalance liquidity tries to close the wrapped SOL account, we need to filter it out
      rebalancePositionInstruction = filterOutCloseSplTokenAccountInstructions(
        _rebalancePositionInstruction
      );
    }

    // swap tokens to balance if needed
    const tokenXAmount = new BN(userPosition.positionData.totalXAmount);
    const tokenYAmount = new BN(userPosition.positionData.totalYAmount);
    let swapTransaction: Transaction | undefined;
    if (
      directSwapEstimate.swapType !== DlmmSwapType.NoSwap &&
      directSwapEstimate.quote
    ) {
      const swapQuote = directSwapEstimate.quote;
      if (swapQuote.route === DlmmDirectSwapQuoteRoute.Jupiter) {
        const { transaction: swapTx } = await buildJupiterSwapTransaction(
          user,
          directSwapEstimate.swapType === DlmmSwapType.XToY
            ? dlmm.lbPair.tokenXMint
            : dlmm.lbPair.tokenYMint,
          directSwapEstimate.swapType === DlmmSwapType.XToY
            ? dlmm.lbPair.tokenYMint
            : dlmm.lbPair.tokenXMint,
          directSwapEstimate.swapAmount,
          maxAccounts,
          swapSlippageBps
        );
        swapTransaction = swapTx;
      } else {
        const swapForY = directSwapEstimate.swapType === DlmmSwapType.XToY;
        const binArrays = await dlmm.getBinArrayForSwap(swapForY);
        const swapTx = await dlmm.swap({
          inToken: swapForY ? dlmm.lbPair.tokenXMint : dlmm.lbPair.tokenYMint,
          outToken: swapForY ? dlmm.lbPair.tokenYMint : dlmm.lbPair.tokenXMint,
          inAmount: directSwapEstimate.swapAmount,
          minOutAmount: directSwapEstimate.expectedOutput,
          lbPair,
          user,
          binArraysPubkey: binArrays.map((item) => item.publicKey),
        });

        if (
          dlmm.lbPair.tokenXMint.equals(NATIVE_MINT) ||
          dlmm.lbPair.tokenYMint.equals(NATIVE_MINT)
        ) {
          // dlmm swap tries to close the wrapped SOL account, we need to filter it out
          swapTx.instructions = filterOutCloseSplTokenAccountInstructions(
            swapTx.instructions
          );
        }
        swapTransaction = swapTx;
      }
    }

    const preTokenXBalance = await getTokenAccountBalance(
      this.connection,
      userTokenX
    );
    const preTokenYBalance = await getTokenAccountBalance(
      this.connection,
      userTokenY
    );

    const tokenXAmountAfterSwap =
      directSwapEstimate.swapType === DlmmSwapType.XToY
        ? tokenXAmount.sub(directSwapEstimate.swapAmount)
        : directSwapEstimate.swapType === DlmmSwapType.YToX
        ? tokenXAmount.add(directSwapEstimate.expectedOutput)
        : tokenXAmount;
    const tokenYAmountAfterSwap =
      directSwapEstimate.swapType === DlmmSwapType.XToY
        ? tokenYAmount.add(directSwapEstimate.expectedOutput)
        : directSwapEstimate.swapType === DlmmSwapType.YToX
        ? tokenYAmount.sub(directSwapEstimate.swapAmount)
        : tokenYAmount;

    // initialize ledger if needed and update balances
    const ledgerAddress = deriveLedgerAccount(user);
    const ledgerAccountInfo = await this.connection.getAccountInfo(
      ledgerAddress
    );
    const ledgerTransaction = new Transaction();
    if (!ledgerAccountInfo) {
      // initialize ledger account when it already exists will cause an error
      const initLedgerTx = await this.initializeLedgerAccount(user, user);
      ledgerTransaction.add(...initLedgerTx.instructions);
    }
    // Wrap SOL if needed before updating ledger
    if (
      (dlmm.lbPair.tokenXMint.equals(NATIVE_MINT) &&
        tokenXAmountAfterSwap.gt(new BN(0))) ||
      (dlmm.lbPair.tokenYMint.equals(NATIVE_MINT) &&
        tokenYAmountAfterSwap.gt(new BN(0)))
    ) {
      const isTokenXSol = dlmm.lbPair.tokenXMint.equals(NATIVE_MINT);
      const wrapAmount = BigInt(
        isTokenXSol
          ? tokenXAmountAfterSwap.toString()
          : tokenYAmountAfterSwap.toString()
      );
      const wrapIxs = wrapSOLInstruction(
        user,
        isTokenXSol ? userTokenX : userTokenY,
        wrapAmount,
        isTokenXSol ? tokenXProgram : tokenYProgram
      );
      ledgerTransaction.add(...wrapIxs);
    }

    const updateLedgerXTx = await this.updateLedgerBalanceAfterSwap(
      user,
      userTokenX,
      new BN(preTokenXBalance),
      tokenXAmountAfterSwap,
      true
    );
    ledgerTransaction.add(...updateLedgerXTx.instructions);
    const updateLedgerYTx = await this.updateLedgerBalanceAfterSwap(
      user,
      userTokenY,
      new BN(preTokenYBalance),
      tokenYAmountAfterSwap,
      false
    );
    ledgerTransaction.add(...updateLedgerYTx.instructions);

    const binArrays = getBinArraysRequiredByPositionRange(
      lbPair,
      new BN(dlmm.lbPair.activeId + minDeltaId),
      new BN(dlmm.lbPair.activeId + maxDeltaId),
      DLMM_PROGRAM_ID
    ).map((item) => ({
      pubkey: item.key,
      isSigner: false,
      isWritable: true,
    }));

    const { remainingAccountsInfo: remainingAccountInfo } =
      await getDlmmRemainingAccounts(
        this.connection,
        lbPair,
        user,
        userTokenX,
        userTokenY,
        tokenXProgram,
        tokenYProgram,
        dlmm.lbPair
      );
    // build zap in transaction with compute budget
    const zapInTransaction = await this.zapInDlmmForInitializedPosition({
      user,
      lbPair,
      position,
      activeId: dlmm.lbPair.activeId,
      minDeltaId,
      maxDeltaId,
      maxActiveBinSlippage,
      favorXInActiveId,
      binArrays,
      strategy,
      remainingAccountInfo,
    });
    zapInTransaction.instructions.unshift(
      // based on 1 tx that consumed 462_610. Add 20% for safety and round up to nearest 100,000
      // 462_610 * 1.2 = 555_132 => 600_000
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })
    );

    const cleanUpTransaction = new Transaction();
    const closeLedgerTx = await this.closeLedgerAccount(user, user);
    cleanUpTransaction.add(closeLedgerTx);
    // unwrap any remaining WSOL back to native SOL
    if (
      dlmm.lbPair.tokenXMint.equals(NATIVE_MINT) ||
      dlmm.lbPair.tokenYMint.equals(NATIVE_MINT)
    ) {
      const unwrapIx = unwrapSOLInstruction(user, user);
      if (unwrapIx) {
        cleanUpTransaction.add(unwrapIx);
      }
    }

    return {
      setupTransaction,
      initBinArrayTransaction:
        initBinArrayInstructions.length > 0
          ? new Transaction().add(...initBinArrayInstructions)
          : undefined,
      rebalancePositionTransaction:
        rebalancePositionInstruction.length > 0
          ? new Transaction().add(...rebalancePositionInstruction)
          : undefined,
      swapTransaction,
      ledgerTransaction,
      zapInTransaction,
      cleanUpTransaction,
      estimation: {
        currentBalances: {
          tokenX: tokenXAmount,
          tokenY: tokenYAmount,
        },
        afterSwap: {
          tokenX: tokenXAmountAfterSwap,
          tokenY: tokenYAmountAfterSwap,
        },
      },
    };
  }
  //#endregion Zap In

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
