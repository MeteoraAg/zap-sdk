import {
  createTransferCheckedWithTransferHookInstruction,
  getTransferHook,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

export async function getExtraAccountMetasForTransferHook(
  connection: Connection,
  mint: PublicKey
) {
  const info = await connection.getAccountInfo(mint);

  if (!info) {
    return [];
  }

  if (info.owner.equals(TOKEN_PROGRAM_ID)) {
    return [];
  }

  const accountInfoWithBuffer = {
    ...info,
    data: Buffer.from(info.data),
  };
  const mintInfo = unpackMint(
    mint,
    accountInfoWithBuffer,
    TOKEN_2022_PROGRAM_ID
  );

  const transferHook = getTransferHook(mintInfo);
  if (!transferHook) {
    return [];
  } else {
    const transferWithHookIx = createTransferCheckedWithTransferHookInstruction(
      connection,
      PublicKey.default,
      mint,
      PublicKey.default,
      PublicKey.default,
      BigInt(0),
      mintInfo.decimals,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    // Only 4 keys needed if it's single signer. https://github.com/solana-labs/solana-program-library/blob/d72289c79a04411c69a8bf1054f7156b6196f9b3/token/js/src/extensions/transferFee/instructions.ts#L251
    return (await transferWithHookIx).keys.slice(4);
  }
}
