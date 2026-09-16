import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { JupiterApiVersion, JupiterInstructionLayout } from "./types";
import {
  BIN_ARRAY_BITMAP_SIZE,
  EXTENSION_BINARRAY_BITMAP_SIZE,
} from "@meteora-ag/dlmm";
import ZapIDL from "./idl/zap/idl.json";

export const ZAP_PROGRAM_ID = new PublicKey(ZapIDL.address);
export const JUP_V6_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);
export const DAMM_V2_PROGRAM_ID = new PublicKey(
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
);
export const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

export const BIN_ARRAY_INDEX_BOUND = [
  BIN_ARRAY_BITMAP_SIZE.mul(
    EXTENSION_BINARRAY_BITMAP_SIZE.add(new BN(1)),
  ).neg(),
  BIN_ARRAY_BITMAP_SIZE.mul(EXTENSION_BINARRAY_BITMAP_SIZE.add(new BN(1))).sub(
    new BN(1),
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

/**
 * @deprecated Use `getJupiterInstructionLayout` from helpers; the offset depends on the instruction variant.
 * Offset for amount_in in reverse order of jupiter Route instruction data:
 * amount_in(u64) + quoted_out_amount(64) + slippage_bps(u16) + platform_fee_bps(u8) = 19 bytes
 */
export const AMOUNT_IN_JUP_V6_REVERSE_OFFSET = 19;

// Anchor discriminators of the Jupiter v6 swap instructions (see tests/fixtures/jupiter.json)
export const JUP_V6_ROUTE_DISCRIMINATOR = [
  229, 23, 203, 151, 122, 227, 173, 42,
];
export const JUP_V6_SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR = [
  193, 32, 155, 51, 65, 214, 156, 129,
];
export const JUP_V6_ROUTE_V2_DISCRIMINATOR = [
  187, 100, 250, 204, 49, 196, 175, 20,
];
export const JUP_V6_SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR = [
  209, 152, 83, 147, 124, 254, 216, 233,
];

// Where amount_in sits in the instruction data and which account is the user transfer authority,
// keyed by the hex of the 8-byte discriminator.
// v1 (route, shared_accounts_route): route_plan vec comes first, so amount_in is found from the end:
//   amount_in(u64) + quoted_out_amount(u64) + slippage_bps(u16) + platform_fee_bps(u8) = 19 bytes.
// v2 (route_v2, shared_accounts_route_v2): amount_in comes right after the discriminator (and the u8 id for shared).
export const JUPITER_INSTRUCTION_LAYOUTS: Record<
  string,
  JupiterInstructionLayout
> = {
  // route
  [Buffer.from(JUP_V6_ROUTE_DISCRIMINATOR).toString("hex")]: {
    amountInOffset: (dataLength) =>
      dataLength - AMOUNT_IN_JUP_V6_REVERSE_OFFSET,
    userTransferAuthorityIndex: 1,
  },
  // shared_accounts_route
  [Buffer.from(JUP_V6_SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR).toString("hex")]: {
    amountInOffset: (dataLength) =>
      dataLength - AMOUNT_IN_JUP_V6_REVERSE_OFFSET,
    userTransferAuthorityIndex: 2,
  },
  // route_v2
  [Buffer.from(JUP_V6_ROUTE_V2_DISCRIMINATOR).toString("hex")]: {
    amountInOffset: () => 8,
    userTransferAuthorityIndex: 0,
  },
  // shared_accounts_route_v2
  [Buffer.from(JUP_V6_SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR).toString("hex")]:
    {
      amountInOffset: () => 9,
      userTransferAuthorityIndex: 1,
    },
};

// Offset for amount_in for damm v2 pool:
export const AMOUNT_IN_DAMM_V2_OFFSET = 8;
export const DAMM_V2_SWAP_DISCRIMINATOR = [
  248, 198, 158, 145, 225, 117, 135, 200,
];

export const DEFAULT_JUPITER_API_URL = "https://api.jup.ag";
export const DEFAULT_JUPITER_API_VERSION = JupiterApiVersion.V2;
