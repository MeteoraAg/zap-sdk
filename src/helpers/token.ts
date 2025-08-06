import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Get or create a token account
 * @param connection - Solana connection
 * @param tokenMint - The mint of the token
 * @param owner - The owner of the token
 * @param payer - The payer of the token
 * @param allowOwnerOffCurve - Whether to allow the owner to be off curve
 * @param tokenProgram - The token program to use (defaults to TOKEN_PROGRAM_ID)
 * @returns The token account and the instruction to create it if it doesn't exist
 */
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
 * Unwrap SOL instruction
 * @param owner - The owner of the SOL
 * @param receiver - The receiver of the SOL
 * @param allowOwnerOffCurve - Whether to allow the owner to be off curve
 * @returns The unwrap SOL instruction
 */
export function unwrapSOLInstruction(
  owner: PublicKey,
  receiver: PublicKey,
  allowOwnerOffCurve = true
): TransactionInstruction | null {
  const wSolATAAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    owner,
    allowOwnerOffCurve
  );
  if (wSolATAAccount) {
    const closedWrappedSolInstruction = createCloseAccountInstruction(
      wSolATAAccount,
      receiver,
      owner,
      [],
      TOKEN_PROGRAM_ID
    );
    return closedWrappedSolInstruction;
  }
  return null;
}

/**
 * Get token account balance with fallback for newly created accounts
 * @param connection - Solana connection
 * @param tokenAccount - The token account address
 * @param accountCreationIx - The instruction that creates the account (if any)
 * @returns The token account balance as a string, or "0" if the account is being created
 */
export async function getTokenAccountBalance(
  connection: Connection,
  tokenAccount: PublicKey,
  accountCreationIx?: TransactionInstruction
): Promise<string> {
  return accountCreationIx
    ? "0"
    : (await connection.getTokenAccountBalance(tokenAccount)).value.amount;
}

/**
 * Wrap SOL instruction
 * @param from - The from address
 * @param to - The to address
 * @param amount - The amount to wrap
 * @param tokenProgram - The token program to use (defaults to TOKEN_PROGRAM_ID)
 * @returns The wrap SOL instruction
 */
export function wrapSOLInstruction(
  from: PublicKey,
  to: PublicKey,
  amount: bigint,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID
): TransactionInstruction[] {
  return [
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: to,
      lamports: amount,
    }),
    new TransactionInstruction({
      keys: [
        {
          pubkey: to,
          isSigner: false,
          isWritable: true,
        },
      ],
      data: Buffer.from(new Uint8Array([17])),
      programId: tokenProgram,
    }),
  ];
}
