import DLMM, {
  BinArrayBitmapExtensionAccount,
  LbPair,
  MEMO_PROGRAM_ID,
} from "@meteora-ag/dlmm";
import { PublicKey } from "@solana/web3.js";
import { deriveDlmmEventAuthority, deriveZapAuthorityAddress } from "./pda";

export function getSwapDlmmAccounts(
  poolAddress: PublicKey,
  lbPairState: LbPair,
  binArrayBitmapExtension: BinArrayBitmapExtensionAccount | null,
  inputTokenAccount: PublicKey,
  outputTokenAccount: PublicKey,
  oracle: PublicKey,
  dlmmProgramId: PublicKey,
  tokenXProgram: PublicKey,
  tokenYProgram: PublicKey
): Array<{
  isSigner: boolean;
  isWritable: boolean;
  pubkey: PublicKey;
}> {
  const swapAccounts = [
    {
      isSigner: false,
      isWritable: true,
      pubkey: poolAddress,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: binArrayBitmapExtension
        ? binArrayBitmapExtension.publicKey
        : dlmmProgramId,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: lbPairState.reserveX,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: lbPairState.reserveY,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: inputTokenAccount,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: outputTokenAccount,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: lbPairState.tokenXMint,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: lbPairState.tokenYMint,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: oracle,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: dlmmProgramId, // host fee option
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: deriveZapAuthorityAddress(),
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: tokenXProgram,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: tokenYProgram,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: MEMO_PROGRAM_ID,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: deriveDlmmEventAuthority(dlmmProgramId),
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: dlmmProgramId,
    },
  ];

  return swapAccounts;
}
