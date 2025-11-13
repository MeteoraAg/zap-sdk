import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";

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

export function convertLamportsToUiAmount(
  amount: Decimal,
  decimals: number
): Decimal {
  return amount.div(Decimal.pow(10, decimals));
}

export function convertUiAmountToLamports(
  amount: Decimal,
  decimals: number
): Decimal {
  return amount.mul(Decimal.pow(10, decimals));
}
