import { PublicKey } from "@solana/web3.js";
import ZapIDL from "../idl/zap.json";

export function deriveZapAuthorityAddress(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("zap_authority")],
    new PublicKey(ZapIDL.address)
  )[0];
}

export function deriveTokenLedgerAddress(mintAddress: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_ledger"), mintAddress.toBuffer()],
    new PublicKey(ZapIDL.address)
  )[0];
}
