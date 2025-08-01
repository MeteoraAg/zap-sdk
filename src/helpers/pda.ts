import { PublicKey } from "@solana/web3.js";
import ZapIDL from "../idl/zap.json";
import { CP_AMM_PROGRAM_ID } from "@meteora-ag/cp-amm-sdk";
import { JUP_V6_PROGRAM_ID } from "../constants";



export function deriveDlmmEventAuthority(programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId
  )[0];
}

export function deriveDammV2EventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    CP_AMM_PROGRAM_ID
  )[0];
}

export function deriveDammV2PoolAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    CP_AMM_PROGRAM_ID
  )[0];
}

export function deriveJupV6EventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    JUP_V6_PROGRAM_ID
  )[0];
}
