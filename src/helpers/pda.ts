import { PublicKey } from "@solana/web3.js";
import {
  DAMM_V2_PROGRAM_ID,
  DLMM_PROGRAM_ID,
  ZAP_PROGRAM_ID,
} from "../constants";

export function deriveDammV2EventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DAMM_V2_PROGRAM_ID
  )[0];
}

export function deriveDammV2PoolAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    DAMM_V2_PROGRAM_ID
  )[0];
}

export function deriveLedgerAccount(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_ledger"), owner.toBuffer()],
    ZAP_PROGRAM_ID
  )[0];
}

export function deriveDlmmEventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DLMM_PROGRAM_ID
  )[0];
}
