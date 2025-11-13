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
  getJupiterPrice,
  convertLamportsToUiAmount,
  getJupiterQuote,
  getJupiterSwapInstruction,
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
import { calculateSwapAmountDirectPool } from "./helpers/zapin";

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

  async getZapInDammV2Params(
    user: PublicKey,
    amountIn: Decimal,
    pool: PublicKey
  ): Promise<{
    amount: BN;
    externalSwapAmount: BN;
    isDirectPool: boolean;
    tokenAMint: PublicKey;
    tokenBMint: PublicKey;
    tokenAVault: PublicKey;
    tokenBVault: PublicKey;
    tokenAProgram: PublicKey;
    tokenBProgram: PublicKey;
    preInstructions: TransactionInstruction[];
    maxTransferAmount: BN;
    preSqrtPrice: BN;
    swapTransaction: Transaction | null;
  }> {
    const poolState = await getDammV2Pool(this.connection, pool);
    const {
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      tokenAFlag,
      tokenBFlag,
      sqrtPrice,
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

    const currentPoolPrice = getPriceFromSqrtPrice(
      sqrtPrice,
      tokenADecimal,
      tokenADecimal
    ).toNumber();

    if (tokenAMint.equals(NATIVE_MINT) || tokenBMint.equals(NATIVE_MINT)) {
      let jupPrice;
      if (tokenAMint.equals(NATIVE_MINT)) {
        // TODO: Token B is native
        jupPrice = await getJupiterPrice(tokenAMint);
      }

      let amount;
      let swapTransaction: Transaction | null = null;
      let maxTransferAmount;

      if (!jupPrice || jupPrice > currentPoolPrice) {
        amount = new BN(amountIn.mul(LAMPORTS_PER_SOL).floor().toString());
        maxTransferAmount = U64_MAX; // TODO check this
      } else {
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
        const swapAmount = calculateSwapAmountDirectPool(
          amountIn,
          new Decimal(jupPrice),
          convertLamportsToUiAmount(
            new Decimal(poolBalanceTokenA.toString()),
            tokenADecimal
          ),
          convertLamportsToUiAmount(
            new Decimal(poolBalanceTokenB.toString()),
            tokenBDecimal
          )
        );

        const swapAmountInLamports = new BN(
          convertUiAmountToLamports(swapAmount, tokenADecimal)
            .floor()
            .toString()
        );

        // TODO: fix these params dynamic customize
        const quoteResponse = await getJupiterQuote(
          tokenAMint,
          tokenBMint,
          swapAmountInLamports,
          40,
          50,
          false,
          true,
          true,
          "https://lite-api.jup.ag"
        );

        const swapInstructionResponse = await getJupiterSwapInstruction(
          user,
          quoteResponse
        );

        const swapInstruction = new TransactionInstruction({
          keys: swapInstructionResponse.swapInstruction.accounts,
          programId: new PublicKey(
            swapInstructionResponse.swapInstruction.programId
          ),
          data: Buffer.from(
            swapInstructionResponse.swapInstruction.data,
            "base64"
          ),
        });
        swapTransaction = new Transaction().add(swapInstruction);
        maxTransferAmount = new BN(quoteResponse.outAmount).muln(6).divn(5); // larger than 20% with out amount, TODO: fix as dynamic threshold
      }

      return {
        amount: new BN(amountIn.mul(LAMPORTS_PER_SOL).floor().toString()),
        externalSwapAmount: new BN(0),
        isDirectPool: true,
        tokenAMint,
        tokenBMint,
        tokenAVault,
        tokenBVault,
        tokenAProgram: getTokenProgram(tokenAFlag),
        tokenBProgram: getTokenProgram(tokenBFlag),
        maxTransferAmount, // TODO calculate from quotes
        preSqrtPrice: poolState.sqrtPrice,
        preInstructions,
        swapTransaction,
      };
    } else {
      ///  fetch price SOL. -> token A, SOL -> token B
      ///  if p1 & p2 null -> return error
      /// p1 => swap all amount -> token A -> zap in
      /// p2 => swap all amount -> token b -> zap in
      // p1 & p2 => calculateSwapAmountForIndirectPool

      return {
        amount: new BN(amountIn.mul(LAMPORTS_PER_SOL).floor().toString()),
        externalSwapAmount: new BN(0),
        isDirectPool: false,
        tokenAMint,
        tokenBMint,
        tokenAVault,
        tokenBVault,
        tokenAProgram: getTokenProgram(tokenAFlag),
        tokenBProgram: getTokenProgram(tokenBFlag),
        preInstructions,
        maxTransferAmount: U64_MAX, // TODO calculate from quotes
        preSqrtPrice: poolState.sqrtPrice,
        swapTransaction: null,
      };
    }
  }

  async buildZapInDammV2Transaction(params: {
    user: PublicKey;
    pool: PublicKey;
    position: PublicKey;
    positionNftAccount: PublicKey;
    tokenAMint: PublicKey;
    tokenBMint: PublicKey;
    tokenAVault: PublicKey;
    tokenBVault: PublicKey;
    tokenAProgram: PublicKey;
    tokenBProgram: PublicKey;
    isDirectPool: boolean;
    maxTransferAmount: BN;
    preSqrtPrice: BN;
    maxSqrtPriceChangeBps: number;
    amount: BN;
    preInstruction: TransactionInstruction[];
    swapTransaction: Transaction | null;
  }): Promise<Transaction> {
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
      maxTransferAmount,
      preSqrtPrice,
      maxSqrtPriceChangeBps,
      preInstruction,
      swapTransaction,
    } = params;

    const preInstructions: TransactionInstruction[] = [];

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

    initializeTokenAIx && preInstructions.push(initializeTokenAIx);
    initializeTokenBIx && preInstructions.push(initializeTokenBIx);
    preInstructions.push(...preInstruction);

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
        const preTokenBalance = await getTokenAccountBalance(
          this.connection,
          isTokenA ? tokenBAccount : tokenAAccount
        );

        const updateLedgerBalanceAfterSwapTx =
          await this.updateLedgerBalanceAfterSwap(
            user,
            tokenBAccount,
            new BN(preTokenBalance),
            maxTransferAmount,
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
        tokenAAccount
      );

      const updateLedgerBalanceTokenAAfterSwapTx =
        await this.updateLedgerBalanceAfterSwap(
          user,
          tokenAAccount,
          new BN(preTokenABalance),
          maxTransferAmount,
          true // is token A
        );

      const updateLedgerBalanceTokenBAfterSwapTx =
        await this.updateLedgerBalanceAfterSwap(
          user,
          tokenBAccount,
          new BN(preTokenBBalance),
          maxTransferAmount,
          false // isn't token A
        );
      ledgerTransaction
        .add(updateLedgerBalanceTokenAAfterSwapTx)
        .add(updateLedgerBalanceTokenBAfterSwapTx);
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

    return new Transaction()
      .add(...preInstructions)
      .add(swapTransaction ?? new Transaction())
      .add(initializeLedgerTx)
      .add(ledgerTransaction)
      .add(zapInTx)
      .add(closeLedgerTx);
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
