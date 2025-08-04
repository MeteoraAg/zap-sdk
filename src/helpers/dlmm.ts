import { AccountMeta, Connection, PublicKey } from "@solana/web3.js";
import {
  AccountsType,
  BIN_ARRAY_INDEX_BOUND,
  DLMM_PROGRAM_ID,
  MEMO_PROGRAM_ID,
} from "../constants";
import BN from "bn.js";
import DLMM, {
  BinArrayBitmapExtension,
  binIdToBinArrayIndex,
  isOverflowDefaultBinArrayBitmap,
  BIN_ARRAY_BITMAP_SIZE,
  LbPair,
  RemainingAccountInfo,
  createProgram,
  deriveBinArrayBitmapExtension,
  deriveOracle,
  deriveEventAuthority,
  deriveBinArray,
} from "@meteora-ag/dlmm";
import { getExtraAccountMetasForTransferHook } from "./token2022";

export async function getLbPairState(
  connection: Connection,
  lbPair: PublicKey
): Promise<LbPair> {
  const dlmmClient = await DLMM.create(connection, lbPair, {
    cluster: "mainnet-beta",
    programId: new PublicKey(DLMM_PROGRAM_ID),
  });
  return dlmmClient.lbPair;
}

export async function getBinArrayBitmapExtension(
  connection: Connection,
  binArray: PublicKey
): Promise<BinArrayBitmapExtension | null> {
  const program = createProgram(connection);
  const account = await connection.getAccountInfo(binArray);
  if (!account) {
    return null;
  }
  return program.coder.accounts.decode(
    "binArrayBitmapExtension",
    Buffer.from(account.data)
  );
}

export function getBitFromBinArrayIndexInBitmapExtension(
  binArrayIndex: BN,
  state: BinArrayBitmapExtension
) {
  // In extension, the range start with -513 and 512
  // Brain burst, let's just shift back to the actual index and calculate from there ...
  const idx = binArrayIndex.isNeg()
    ? binArrayIndex.add(new BN(1)).abs().sub(BIN_ARRAY_BITMAP_SIZE)
    : binArrayIndex.sub(BIN_ARRAY_BITMAP_SIZE);

  const bitmapOffset = idx.div(BIN_ARRAY_BITMAP_SIZE);

  const bitmap = binArrayIndex.isNeg()
    ? state.negativeBinArrayBitmap[bitmapOffset.toNumber()]
    : state.positiveBinArrayBitmap[bitmapOffset.toNumber()];

  const { div: offsetToU64InBitmap, mod: offsetToBit } = idx.divmod(new BN(64));

  // Each U512 have 8 u64
  const { mod: offsetToU64InChunkBitmap } = offsetToU64InBitmap.divmod(
    new BN(8)
  );

  if (!bitmap) {
    console.log(binArrayIndex.toString());
    console.log(bitmapOffset.toString());
  }

  const chunkedBitmap = bitmap[offsetToU64InChunkBitmap.toNumber()];
  return chunkedBitmap.testn(offsetToBit.toNumber());
}

export function getNextBinArrayIndexWithLiquidity(
  binArrayIndex: BN,
  pairState: LbPair,
  swapForY: boolean,
  state: BinArrayBitmapExtension | null
): BN | null {
  const [minBinArrayIndex, maxBinArrayIndex] = BIN_ARRAY_INDEX_BOUND;
  const step = swapForY ? new BN(-1) : new BN(1);
  // Start search from the next bin array index
  while (true) {
    if (isOverflowDefaultBinArrayBitmap(binArrayIndex)) {
      // Search in extension
      if (state) {
        const isBitSet = getBitFromBinArrayIndexInBitmapExtension(
          binArrayIndex,
          state
        );
        if (isBitSet) {
          return binArrayIndex;
        }
      } else {
        break;
      }
    } else {
      // Because bitmap in pair state is continuous, -512 will be index 0. The add will shift to the actual index.
      const actualIdx = binArrayIndex.add(BIN_ARRAY_BITMAP_SIZE);
      // FullBitmap = U1024
      let { div: offsetInFullBitmap, mod: index } = actualIdx.divmod(
        new BN(64)
      );
      if (
        pairState.binArrayBitmap[offsetInFullBitmap.toNumber()].testn(
          index.toNumber()
        )
      ) {
        return binArrayIndex;
      }
    }
    binArrayIndex = binArrayIndex.add(step);
    if (
      binArrayIndex.gt(maxBinArrayIndex) ||
      binArrayIndex.lt(minBinArrayIndex)
    ) {
      break;
    }
  }
  return null;
}

export async function getDlmmRemainingAccounts(
  connection: Connection,
  lbPair: PublicKey,
  user: PublicKey,
  userInputTokenAccount: PublicKey,
  userTokenOutAccount: PublicKey,
  tokenXProgram: PublicKey,
  tokenYProgram: PublicKey,
  lbPairState: LbPair
): Promise<{
  remainingAccounts: AccountMeta[];
  remainingAccountsInfo: RemainingAccountInfo;
}> {
  let [binArrayBitmapExtension] = deriveBinArrayBitmapExtension(
    lbPair,
    DLMM_PROGRAM_ID
  );
  const binArrayBitmapExtensionState = await connection.getAccountInfo(
    binArrayBitmapExtension
  );
  if (!binArrayBitmapExtensionState) {
    binArrayBitmapExtension = new PublicKey(DLMM_PROGRAM_ID);
  }

  const transferHookXAccounts = await getExtraAccountMetasForTransferHook(
    connection,
    lbPairState.tokenXMint
  );
  const transferHookYAccounts = await getExtraAccountMetasForTransferHook(
    connection,
    lbPairState.tokenYMint
  );
  let remainingAccountsInfo: RemainingAccountInfo = { slices: [] };

  if (transferHookXAccounts.length > 0) {
    remainingAccountsInfo.slices.push({
      accountsType: AccountsType.TransferHookX,
      length: transferHookXAccounts.length,
    });
  }

  if (transferHookYAccounts.length > 0) {
    remainingAccountsInfo.slices.push({
      accountsType: AccountsType.TransferHookY,
      length: transferHookYAccounts.length,
    });
  }

  const [oracle] = deriveOracle(lbPair, DLMM_PROGRAM_ID);
  const [eventAuthority] = deriveEventAuthority(DLMM_PROGRAM_ID);

  const remainingAccounts: AccountMeta[] = [
    {
      isSigner: false,
      isWritable: true,
      pubkey: lbPair,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: binArrayBitmapExtension,
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
      pubkey: userInputTokenAccount,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: userTokenOutAccount,
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
      pubkey: new PublicKey(DLMM_PROGRAM_ID), // host fee option
    },
    {
      isSigner: true,
      isWritable: false,
      pubkey: user,
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
      pubkey: eventAuthority,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: DLMM_PROGRAM_ID,
    },
  ];

  const dlmmClient = await DLMM.create(connection, lbPair, {
    cluster: "mainnet-beta",
    programId: new PublicKey(DLMM_PROGRAM_ID),
  });
  const binArrays = await dlmmClient.getBinArrayForSwap(true, 5);

  const binArraysAccountMeta: AccountMeta[] = binArrays.map((binArray) => {
    return {
      isSigner: false,
      isWritable: true,
      pubkey: binArray.publicKey,
    };
  });

  remainingAccounts.push(
    ...[...transferHookXAccounts, ...transferHookYAccounts]
  );
  remainingAccounts.push(...binArraysAccountMeta);

  return {
    remainingAccounts,
    remainingAccountsInfo,
  };
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

  throw new Error(`Unknown account type: ${JSON.stringify(accountType)}`);
}
