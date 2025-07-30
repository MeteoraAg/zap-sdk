import { PublicKey } from "@solana/web3.js";
import JupIDL from "./idl/jup_v6.json";

export const JUP_V6_PROGRAM_ID = new PublicKey(JupIDL.address);
