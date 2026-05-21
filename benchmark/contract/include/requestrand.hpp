#include <eosio/eosio.hpp>
#include <eosio/crypto.hpp>
#include <eosio/singleton.hpp>
#include <eosio/asset.hpp>
#include <eosio/transaction.hpp>

using namespace std;
using namespace eosio;
static const symbol WAX_SYMBOL = symbol("WAX", 8);

CONTRACT requestrand : public contract
{
public:
  using contract::contract;
  ACTION requestsucce(uint64_t signing_value);

  ACTION requestfail(uint64_t signing_value);

  ACTION receiverand(
    uint64_t assoc_id,
    checksum256 rv_hash
  );

private:
  TABLE jobs
  {
    uint64_t id;
    bool expected; // success/fail
    bool resolved = false; // success/fail
    uint64_t primary_key() const { return id; }
  };
  typedef multi_index<
      "jobs"_n,
      jobs>
      jobs_t;
  
  TABLE result
  {
    vector<uint64_t> result = vector<uint64_t>(10, 0);
  };
  typedef singleton<"result"_n, result> result_t;
  typedef multi_index<
      "result"_n,
      result> result_abi_t;

  uint64_t _hash_to_int(const checksum256 &value)
  {
    auto byte_array = value.extract_as_byte_array();
    uint64_t int_value = 0;
    for (int i = 0; i < 8; i++) {
      int_value <<= 8;
      int_value |= byte_array[i] & 127;
    }
    return int_value;
  }
};
