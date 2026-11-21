import assert from 'node:assert/strict';
import test from 'node:test';
import {
  communityKarma,
  getPageWindow,
  rankFromAscendingIndex,
  recordUniqueActivity,
  getHistoricalPostIds,
} from '../src/shared/leaderboard.ts';

test('community karma adds subreddit post and comment karma, including negative scores', () => {
  assert.equal(communityKarma(12, 8), 20);
  assert.equal(communityKarma(-3, 5), 2);
  assert.equal(communityKarma(undefined, 5), 5);
  assert.equal(communityKarma(Number.NaN, 5), null);
});

test('page window clamps requested pages and handles an empty leaderboard', () => {
  assert.deepEqual(getPageWindow(23, 1), { page: 1, pageCount: 3, start: 10, stop: 19 });
  assert.deepEqual(getPageWindow(23, 99), { page: 2, pageCount: 3, start: 20, stop: 22 });
  assert.deepEqual(getPageWindow(0, -1), { page: 0, pageCount: 1, start: 0, stop: -1 });
});

test('viewer rank converts ascending Redis indexes to descending leaderboard ranks', () => {
  assert.equal(rankFromAscendingIndex(100, 0), 100);
  assert.equal(rankFromAscendingIndex(100, 99), 1);
  assert.equal(rankFromAscendingIndex(100, undefined), null);
  assert.equal(rankFromAscendingIndex(100, 1.5), null);
});

test('duplicate activity deliveries only apply the activity once', async () => {
  const seen = new Set();
  let count = 0;
  const itemId = 't3_unique-post';
  const markSeen = async () => {
    if (seen.has(itemId)) return 0;
    seen.add(itemId);
    return 1;
  };
  const onNewActivity = async () => { count += 1; };

  await Promise.all([
    recordUniqueActivity(markSeen, onNewActivity),
    recordUniqueActivity(markSeen, onNewActivity),
    recordUniqueActivity(markSeen, onNewActivity),
  ]);

  assert.equal(count, 1);
});


test('historical scan includes posts that predate app installation and skips its own leaderboard post', () => {
  const posts = [
    { id: 't3_old_post' },
    { id: 't3_board_post' },
    { id: 't3_recent_post' },
    { id: 't3_old_post' },
  ];
  assert.deepEqual(
    getHistoricalPostIds(posts, 't3_board_post'),
    ['t3_old_post', 't3_recent_post'],
  );
});
