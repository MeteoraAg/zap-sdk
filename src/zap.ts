import {
  Cluster,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import ZapIDL from "./idl/zap/zap.json";
import { Zap as ZapTypes } from "./idl/zap/zap";
import { ZapOutParams, ZapOutThroughJupiterParams, ZapProgram } from "./types";

import { getOrCreateATAInstruction } from "./helpers";
import {
  AMOUNT_IN_JUP_V6_REVERSE_OFFSET,
  JUP_V6_PROGRAM_ID,
} from "./constants";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export class Zap {
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
    this.cluster = cluster;
    this.zapProgram = new Program(ZapIDL as ZapTypes, { connection });
    this.commitment = commitment;
  }

  /////// ZAPOUT PROGRAM ///////

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
      zapOutParams,
      userTokenInAccount,
      remainingAccounts,
      ammProgram,
      preInstructions,
    } = params;
    return this.zapProgram.methods
      .zapOut(zapOutParams)
      .accountsPartial({
        userTokenInAccount,
        ammProgram,
      })
      .remainingAccounts(remainingAccounts)
      .preInstructions(preInstructions || [])
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
   * @param params.inputTokenAccount - Token ledger account to swap from
   * @param params.jupiterSwapResponse - Jupiter swap instruction response
   * @param params.inputTokenProgram - Token program for the input token (defaults to SPL Token)
   * @returns built transaction
   */
  async zapOutThroughJupiter(
    params: ZapOutThroughJupiterParams
  ): Promise<Transaction> {
    const {
      user,
      inputMint,
      outputMint,
      jupiterSwapResponse,
      inputTokenProgram,
      outputTokenProgram,
      maxSwapAmount,
      percentageToZapOut,
    } = params;

    // user inputMint ATA
    const userInputMintAta = getAssociatedTokenAddressSync(
      inputMint,
      user,
      true,
      inputTokenProgram
    );

    const preUserTokenBalance = (
      await this.connection.getTokenAccountBalance(userInputMintAta)
    ).value.amount;

    const preInstructions: TransactionInstruction[] = [];

    const { ataPubkey: outputTokenAccountAta, ix: outputTokenAccountAtaIx } =
      await getOrCreateATAInstruction(
        this.connection,
        outputMint,
        user,
        user,
        true,
        outputTokenProgram
      );

    if (outputTokenAccountAtaIx) {
      preInstructions.push(outputTokenAccountAtaIx);
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

    return await this.zapOut({
      userTokenInAccount: userInputMintAta,
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
    });
  }
}
