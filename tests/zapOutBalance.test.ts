import { strict as assert } from "assert";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";
import { Zap } from "../src/zap";
import { JupiterSwapInstructionResponse } from "../src/types";
import {
  createDammV2Pool,
  createPositionAndAddLiquidity,
  removeLiquidity,
  getDammV2Pool,
  getDammV2Position,
} from "./helpers/damm_v2";
import { createToken, mintToken, getTokenBalance } from "./helpers/token";
import {
  startSvm,
  generateKpAndFund,
  createLiteSvmConnection,
  signAndSendTransaction,
} from "./helpers/svm";
import { getAmountAFromLiquidityDelta, Rounding } from "@meteora-ag/cp-amm-sdk";

describe("zap-out balance snapshots", () => {
  const setup = async () => {
    const svm = startSvm();
    const admin = generateKpAndFund(svm);
    const user = generateKpAndFund(svm);
    const inputMint = createToken(svm, admin, admin.publicKey, null);
    const outputMint = createToken(svm, admin, admin.publicKey, null);
    for (const mint of [inputMint, outputMint]) {
      for (const owner of [admin, user])
        mintToken(svm, admin, mint, admin, owner.publicKey);
    }
    const poolAddress = await createDammV2Pool({
      svm,
      creator: admin,
      tokenAMint: inputMint,
      tokenBMint: outputMint,
    });
    const connection = createLiteSvmConnection(svm);
    const inputAccount = getAssociatedTokenAddressSync(
      inputMint,
      user.publicKey,
    );
    const outputAccount = getAssociatedTokenAddressSync(
      outputMint,
      user.publicKey,
    );
    const params = {
      user: user.publicKey,
      poolAddress,
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ID,
      outputTokenProgram: TOKEN_PROGRAM_ID,
      amountIn: new BN(100),
      minimumSwapAmountOut: new BN(0),
      maxSwapAmount: new BN(200),
      percentageToZapOut: 100,
    };
    return {
      svm,
      admin,
      user,
      connection,
      inputAccount,
      outputAccount,
      params,
    };
  };

  it("rejects the DAMM builder when its input-balance RPC fails", async () => {
    const f = await setup();
    const getAccountInfo = f.connection.getAccountInfo.bind(f.connection);
    const rpcError = new Error("503 Service Unavailable");
    f.connection.getAccountInfo = async (key, commitment) => {
      if (key.equals(f.inputAccount)) throw rpcError;
      return getAccountInfo(key, commitment);
    };
    f.connection.getTokenAccountBalance = async () => {
      throw rpcError;
    };
    await assert.rejects(
      new Zap(f.connection).zapOutThroughDammV2(f.params),
      (error) => error === rpcError,
    );
  });

  it("rejects the Jupiter builder before consuming swap instructions when the balance RPC fails", async () => {
    const f = await setup();
    const rpcError = new Error("429 Too Many Requests");
    f.connection.getAccountInfo = async () => {
      throw rpcError;
    };
    f.connection.getTokenAccountBalance = async () => {
      throw rpcError;
    };
    await assert.rejects(
      new Zap(f.connection).zapOutThroughJupiter({
        ...f.params,
        jupiterSwapResponse: {} as JupiterSwapInstructionResponse,
      }),
      (error) => error === rpcError,
    );
  });

  it("rejects the DLMM builder when the balance RPC fails after loading the pool", async () => {
    const f = await setup();
    const rpcError = new Error("RPC request timed out");
    const getAccountInfo = f.connection.getAccountInfo.bind(f.connection);
    f.connection.getAccountInfo = async (key, commitment) => {
      if (key.equals(f.inputAccount)) throw rpcError;
      return getAccountInfo(key, commitment);
    };
    f.connection.getTokenAccountBalance = async () => {
      throw rpcError;
    };
    const originalCreate = DLMM.create;
    // Isolate balance-error handling from the earlier DLMM pool fetch.
    DLMM.create = async () =>
      ({
        lbPair: {
          tokenXMint: f.params.inputMint,
          tokenYMint: f.params.outputMint,
          reserveX: f.inputAccount,
          reserveY: f.outputAccount,
          tokenMintXProgramFlag: 0,
          tokenMintYProgramFlag: 0,
        },
        getBinArrayForSwap: async () => [],
      }) as unknown as DLMM;
    try {
      await assert.rejects(
        new Zap(f.connection).zapOutThroughDlmm({
          ...f.params,
          lbPairAddress: f.params.poolAddress,
        }),
        (error) => error === rpcError,
      );
    } finally {
      DLMM.create = originalCreate;
    }
  });

  it("preserves pre-existing input tokens when maxSwapAmount exceeds the withdrawal", async () => {
    const f = await setup();
    const position = await createPositionAndAddLiquidity(
      f.svm,
      f.user,
      f.params.poolAddress,
    );
    const pool = getDammV2Pool(f.svm, f.params.poolAddress);
    const positionState = getDammV2Position(f.svm, position);
    const withdrawn = getAmountAFromLiquidityDelta(
      pool.sqrtPrice,
      pool.sqrtMaxPrice,
      positionState.unlockedLiquidity,
      Rounding.Down,
      pool.collectFeeMode,
      pool.tokenAAmount,
      pool.liquidity,
    );
    const before = getTokenBalance(f.svm, f.inputAccount);
    const remove = await removeLiquidity(
      f.svm,
      f.user.publicKey,
      f.params.poolAddress,
      position,
      f.inputAccount,
      f.outputAccount,
    );
    const zap = await new Zap(f.connection).zapOutThroughDammV2({
      ...f.params,
      amountIn: withdrawn,
      maxSwapAmount: withdrawn.muln(2),
    });
    signAndSendTransaction(f.svm, new Transaction().add(remove).add(zap), [
      f.user,
    ]);
    assert(getTokenBalance(f.svm, f.inputAccount).eq(before));
  });
});
