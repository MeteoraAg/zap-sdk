import {
  ACCOUNT_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  ExtensionType,
  getAccountLen,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  NATIVE_MINT_2022,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
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
  tokenProgram: PublicKey,
): Promise<{ ataPubkey: PublicKey; ix?: TransactionInstruction }> => {
  const toAccount = getAssociatedTokenAddressSync(
    tokenMint,
    owner,
    allowOwnerOffCurve,
    tokenProgram,
  );

  const ix = createAssociatedTokenAccountIdempotentInstruction(
    payer,
    toAccount,
    owner,
    tokenMint,
    tokenProgram,
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
  allowOwnerOffCurve = true,
): TransactionInstruction | null {
  const wSolATAAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    owner,
    allowOwnerOffCurve,
  );
  if (wSolATAAccount) {
    const closedWrappedSolInstruction = createCloseAccountInstruction(
      wSolATAAccount,
      receiver,
      owner,
      [],
      TOKEN_PROGRAM_ID,
    );
    return closedWrappedSolInstruction;
  }
  return null;
}

/**
 * Get token account balance
 * @param connection - Solana connection
 * @param tokenAccount - The token account address
 * @param creation - ATA identity when idempotent creation precedes token use
 * @returns The balance as a string, including tokens created by pending native ATA initialization
 * @throws If the RPC request fails or the account is not a valid SPL token account
 */
export async function getTokenAccountBalance(
  connection: Connection,
  tokenAccount: PublicKey,
  creation?: { mint: PublicKey; owner: PublicKey; tokenProgram: PublicKey },
): Promise<string> {
  const accountInfo = await connection.getAccountInfo(tokenAccount);
  if (accountInfo === null) return "0";

  if (
    creation &&
    !accountInfo.executable &&
    accountInfo.owner.equals(SystemProgram.programId) &&
    accountInfo.data.length === 0 &&
    (creation.tokenProgram.equals(TOKEN_PROGRAM_ID) ||
      creation.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) &&
    tokenAccount.equals(
      getAssociatedTokenAddressSync(
        creation.mint,
        creation.owner,
        true,
        creation.tokenProgram,
      ),
    )
  ) {
    const token2022 = creation.tokenProgram.equals(TOKEN_2022_PROGRAM_ID);
    const nativeMint = token2022 ? NATIVE_MINT_2022 : NATIVE_MINT;
    if (!creation.mint.equals(nativeMint)) return "0";

    // Native ATA initialization turns lamports above its rent reserve into tokens.
    // Preserve that pre-funded balance instead of counting it as newly received.
    const accountSize = token2022
      ? getAccountLen([ExtensionType.ImmutableOwner])
      : ACCOUNT_SIZE;
    const rent =
      await connection.getMinimumBalanceForRentExemption(accountSize);
    if (
      !Number.isSafeInteger(accountInfo.lamports) ||
      !Number.isSafeInteger(rent) ||
      accountInfo.lamports < 0 ||
      rent < 0
    ) {
      throw new Error(
        "Cannot determine the pre-funded native ATA balance exactly",
      );
    }
    return BigInt(Math.max(0, accountInfo.lamports - rent)).toString();
  }

  const tokenProgram = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  return unpackAccount(
    tokenAccount,
    accountInfo,
    tokenProgram,
  ).amount.toString();
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
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
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
  instructions: TransactionInstruction[],
): TransactionInstruction[] {
  return instructions.filter((ix) => {
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      return ix.data[0] !== CLOSE_ACCOUNT_DISCRIMINATOR;
    }
    return true;
  });
}
