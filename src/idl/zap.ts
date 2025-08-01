/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/zap.json`.
 */
export type Zap = {
  "address": "zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz",
  "metadata": {
    "name": "zap",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "zapOut",
      "discriminator": [
        155,
        108,
        185,
        112,
        104,
        210,
        161,
        64
      ],
      "accounts": [
        {
          "name": "userTokenInAccount",
          "writable": true
        },
        {
          "name": "ammProgram"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "zapOutParameters"
            }
          }
        }
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "mathOverflow",
      "msg": "Math operation overflow"
    },
    {
      "code": 6001,
      "name": "invalidOffset",
      "msg": "Invalid offset"
    },
    {
      "code": 6002,
      "name": "invalidZapOutParameters",
      "msg": "Math operation overflow"
    },
    {
      "code": 6003,
      "name": "typeCastFailed",
      "msg": "Type cast error"
    },
    {
      "code": 6004,
      "name": "ammIsNotSupported",
      "msg": "Amm program is not supported"
    }
  ],
  "types": [
    {
      "name": "zapOutParameters",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "percentage",
            "type": "u8"
          },
          {
            "name": "offsetAmountIn",
            "type": "u16"
          },
          {
            "name": "preUserTokenBalance",
            "type": "u64"
          },
          {
            "name": "payloadData",
            "type": "bytes"
          }
        ]
      }
    }
  ]
};
