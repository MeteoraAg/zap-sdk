import { PublicKey } from "@solana/web3.js";
import { DAMM_V2_PROGRAM_ID } from "../constants";

export function deriveDammV2EventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DAMM_V2_PROGRAM_ID
  )[0];
}
