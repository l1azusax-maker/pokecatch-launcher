'use strict';

async function mapLimit(items, limit, worker) {
  const list = Array.from(items || []);
  if (list.length === 0) return [];
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length));
  const results = new Array(list.length);
  let cursor = 0;

  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, run));
  return results;
}

module.exports = { mapLimit };
