import { LiteSVM } from "litesvm";
import { lamports } from "@solana/kit";
import { AddressLookupTableProgram, PublicKey } from "@solana/web3.js";

import { toAddress } from "./svm";

const LOOKUP_TABLE_META_SIZE = 56;
const LOOKUP_TABLE_TYPE_INDEX = 1;
const U64_MAX = BigInt("0xffffffffffffffff");

// Serializes an active lookup table without an authority, in the layout `AddressLookupTableAccount.deserialize` reads.
function serializeLookupTable(addresses: PublicKey[]): Buffer {
  const data = Buffer.alloc(LOOKUP_TABLE_META_SIZE + addresses.length * 32);
  data.writeUInt32LE(LOOKUP_TABLE_TYPE_INDEX, 0);
  data.writeBigUInt64LE(U64_MAX, 4);
  addresses.forEach((address, i) =>
    address.toBuffer().copy(data, LOOKUP_TABLE_META_SIZE + i * 32),
  );
  return data;
}

// Writes an active lookup table holding `addresses` into the SVM. Moves the clock past slot 0,
// because a table's addresses only resolve in slots after `lastExtendedSlot` (0 here).
export function setLookupTable(
  svm: LiteSVM,
  key: PublicKey,
  addresses: PublicKey[],
): void {
  const data = serializeLookupTable(addresses);
  svm.setAccount({
    address: toAddress(key),
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: toAddress(AddressLookupTableProgram.programId),
    space: BigInt(data.length),
  });
  if (svm.getClock().slot === BigInt(0)) {
    svm.warpToSlot(BigInt(1));
  }
}
