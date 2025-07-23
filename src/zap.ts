import {
  AccountMeta,
  Cluster,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import { deriveTokenLedgerAddress, deriveZapAuthorityAddress } from "./pda";
import { BN, Program } from "@coral-xyz/anchor";
import ZapIDL from "./idl/zap.json";
import { Zap as ZapTypes } from "./idl/zap";
import {
  ActionType,
  RemoveDammV2LiquidityWithZapOutParams,
  RemoveDlmmLiquidityWithZapOutParams,
  ZapOutParams,
  ZapOutSwapDammV2Params,
  ZapOutSwapDlmmParams,
} from "./types";
import {
  CP_AMM_PROGRAM_ID,
  CpAmm,
  getTokenProgram,
  unwrapSOLInstruction,
} from "@meteora-ag/cp-amm-sdk";
import {
  deriveDammV2PoolAuthority,
  getSwapDammV2Accounts,
} from "./helpers/dammV2";
import DLMM, { RemainingAccountInfo } from "@meteora-ag/dlmm";
import {
  convertAccountTypeToNumber,
  getSwapDlmmAccounts,
} from "./helpers/dlmm";

export type ZapProgram = Program<ZapTypes>;

export class Zap {
  private zapAuthority: PublicKey;
  private connection: Connection;
  private zapProgram: ZapProgram;
  private cluster: Cluster;
  private commitment: Commitment;
  constructor(
    connection: Connection,
    cluster: Cluster = "mainnet-beta",
    commitment: Commitment = "confirmed"
  ) {
    this.connection = connection;
    this.zapAuthority = deriveZapAuthorityAddress();
    this.cluster = cluster;
    this.zapProgram = new Program(ZapIDL as ZapTypes, { connection });
    this.commitment = commitment;
  }

  /////// ZAPOUT PROGRAM ///////
  /**
   * Initializes a token ledger account for a specific token mint.
   * Token ledgers are used to temporarily hold tokens during zap operations.
   *
   * @param payer - Public key of the account that will pay for the transaction
   * @param tokenMint - Public key of the token mint to create a ledger for
   * @param tokenProgram - Token program ID (SPL Token or Token-2022)
   * @returns built transaction
   */
  async initializeTokenLedger(
    payer: PublicKey,
    tokenMint: PublicKey,
    tokenProgram: PublicKey
  ): Promise<Transaction> {
    return this.zapProgram.methods
      .initializeTokenLedger()
      .accountsPartial({
        zapAuthority: this.zapAuthority,
        tokenLedgerAccount: deriveTokenLedgerAddress(tokenMint),
        tokenMint,
        payer,
        tokenProgram,
      })
      .transaction();
  }

  /**
   * Executes a generic zap out operation with custom parameters.
   *
   * @param ZapOutParams - Zap out operation parameters
   * @param params.tokenLedgerAccount - Token ledger account to zap out from
   * @param params.actionType - Type of action to perform (SwapDammV2, SwapDlmm)
   * @param params.payloadData - Serialized payload data for the specific action
   * @param params.remainingAccounts - Additional accounts needed for the operation
   * @param params.ammProgram - AMM program ID to interact with
   * @returns builder transaction
   */
  async zapOut(params: ZapOutParams): Promise<Transaction> {
    const {
      tokenLedgerAccount,
      actionType,
      payloadData,
      remainingAccounts,
      ammProgram,
    } = params;
    return this.zapProgram.methods
      .zapOut(actionType, payloadData)
      .accountsPartial({
        zapAuthority: this.zapAuthority,
        tokenLedgerAccount,
        ammProgram,
      })
      .remainingAccounts(remainingAccounts)
      .transaction();
  }

  ////// DAMM V2 METHODS /////////
  /**
   * Performs a token swap using DAMM V2 protocol as part of a zap out operation.
   * Swaps tokens from the input token ledger to the user's output token account.
   *
   * @param params - DAMM V2 swap parameters
   * @param params.user - Public key of the user performing the swap
   * @param params.poolAddress - Public key of the DAMM V2 pool
   * @param params.poolState - Pool state data containing token mints and vaults
   * @param params.inputTokenMint - Token mint being swapped from
   * @param params.outputTokenMint - Token mint being swapped to
   * @param params.outputTokenProgram - Token program for the output token
   * @param params.minimumSwapAmountOut - Minimum amount to receive (slippage protection)
   * @returns built transaction
   */
  async zapOutSwapDammV2(params: ZapOutSwapDammV2Params): Promise<Transaction> {
    const {
      poolAddress,
      poolState,
      inputTokenAccount,
      outputTokenAccount,
      minimumSwapAmountOut,
    } = params;

    const swapDammV2Accounts = getSwapDammV2Accounts(
      poolAddress,
      poolState,
      inputTokenAccount,
      outputTokenAccount
    );
    const payloadData = minimumSwapAmountOut.toArrayLike(Buffer, "le", 8);
    return await this.zapOut({
      tokenLedgerAccount: inputTokenAccount,
      actionType: ActionType.SwapDammV2,
      payloadData,
      remainingAccounts: swapDammV2Accounts,
      ammProgram: CP_AMM_PROGRAM_ID,
    });
  }

  /**
   * Removes liquidity from a DAMM V2 position and automatically swaps one of the
   * received tokens to the desired output token in a single transaction.
   *
   * @param params - Remove liquidity with zap out parameters
   * @param params.user - Public key of the position owner
   * @param params.poolState - Pool state data containing token information
   * @param params.position - Position data to remove liquidity from
   * @param params.poolAddress - Public key of the pool
   * @param params.positionNftAccount - NFT account representing the position
   * @param params.liquidityDelta - Amount of liquidity to remove
   * @param params.outputTokenMint - Desired output token mint
   * @param params.tokenAAmountThreshold - Minimum amount of token A to receive
   * @param params.tokenBAmountThreshold - Minimum amount of token B to receive
   * @param params.minimumSwapAmountOut - Minimum amount from the swap (slippage protection)
   * @param params.vestings - Vesting schedules if applicable
   * @returns Promise resolving to a Transaction that removes liquidity and swaps tokens
   */
  async removeDammV2LiquidityWithZapOut(
    params: RemoveDammV2LiquidityWithZapOutParams
  ): Promise<Transaction> {
    const {
      user,
      poolState,
      position,
      poolAddress,
      positionNftAccount,
      liquidityDelta,
      outputTokenMint,
      tokenAAmountThreshold,
      tokenBAmountThreshold,
      minimumSwapAmountOut,
      vestings,
    } = params;
    const dammV2 = new CpAmm(this.connection);
    const program = dammV2._program;

    const [inputTokenMint, outputTokenProgram, inputTokenProgram] =
      poolState.tokenAMint.equals(outputTokenMint)
        ? [
            poolState.tokenBMint,
            getTokenProgram(poolState.tokenAFlag),
            getTokenProgram(poolState.tokenBFlag),
          ]
        : [
            poolState.tokenAMint,
            getTokenProgram(poolState.tokenBFlag),
            getTokenProgram(poolState.tokenAFlag),
          ];
    const tokenLedgerAccount = deriveTokenLedgerAddress(inputTokenMint);
    const outputTokenAccount = getAssociatedTokenAddressSync(
      outputTokenMint,
      user,
      true,
      outputTokenProgram
    );

    const [tokenAAccount, tokenBAccount] = poolState.tokenAMint.equals(
      outputTokenMint
    )
      ? [outputTokenAccount, tokenLedgerAccount]
      : [tokenLedgerAccount, outputTokenAccount];

    const preInstructions: TransactionInstruction[] = [];
    const tokenLedgerAccountData = await this.connection.getAccountInfo(
      tokenLedgerAccount
    );
    if (!tokenLedgerAccountData) {
      const initializeTokenledgerTx = await this.initializeTokenLedger(
        user,
        inputTokenMint,
        inputTokenProgram
      );
      preInstructions.push(...initializeTokenledgerTx.instructions);
    }

    const outputTokenAccountData = await this.connection.getAccountInfo(
      outputTokenAccount
    );
    if (!outputTokenAccountData) {
      const ix = createAssociatedTokenAccountIdempotentInstruction(
        user,
        outputTokenAccount,
        user,
        outputTokenMint,
        outputTokenProgram
      );

      preInstructions.push(ix);
    }

    if (vestings.length > 0) {
      const refreshVestingTx = await dammV2.refreshVesting({
        owner: user,
        position,
        positionNftAccount,
        pool: poolAddress,
        vestingAccounts: vestings.map((item) => item.account),
      });

      preInstructions.push(...refreshVestingTx.instructions);
    }

    const removeLiquidityTx = await program.methods
      .removeLiquidity({
        liquidityDelta,
        tokenAAmountThreshold,
        tokenBAmountThreshold,
      })
      .accountsPartial({
        poolAuthority: deriveDammV2PoolAuthority(),
        pool: poolAddress,
        position,
        positionNftAccount,
        owner: user,
        tokenAAccount,
        tokenBAccount,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAProgram: getTokenProgram(poolState.tokenAFlag),
        tokenBProgram: getTokenProgram(poolState.tokenBFlag),
      })
      .preInstructions(preInstructions)
      .transaction();

    const zapOutSwapDammV2Tx = await this.zapOutSwapDammV2({
      poolAddress,
      poolState,
      inputTokenAccount: tokenLedgerAccount,
      outputTokenAccount,
      minimumSwapAmountOut,
    });

    const unwarpSOLInstruction = [];
    if (outputTokenMint.equals(NATIVE_MINT)) {
      const unwarpSOLIx = await unwrapSOLInstruction(user, user, true);
      unwarpSOLInstruction.push(unwarpSOLIx);
    }

    return new Transaction()
      .add(removeLiquidityTx)
      .add(zapOutSwapDammV2Tx)
      .add(...unwarpSOLInstruction);
  }

  ///////////// DLMM METHODS /////////////
  /**
   * Performs a token swap using DLMM as part of a zap out operation
   *
   * @param params - DLMM swap parameters
   * @param params.user - Public key of the user performing the swap
   * @param params.poolAddress - Public key of the DLMM pair
   * @param params.inputTokenMint - Token mint being swapped from
   * @param params.minimumSwapAmountOut - Minimum amount to receive (slippage protection)
   * @param params.dlmm - DLMM instance containing pair and bin data
   * @param params.outputTokenMint - Token mint being swapped to
   * @param params.outputTokenProgram - Token program for the output token
   * @returns Promise resolving to a Transaction that performs the DLMM swap
   */
  async zapOutSwapDlmm(params: ZapOutSwapDlmmParams): Promise<Transaction> {
    const {
      user,
      poolAddress,
      inputTokenMint,
      minimumSwapAmountOut,
      dlmm,
      outputTokenMint,
      outputTokenProgram,
    } = params;

    const swapForY = inputTokenMint.equals(dlmm.lbPair.tokenXMint);
    const inputTokenAccount = deriveTokenLedgerAddress(inputTokenMint);
    const outputTokenAccount = getAssociatedTokenAddressSync(
      outputTokenMint,
      user,
      true,
      outputTokenProgram
    );

    const swapDlmmAccounts = getSwapDlmmAccounts(
      poolAddress,
      dlmm.lbPair,
      dlmm.binArrayBitmapExtension,
      inputTokenAccount,
      outputTokenAccount,
      dlmm.lbPair.oracle,
      dlmm.program.programId,
      dlmm.tokenX.owner,
      dlmm.tokenY.owner
    );

    let remainingAccountsInfo: RemainingAccountInfo = { slices: [] };
    if (dlmm.tokenX.transferHookAccountMetas.length > 0) {
      remainingAccountsInfo.slices.push({
        accountsType: {
          transferHookX: {},
        },
        length: dlmm.tokenX.transferHookAccountMetas.length,
      });
    }

    if (dlmm.tokenY.transferHookAccountMetas.length > 0) {
      remainingAccountsInfo.slices.push({
        accountsType: {
          transferHookY: {},
        },
        length: dlmm.tokenY.transferHookAccountMetas.length,
      });
    }

    const transferHookAccounts = dlmm.tokenX.transferHookAccountMetas.concat(
      dlmm.tokenY.transferHookAccountMetas
    );
    const bidBinArrays = await dlmm.getBinArrayForSwap(swapForY, 3);
    const binArraysPubkey = bidBinArrays.map((b) => b.publicKey);
    const binArraysAccountMeta: AccountMeta[] = binArraysPubkey.map(
      (pubkey) => {
        return {
          isSigner: false,
          isWritable: true,
          pubkey,
        };
      }
    );

    const minimumAmountOutData = minimumSwapAmountOut.toArrayLike(
      Buffer,
      "le",
      8
    );

    const sliceCount = Buffer.alloc(4);
    sliceCount.writeUInt32LE(remainingAccountsInfo.slices.length, 0);

    // Serialize each slice (accounts_type: u8, length: u8)
    const slicesData = Buffer.concat(
      remainingAccountsInfo.slices.map((slice) => {
        const sliceBuffer = Buffer.alloc(2);
        sliceBuffer.writeUInt8(
          convertAccountTypeToNumber(slice.accountsType),
          0
        );
        sliceBuffer.writeUInt8(slice.length, 1);
        return sliceBuffer;
      })
    );

    const payloadData = Buffer.concat([
      minimumAmountOutData,
      sliceCount,
      slicesData,
    ]);

    const remainingAccounts = [
      ...swapDlmmAccounts,
      ...transferHookAccounts,
      ...binArraysAccountMeta,
    ];

    return await this.zapOut({
      tokenLedgerAccount: inputTokenAccount,
      actionType: ActionType.SwapDlmm,
      payloadData,
      remainingAccounts,
      ammProgram: dlmm.program.programId,
    });
  }

  /**
   * Removes liquidity from a DLMM position and automatically swaps one of the
   * received tokens to the desired output token in a single transaction.
   *
   * @param params - Remove DLMM liquidity with zap out parameters
   * @param params.user - Public key of the position owner
   * @param params.poolAddress - Public key of the DLMM pair
   * @param params.position - Position data containing liquidity information
   * @param params.fromBinId - Starting bin ID for liquidity removal
   * @param params.toBinId - Ending bin ID for liquidity removal
   * @param params.outputTokenMint - Desired output token mint
   * @param params.minimumSwapAmountOut - Minimum amount from the swap
   * @param params.bps - Basis points of liquidity to remove (10000 = 100%)
   * @returns transaction
   */
  async removeDlmmLiquidityWithZapOut(
    params: RemoveDlmmLiquidityWithZapOutParams
  ): Promise<Transaction> {
    const {
      user,
      poolAddress,
      position,
      fromBinId,
      toBinId,
      outputTokenMint,
      minimumSwapAmountOut,
      bps,
    } = params;
    const dlmm = await DLMM.create(this.connection, poolAddress, {
      cluster: this.cluster,
    });

    const removeLiquidityTx = await dlmm.removeLiquidity({
      user,
      position,
      fromBinId,
      toBinId,
      bps,
    });

    const [inputTokenMint, outputTokenProgram] = dlmm.lbPair.tokenXMint.equals(
      outputTokenMint
    )
      ? [dlmm.lbPair.tokenYMint, dlmm.tokenX.owner]
      : [dlmm.lbPair.tokenXMint, dlmm.tokenY.owner];

    const zapOutSwapDlmmTx = await this.zapOutSwapDlmm({
      user,
      poolAddress,
      inputTokenMint,
      minimumSwapAmountOut,
      dlmm,
      outputTokenMint,
      outputTokenProgram,
    });

    const transaction = new Transaction();
    if (removeLiquidityTx instanceof Array) {
      transaction.add(...removeLiquidityTx);
    } else {
      transaction.add(removeLiquidityTx);
    }

    transaction.add(zapOutSwapDlmmTx);

    return transaction;
  }
}
