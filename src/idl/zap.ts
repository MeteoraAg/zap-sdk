/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/zap.json`.
 */
export type Zap = {
  address: "zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz";
  metadata: {
    name: "zap";
    version: "0.1.0";
    spec: "0.1.0";
    description: "Created with Anchor";
  };
  instructions: [
    {
      name: "initializeTokenLedger";
      discriminator: [244, 63, 250, 192, 50, 44, 172, 250];
      accounts: [
        {
          name: "zapAuthority";
          address: "5GAePfba5djevckzzENFkU22BQobHa4mQTQoJaG7DbDk";
        },
        {
          name: "tokenLedgerAccount";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ];
              },
              {
                kind: "account";
                path: "tokenMint";
              }
            ];
          };
        },
        {
          name: "tokenMint";
        },
        {
          name: "payer";
          writable: true;
          signer: true;
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
        {
          name: "tokenProgram";
        },
        {
          name: "eventAuthority";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ];
              }
            ];
          };
        },
        {
          name: "program";
        }
      ];
      args: [];
    },
    {
      name: "zapOut";
      discriminator: [155, 108, 185, 112, 104, 210, 161, 64];
      accounts: [
        {
          name: "zapAuthority";
          address: "5GAePfba5djevckzzENFkU22BQobHa4mQTQoJaG7DbDk";
        },
        {
          name: "tokenLedgerAccount";
          writable: true;
        },
        {
          name: "ammProgram";
        }
      ];
      args: [
        {
          name: "actionType";
          type: "u8";
        },
        {
          name: "payloadData";
          type: "bytes";
        }
      ];
    }
  ];
  errors: [
    {
      code: 6000;
      name: "invalidAmmProgramId";
      msg: "Invalid amm program id";
    },
    {
      code: 6001;
      name: "invalidActionType";
      msg: "Invalid action type";
    },
    {
      code: 6002;
      name: "typeCastFailed";
      msg: "Type cast error";
    }
  ];
};
