import { PublicKey } from "@solana/web3.js";
import JupIDL from "./idl/jupiter/idl.json";
import CpAmmIDL from "./idl/damm-v2/idl.json";

export const JUP_V6_PROGRAM_ID = new PublicKey(JupIDL.address);
export const DAMM_V2_PROGRAM_ID = new PublicKey(CpAmmIDL.address);

// Offset for amount_in in reverse order of jupiter Route instruction data:
// amount_in(u64) + quoted_out_amount(64) + slippage_bps(u16) + platform_fee_bps(u8) = 19 bytes
export const AMOUNT_IN_JUP_V6_REVERSE_OFFSET = 19;

// Offset for amount_in for damm v2 pool:
export const AMOUNT_IN_DAMM_V2_OFFSET = 8;
export const DAMM_V2_SWAP_DISCRIMINATOR = [
  248, 198, 158, 145, 225, 117, 135, 200,
];
