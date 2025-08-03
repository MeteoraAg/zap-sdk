import { PublicKey } from "@solana/web3.js";
import JupIDL from "./idl/jupiter/idl.json";
import CpAmmIDL from "./idl/damm-v2/idl.json";
import LbClmmIDL from "./idl/dlmm/idl.json";
import BN from "bn.js";

export const JUP_V6_PROGRAM_ID = new PublicKey(JupIDL.address);
export const DAMM_V2_PROGRAM_ID = new PublicKey(CpAmmIDL.address);
export const DLMM_PROGRAM_ID = new PublicKey(LbClmmIDL.address);

export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

export const CONSTANTS = LbClmmIDL.constants;
export const BIN_ARRAY_BITMAP_SIZE = new BN(
  CONSTANTS.find((constant) => constant.name === "BIN_ARRAY_BITMAP_SIZE")
    ?.value || "0"
);

export const MAX_BIN_PER_ARRAY = new BN(
  CONSTANTS.find((constant) => constant.name === "MAX_BIN_PER_ARRAY")?.value ||
    "0"
);

export const DEFAULT_BITMAP_RANGE = [
  BIN_ARRAY_BITMAP_SIZE.neg(),
  BIN_ARRAY_BITMAP_SIZE.sub(new BN(1)),
];

export const EXTENSION_BINARRAY_BITMAP_SIZE = new BN(
  CONSTANTS.find(
    (constant) => constant.name === "EXTENSION_BINARRAY_BITMAP_SIZE"
  )?.value || "0"
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
