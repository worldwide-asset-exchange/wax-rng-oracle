const { expect } = require('chai');
const {
  shuffleArray,
  generateDailySeed,
  SeededRandom,
} = require('../lib/utils/shuffle');

describe('Shuffle Utility Tests', () => {
  describe('SeededRandom', () => {
    it('should generate deterministic random numbers with same seed', () => {
      const rng1 = new SeededRandom(12345);
      const rng2 = new SeededRandom(12345);

      const sequence1 = [rng1.next(), rng1.next(), rng1.next()];
      const sequence2 = [rng2.next(), rng2.next(), rng2.next()];

      expect(sequence1).to.deep.equal(sequence2);
    });

    it('should generate different sequences with different seeds', () => {
      const rng1 = new SeededRandom(12345);
      const rng2 = new SeededRandom(54321);

      const sequence1 = [rng1.next(), rng1.next(), rng1.next()];
      const sequence2 = [rng2.next(), rng2.next(), rng2.next()];

      expect(sequence1).to.not.deep.equal(sequence2);
    });

    it('should generate numbers between 0 and 1', () => {
      const rng = new SeededRandom(12345);

      for (let i = 0; i < 100; i++) {
        const value = rng.next();
        expect(value).to.be.at.least(0);
        expect(value).to.be.at.most(1);
      }
    });
  });

  describe('shuffleArray', () => {
    it('should return a new array with same length', () => {
      const original = [1, 2, 3, 4, 5];
      const shuffled = shuffleArray(original, 12345);

      expect(shuffled).to.have.lengthOf(original.length);
      expect(shuffled).to.not.equal(original); // Different array reference
    });

    it('should contain all original elements', () => {
      const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const shuffled = shuffleArray(original, 12345);

      expect(shuffled.sort()).to.deep.equal(original.sort());
    });

    it('should produce deterministic results with same seed', () => {
      const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const shuffled1 = shuffleArray(original, 12345);
      const shuffled2 = shuffleArray(original, 12345);

      expect(shuffled1).to.deep.equal(shuffled2);
    });

    it('should produce different results with different seeds', () => {
      const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const shuffled1 = shuffleArray(original, 12345);
      const shuffled2 = shuffleArray(original, 54321);

      expect(shuffled1).to.not.deep.equal(shuffled2);
    });

    it('should handle empty array', () => {
      const original = [];
      const shuffled = shuffleArray(original, 12345);

      expect(shuffled).to.deep.equal([]);
    });

    it('should handle single element array', () => {
      const original = [42];
      const shuffled = shuffleArray(original, 12345);

      expect(shuffled).to.deep.equal([42]);
    });

    it('should work without seed (non-deterministic)', () => {
      const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const shuffled = shuffleArray(original);

      expect(shuffled).to.have.lengthOf(original.length);
      expect(shuffled.sort()).to.deep.equal(original.sort());
    });

    it('should throw TypeError for non-array input', () => {
      expect(() => shuffleArray('not an array', 12345)).to.throw(TypeError);
      expect(() => shuffleArray(123, 12345)).to.throw(TypeError);
      expect(() => shuffleArray(null, 12345)).to.throw(TypeError);
    });

    it('should handle arrays with objects', () => {
      const original = [
        { id: 1, name: 'job1' },
        { id: 2, name: 'job2' },
        { id: 3, name: 'job3' },
      ];
      const shuffled = shuffleArray(original, 12345);

      expect(shuffled).to.have.lengthOf(3);
      expect(shuffled).to.include.members(original);
    });
  });

  describe('generateDailySeed', () => {
    it('should generate consistent seed for same keyIndex on same day', () => {
      const seed1 = generateDailySeed(1);
      const seed2 = generateDailySeed(1);

      expect(seed1).to.equal(seed2);
    });

    it('should generate different seeds for different keyIndex values', () => {
      const seed1 = generateDailySeed(1);
      const seed2 = generateDailySeed(2);
      const seed3 = generateDailySeed(3);

      expect(seed1).to.not.equal(seed2);
      expect(seed2).to.not.equal(seed3);
      expect(seed1).to.not.equal(seed3);
    });

    it('should generate different seeds for different processModulus values', () => {
      const seed1 = generateDailySeed(1, 0);
      const seed2 = generateDailySeed(1, 1);
      const seed3 = generateDailySeed(1, 2);

      expect(seed1).to.not.equal(seed2);
      expect(seed2).to.not.equal(seed3);
      expect(seed1).to.not.equal(seed3);
    });

    it('should generate different seeds for same keyIndex but different processModulus', () => {
      const seed1a = generateDailySeed(1, 0);
      const seed1b = generateDailySeed(1, 1);
      const seed2a = generateDailySeed(2, 0);
      const seed2b = generateDailySeed(2, 1);

      // Same keyIndex, different modulus
      expect(seed1a).to.not.equal(seed1b);
      expect(seed2a).to.not.equal(seed2b);

      // Different keyIndex, same modulus
      expect(seed1a).to.not.equal(seed2a);
      expect(seed1b).to.not.equal(seed2b);
    });

    it('should default to 0 when processModulus is undefined', () => {
      const seed1 = generateDailySeed(1);
      const seed2 = generateDailySeed(1, 0);

      expect(seed1).to.equal(seed2);
    });

    it('should throw TypeError for invalid keyIndex', () => {
      expect(() => generateDailySeed(0)).to.throw(TypeError);
      expect(() => generateDailySeed(-1)).to.throw(TypeError);
      expect(() => generateDailySeed(1.5)).to.throw(TypeError);
      expect(() => generateDailySeed('1')).to.throw(TypeError);
    });

    it('should generate positive integer seeds', () => {
      for (let i = 1; i <= 10; i++) {
        const seed = generateDailySeed(i);
        expect(seed).to.be.a('number');
        expect(seed).to.be.above(0);
        expect(Number.isInteger(seed)).to.be.true;
      }
    });

    it('should generate positive integer seeds with processModulus', () => {
      for (let i = 1; i <= 10; i++) {
        for (let m = 0; m < 5; m++) {
          const seed = generateDailySeed(i, m);
          expect(seed).to.be.a('number');
          expect(seed).to.be.above(0);
          expect(Number.isInteger(seed)).to.be.true;
        }
      }
    });
  });

  describe('Collision reduction simulation', () => {
    it('should demonstrate different oracles get different job orders', () => {
      const jobs = [];
      for (let i = 1; i <= 20; i++) {
        jobs.push({ id: i, seed: `seed${i}` });
      }

      // Simulate 3 different oracle nodes
      const oracle1Jobs = shuffleArray(jobs, generateDailySeed(1));
      const oracle2Jobs = shuffleArray(jobs, generateDailySeed(2));
      const oracle3Jobs = shuffleArray(jobs, generateDailySeed(3));

      // First jobs selected by each oracle should likely be different
      expect(oracle1Jobs[0].id).to.not.equal(oracle2Jobs[0].id);
      expect(oracle2Jobs[0].id).to.not.equal(oracle3Jobs[0].id);

      // All oracles should have all jobs (no loss)
      expect(oracle1Jobs.map(j => j.id).sort()).to.deep.equal(
        jobs.map(j => j.id).sort()
      );
      expect(oracle2Jobs.map(j => j.id).sort()).to.deep.equal(
        jobs.map(j => j.id).sort()
      );
      expect(oracle3Jobs.map(j => j.id).sort()).to.deep.equal(
        jobs.map(j => j.id).sort()
      );
    });

    it('should show different selection patterns over first 5 jobs', () => {
      const jobs = [];
      for (let i = 1; i <= 20; i++) {
        jobs.push({ id: i });
      }

      const oracle1Top5 = shuffleArray(jobs, generateDailySeed(1))
        .slice(0, 5)
        .map(j => j.id);
      const oracle2Top5 = shuffleArray(jobs, generateDailySeed(2))
        .slice(0, 5)
        .map(j => j.id);
      const oracle3Top5 = shuffleArray(jobs, generateDailySeed(3))
        .slice(0, 5)
        .map(j => j.id);

      // At least some jobs in top 5 should be different
      const allSame =
        JSON.stringify(oracle1Top5) === JSON.stringify(oracle2Top5) &&
        JSON.stringify(oracle2Top5) === JSON.stringify(oracle3Top5);

      expect(allSame).to.be.false;
    });

    it('should demonstrate cluster mode workers get different job orders', () => {
      const jobs = [];
      for (let i = 1; i <= 20; i++) {
        jobs.push({ id: i, seed: `seed${i}` });
      }

      // Simulate same oracle (keyIndex=1) with 4 cluster workers (modulus 0-3)
      const worker0Jobs = shuffleArray(jobs, generateDailySeed(1, 0));
      const worker1Jobs = shuffleArray(jobs, generateDailySeed(1, 1));
      const worker2Jobs = shuffleArray(jobs, generateDailySeed(1, 2));
      const worker3Jobs = shuffleArray(jobs, generateDailySeed(1, 3));

      // First jobs selected by each worker should be different
      const firstJobs = [
        worker0Jobs[0].id,
        worker1Jobs[0].id,
        worker2Jobs[0].id,
        worker3Jobs[0].id,
      ];
      const uniqueFirstJobs = [...new Set(firstJobs)];
      expect(uniqueFirstJobs.length).to.be.at.least(2); // At least 2 different

      // All workers should have all jobs (no loss)
      const sortedIds = jobs.map(j => j.id).sort();
      expect(worker0Jobs.map(j => j.id).sort()).to.deep.equal(sortedIds);
      expect(worker1Jobs.map(j => j.id).sort()).to.deep.equal(sortedIds);
      expect(worker2Jobs.map(j => j.id).sort()).to.deep.equal(sortedIds);
      expect(worker3Jobs.map(j => j.id).sort()).to.deep.equal(sortedIds);
    });

    it('should demonstrate different oracles with cluster mode all get unique patterns', () => {
      const jobs = [];
      for (let i = 1; i <= 20; i++) {
        jobs.push({ id: i });
      }

      // Simulate 2 oracles, each with 2 cluster workers
      const oracle1worker0 = shuffleArray(jobs, generateDailySeed(1, 0));
      const oracle1worker1 = shuffleArray(jobs, generateDailySeed(1, 1));
      const oracle2worker0 = shuffleArray(jobs, generateDailySeed(2, 0));
      const oracle2worker1 = shuffleArray(jobs, generateDailySeed(2, 1));

      const firstJobs = [
        oracle1worker0[0].id,
        oracle1worker1[0].id,
        oracle2worker0[0].id,
        oracle2worker1[0].id,
      ];

      // All 4 combinations should ideally have different first selections
      const uniqueFirstJobs = [...new Set(firstJobs)];
      expect(uniqueFirstJobs.length).to.be.at.least(2);
    });
  });
});
