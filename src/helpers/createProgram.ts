import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import CpAmmIDL from "../idl/damm-v2/idl.json";
import { CpAmm as CpAmmTypes } from "../idl/damm-v2/idl";
import LbClmmIDL from "../idl/dlmm/idl.json";
import { LbClmm as LbClmmTypes } from "../idl/dlmm/idl";

export function createDammV2Program(connection: Connection) {
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, {});

  return new Program<CpAmmTypes>(CpAmmIDL as CpAmmTypes, provider);
}

export function createDlmmProgram(connection: Connection) {
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, {});

  return new Program<LbClmmTypes>(LbClmmIDL as LbClmmTypes, provider);
}
