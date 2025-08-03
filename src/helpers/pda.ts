import { PublicKey } from "@solana/web3.js";
import {
  DAMM_V2_PROGRAM_ID,
  JUP_V6_PROGRAM_ID,
  DLMM_PROGRAM_ID,
} from "../constants";
import BN from "bn.js";

export function deriveDlmmEventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DLMM_PROGRAM_ID
  )[0];
}

export function deriveBinArrayBitmapExtension(lbPair: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bitmap"), lbPair.toBytes()],
    DLMM_PROGRAM_ID
  )[0];
}

export function deriveOracle(lbPair: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle"), lbPair.toBytes()],
    DLMM_PROGRAM_ID
  )[0];
}

export function deriveBinArray(lbPair: PublicKey, index: BN) {
  let binArrayBytes: Uint8Array;
  if (index.isNeg()) {
    binArrayBytes = new Uint8Array(index.toTwos(64).toBuffer("le", 8));
  } else {
    binArrayBytes = new Uint8Array(index.toBuffer("le", 8));
  }

  return PublicKey.findProgramAddressSync(
    [Buffer.from("bin_array"), lbPair.toBytes(), binArrayBytes],
    DLMM_PROGRAM_ID
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
