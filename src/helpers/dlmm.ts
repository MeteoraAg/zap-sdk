import DLMM, {
  BinArrayBitmapExtensionAccount,
  deriveOracle,
  LBCLMM_PROGRAM_IDS,
  LbPair,
  MEMO_PROGRAM_ID,
  RemainingAccountInfo,
} from "@meteora-ag/dlmm";
import { AccountMeta, PublicKey } from "@solana/web3.js";
import { deriveZapAuthorityAddress } from "../pda";

export function deriveDlmmEventAuthority(programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId
  )[0];
}

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
}

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
