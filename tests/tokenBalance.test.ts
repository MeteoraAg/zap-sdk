import BN from "bn.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInvalidAccountError,
  TokenInvalidAccountSizeError,
} from "@solana/spl-token";
import {
  AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { expect } from "chai";

import { getTokenAccountBalance } from "../src/helpers/token";
import { Zap } from "../src/zap";

const RENT = 2_039_280;
// Token-2022 `AccountType`, the byte after the base token account or the padded mint
const MINT_TYPE = 1;
const ACCOUNT_TYPE = 2;
const RAW_AMOUNT = BigInt("10000000000000000001");

function tokenAccount(mint: PublicKey, owner: PublicKey, programId: PublicKey) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: RAW_AMOUNT,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: BigInt(0),
      delegatedAmount: BigInt(0),
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return account(programId, data);
}

function account(
  owner: PublicKey,
  data: Buffer,
  lamports = RENT,
): AccountInfo<Buffer> {
  return {
    owner,
    data,
    lamports,
    executable: false,
    rentEpoch: 0,
  };
}

function connectionFor(
  accounts: Map<string, AccountInfo<Buffer> | "throw">,
  rent = RENT,
): Connection {
  return {
    getAccountInfo: async (pubkey: PublicKey) => {
      const accountInfo = accounts.get(pubkey.toBase58());
      if (accountInfo === "throw") {
        throw new Error("503");
      }
      return accountInfo ?? null;
    },
    getMinimumBalanceForRentExemption: async () => rent,
  } as unknown as Connection;
}

async function thrown(run: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

describe("token account balance", () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;

  it("returns zero when the account is missing", async () => {
    const ata = getAssociatedTokenAddressSync(
      mint,
      owner,
      true,
      TOKEN_PROGRAM_ID,
    );
    const balance = await getTokenAccountBalance(
      connectionFor(new Map()),
      ata,
      { mint, owner, tokenProgram: TOKEN_PROGRAM_ID },
    );
    expect(balance).to.equal("0");
  });

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const name = programId.equals(TOKEN_PROGRAM_ID)
      ? "spl token"
      : "token-2022";
    it(`returns the raw ${name} amount`, async () => {
      const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);
      const balance = await getTokenAccountBalance(
        connectionFor(
          new Map([[ata.toBase58(), tokenAccount(mint, owner, programId)]]),
        ),
        ata,
      );
      expect(balance).to.equal(RAW_AMOUNT.toString());
    });
  }

  it("returns the raw amount of a token-2022 account with extensions", async () => {
    const ata = getAssociatedTokenAddressSync(
      mint,
      owner,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const { data } = tokenAccount(mint, owner, TOKEN_2022_PROGRAM_ID);
    const balance = await getTokenAccountBalance(
      connectionFor(
        new Map([
          [
            ata.toBase58(),
            account(
              TOKEN_2022_PROGRAM_ID,
              Buffer.concat([data, Buffer.from([ACCOUNT_TYPE, 0, 0, 0, 0])]),
            ),
          ],
        ]),
      ),
      ata,
    );
    expect(balance).to.equal(RAW_AMOUNT.toString());
  });

  // A token-2022 mint with extensions is padded to the token account size, so only its account
  // type tells it from a token account.
  for (const { name, programId, data, errorType } of [
    {
      name: "an spl token mint",
      programId: TOKEN_PROGRAM_ID,
      data: Buffer.alloc(MINT_SIZE),
      errorType: TokenInvalidAccountSizeError,
    },
    {
      name: "a token-2022 mint with extensions",
      programId: TOKEN_2022_PROGRAM_ID,
      data: Buffer.concat([
        Buffer.alloc(ACCOUNT_SIZE),
        Buffer.from([MINT_TYPE, 0, 0, 0, 0]),
      ]),
      errorType: TokenInvalidAccountError,
    },
  ]) {
    it(`throws when the account is ${name}`, async () => {
      const address = Keypair.generate().publicKey;
      const error = await thrown(() =>
        getTokenAccountBalance(
          connectionFor(
            new Map([[address.toBase58(), account(programId, data)]]),
          ),
          address,
        ),
      );
      expect(error).to.be.instanceOf(errorType);
    });
  }

  it("returns zero for an uninitialized associated token account", async () => {
    const ata = getAssociatedTokenAddressSync(
      mint,
      owner,
      true,
      TOKEN_PROGRAM_ID,
    );
    const balance = await getTokenAccountBalance(
      connectionFor(
        new Map([
          [
            ata.toBase58(),
            account(SystemProgram.programId, Buffer.alloc(0), RENT + 50),
          ],
        ]),
      ),
      ata,
      { mint, owner, tokenProgram: TOKEN_PROGRAM_ID },
    );
    expect(balance).to.equal("0");
  });

  describe("uninitialized wrapped SOL account", () => {
    const ata = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      owner,
      true,
      TOKEN_PROGRAM_ID,
    );
    const balanceWith = (lamports: number, rent = RENT) =>
      getTokenAccountBalance(
        connectionFor(
          new Map([
            [
              ata.toBase58(),
              account(SystemProgram.programId, Buffer.alloc(0), lamports),
            ],
          ]),
          rent,
        ),
        ata,
        { mint: NATIVE_MINT, owner, tokenProgram: TOKEN_PROGRAM_ID },
      );

    it("keeps the lamports above rent", async () => {
      expect(await balanceWith(RENT + 12345)).to.equal("12345");
    });

    for (const lamports of [RENT, RENT - 1]) {
      it(`returns zero with ${lamports === RENT ? "exactly" : "less than"} rent`, async () => {
        expect(await balanceWith(lamports)).to.equal("0");
      });
    }

    // web3.js returns 0 for the rent lookup when the RPC answers with an error.
    it("throws when the rent lookup fails", async () => {
      const error = await thrown(() => balanceWith(RENT + 12345, 0));
      expect(error?.message).to.equal(
        "Could not read the rent-exempt minimum of a token account",
      );
    });
  });

  it("throws for an uninitialized account without the associated token account details", async () => {
    const ata = getAssociatedTokenAddressSync(
      mint,
      owner,
      true,
      TOKEN_PROGRAM_ID,
    );
    const error = await thrown(() =>
      getTokenAccountBalance(
        connectionFor(
          new Map([
            [ata.toBase58(), account(SystemProgram.programId, Buffer.alloc(0))],
          ]),
        ),
        ata,
      ),
    );
    expect(error?.message).to.equal(
      `Could not read token account ${ata.toBase58()}`,
    );
  });

  it("throws when the account is not the associated token account", async () => {
    const other = Keypair.generate().publicKey;
    const error = await thrown(() =>
      getTokenAccountBalance(
        connectionFor(
          new Map([
            [
              other.toBase58(),
              account(SystemProgram.programId, Buffer.alloc(0)),
            ],
          ]),
        ),
        other,
        { mint, owner, tokenProgram: TOKEN_PROGRAM_ID },
      ),
    );
    expect(error?.message).to.equal(
      `Could not read token account ${other.toBase58()}`,
    );
  });

  it("throws when the account lookup fails", async () => {
    const ata = getAssociatedTokenAddressSync(
      mint,
      owner,
      true,
      TOKEN_PROGRAM_ID,
    );
    const error = await thrown(() =>
      getTokenAccountBalance(
        connectionFor(new Map([[ata.toBase58(), "throw"]])),
        ata,
        { mint, owner, tokenProgram: TOKEN_PROGRAM_ID },
      ),
    );
    expect(error?.message).to.equal("503");
  });

  it("zapOutThroughJupiter throws when the balance lookup fails", async () => {
    const zap = new Zap({
      getAccountInfo: async () => {
        throw new Error("503");
      },
    } as unknown as Connection);
    const error = await thrown(() =>
      zap.zapOutThroughJupiter({
        user: owner,
        inputMint: mint,
        outputMint: NATIVE_MINT,
        inputTokenProgram: TOKEN_PROGRAM_ID,
        outputTokenProgram: TOKEN_PROGRAM_ID,
        jupiterSwapResponse: {
          swapInstruction: {
            programId: TOKEN_PROGRAM_ID.toBase58(),
            accounts: [],
            data: "",
          },
        },
        maxSwapAmount: new BN(1),
        percentageToZapOut: 100,
      }),
    );
    expect(error?.message).to.equal("503");
  });
});
