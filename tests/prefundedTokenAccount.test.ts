import { strict as assert } from "assert";
import { createServer } from "http";
import BN from "bn.js";
import {
  AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  MintLayout,
  MINT_SIZE,
  NATIVE_MINT,
  NATIVE_MINT_2022,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { getTokenAccountBalance } from "../src/helpers/token";
import { Zap } from "../src/zap";
import { createDammV2Pool } from "./helpers/damm_v2";
import { createToken, mintToken, getTokenBalance } from "./helpers/token";
import {
  createLiteSvmConnection,
  generateKpAndFund,
  signAndSendTransaction,
  startSvm,
} from "./helpers/svm";

describe("pre-funded associated token account snapshots", () => {
  const identity = {
    mint: Keypair.generate().publicKey,
    owner: Keypair.generate().publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  const ata = getAssociatedTokenAddressSync(
    identity.mint,
    identity.owner,
    true,
    identity.tokenProgram,
  );
  const empty: AccountInfo<Buffer> = {
    owner: SystemProgram.programId,
    data: Buffer.alloc(0),
    executable: false,
    lamports: 890880,
  };
  const connection = (info: AccountInfo<Buffer>): Connection =>
    ({ getAccountInfo: async () => info }) as unknown as Connection;

  it("recognizes only a derived, unallocated ATA with explicit creation context", async () => {
    assert.equal(
      await getTokenAccountBalance(connection(empty), ata, identity),
      "0",
    );
    await assert.rejects(getTokenAccountBalance(connection(empty), ata));
    await assert.rejects(
      getTokenAccountBalance(connection(empty), identity.owner, identity),
    );
    for (const invalid of [
      { ...empty, executable: true },
      { ...empty, data: Buffer.alloc(1) },
      { ...empty, owner: Keypair.generate().publicKey },
    ]) {
      await assert.rejects(
        getTokenAccountBalance(connection(invalid), ata, identity),
      );
    }
  });

  it("creates a pre-funded ATA and executes the DAMM swap in one transaction", async () => {
    const svm = startSvm();
    const admin = generateKpAndFund(svm);
    const user = generateKpAndFund(svm);
    const inputMint = createToken(svm, admin, admin.publicKey, null);
    const outputMint = createToken(svm, admin, admin.publicKey, null);
    for (const mint of [inputMint, outputMint])
      mintToken(svm, admin, mint, admin, admin.publicKey);
    const poolAddress = await createDammV2Pool({
      svm,
      creator: admin,
      tokenAMint: inputMint,
      tokenBMint: outputMint,
    });
    const input = getAssociatedTokenAddressSync(inputMint, user.publicKey);
    const output = getAssociatedTokenAddressSync(outputMint, user.publicKey);
    signAndSendTransaction(
      svm,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: input,
          lamports: Number(svm.getRent().minimumBalance(BigInt(0))),
        }),
      ),
      [admin],
    );
    const connection = createLiteSvmConnection(svm);
    const zap = new Zap(connection);
    const transaction = await zap.zapOutThroughDammV2({
      user: user.publicKey,
      poolAddress,
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ID,
      outputTokenProgram: TOKEN_PROGRAM_ID,
      amountIn: new BN(1000000),
      minimumSwapAmountOut: new BN(1),
      maxSwapAmount: new BN(2000000),
      percentageToZapOut: 100,
    });
    const swapIndex = transaction.instructions.findIndex((ix) =>
      ix.programId.equals(zap.zapProgram.programId),
    );
    assert(swapIndex > 0);
    signAndSendTransaction(
      svm,
      new Transaction()
        .add(...transaction.instructions.slice(0, swapIndex))
        .add(
          createTransferInstruction(
            getAssociatedTokenAddressSync(inputMint, admin.publicKey),
            input,
            admin.publicKey,
            BigInt(1000000),
          ),
        )
        .add(...transaction.instructions.slice(swapIndex)),
      [admin, user],
    );
    assert(getTokenBalance(svm, input).isZero());
    assert(getTokenBalance(svm, output).gtn(0));
  });

  it("rejects unavailable rent and imprecise native lamports", async () => {
    const native = { ...identity, mint: NATIVE_MINT };
    const tokenAccount = getAssociatedTokenAddressSync(
      native.mint,
      native.owner,
    );
    const rpc = connection({ ...empty, lamports: 5000000 });
    const error = new Error("rent RPC unavailable");
    rpc.getMinimumBalanceForRentExemption = async () => {
      throw error;
    };
    await assert.rejects(
      getTokenAccountBalance(rpc, tokenAccount, native),
      (actual) => actual === error,
    );
    rpc.getMinimumBalanceForRentExemption = async () => 2039280;
    rpc.getAccountInfo = async () => ({
      ...empty,
      lamports: Number.MAX_SAFE_INTEGER + 1,
    });
    await assert.rejects(
      getTokenAccountBalance(rpc, tokenAccount, native),
      /exactly/,
    );
  });

  it("rejects a JSON-RPC rent error that web3.js converts to zero", async () => {
    const native = { ...identity, mint: NATIVE_MINT };
    const tokenAccount = getAssociatedTokenAddressSync(
      native.mint,
      native.owner,
    );
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      const payload =
        rpc.method === "getMinimumBalanceForRentExemption"
          ? { error: { code: -32603, message: "rent unavailable" } }
          : {
              result: {
                context: { slot: 1 },
                value: {
                  owner: SystemProgram.programId.toBase58(),
                  data: ["", "base64"],
                  executable: false,
                  lamports: 5000000,
                  rentEpoch: 0,
                },
              },
            };
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...payload }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      assert(address && typeof address !== "string");
      const rpc = new Connection(`http://127.0.0.1:${address.port}`);
      // This public web3.js method warns and returns zero for JSON-RPC errors.
      assert.equal(await rpc.getMinimumBalanceForRentExemption(165), 0);
      await assert.rejects(
        getTokenAccountBalance(rpc, tokenAccount, native),
        /native ATA balance/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  for (const [mint, tokenProgram] of [
    [NATIVE_MINT, TOKEN_PROGRAM_ID],
    [NATIVE_MINT_2022, TOKEN_2022_PROGRAM_ID],
  ]) {
    for (const lamports of [890880, 5000000]) {
      it(`preserves native ATA balance for ${tokenProgram.toBase58()} funded with ${lamports} lamports`, async () => {
        const svm = startSvm();
        const user = generateKpAndFund(svm);
        // LiteSVM starts without the native mint account. Install its standard state.
        const data = Buffer.alloc(MINT_SIZE);
        MintLayout.encode(
          {
            mintAuthorityOption: 0,
            mintAuthority: PublicKey.default,
            supply: BigInt(0),
            decimals: 9,
            isInitialized: true,
            freezeAuthorityOption: 0,
            freezeAuthority: PublicKey.default,
          },
          data,
        );
        svm.setAccount(mint, {
          data,
          owner: tokenProgram,
          executable: false,
          lamports: Number(svm.getRent().minimumBalance(BigInt(MINT_SIZE))),
        });
        const tokenAccount = getAssociatedTokenAddressSync(
          mint,
          user.publicKey,
          true,
          tokenProgram,
        );
        signAndSendTransaction(
          svm,
          new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: user.publicKey,
              toPubkey: tokenAccount,
              lamports,
            }),
          ),
          [user],
        );
        const connection = createLiteSvmConnection(svm);
        connection.getMinimumBalanceForRentExemption = async (size) =>
          Number(svm.getRent().minimumBalance(BigInt(size)));
        const before = await getTokenAccountBalance(connection, tokenAccount, {
          mint,
          owner: user.publicKey,
          tokenProgram,
        });
        signAndSendTransaction(
          svm,
          new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(
              user.publicKey,
              tokenAccount,
              user.publicKey,
              mint,
              tokenProgram,
            ),
          ),
          [user],
        );
        assert.equal(BigInt(before) > BigInt(0), lamports === 5000000);
        assert.equal(
          before,
          await getTokenAccountBalance(connection, tokenAccount),
        );
      });
    }
  }
});
