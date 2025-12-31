import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  BIN_ARRAY_BITMAP_SIZE,
  EXTENSION_BINARRAY_BITMAP_SIZE,
} from "@meteora-ag/dlmm";
import ZapIDL from "./idl/zap/idl.json";

export const ZAP_PROGRAM_ID = new PublicKey(ZapIDL.address);
export const JUP_V6_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);
export const DAMM_V2_PROGRAM_ID = new PublicKey(
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
);
export const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

export const BIN_ARRAY_INDEX_BOUND = [
  BIN_ARRAY_BITMAP_SIZE.mul(
    EXTENSION_BINARRAY_BITMAP_SIZE.add(new BN(1))
  ).neg(),
  BIN_ARRAY_BITMAP_SIZE.mul(EXTENSION_BINARRAY_BITMAP_SIZE.add(new BN(1))).sub(
    new BN(1)
  ),
];

export const AccountsType = {
  TransferHookX: {
    transferHookX: {},
  },
  TransferHookY: {
    transferHookY: {},
  },
  TransferHookReward: {
    transferHookReward: {},
  },
};

export const DLMM_SWAP_DISCRIMINATOR = [65, 75, 63, 76, 235, 91, 91, 136];
export const AMOUNT_IN_DLMM_OFFSET = 8;

// Offset for amount_in in reverse order of jupiter Route instruction data:
// amount_in(u64) + quoted_out_amount(64) + slippage_bps(u16) + platform_fee_bps(u8) = 19 bytes
export const AMOUNT_IN_JUP_V6_REVERSE_OFFSET = 19;

// Offset for amount_in for damm v2 pool:
export const AMOUNT_IN_DAMM_V2_OFFSET = 8;
export const DAMM_V2_SWAP_DISCRIMINATOR = [
  248, 198, 158, 145, 225, 117, 135, 200,
];

export const DEFAULT_JUPITER_API_URL = "https://api.jup.ag";
