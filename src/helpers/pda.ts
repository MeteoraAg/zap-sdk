import { PublicKey } from "@solana/web3.js";
import { DAMM_V2_PROGRAM_ID, JUP_V6_PROGRAM_ID } from "../constants";

export function deriveDlmmEventAuthority(programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId
  )[0];
}

export function deriveDammV2EventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DAMM_V2_PROGRAM_ID
  )[0];
}

export function deriveDammV2PoolAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    DAMM_V2_PROGRAM_ID
  )[0];
}

export function deriveJupV6EventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    JUP_V6_PROGRAM_ID
  )[0];
}
