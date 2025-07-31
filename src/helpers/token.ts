import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from "@solana/spl-token";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";

export const getOrCreateATAInstruction = async (
  connection: Connection,
  tokenMint: PublicKey,
  owner: PublicKey,
  payer: PublicKey,
  allowOwnerOffCurve = true,
  tokenProgram: PublicKey
): Promise<{ ataPubkey: PublicKey; ix?: TransactionInstruction }> => {
  const toAccount = getAssociatedTokenAddressSync(
    tokenMint,
    owner,
    allowOwnerOffCurve,
    tokenProgram
  );

  try {
    await getAccount(connection, toAccount);
    return { ataPubkey: toAccount, ix: undefined };
  } catch (e) {
    if (
      e instanceof TokenAccountNotFoundError ||
      e instanceof TokenInvalidAccountOwnerError
    ) {
      const ix = createAssociatedTokenAccountIdempotentInstruction(
        payer,
        toAccount,
        owner,
        tokenMint,
        tokenProgram
      );

      return { ataPubkey: toAccount, ix };
    } else {
      /* handle error */
      console.error("Error::getOrCreateATAInstruction", e);
      throw e;
    }
  }
};

/**
 * Check if a token ledger account exists
 * @param connection - Solana connection
 * @param tokenLedgerAccount - The token ledger account address
 * @returns true if account exists, false otherwise
 */
export const checkTokenLedgerExists = async (
  connection: Connection,
  tokenLedgerAccount: PublicKey
): Promise<boolean> => {
  try {
    const accountInfo = await connection.getAccountInfo(tokenLedgerAccount);
    return accountInfo !== null;
  } catch (e) {
    console.error("Error checking token ledger existence:", e);
    return false;
  }
};
