import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import CpAmmIDL from "../idl/damm-v2/idl.json";
import { CpAmm } from "../idl/damm-v2/idl";
import LbClmmIDL from "../idl/dlmm/idl.json";
import { LbClmm } from "../idl/dlmm/idl";

export function createDammV2Program(connection: Connection) {
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, {});

  return new Program<CpAmm>(CpAmmIDL as CpAmm, provider);
}

export function createDlmmProgram(connection: Connection) {
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, {});

  return new Program<LbClmm>(LbClmmIDL as LbClmm, provider);
}
