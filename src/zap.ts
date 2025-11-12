import {
  AccountMeta,
  Connection,
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
import { getTokenProgram } from "@meteora-ag/cp-amm-sdk";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { getTokenProgramId, RemainingAccountInfo } from "@meteora-ag/dlmm";

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
  }): Promise<Transaction> {
    const {
      user,
      pool,
      position,
      positionNftAccount,
      preSqrtPrice,
      maxSqrtPriceChangeBps,
    } = params;
    const dammV2PoolState = await getDammV2Pool(this.connection, pool);
    const {
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      tokenAFlag,
      tokenBFlag,
    } = dammV2PoolState;

    const tokenAProgram = getTokenProgram(tokenAFlag);
    const tokenBProgram = getTokenProgram(tokenBFlag);

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
