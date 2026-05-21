# wax-rng-oracle

NodeJS Application for WAX Block Producers to Process RNG Jobs:

- Update the public keys that the node is using
- Participate in the epoch process by submitting seeds and signatures to randomly chosen resolvers
- Polling for pending RNG jobs and submit signature for job
- Execute jobs that has been completed
- Report failed job executions
- Cleans signed value

## Development

Require NodeJs version >16

Install dependencies first:

```bash
$ npm install
```

### Run all unit tests:

```bash
$ npm test
```

### Run local development env

The local environment runs a 5 block-producer WAX chain and **3 oracle nodes**
(`oracle1`, `oracle2`, `oracle3`) that share a 2-of-3 RSA threshold key.

1. Unlock your local wallet and make sure the default eos key exists in your wallet

```bash
$ cleos wallet unlock
# import key EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV
$ cleos wallet import --private-key 5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3
```

> These keys are throwaway credentials for the local Docker chain only. Never
> reuse them on a public network.

2. Create the oracle node config files

Each oracle node reads `config/local<N>.json`. These files hold key material and
are gitignored, so copy the provided templates and fill them in:

```bash
$ cp config/local1.example.json config/local1.json
$ cp config/local2.example.json config/local2.json
$ cp config/local3.example.json config/local3.json
```

For each node, set:

- `mnemonic` — seed used to derive the node's signing key
- `eos.orng.privateKey` — private key for that node's `oracleN` account
- `shareKey` — this node's RSA threshold share: `shareIndex`, `sharedKey`,
  `publicKey.n`, `publicKey.e`, `verificationKey`, `verificationKeyShare`, `vku`

The three nodes must use one coordinated threshold keyset. Generate one with the
[`@waxio/rsa-threshold-signatures`](https://github.com/worldwide-asset-exchange/rsa-threshold-sigs-js)
library, then register the keyset's public key on-chain. The
`config-rng-decentralize` target in the [Makefile](./Makefile) calls `setpubkey`
with a sample public key — replace it with the `publicKey.n` of the keyset you
generate so the contract and nodes agree.

3. Setup local chain

- Run a local WAX chain with 5 block producers
- Deploy the `orng.wax` contract and a dapp contract used to request random jobs
- Create the `oracle1/2/3` accounts and configure `orng.wax` for decentralized mode

```bash
$ make setup-env
```

4. Start the 3 rng oracle nodes (via PM2)

```bash
$ make start-node1
$ make start-node2
$ make start-node3
```

Query contract table to check for epoch process:

```bash
$ cleos get table orng.wax orng.wax epochseed.a
{
  "rows": [{
      "id": 12,
      "seeds": [{
          "node": "bproducer111",
          "seed": "ac97ca37682696dc9b417878b486e09c91d9987d6ac28122c9042e778393ea17",
          "signature": ""
        },{
          "node": "bproducer112",
          "seed": "71210bef066cbf544c7b57648a5ad71cd76fb57f179455d56c05d2e9a8cb97dd",
          "signature": ""
        },{
          "node": "bproducer113",
          "seed": "b11f50e2637e1280f813af920f4926d448558ea123c2fb7b6338ce6e35189aef",
          "signature": ""
        },{
          "node": "bproducer114",
          "seed": "d2722771c885c4d36b7fba815f33123b4187b4f12b359c8619fd15e9c7af76df",
          "signature": ""
        },{
          "node": "bproducer115",
          "seed": "783b7e355af89a609cd819e0e86962d95a57adc7d2a1d720c89555b075c1a52d",
          "signature": ""
        }
      ],
      "end_submit_seed_time": 1739261633,
      "submit_signature_deadline": 1739261693
    }
  ],
  "more": false,
  "next_key": ""
}
```

```bash
$ cleos get table orng.wax orng.wax epochsig.a
{
  "rows": [{
      "id": 12,
      "seeds": [{
          "node": "bproducer111",
          "seed": "ac97ca37682696dc9b417878b486e09c91d9987d6ac28122c9042e778393ea17",
          "signature": "0c3071a86709ed1bdecdccf3f3e3ce926fc2d3dd681913a683966a35e1d05c3880eec4a671c1488dfe25e679cc0a92192daa5edbbf6b4e8b7201b2ff5763e682fd71b73231065bedb755c580df515c9bea1551295035aa1eec49c9c9fbb6bb9bff043ac26d688f0dcdbdbeded4eb579e711c43b2e68bd911ed3a3aa6edf7702329cc5bdbce5622c4393e1184128385a3d549dbde228e4044392ed41984a30ba649ef64d5a5b08ebb0f2b5badd5d65df30bdb5bbc5a0bb0bf1603478c76b0278952b73bfda68876776e8352fc9499761057bbe504b76d1a1192225ce30c216880811ffd643b0ada86838e3c2fc88adf59ba5101d2e6de727a88f1a1a485a91ab8002ab31ccce8416460b625652ca3dd93222fcb2e6001a099db76d04cb4801d836a6c952520fbeea79b49c16f9b34748089865ec325ae0e13c5f113203d003cdd7693c5ef21798b7a9b6e0ba58494e6eacace58a06ad38b6717280dc4586e690367ba61760ff60281ab2da8ac28278472a75aadc167eb45e9d3df2aeb56774d40891d22a8b658bd380710053833a42c6d753695773cf087586110c32539f08a81ce4c21c216afba1460da13ba73bb01735c1c74f2eb6a6f9dcae0f6fa92db3bee281e87a6cc88f645628217ece129ed19f9a9150613a84c1592377aa023741a0db579d577c451dc3806e33159df0d449cf232758ed79cfae175be29dd2130ad6b"
        },{
          "node": "bproducer112",
          "seed": "71210bef066cbf544c7b57648a5ad71cd76fb57f179455d56c05d2e9a8cb97dd",
          "signature": "06bcb2d676463bdf71bd21af846e3c8479a147440647133551ea72fdb7afbdfeb8605e7056685ab3c36075a569c48836eac312b5f405392b527bbf5d1e8c392959a1a0c04c336a4c7413c430d7482fb20b99346723cb7c57e90336bc07ead9e5ec5bab7f1a7b801866325be8883b902c256bb648383ccb0df8afe1ddede5218ff8c4ebe549d1a18f7bc809fc335b0036db8cff81402ed10b93d867b109096eefa8910f9e7d984309819a832cef867789424c21468fcb50600a4dbccb95229606835e4ca9b564ed357125f2cad189f930ba53b83bfdea9a2c416f260731c7a9e3ffb80aaf82e240a5458175d29d33a43fbd79f10422ea675d74d7a86a0af97068dd71d8fb3731fd88c577c02ff968deecb4aab3b51c6fec328fff74a62b3bc3659e9addbfb1e043b3a893b7abbd00603a1ce12c0a97c9fb1b438ec5c088cbf30aa242121523a2ab1f3db91ba9ac6c87611022546854d74dd9e8766148d3917d8330bdce237705bccc3b6e7e30d94a0adc9a541012588ea152871ad996a5a04d4afce2f2fe747c19d49b8828b7929bae55a5e1188e5b4d8732a21fded20281d6f4c28943ea3b5346c71d288cb33fe2c5d2d36ad06b3697425ed459c5996ca92fce6da388144c7f17572164dc92cbd39b587f3589fa2dd4417ab697103368cedfe1aa0036b864aa2c798bb90758dbe31624251e11ee589e8105bcd788d301ee8fbd"
        },{
          "node": "bproducer113",
          "seed": "b11f50e2637e1280f813af920f4926d448558ea123c2fb7b6338ce6e35189aef",
          "signature": "1506cc02ab8a0d3104ce9bf8a4be8a886e5a969a49e085e080064962a9bed836efa5a043414450aa149c64f4194c0b71300d7229a38600c57688a72c54b4800984965d0bb728726a1b09824a5dfc8b209cccc2169d3062a448de9be3ca4316fd5d9d978c6baf051fbc6e4a9f8d9caaf728d790accdae8e220eb65d2749e338e1e5408c13fa59930db2094d871f850d3a514734c2cbcda490e23d8826f170f43f5748b9d0b91a8703147d3d53c8cb6eb0931d1d3941ba91c0c61ca16aff35777300c33b79c3bbaf8036c0aa10791c9a9f0b62c394e2dfef5a4f34b0e53cfa6648baf86cd595cc45ca37bfdadc301eeca87720e784070f75621cc3ccbd4bd74e8bef556f931bd3ac2cdf32679cccae5a51596d5f3f6aa2a9c135908838c4ba13573c27a9566b79ddab59c20954b45389d30b1d8021e6e08f7c7c9ac7e07d721a3606cf0293012c244463a3d8286b687b9a713e5f67b43dc3aca75469bf9c5f5df4787a8876df3ab2ac2ba7dc39c464d79f031ba94abe9497b579c075f86aef2a53062391487424bb22ef617b62f2b8de848cd087bb286c6ea0d48eaabfe7d6c8b28966327b3b5b1325bed86b4c675139d7aa0b074e448903df011fadb95ac1a6056cdb5a06cf0e84d2bfd5b157da728dda463eae46fc89503f699223b4fb5333d5322198949757e41c18573df2cc12c5b5e4e8af2f00669f235a4b9d84345dc4d5"
        },{
          "node": "bproducer114",
          "seed": "d2722771c885c4d36b7fba815f33123b4187b4f12b359c8619fd15e9c7af76df",
          "signature": "7b8eb305745efe7f6a94eb4855214f2dfdc3e6ce2f56ecf29790b5c3146214b40dbc86acfabade8783bf40596f76f46173d788150ce122ff1426f3d070755a961dd6acaa4406f0bfbcda2882aa6f67a1c30ebd42e5f610f6a04ab1c5bbdaa9174f539c870f91cfbb1c16406dbb9c486a7fa5a81b7ef7eef39d4dccd363bc34871067f2d4fc0a41dfc08819d58aae0d783dc82d993b96853bf45f5b4edddd23e629022020770275d72fa6d9be7ee58d32d7f0e0652446244aad98b0204e6575ac6d4db72628ee862c3221445c8de264bf305f719a49852ffb8b18e425e4be4dca19a715eb119141adf46920faae40ea7cb9dcf15d40c8b2815a890581edea3f1f32fd14f665321ad5cb5ca03310c9ed92f9a36775604baeb15d9b5b316f72ac7d367bd22b23b43e3d3db9cb645869d5eb78e3afbcad6ef1583871731a808473b8bf127b1007f6a2f025465e3bbb653cda4339a24a005e4a98c332a3d3c4c93839b59af8b38ecc80c4a23cd92b5e15f35c7a240d5355f81f838a605ee3aff57a14a7a59c4764a203aa1d0c232928d4f71a3ad6e6887ded26416005040162280b369719472de8a2d06917cbc289cdd9d5d001878c23198c7d59d34bf972e374823b9397642d7d99b0a20fe2b861dc3b1ccd89b1d3c32c7b5924b2329d30c4420b07eb5b9573701957add5efeeb310405da76d5dfad8f56f798e20aef7b40c0d11b0"
        },{
          "node": "bproducer115",
          "seed": "783b7e355af89a609cd819e0e86962d95a57adc7d2a1d720c89555b075c1a52d",
          "signature": "56e04ef2eedd545d33d39384e0e0fe8044663b81a7a2e3adb36557a0065c3b291220452e3f6309dc63c920b6802385198617db1a009e881fba9233685b12a92e6558ca1174e6fb627bacb9c958e70392b6fe88c5d77aa084ad1b84200a694c3f33d490b69fa7da6c6567ab0e7914aa34bf6a36e20bfd553331dc644b01bd0c97b5939805c59708212987736f28f9ad2bcce8797eebb772be27c3b4d0b29132160bb03717389b38b067c0b6ce3a1d1d58376e69c585e19464d4818c931bfdd8a4f9ce793538591890967a2e266d1edc2159d6c8371cbf57fa8834ae751120aefe53e65567319a1466a2efb48cc80281dd3d1728ac5bfc3a6314d68ab6560db4d749dd1d7f17b8f9bbf3d9fc27ec26cd5d3f9803dcccbde68a07bf2c5b6e79f36fee4d50ca5c67f76412b7d45dcc90c80d07458735b065d3c995e95cba0bdab156040d311f6ddd2118cf5c751a6de48f71dc32adb91c91cece2e8e4efb35c5b82af04a2d621eae750ff8a5a5a95de0361615e6b7c817b0870bf8d9688087868f160d19d6192b8ebbe3303dcbd9f0c4bedad84ef0b567df71f48ed19b1ce23463c09b900e3c0e96acb9b05d90a3c71e617d31e9643f9d91475ce771e26fc954f4d246b6917e0aac6fc74f256fd5a50a641442a6cd13af54d3f139de4b2058adc0f39d0ec0b1e49f599860a7e2b16c108b5de408335ecf7690164495d865a61dd73d"
        }
      ],
      "end_submit_signature_time": 1739261693,
      "resolve_deadline": 1739261753
    }
  ],
  "more": false,
  "next_key": ""
}
```

```bash
$ cleos get table orng.wax orng.wax epoch.a
{
  "rows": [{
      "id": 11,
      "resolvers": [
        "bproducer111",
        "bproducer115",
        "bproducer113"
      ],
      "end_time": 1739261693
    }
  ],
  "more": false,
  "next_key": ""
}
```

You can run node in cluster mode using command:

```bash
NODE_ENV=local3 CLUSTER_MODE=true node index.js
```

5. Request rand

Use deployed dapp contract `requestrand` to request for decentralized random value

```bash
$ cleos push action requestrand requestsucce '[1]' -p requestrand
```

Create job that failed to execute using command:

```bash
$ cleos push action requestrand requestfail '[1]' -p requestrand
```

Get `node.a` table to check processed job count for each table

```bash
$ cleos get table orng.wax orng.wax node.a
{
  "rows": [{
      "owner": "bproducer113",
      "job_count": 1
    },{
      "owner": "bproducer114",
      "job_count": 1
    },{
      "owner": "bproducer115",
      "job_count": 1
    }
  ],
  "more": false,
  "next_key": ""
}
```

6. Run benchmark script

In order to benchmark performance of decentralized orng network, We created script batch create jobs that defined quantity [here](wax-rng-oracle/benchmark/benmark.js#L21). The script also poll to check for the time needed for network to completed all of benchmark jobs.

```bash
$ node benchmark/benmark.js
Processed  173  requests
Processed  194  requests
Processed  1118  requests
Processed  1139  requests
Polling to check time nodes needed to process jobs
Polling to check time nodes needed to process jobs
Polling to check time nodes needed to process jobs
All job processed
Total time for process  1000  jobs  61414
DONE
```

## Run the application

### Configuration

This project uses the standard [config](https://www.npmjs.com/package/config) library for configuration management. Configuration files are located in the `config/` directory.

WAX internal deployments can optionally use `@waxio/wax-config` for secrets management - if installed, it will be used automatically.

Default configuration is set in [config/default.json](./config/default.json). You can override settings using environment-specific config files or environment variables:

- `MNEMONIC`: mnemonic to generate signing key of node
- `NUMBER_OF_AVAILABLE_PUBKEYS`: number of available signing public key of node that updated in RNG smart contract, must be greater than 2.
- `NUM_OF_CLEAR_ROWS`: number of rows to clean signed value
- `READONLY_MODE`: run express app only
- `METRICS_HOST`, `METRICS_PORT`, `METRICS_PREFIX`: metrics config
- `EOS_CHAIN_ID`: wax chain id
- `EOS_API_URL`: wax chain api url
- `EOS_ORNG_NODE_OWNER`: block producer account name
- `EOS_ORNG_CONTRACT_NAME`: must be `orng.wax`
- `EOS_ORNG_MAX_CPU`: max CPU to push transaction to blockchain
- `EOS_ORNG_PRIVATE_KEY`: private of permission to push RNG actions
- `JOB_RETRY_MAX_RETRIES`: Maximum execution retry times if fail
- `JOB_PENDING_ALERT_MAX_JOB_PENDING`: send alert message to slack channel if pending job greater than this config
- `DB_FILE`: Path to db file
- `EXPRESS_APP_ENABLE`: enable express app
- `EXPRESS_APP_PORT`: express app port
- `CLUSTER_MODE`: run app as cluster mode
- `SLACK_WEBHOOK`: slack webhook channel

```bash
$ npm start
```

### Stats metrics

| Metric                                           | Meaning                                             | Tags |
| ------------------------------------------------ | --------------------------------------------------- | ---- |
| eos.response_time.get_seeds_to_be_send           | Time to poll jobs from blockchain to be process     | None |
| eos.response_time.get_job_to_execute             | Time to poll jobs from blockchain to be execute     | None |
| set_rand_heart_beat                              | Set rand jobs poller heartbeat                      | None |
| seeds_to_be_send_loaded                          | Number of jobs need to be processed                 | None |
| seeds_sent                                       | Number of jobs have been processed                  | `contract`: contract name that request ramdom |
| seeds_failed                                     | Number of jobs have been failed to process          | `contract`: contract name that request ramdom |
| execute_heart_beat                               | Execute jobs poller heartbeat                       | None |
| seeds_to_execute_loaded                          | Number of jobs need to be executed                  | None |
| executed_job                                     | Number of jobs has been executed                    | None |
| execute_failed                                   | Number of jobs has been failed to execute           | None |
| seeds_pending                                    | Number of pending jobs                              | None |
