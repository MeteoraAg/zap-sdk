import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

export function convertAccountTypeToNumber(accountType: object): number {
  if (JSON.stringify(accountType) === JSON.stringify({ transferHookX: {} })) {
    return 0;
  }

  if (JSON.stringify(accountType) === JSON.stringify({ transferHookY: {} })) {
    return 1;
  }

  if (
    JSON.stringify(accountType) === JSON.stringify({ transferHookReward: {} })
  ) {
    return 2;
  }

  throw new Error(`Unknown account type: ${JSON.stringify(accountType)}`);
}

export async function getTokenProgramFromMint(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  if (mint.equals(NATIVE_MINT)) {
    return TOKEN_PROGRAM_ID;
  }

  try {
    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) {
      throw new Error(`Mint account not found: ${mint.toString()}`);
    }

    if (
      mintInfo.owner.equals(
        new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
      )
    ) {
      return new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    } else {
      return TOKEN_PROGRAM_ID;
    }
  } catch (error) {
    console.warn(
      `Failed to determine token program for ${mint.toString()}, defaulting to TOKEN_PROGRAM_ID:`,
      error
    );
    return TOKEN_PROGRAM_ID;
  }
}
