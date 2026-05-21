SHELL:= /bin/bash
wax_all_image = waxteam/wax-all:latest

APP_NAME=dicegame

CONTRACT_NAME=diceexample1

clean-benchmark:
	-rm -rf .benchmark/dice-contract/build

stop-wax-all:
	-docker stop wax-all
	-docker rm wax-all

start-wax-all: stop-wax-all
	docker pull $(wax_all_image)
	docker run --entrypoint /opt/wax-all/run-local-chain.sh --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 -d -p 8080:8080 -p 8888:8888 -p 9876:9876 -e NUM_PRODUCER=5 --name wax-all ${wax_all_image}
	sleep 30

make-benchmark-build-dir:
	-mkdir -p ./benchmark/dice-contract/build

build-benchmark-contract: clean-benchmark make-benchmark-build-dir
	cdt-cpp ./benchmark/dice-contract/src/${APP_NAME}.cpp -o ./benchmark/dice-contract/build/${APP_NAME}.wasm  -I ./benchmark/dice-contract/include/ -abigen_output ./benchmark/dice-contract/build/${APP_NAME}.abi

create-contract-account:
	cleos -u "http://localhost:8888" system newaccount eosio ${CONTRACT_NAME} EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV --stake-net "100.00000000 WAX" --stake-cpu "100.00000000 WAX" --buy-ram-bytes 505980000 --transfer

create-oracle-account:
	cleos -u "http://localhost:8888" system newaccount eosio oracle1 EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV --stake-net "100.00000000 WAX" --stake-cpu "100.00000000 WAX" --buy-ram-bytes 505980000 --transfer
	cleos -u "http://localhost:8888" system newaccount eosio oracle2 EOS8VipYEviUzEniPwZUdNRqnzujtTEzAWpNXXpn7a3pDz3ux6j3B EOS8VipYEviUzEniPwZUdNRqnzujtTEzAWpNXXpn7a3pDz3ux6j3B --stake-net "100.00000000 WAX" --stake-cpu "100.00000000 WAX" --buy-ram-bytes 505980000 --transfer
	cleos -u "http://localhost:8888" system newaccount eosio oracle3 EOS5UGRMxAucdYXVD8X4aDjYQP2GeMQ55sQ1P7iwgitoxmRWQRXv3 EOS5UGRMxAucdYXVD8X4aDjYQP2GeMQ55sQ1P7iwgitoxmRWQRXv3 --stake-net "100.00000000 WAX" --stake-cpu "100.00000000 WAX" --buy-ram-bytes 505980000 --transfer

set_contract_code:
	cleos -u "http://localhost:8888" set account permission ${CONTRACT_NAME} active --add-code

deploy-local:
	cleos -u "http://localhost:8888" set contract ${CONTRACT_NAME} ./benchmark/dice-contract/build/ "${APP_NAME}.wasm" "${APP_NAME}.abi" -p ${CONTRACT_NAME}@active
	cleos -u "http://localhost:8888" set contract orng.wax ./test/artifacts "wax.orng.wasm" "wax.orng.abi" -p orng.wax@active

stake-dapp:
	cleos -u "http://localhost:8888" transfer eosio ${CONTRACT_NAME} "1000.00000000 WAX" -p eosio@active
	cleos -u "http://localhost:8888" transfer ${CONTRACT_NAME} orng.wax "100.00000000 WAX" "deposit" -p ${CONTRACT_NAME}@active

config-rng-decentralize:
	cleos push action orng.wax setpubkey '[1,"10001","e432619c6f144563763dff22e9214bddadc9e4920fffc6ce94d3616631927cc6c4a54009ce4729c7028d7ef9dfd802677943184d2d065adae859a14a313b21d3c788bbc8c47c75418eb58018fff6266ace123ede73a45b1a50db543bdaf492924eb9f4c65fd4699f6c1f98d6b04c5ca7e0993a7d7b836ae9b5b8f2ad857c71fa8e070b70f499ad5cfa7111467dd16a7d1aad389eab26e623fcf9c751566ccaf25d0209574decfe18ba8bc1984ae10723915677fc4795c631427aac6ee60c5c7e0732c2b19d590d89e66f1ee8c820ccb5b13b5aef4c2bd47bed8076b43f4d2bf2d48bda74d2e542d75e8592d9e27fb29c6ad9493bd989df851465eafff08f5c5d7ee11601ed6a402df8ecdf4fa1d045d5aa1e65a84284c07edda669ab0decd86a51e1ffdbdd4a36defa8c0e24426d2578bcfd1b434d6fd6c14b1a2b9e1edfbe68c506a3c2d644663b1090235c62094bddfce7488073fe3b35d66ccdbd4b2d022ba318eac60c1437b31b034e4d83391f1c879a06cebfc809dc8fd8f9620313946727dffe54aa3c928893e64ffb5e21b1e87fa474c6b1d0ff10df2a913346a577fbe18664365b112891a746b889667036fe91937c8e277e677213e02233cdc872a1624d4172704b9ddafe3a75376979ba8c261b0163468d6e88d19c4bf483b72923776032c9ea1b7ea314fe4c927742d5a91eedc7eaf6fd638a420059fbdd45f979"]' -p orng.wax
	cleos push action orng.wax configv2 '["0.00500000 WAX", 3, 10, 10]' -p orng.wax
	cleos push action orng.wax setoracles '[["oracle1","oracle2","oracle3"]]' -p orng.wax
	cleos transfer eosio orng.wax "1000.00000000 WAX" "treasury" -p eosio

setup-rng-decentralize: create-contract-account deploy-local set_contract_code create-oracle-account config-rng-decentralize stake-dapp

setup-env: start-wax-all setup-rng-decentralize

start-node1:
	NODE_ENV=local1 NODE_CONFIG_DIR=./config pm2 start ./index.js -n node1 -l benchmark/log/node1.log --update-env

start-node2:
	NODE_ENV=local2 NODE_CONFIG_DIR=./config pm2 start ./index.js -n node2 -l benchmark/log/node2.log --update-env

start-node3:
	NODE_ENV=local3 NODE_CONFIG_DIR=./config pm2 start ./index.js -n node3 -l benchmark/log/node3.log --update-env


stop-node1:
	pm2 stop node1
	pm2 delete node1

stop-node2:
	pm2 stop node2
	pm2 delete node2

stop-node3:
	pm2 stop node3
	pm2 delete node3


stop-rng-nodes: stop-node1 stop-node2 stop-node3 stop-node4 stop-node5

start-rng-nodes: start-node1 start-node2 start-node3 start-node4 start-node5