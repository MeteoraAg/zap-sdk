import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
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

  const ix = createAssociatedTokenAccountIdempotentInstruction(
    payer,
    toAccount,
    owner,
    tokenMint,
    tokenProgram
  );
  return { ataPubkey: toAccount, ix };
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
 * Get token account balance
 * @param connection - Solana connection
 * @param tokenAccount - The token account address
 * @returns The token account balance as a string
 */
export async function getTokenAccountBalance(
  connection: Connection,
  tokenAccount: PublicKey
): Promise<string> {
  let balance: string;
  try {
    balance = (await connection.getTokenAccountBalance(tokenAccount)).value
      .amount;
  } catch {
    balance = "0";
  }

  return balance;
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

// SPL Token program CloseAccount instruction discriminator. Variant 9 in TokenInstruction enum
// https://github.com/solana-labs/solana-program-library/blob/d72289c79/token/js/src/instructions/types.ts#L12
const CLOSE_ACCOUNT_DISCRIMINATOR = 9;

/**
 * Filters out SPL Token CloseAccount instructions from a list of instructions.
 * helpful when building transactions that need to keep temporary token accounts open
 * @param instructions - Array of transaction instructions to filter
 * @returns Filtered array with CloseAccount instructions removed
 */
export function filterOutCloseSplTokenAccountInstructions(
  instructions: TransactionInstruction[]
): TransactionInstruction[] {
  return instructions.filter((ix) => {
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      return ix.data[0] !== CLOSE_ACCOUNT_DISCRIMINATOR;
    }
    return true;
  });
}
