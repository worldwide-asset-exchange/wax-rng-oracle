#!/usr/bin/env bash

openssl genrsa -out ./resources/test_rsa_4096_priv.pem 4096
openssl rsa -modulus -in ./resources/test_rsa_4096_priv.pem | grep Modulus | awk '{print tolower($0)}'
