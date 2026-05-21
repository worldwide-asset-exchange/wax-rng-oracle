#include <requestrand.hpp>

ACTION requestrand::requestsucce(uint64_t signing_value)
{
  require_auth(get_self());
  jobs_t _jobs(get_self(), get_self().value);
  uint64_t id = _jobs.available_primary_key();
  _jobs.emplace(get_self(), [&](auto &j)
                    {
        j.id = id;
        j.expected = true; });

  action(
        {get_self(), "active"_n},
        "orng.wax"_n, "requestrand"_n,
        std::tuple(id, signing_value, get_self()))
        .send();
}

ACTION requestrand::requestfail(uint64_t signing_value)
{
  require_auth(get_self());
  jobs_t _jobs(get_self(), get_self().value);
  uint64_t id = _jobs.available_primary_key();
  _jobs.emplace(get_self(), [&](auto &j)
                    {
        j.id = id;
        j.expected = false; });

  action(
        {get_self(), "active"_n},
        "orng.wax"_n, "requestrand"_n,
        std::tuple(id, signing_value, get_self()))
        .send();
}

ACTION requestrand::receiverand(
    uint64_t assoc_id,
    checksum256 rv_hash
){
  require_auth("orng.wax"_n);
  jobs_t _jobs(get_self(), get_self().value);
  auto itr = _jobs.find(assoc_id);
  if (itr != _jobs.end() && itr->expected == false)
  {
    check(false, "revert");
  }

  uint64_t random_number = _hash_to_int(rv_hash);
  uint8_t random_result = random_number % 10;

  result_t _result(get_self(), get_self().value);
  if (!_result.exists()) {
    result result_record;
    result_record.result[random_result]++;
    _result.get_or_create(get_self(), result_record);
  } else {
    auto result_record = _result.get();
    result_record.result[random_result]++;
    _result.set(result_record, get_self());
  }

  _jobs.modify(itr, get_self(), [&](auto& j) {
      j.resolved = true;
  });
}