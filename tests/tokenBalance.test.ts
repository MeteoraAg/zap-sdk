import { strict as assert } from "assert";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AccountInfo, Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getTokenAccountBalance } from "../src/helpers/token";

describe("getTokenAccountBalance", () => {
  const tokenAccount = Keypair.generate().publicKey;
  const amount = BigInt("18446744073709551615");

  const accountInfo = (owner: PublicKey): AccountInfo<Buffer> => {
    const data = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
      {
        mint: Keypair.generate().publicKey,
        owner: Keypair.generate().publicKey,
        amount,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: BigInt(0),
        delegatedAmount: BigInt(0),
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data,
    );
    return { data, owner, lamports: 2_039_280, executable: false };
  };

  const connection = (info: AccountInfo<Buffer> | null): Connection =>
    ({
      getAccountInfo: async () => info,
      getTokenAccountBalance: async () => {
        if (!info) throw new Error("Account not found");
        return { value: { amount: amount.toString() } };
      },
    }) as unknown as Connection;

  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    it(`preserves the exact u64 amount for ${program.toBase58()}`, async () => {
      assert.equal(
        await getTokenAccountBalance(
          connection(accountInfo(program)),
          tokenAccount,
        ),
        amount.toString(),
      );
    });
  }

  it("returns zero only for a confirmed absent account", async () => {
    assert.equal(
      await getTokenAccountBalance(connection(null), tokenAccount),
      "0",
    );
  });

  it("propagates an RPC failure instead of inventing a zero balance", async () => {
    const error = new Error("503 Service Unavailable");
    const rpc = {
      getAccountInfo: async () => {
        throw error;
      },
      getTokenAccountBalance: async () => {
        throw error;
      },
    } as unknown as Connection;
    await assert.rejects(
      getTokenAccountBalance(rpc, tokenAccount),
      (actual) => actual === error,
    );
  });

  it("rejects an account owned by a different program", async () => {
    await assert.rejects(
      getTokenAccountBalance(
        connection(accountInfo(PublicKey.default)),
        tokenAccount,
      ),
    );
  });

  it("rejects malformed token account data", async () => {
    const malformed = accountInfo(TOKEN_PROGRAM_ID);
    malformed.data = Buffer.alloc(1);
    await assert.rejects(
      getTokenAccountBalance(connection(malformed), tokenAccount),
    );
  });
});
