import { PublicKey } from "@solana/web3.js";
import JupIDL from "./idl/jupiter/jup_v6.json";

export const JUP_V6_PROGRAM_ID = new PublicKey(JupIDL.address);

// Offset for amount_in in reverse order of jupiter Route instruction data:
// amount_in(u64) + quoted_out_amount(64) + slippage_bps(u16) + platform_fee_bps(u8) = 19 bytes
export const AMOUNT_IN_JUP_V6_REVERSE_OFFSET = 19;
