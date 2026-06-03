let config = require('../lib/config/configLoader').loadConfig();
const { expect } = require('chai');
const sinon = require('sinon');
const { Chain } = require('qtest-js');
let { eosRpc, getOrngContract } = require('../lib/config/eos');
const eosHelper = require('./eosHelper');
const Storage = require('../lib/storage');
const JobService = require('../lib/jobService');
const Poller = require('../lib/poller');
const ShareKeyService = require('../lib/shareKeyService');
const { sha256 } = require('./eosHelper');
const RngPusher = require('../lib/rngPusher');
const { request } = require('express');

const shareKey1 = {
  threshold: 2,
  numParties: 3,
  bits: 4096,
  shareIndex: 1,
  sharedKey:
    '2b6a11df5480f9f5ceb40aa79b7664a649b7509d564719e067f1081b7a16e3cf29e6fa51d791266da450a526027829b044fc6d60775719e156b77a3aff9524ae5aac376ecde5ca54b1668890ded9c427b59a1cf42ecbb20016a54b1f922023f7b4ecb59154f9b97fd151900a2ad3a58b64e20d83f8404df07fa285a608723b36d6e4dd19fdc978ce5e602e270538e6d1883813af700384b861349f58d38c5248ac498a54f3f402b528342f3cd81639c6571a71e69c189cbdc88bc26edfb00f5cc43d65f18901d14ce47b4fc1391d3d249995aadcb21adb343c533a38bfd72b9124b5d871497c014883e0914a8e45eaf9c6291b958d67214e429a860eccd8c39bf86c4a72a23ef8e1aaae91482b40837417b1c67140c8ed841c92f2f41e72cfa05fc534f00ebf9a2290a44708e4aae44227029c757da62898f6468fb95f9d722f5da750f6fdf1482e8b9fbf6208796448d0f8982eaf1dd0404944d57a50291964c0ee2ed0c6ae807d072b79a35a4638682d3b6b05b1d450a64b442b45b874999e09ecd58a9832f855ea9881921ccb3ea38704f0bc3b8f1d08571e7748292dc9131bf12096858414b0b546be2a673592f979798047590b19cabef90b59c46831fafc0649bf7e0310d5371442db24dc1d6b20280785b331857bf54836ffd1b4085adffa02464b53293ec0a3753e601fb7d8982920ce8af78d21c5a5546603a80143',
  publicKey: {
    n:
      'e432619c6f144563763dff22e9214bddadc9e4920fffc6ce94d3616631927cc6c4a54009ce4729c7028d7ef9dfd802677943184d2d065adae859a14a313b21d3c788bbc8c47c75418eb58018fff6266ace123ede73a45b1a50db543bdaf492924eb9f4c65fd4699f6c1f98d6b04c5ca7e0993a7d7b836ae9b5b8f2ad857c71fa8e070b70f499ad5cfa7111467dd16a7d1aad389eab26e623fcf9c751566ccaf25d0209574decfe18ba8bc1984ae10723915677fc4795c631427aac6ee60c5c7e0732c2b19d590d89e66f1ee8c820ccb5b13b5aef4c2bd47bed8076b43f4d2bf2d48bda74d2e542d75e8592d9e27fb29c6ad9493bd989df851465eafff08f5c5d7ee11601ed6a402df8ecdf4fa1d045d5aa1e65a84284c07edda669ab0decd86a51e1ffdbdd4a36defa8c0e24426d2578bcfd1b434d6fd6c14b1a2b9e1edfbe68c506a3c2d644663b1090235c62094bddfce7488073fe3b35d66ccdbd4b2d022ba318eac60c1437b31b034e4d83391f1c879a06cebfc809dc8fd8f9620313946727dffe54aa3c928893e64ffb5e21b1e87fa474c6b1d0ff10df2a913346a577fbe18664365b112891a746b889667036fe91937c8e277e677213e02233cdc872a1624d4172704b9ddafe3a75376979ba8c261b0163468d6e88d19c4bf483b72923776032c9ea1b7ea314fe4c927742d5a91eedc7eaf6fd638a420059fbdd45f979',
    e: '10001',
  },
  verificationKey:
    '745fe21854e07fb1c240eaae6a613916070225d5e009e0ff4fd0a0179e3b37e1a78625c82c6e00d578721ec29b02f41f12995b3e595279b19b3206e62157a19260b80f334eb02662a3dc4996447ab34b129fa7627400192ac957b3692f6bee6a70a019aecb525f88266c4a5b9864ce9ed504e43686055878f33a0e159c21e1d49ab55e952292dc944fbaa703c4dcf4ceac1f82f3982037ce604ebc9fd7a981c62fbd243e4d7cd4391c5b69f0b950b0c73b1f3216f0e49b03d1991c51b60a2526134534aa3c3c23479089494b4a6822013d4d85f67c94d2176536715859ef0588d8054ea7b8c82f362e01bc430e93d5761b3c1d5360a4011842845c01e7f98ab94815072bb1dc09250509a12850534afb3bf90b119113a673a4df7bf1970a1df67268b9bfe5ffa71b8c9380d03bbc367e13a0dcc665ab29095fe021c64c04475c9172b3991af678f56fcb418c872967b619df726df8d7d7149b60c0d86b67e6263ecbecde8603ba8395a2065bac20dac8775b5b7645d71f4fd3b6ddb21dac66ef50d4b55f7b38b1d2bc3ec2b30fca7d605603ed300d4585b19c890e9711236f640ea76c0f883aee248e073be86503515e093c6e27c160567d6d7bc2dc36687b211c2de8d83bf169cce5c1fd4534a5f3c5d4da7b76d16e4e5960dbe5143ac624833105be0b08a8ac2c691af64a21fa4f151ea6ae3631e48bf96d87a89f3af2b545',
  vku:
    'a9a192f10f9da4ceee548f2caed89a17dd9209461b9e7c977a852c8c9a444c37f958185265eb0985dcb86262125899bccfd3fa2799f08ce8f3cc2273e8ca4792bc51fd0d716ae7f5a76c1997eaa79a5dc10e96d1343ab1f7195b8cecf09f16a9285f5f26585b6ba3c57d735b774de9ab12d4ebdb49462f61a300afc2fee90f011ee678d5d7ac029a28d56b47928e7a59028f9f301b7d1055a8e178ffc4d72a6cfffffa7b635835c1b57590a59df5c9c43ff463eba7ef5c18797bedaf06a9ab33eb131403a2088fe7063ae81dd964f71dd2cf7c7c871d0a4b2e82cf0942391b5e9a9f72fc37081934525679f966494d56391c51bca9fe1e9903d40d1bea3ed4f3e1439ca82a2f55460ad3ff90a8fb898171efbcfd149f24202247524938dc80bcb27e794ac81fd84502cd7d1f4019095301171e2083429be6cc2f16fc62bf2cf7e8dbaa7a57a599821e960cb2adc3089c4bf9d3aed4c5e96417ada74620d84bfc6174d074985e13686d4f73b72818c02d101f46af939f2e1647503c8bdb75991233682db412dcc0a0ed991780dfecb0f9df0bb53772c079f989292e8c75e3adaac2b98684f40343c089c3646c07288c977f641f75ecb57dc1f140bdc06fcb5895b92351531c0a3824dc749a22cee03e1628a0c3edfc4eacc3cd2be74acc2b7e600910535d40a25e3c072fd31a52379ecf253b87a7e002cf0dddbe052935d66477',
  verificationKeyShare:
    '797449fb6eb991e5de9b11025cb5828084d6c64a9d80c923515b5f5e832b564e96f759f59c0744f2fff35cab113ce1038f7b0979ada78fc0d7772453c7e739e9a0bf36763b5cc34cb094fe47def247920e582c4f73b47c9a55968e4f30cbcd170cfa8ea4207ecbf80f23db83e0d8067ac595c0486afbd05445a08217535cf33c0bddbeac003ed4828edf8541f73d0f72862364f15ab3362499d96fea0d72982e56a9d80170ef3a1cbb7a5577ba1ce300daa5dd66394a13feaf2c48fa38b3d152276e8899de8104bb36e7bc954aab997b88619126472a97e367a591fc1a76e341b932d53b9d00b1c06b343e20826e146bb39c4bfa5ee54becbbf076d721f5dcd3a659b556968014e620ba856fe6abbf8105d774f3bd7ad3d0da9e1b42fb0e0daefe3dca8eab13c7beb17ff81b28a75ba25b206f2dbb8c56637eace1c5a2420dcda39720c8034a2a8aec8c483dab1ee86eef4fc3652b12377b191b9fe71ac73f8253d86c6d715f9f0cad13d3c04d1daefb7b2b59e4b275e13775fb084f4b44be11b88a4fbf990360be5cb99ead9772d4a4e74aee36e38dc7e92405e493dd0cb3bd8eab419629aae7cb3af49679dfb93a322e81f31885a9be5ba3cd1f3400298c7b6592111d9e13afee6527b1e4df3756550f723c8ef5ef72d61ac74102d617a89f8d66da9d85cf533f5c5e6f2093c42dd8744d72826dbca98ddb47a08971bf3067',
};
const shareKey2 = {
  threshold: 2,
  numParties: 3,
  bits: 4096,
  shareIndex: 2,
  publicKey: {
    n:
      'e432619c6f144563763dff22e9214bddadc9e4920fffc6ce94d3616631927cc6c4a54009ce4729c7028d7ef9dfd802677943184d2d065adae859a14a313b21d3c788bbc8c47c75418eb58018fff6266ace123ede73a45b1a50db543bdaf492924eb9f4c65fd4699f6c1f98d6b04c5ca7e0993a7d7b836ae9b5b8f2ad857c71fa8e070b70f499ad5cfa7111467dd16a7d1aad389eab26e623fcf9c751566ccaf25d0209574decfe18ba8bc1984ae10723915677fc4795c631427aac6ee60c5c7e0732c2b19d590d89e66f1ee8c820ccb5b13b5aef4c2bd47bed8076b43f4d2bf2d48bda74d2e542d75e8592d9e27fb29c6ad9493bd989df851465eafff08f5c5d7ee11601ed6a402df8ecdf4fa1d045d5aa1e65a84284c07edda669ab0decd86a51e1ffdbdd4a36defa8c0e24426d2578bcfd1b434d6fd6c14b1a2b9e1edfbe68c506a3c2d644663b1090235c62094bddfce7488073fe3b35d66ccdbd4b2d022ba318eac60c1437b31b034e4d83391f1c879a06cebfc809dc8fd8f9620313946727dffe54aa3c928893e64ffb5e21b1e87fa474c6b1d0ff10df2a913346a577fbe18664365b112891a746b889667036fe91937c8e277e677213e02233cdc872a1624d4172704b9ddafe3a75376979ba8c261b0163468d6e88d19c4bf483b72923776032c9ea1b7ea314fe4c927742d5a91eedc7eaf6fd638a420059fbdd45f979',
    e: '10001',
  },
  verificationKey:
    '745fe21854e07fb1c240eaae6a613916070225d5e009e0ff4fd0a0179e3b37e1a78625c82c6e00d578721ec29b02f41f12995b3e595279b19b3206e62157a19260b80f334eb02662a3dc4996447ab34b129fa7627400192ac957b3692f6bee6a70a019aecb525f88266c4a5b9864ce9ed504e43686055878f33a0e159c21e1d49ab55e952292dc944fbaa703c4dcf4ceac1f82f3982037ce604ebc9fd7a981c62fbd243e4d7cd4391c5b69f0b950b0c73b1f3216f0e49b03d1991c51b60a2526134534aa3c3c23479089494b4a6822013d4d85f67c94d2176536715859ef0588d8054ea7b8c82f362e01bc430e93d5761b3c1d5360a4011842845c01e7f98ab94815072bb1dc09250509a12850534afb3bf90b119113a673a4df7bf1970a1df67268b9bfe5ffa71b8c9380d03bbc367e13a0dcc665ab29095fe021c64c04475c9172b3991af678f56fcb418c872967b619df726df8d7d7149b60c0d86b67e6263ecbecde8603ba8395a2065bac20dac8775b5b7645d71f4fd3b6ddb21dac66ef50d4b55f7b38b1d2bc3ec2b30fca7d605603ed300d4585b19c890e9711236f640ea76c0f883aee248e073be86503515e093c6e27c160567d6d7bc2dc36687b211c2de8d83bf169cce5c1fd4534a5f3c5d4da7b76d16e4e5960dbe5143ac624833105be0b08a8ac2c691af64a21fa4f151ea6ae3631e48bf96d87a89f3af2b545',
  vku:
    'a9a192f10f9da4ceee548f2caed89a17dd9209461b9e7c977a852c8c9a444c37f958185265eb0985dcb86262125899bccfd3fa2799f08ce8f3cc2273e8ca4792bc51fd0d716ae7f5a76c1997eaa79a5dc10e96d1343ab1f7195b8cecf09f16a9285f5f26585b6ba3c57d735b774de9ab12d4ebdb49462f61a300afc2fee90f011ee678d5d7ac029a28d56b47928e7a59028f9f301b7d1055a8e178ffc4d72a6cfffffa7b635835c1b57590a59df5c9c43ff463eba7ef5c18797bedaf06a9ab33eb131403a2088fe7063ae81dd964f71dd2cf7c7c871d0a4b2e82cf0942391b5e9a9f72fc37081934525679f966494d56391c51bca9fe1e9903d40d1bea3ed4f3e1439ca82a2f55460ad3ff90a8fb898171efbcfd149f24202247524938dc80bcb27e794ac81fd84502cd7d1f4019095301171e2083429be6cc2f16fc62bf2cf7e8dbaa7a57a599821e960cb2adc3089c4bf9d3aed4c5e96417ada74620d84bfc6174d074985e13686d4f73b72818c02d101f46af939f2e1647503c8bdb75991233682db412dcc0a0ed991780dfecb0f9df0bb53772c079f989292e8c75e3adaac2b98684f40343c089c3646c07288c977f641f75ecb57dc1f140bdc06fcb5895b92351531c0a3824dc749a22cee03e1628a0c3edfc4eacc3cd2be74acc2b7e600910535d40a25e3c072fd31a52379ecf253b87a7e002cf0dddbe052935d66477',
  sharedKey:
    '1867bc75eed54ae2d29292434a372b8d95864f0421d43d7557ae009658cc96c2a912eeb78e5b6226914547ed015428de01756e8f653d1aa04406c7665227e4f761c33d0695bcfd68afd977021bbfd16330502dcef1747926fd1cf3746a8969ca5ca52b39ecd9a332820810c6769eb9d229661cca7c1b88f527b6cd0d38a9b7dea5977924618f28c32b724dbb42c89daa7643b66e0464302f41290ac19253ffa67103361189db47f979830b24c011efd78bcf8bbe62747339b21acd97dd3d1cf2cb5385a67fcb68e52ff73075ac4bec413e19d9c3e9b7f44fd1e80951b926f107c14d7f8ec95c9793aba9d53f34a34bc25080fc0063fa9975afd0db58db3a341d24da9f50bba12502052bb1192a6fa06a6617a0ce1b725a5be1071c1fe63cf99d509ea7593ace6f21e61af555374dbeeeff7a782a65ab8ae7b449343bb251874e3938c0aecc7c73d6918f5b559acf6ef111f777e16cb212c46d372a5e28a7ce1f994591e4c6e5d3b9bb43e390b827ecf3713b7cd32b9333af3317e883abb1ea5853017813c130126e8234f3c9e0427393e9d79451779b2263aa712822c070d3c5abe8393e6e383d679ea486b7eb5cc1d7d86546bb5582c0334eb1e15e5d06af6712601d6577815ea450b0a842fd39198909da06245e701292f8195ce9ed1dbff2ade0ff69f27ff3e755ee838331c42a2a672c6947928feb6891e2c7864011928d',
  verificationKeyShare:
    '7c1f474b717ae81a7f6e91e73119a58c1540ce9fbe8074a34a4710e5935348b9d92d48b27dbeea78b213112af059756638059626abcdab27ff00d0a52cbe34998763930bb1b3616a1e2f2cdb5b729e2f25591df64b8c74054f2247b7541382925b425c940d70bd1475502dd10b8a249cd123b92e136b216cbbc17517b3eb7258975c7bc3b395609035feea9a8e31e5436541e20326ad3c4b8c204706a963976f7b57c447d67ed65d99e607cfd282c162b89aff528934c0980b522a4952996b1389bb31f3ce4c0748d127359490b8313d4b8427fbe8799c147d2a94ecf697cd2e15a0549076b5fa828595f2a1ca5c05e0f3cd7db98207446d0e21477b47dc6bac68ca4ab26145380275b1d52cb3de8a6f5198629cba8b4ce0cf3219382892b95929fee30c5418f25097e2cacc287ce631b9de4c94fa3eb53bc2b820ede58cfb3bdc13d1c85e0bb70a57c3a4b74db1280541db1275d834065a7bdae91bd20a206de5e6ea488fdc5a054288ae06cf50e038aef47d77d94376a7743873c713f085272525af7048458d4f1d6c7be65081d09aeac3f2933dde01698a8695604a3e86eceb27d6f17c3a91618899d537fe60373b3f65369beaa8d5f2e890552ee6e7775e8ccd399f4a0921d4f546bc3c2c87648b7c60a2bf978f100e6971c3a5616d7ec3ed9f10e6571223138a9ac183af088647ba0584802848469cc1edf58bc1d35fe1',
};

describe('test rng oracle poller', async () => {
  let chain;
  let orngContract = 'orng.wax';
  let orngOracle = 'oracle.wax';
  let orngOracle2 = 'oracle2.wax';
  let orngV1Oracle = 'oraclev1.wax';
  let dappContract = 'dapp.wax';
  let node1 = 'node1';
  let requestRandContract;

  let jobService1, jobService2;
  let storage1, storage2;
  let poller1;
  let poller2;
  let rngPusher;

  before('Before all', async function() {
    this.timeout(180000);
    chain = await Chain.setupChain('WAX');
    eosRpc.endpoint = `http://127.0.0.1:${chain.port}`;

    ({
      orngContract,
      orngOracle,
      orngOracle2,
      orngV1Oracle,
      node1,
      node2,
      node3,
      node4,
      node5,
      dappContract,
      requestRandContract,
    } = await eosHelper.setupOrngContract(chain, eosRpc));
    console.log('Chain:', eosRpc.endpoint);
    storage1 = new Storage(2);
    await storage1.init('testdb1.json');
    storage2 = new Storage(2);
    await storage2.init('testdb2.json');
    jobService1 = new JobService(storage1, 1);
    jobService2 = new JobService(storage2, 2);

    const shareKeyService1 = new ShareKeyService(shareKey1);
    await shareKeyService1.initialize();

    const shareKeyService2 = new ShareKeyService(shareKey2);
    await shareKeyService2.initialize();

    rngPusher = new RngPusher();
    poller1 = new Poller(
      orngOracle.name,
      shareKeyService1,
      rngPusher,
      jobService1,
      1
    );
    poller2 = new Poller(
      orngOracle2.name,
      shareKeyService2,
      rngPusher,
      jobService2,
      2
    );
  });

  after(async () => {
    await chain.clear();
  }, 30000);

  beforeEach('After each', async function() {
    await storage1.clearAllFailedJobs();
    await storage2.clearAllFailedJobs();
  });

  afterEach('After each', async function() {
    sinon.restore();
  });

  describe('test pollJobsToSetPart', async function() {
    it('should poll and process job on poller 1', async function() {
      this.timeout(180000);
      sinon.spy(jobService1, 'getJobsToProcess');
      sinon.spy(rngPusher, 'submitPartialSignature');
      sinon.spy(jobService1, 'jobSeedFailed');

      await eosHelper.createJobs(orngContract, dappContract, 2);
      const jobs_tbl_before = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });
      expect(jobs_tbl_before.rows.length).to.equal(2);

      await poller1.pollJobsToSetPart();

      const jobs_tbl_after = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });
      expect(jobs_tbl_after.rows.length).to.equal(2);
      const completedJobs = jobs_tbl_after.rows.filter(
        j =>
          j.final_hash !==
          '0000000000000000000000000000000000000000000000000000000000000000'
      );
      expect(completedJobs.length).to.equal(2);

      expect(jobService1.getJobsToProcess.callCount).to.equal(1);
      expect(rngPusher.submitPartialSignature.callCount).to.equal(2);
    });

    it('should poll and do nothing if no available job to process', async function() {
      sinon.spy(jobService1, 'getJobsToProcess');
      sinon.spy(rngPusher, 'submitPartialSignature');
      sinon.spy(jobService1, 'jobSeedFailed');

      await poller1.pollJobsToSetPart();

      expect(jobService1.getJobsToProcess.callCount).to.equal(1);
      expect(rngPusher.submitPartialSignature.callCount).to.equal(0);
    });

    it('should poll and process job on poller 2', async function() {
      this.timeout(180000);
      sinon.spy(jobService2, 'getJobsToProcess');
      sinon.spy(rngPusher, 'submitPartialSignature');
      sinon.spy(jobService2, 'jobSeedFailed');

      const jobs_tbl_before = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });
      expect(jobs_tbl_before.rows.length).to.equal(2);

      await poller2.pollJobsToSetPart();

      const jobs_tbl_after = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });
      expect(jobs_tbl_after.rows.length).to.equal(2);
      const completedJobs = jobs_tbl_after.rows.filter(
        j =>
          j.final_hash !==
          '0000000000000000000000000000000000000000000000000000000000000000'
      );
      expect(completedJobs.length).to.equal(2);

      expect(jobService2.getJobsToProcess.callCount).to.equal(1);
      expect(rngPusher.submitPartialSignature.callCount).to.equal(2);
    });
  });

  describe('test pollJobsToExecute', async function() {
    it('should execute jobs if node is resolver', async function() {
      this.timeout(180000);

      sinon.spy(jobService1, 'getJobsToExecute');
      sinon.spy(rngPusher, 'setRandomNumber');

      await poller1.pollJobsToExecute();

      await chain.waitTillNextBlock(15);

      expect(jobService1.getJobsToExecute.callCount).to.equal(1);
      expect(rngPusher.setRandomNumber.callCount).to.equal(2);

      const jobs_tbl_after = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
        limit: 1000,
      });
      console.log(jobs_tbl_after.rows);
      expect(jobs_tbl_after.rows.length).to.equal(0);
    });
  });

  describe('test request fail', async function() {
    it('should markfailed if request is failed', async function() {
      this.timeout(180000);

      sinon.spy(jobService1, 'getJobsToProcess');
      sinon.spy(rngPusher, 'submitPartialSignature');
      sinon.spy(jobService1, 'jobSeedFailed');

      // await eosHelper.createJobs(orngContract, dappContract, 2);
      await requestRandContract.contract.action.requestfail(
        {
          signing_value: 1001,
        },
        [
          {
            actor: requestRandContract.name,
            permission: 'active',
          },
        ]
      );
      const jobs_tbl_before = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });
      expect(jobs_tbl_before.rows.length).to.equal(1);

      await poller1.pollJobsToSetPart();
      await poller2.pollJobsToSetPart();

      //process set rand on poller 1
      await poller1.pollJobsToExecute();

      const jobs_tbl_after = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });

      expect(jobs_tbl_after.rows.length).to.equal(0);

      const undeliveredJobs = await orngContract.contract.table[
        'undelivered1'
      ].get({
        scope: orngContract.name,
      });

      expect(undeliveredJobs.rows.length).to.equal(1);
    });

    // Regression coverage for WBP-1953: the oracle must read the renamed
    // on-chain table ("undelivered1"). Before the fix it queried "undelivered"
    // (now the empty undelivered_old table), so retry delivery silently found
    // nothing. This drives the actual retry path end-to-end.
    it('should read undelivered1 and drive retry delivery (WBP-1953)', async function() {
      this.timeout(180000);

      // The failed request from the previous test is recorded on-chain.
      const onChain = await orngContract.contract.table['undelivered1'].get({
        scope: orngContract.name,
      });
      expect(onChain.rows.length).to.equal(1);
      const requestId = onChain.rows[0].request_id;

      // The oracle's query path must surface that row. With the wrong table
      // name this returns [] and the assertion below fails.
      const jobsToRetry = await jobService1.getJobsToRetryDeliver();
      expect(jobsToRetry.length).to.equal(1);
      expect(String(jobsToRetry[0].request_id)).to.equal(String(requestId));

      // Drive the full poller retry loop; stub the on-chain push so the test
      // asserts the oracle attempts redelivery for the job it read.
      const retryStub = sinon
        .stub(rngPusher, 'retryDeliver')
        .resolves({ transactionId: 'stub', tx: {} });

      await poller1.pollJobToRetryDeliver();

      expect(retryStub.calledOnce).to.equal(true);
      expect(String(retryStub.firstCall.args[1])).to.equal(String(requestId));
    });

    it('should call contract cleanup', async function() {
      this.timeout(180000);

      sinon.spy(rngPusher, 'cleanup');
      await poller1.cleanupDelivered();
      expect(rngPusher.cleanup.callCount).to.equal(1);
    });
  });
});
