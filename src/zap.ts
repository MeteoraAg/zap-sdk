import {
  AccountMeta,
  Cluster,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import ZapIDL from "./idl/zap.json";
import { Zap as ZapTypes } from "./idl/zap";
import {
  ActionType,
  ZapOutParams,
  ZapOutThroughDammV2Params,
  ZapOutThroughDlmmParams,
  ZapOutThroughJupiterParams,
  ZapProgram,
} from "./types";
import { CP_AMM_PROGRAM_ID } from "@meteora-ag/cp-amm-sdk";
import { RemainingAccountInfo } from "@meteora-ag/dlmm";
import {
  getSwapDlmmAccounts,
  getSwapDammV2Accounts,
  deriveTokenLedgerAddress,
  deriveZapAuthorityAddress,
  convertAccountTypeToNumber,
} from "./helpers";
import { JUP_V6_PROGRAM_ID } from "./constants";

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
  private async zapOut(params: ZapOutParams): Promise<Transaction> {
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
  async zapOutThroughDammV2(
    params: ZapOutThroughDammV2Params
  ): Promise<Transaction> {
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

  ///////////// DLMM METHODS /////////////
  /**
   * Performs a token swap using DLMM protocol as part of a zap out operation.
   * Swaps tokens from the input token ledger to the user's output token account.
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
  async zapOutThroughDlmm(
    params: ZapOutThroughDlmmParams
  ): Promise<Transaction> {
    const {
      poolAddress,
      inputTokenMint,
      minimumSwapAmountOut,
      dlmm,
      inputTokenAccount,
      outputTokenAccount,
    } = params;

    const swapForY = inputTokenMint.equals(dlmm.lbPair.tokenXMint);

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

  ///////////// JUPV6 METHODS /////////////

  /**
   * Performs a token swap using Jupiter V6 protocol as part of a zap out operation.
   *
   * This method works directly with Jupiter's swap-instructions API response,
   * processing the accounts and instruction data with minimal modifications.
   *
   * @param params - Jupiter V6 swap parameters from Jupiter API
   */
  async zapOutThroughJupiter(
    params: ZapOutThroughJupiterParams
  ): Promise<Transaction> {
    const { inputTokenMint, jupiterSwapResponse, jupiterQuoteResponse } =
      params;

    const tokenLedgerAccount = deriveTokenLedgerAddress(inputTokenMint);

    const tokenLedgerAccountInfo = await this.connection.getAccountInfo(
      tokenLedgerAccount
    );
    if (!tokenLedgerAccountInfo) {
      throw new Error("Token ledger account not found");
    }

    const tokenAccountData = Buffer.from(tokenLedgerAccountInfo.data);
    const amount = tokenAccountData.readBigUInt64LE(64);

    const remainingAccounts = jupiterSwapResponse.swapInstruction.accounts.map(
      (account, index) => {
        const pubkey =
          typeof account.pubkey === "string"
            ? new PublicKey(account.pubkey)
            : account.pubkey;

        // Replace input token account with token ledger account
        if (pubkey.equals(params.inputTokenAccount)) {
          return {
            pubkey: tokenLedgerAccount,
            isSigner: false,
            isWritable: account.isWritable || false,
          };
        }

        // Ensure no account is marked as signer - the zap contract will handle all signing
        return {
          pubkey,
          isSigner: false,
          isWritable: account.isWritable || false,
        };
      }
    );

    console.log(remainingAccounts);

    const instructionBytes = Buffer.from(
      jupiterSwapResponse.swapInstruction.data,
      "base64"
    );

    console.log("Payload data as bytes array:", Array.from(instructionBytes));

    // Remove the discriminator from the payload
    const payloadData = instructionBytes.slice(8);
    console.log("Payload data as bytes array:", Array.from(payloadData));

    return await this.zapOut({
      tokenLedgerAccount,
      actionType: ActionType.SwapJupiterV6,
      payloadData,
      remainingAccounts,
      ammProgram: JUP_V6_PROGRAM_ID,
    });
  }
}
