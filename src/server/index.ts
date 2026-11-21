import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort, reddit, redis } from '@devvit/web/server';
import {
  communityKarma,
  getPageWindow,
  rankFromAscendingIndex,
  recordUniqueActivity,
  getHistoricalPostIds,
} from '../shared/leaderboard.ts';

const app = new Hono();

const LEADERBOARD_KEY = 'karma:leaderboard:v1';
const USERS_KEY = 'karma:users:v1';
const POST_QUEUE_KEY = 'karma:backfill:posts:v1';
const POST_CURSOR_KEY = 'karma:backfill:cursor:v1';
const SCAN_STATUS_KEY = 'karma:scan:status:v1';
const SCAN_RUN_KEY = 'karma:scan:run-id:v1';
const SCAN_ATTEMPTS_PREFIX = 'karma:scan:attempts:v1:';
const LEADERBOARD_POST_KEY = 'karma:leaderboard:post-id:v1';
const ACTIVITY_COUNTS_KEY_PREFIX = 'karma:activity-counts:v1:';
const BATCH_POSTS = 6;
const BATCH_USERS = 40;

type UserStats = {
  username: string;
  postKarma: number;
  commentKarma: number;
  totalKarma: number;
  posts: number;
  comments: number;
  lastUpdated: string;
};

type ScanStatus = {
  state: 'idle' | 'scanning' | 'complete';
  scanned: number;
  total: number;
  failed?: number;
};

type BackfillBatchResult = {
  done: boolean;
  scanned: number;
  total: number;
  processed: number;
  failed: number;
  retryingPost?: string;
};

type PostId = `t3_${string}`;

function asPostId(value: string): PostId {
  if (!value.startsWith('t3_')) throw new Error('Invalid Reddit post ID.');
  return value as PostId;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function cleanUsername(value: unknown): string {
  if (typeof value !== 'string') return '';
  const name = value.trim().replace(/^u\//i, '');
  if (!name || name === '[deleted]' || name === 'deleted' || name.toLowerCase() === 'automoderator') return '';
  return name;
}

function readItemId(itemValue: unknown): string {
  const item = asRecord(itemValue);
  return typeof item.id === 'string' ? item.id : '';
}

type CommentId = `t1_${string}`;

function asCommentId(value: string): CommentId {
  if (!value.startsWith('t1_')) throw new Error('Invalid Reddit comment ID.');
  return value as CommentId;
}

async function assertSubredditModerator(subredditName: string): Promise<void> {
  const currentUser = await reddit.getCurrentUser();
  if (!currentUser) throw new Error('Sign in with a moderator account to set up the leaderboard.');
  const permissions = await currentUser.getModPermissionsForSubreddit(subredditName);
  if (!permissions || permissions.length === 0) {
    throw new Error('The account setting up the leaderboard must be a moderator of this subreddit.');
  }
}

function profileKey(username: string): string {
  return 'karma:user:' + username.toLowerCase();
}

function seenKey(kind: 'post' | 'comment'): string {
  return 'karma:seen:' + kind + ':v1';
}

function activityCountsKey(username: string): string {
  return ACTIVITY_COUNTS_KEY_PREFIX + username.toLowerCase();
}

async function getUserStats(username: string): Promise<UserStats | null> {
  const raw = await redis.get(profileKey(username));
  if (!raw) return null;
  let stats: UserStats;
  try {
    stats = JSON.parse(raw) as UserStats;
  } catch {
    return null;
  }

  const [posts, comments] = await redis.hMGet(activityCountsKey(username), ['posts', 'comments']);
  return {
    ...stats,
    posts: posts === null ? stats.posts : Number(posts),
    comments: comments === null ? stats.comments : Number(comments),
  };
}

async function saveUserStats(stats: UserStats): Promise<void> {
  await redis.set(profileKey(stats.username), JSON.stringify(stats));
}

async function ensureCandidate(usernameValue: unknown): Promise<string> {
  const username = cleanUsername(usernameValue);
  if (!username) return '';
  await redis.zAdd(USERS_KEY, { member: username, score: 0 });
  return username;
}

async function refreshCommunityKarma(usernameValue: unknown): Promise<boolean> {
  const username = await ensureCandidate(usernameValue);
  if (!username) return false;

  try {
    const result = await reddit.getUserKarmaFromCurrentSubreddit(username);
    const prior = await getUserStats(username);
    const totalKarma = communityKarma(result?.fromPosts, result?.fromComments);
    if (totalKarma === null) {
      console.error('Reddit returned invalid subreddit karma for ' + username + '.');
      return false;
    }

    const stats: UserStats = {
      username,
      postKarma: result?.fromPosts ?? 0,
      commentKarma: result?.fromComments ?? 0,
      totalKarma,
      posts: prior?.posts ?? 0,
      comments: prior?.comments ?? 0,
      lastUpdated: new Date().toISOString(),
    };

    await saveUserStats(stats);
    await redis.zAdd(LEADERBOARD_KEY, { member: username, score: stats.totalKarma });
    return true;
  } catch (error) {
    console.error('Could not retrieve subreddit karma for ' + username + ':', error);
    return false;
  }
}

async function recordActivity(kind: 'post' | 'comment', itemId: string, usernameValue: unknown): Promise<void> {
  const username = await ensureCandidate(usernameValue);
  if (!username || !itemId) return;

  const countKey = activityCountsKey(username);
  // Initialize the counters once, then only increment the relevant Redis hash.
  // getUserStats() reads these hashes when it renders the leaderboard, so saving
  // the whole profile for every historical comment is unnecessary and expensive.
  await Promise.all([
    redis.hSetNX(countKey, 'posts', '0'),
    redis.hSetNX(countKey, 'comments', '0'),
  ]);

  await recordUniqueActivity(
    () => redis.zAdd(seenKey(kind), { member: itemId, score: 1 }),
    async () => {
      const field = kind === 'post' ? 'posts' : 'comments';
      await redis.hIncrBy(countKey, field, 1);
    },
  );
}

async function readScanStatus(): Promise<ScanStatus> {
  const raw = await redis.get(SCAN_STATUS_KEY);
  if (!raw) return { state: 'idle', scanned: 0, total: 0 };
  try {
    return JSON.parse(raw) as ScanStatus;
  } catch {
    return { state: 'idle', scanned: 0, total: 0 };
  }
}

async function refreshKnownUsersBatch(): Promise<number> {
  const total = await redis.zCard(USERS_KEY);
  if (total === 0) return 0;

  const cursorRaw = Number(await redis.get('karma:refresh:cursor:v1') ?? '0');
  const start = Number.isFinite(cursorRaw) && cursorRaw >= 0 && cursorRaw < total ? cursorRaw : 0;
  const stop = Math.min(start + BATCH_USERS - 1, total - 1);
  const users = await redis.zRange(USERS_KEY, start, stop, { by: 'rank' });

  for (let i = 0; i < users.length; i += 5) {
    const group = users.slice(i, i + 5);
    await Promise.all(group.map((user) => refreshCommunityKarma(user.member)));
  }

  const nextCursor = start + users.length >= total ? 0 : start + users.length;
  await redis.set('karma:refresh:cursor:v1', String(nextCursor));
  return users.length;
}

async function processBackfillBatch(): Promise<BackfillBatchResult> {
  const queueRaw = await redis.get(POST_QUEUE_KEY);
  const priorStatus = await readScanStatus();

  if (!queueRaw) {
    return {
      done: priorStatus.state !== 'scanning',
      scanned: priorStatus.scanned,
      total: priorStatus.total,
      processed: 0,
      failed: priorStatus.failed ?? 0,
    };
  }

  const postIds = JSON.parse(queueRaw) as string[];
  const cursorValue = Number(await redis.get(POST_CURSOR_KEY) ?? '0');
  let cursor = Number.isInteger(cursorValue) && cursorValue >= 0 ? cursorValue : 0;
  let processed = 0;
  let failed = priorStatus.failed ?? 0;
  const runId = await redis.get(SCAN_RUN_KEY) ?? 'legacy';
  const attemptsKey = SCAN_ATTEMPTS_PREFIX + runId;
  const end = Math.min(cursor + BATCH_POSTS, postIds.length);

  for (let index = cursor; index < end; index += 1) {
    const postId = postIds[index];
    try {
      // This historical lookup is independent of app-install time. It loads
      // older posts from Reddit's existing subreddit listing, then their comments.
      const post = await reddit.getPostById(asPostId(postId));
      await recordActivity('post', post.id, post.authorName);

      const comments = await reddit.getComments({
        postId: asPostId(postId),
        limit: 1000,
        pageSize: 100,
      }).all();

      // Keep Redis writes concurrent but bounded so large historical threads
      // do not exceed the server request time limit.
      for (let offset = 0; offset < comments.length; offset += 25) {
        const chunk = comments.slice(offset, offset + 25);
        await Promise.all(chunk.map((comment) =>
          recordActivity('comment', comment.id, comment.authorName),
        ));
      }

      cursor = index + 1;
      processed += 1;
      await redis.set(POST_CURSOR_KEY, String(cursor));
      await redis.set(SCAN_STATUS_KEY, JSON.stringify({
        state: 'scanning',
        scanned: cursor,
        total: postIds.length,
        failed,
      } satisfies ScanStatus));
    } catch (error) {
      const attempts = await redis.hIncrBy(attemptsKey, postId, 1);
      console.error('Historical scan could not process post ' + postId + ' (attempt ' + attempts + ' of 3):', error);

      // Leave the cursor on this post so the next scheduled or manual batch retries it.
      // Activity IDs are de-duplicated, so retrying a partially read thread is safe.
      if (attempts < 3) {
        await redis.set(SCAN_STATUS_KEY, JSON.stringify({
          state: 'scanning',
          scanned: cursor,
          total: postIds.length,
          failed,
        } satisfies ScanStatus));
        if (processed > 0) {
          await refreshKnownUsersBatch();
        }
        return {
          done: false,
          scanned: cursor,
          total: postIds.length,
          processed,
          failed,
          retryingPost: postId,
        };
      }

      // After three attempts, move past a permanently unavailable/deleted post
      // so one broken item cannot block the whole subreddit history scan.
      failed += 1;
      cursor = index + 1;
      await redis.set(POST_CURSOR_KEY, String(cursor));
      await redis.set(SCAN_STATUS_KEY, JSON.stringify({
        state: 'scanning',
        scanned: cursor,
        total: postIds.length,
        failed,
      } satisfies ScanStatus));
    }
  }

  if (processed > 0) {
    // During playtests a moderator can advance the scan manually; refresh a
    // bounded slice of discovered users here as well as via the recurring task.
    await refreshKnownUsersBatch();
  }

  const done = cursor >= postIds.length;
  await redis.set(SCAN_STATUS_KEY, JSON.stringify({
    state: done ? 'complete' : 'scanning',
    scanned: cursor,
    total: postIds.length,
    failed,
  } satisfies ScanStatus));

  if (done) {
    await redis.del(POST_QUEUE_KEY);
  }

  return { done, scanned: cursor, total: postIds.length, processed, failed };
}

async function currentViewer(): Promise<{ username: string; rank: number | null; karma: number } | null> {
  let username = '';
  try {
    username = cleanUsername(await reddit.getCurrentUsername());
  } catch {
    return null;
  }
  if (!username) return null;

  let stats = await getUserStats(username);
  let ascendingRank = await redis.zRank(LEADERBOARD_KEY, username);

  // Include a viewer with existing subreddit karma even if they were outside
  // the initial backfill window, but do not add zero-activity readers to the board.
  if (!stats && (ascendingRank === null || ascendingRank === undefined)) {
    try {
      const ownKarma = await reddit.getUserKarmaFromCurrentSubreddit(username);
      const totalKarma = communityKarma(ownKarma?.fromPosts, ownKarma?.fromComments);
      if (totalKarma !== null && totalKarma !== 0) {
        await refreshCommunityKarma(username);
        stats = await getUserStats(username);
        ascendingRank = await redis.zRank(LEADERBOARD_KEY, username);
      }
    } catch {
      // If Reddit cannot return the viewer's own community karma, keep the footer unranked.
    }
  }

  const count = await redis.zCard(LEADERBOARD_KEY);
  const rank = rankFromAscendingIndex(count, ascendingRank);

  return {
    username,
    rank,
    karma: stats?.totalKarma ?? 0,
  };
}

app.get('/api/leaderboard', async (c) => {
  try {
    const rawPage = Number.parseInt(c.req.query('page') ?? '0', 10);
    const totalUsers = await redis.zCard(LEADERBOARD_KEY);
    const { page, pageCount, start, stop } = getPageWindow(totalUsers, rawPage);

    const members = totalUsers > 0
      ? await redis.zRange(LEADERBOARD_KEY, start, stop, { by: 'rank', reverse: true })
      : [];

    const rows = await Promise.all(members.map(async (member, index) => {
      const username = member.member;
      const stats = await getUserStats(username);
      return {
        username,
        karma: stats?.totalKarma ?? Number(member.score),
        postKarma: stats?.postKarma ?? 0,
        commentKarma: stats?.commentKarma ?? 0,
        posts: stats?.posts ?? 0,
        comments: stats?.comments ?? 0,
        rank: start + index + 1,
      };
    }));

    const viewer = await currentViewer();
    const scan = await readScanStatus();
    let subreddit = 'this subreddit';
    try {
      const current = await reddit.getCurrentSubreddit();
      subreddit = current.name;
    } catch {
      // The subreddit name is cosmetic; the ranking data can still be displayed.
    }

    const lastUpdated = rows.length
      ? (await getUserStats(rows[0].username))?.lastUpdated ?? null
      : null;

    return c.json({
      subreddit,
      page,
      pageCount,
      totalUsers,
      rows,
      viewer,
      scan,
      lastUpdated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown leaderboard error';
    console.error('Karma leaderboard request failed:', message);
    return c.json({ error: message }, 500);
  }
});

app.post('/internal/menu/create-leaderboard', async (c) => {
  try {
    const subreddit = await reddit.getCurrentSubreddit();
    const subredditName = subreddit.name;
    await assertSubredditModerator(subredditName);

    const existingId = await redis.get(LEADERBOARD_POST_KEY);
    let post = existingId ? await reddit.getPostById(asPostId(existingId)) : null;

    if (!post) {
      post = await reddit.submitCustomPost({
        subredditName,
        title: '🏆 r/' + subredditName + ' Karma Leaderboard',
        entry: 'default',
        textFallback: {
          text: 'Subreddit-specific karma leaderboard for r/' + subredditName + '. Scores use post karma and comment karma from this subreddit only.',
        },
      });
      await redis.set(LEADERBOARD_POST_KEY, post.id);
    }

    // Sticky slots are shared by the whole subreddit. Never take slot 1 from
    // another community post; remove only this app's pin if an older version set it.
    if (post.stickied) {
      await post.unsticky();
    }

    const posts = await reddit.getNewPosts({
      subredditName,
      limit: 1000,
      pageSize: 100,
    }).all();

    const postIds = getHistoricalPostIds(posts, post.id);
    const runId = Date.now().toString();
    await redis.set(SCAN_RUN_KEY, runId);
    await redis.set(POST_QUEUE_KEY, JSON.stringify(postIds));
    await redis.set(POST_CURSOR_KEY, '0');
    await redis.set(SCAN_STATUS_KEY, JSON.stringify({
      state: postIds.length > 0 ? 'scanning' : 'complete',
      scanned: 0,
      total: postIds.length,
      failed: 0,
    } satisfies ScanStatus));

    // Process the first page immediately so the initial historical scan does
    // not depend on waiting for a cron tick in a playtest.
    const firstBatch = await processBackfillBatch();
    const message = firstBatch.done
      ? 'Leaderboard ready. Historical scan checked ' + firstBatch.scanned + ' older posts; ' + firstBatch.failed + ' could not be read.'
      : 'Historical scan started: ' + firstBatch.scanned + ' of ' + firstBatch.total + ' posts checked. Use Continue Historical Scan to process another batch; automatic refresh also continues in production.';

    return c.json({
      showToast: {
        text: message,
        appearance: 'success',
      },
    });
  } catch (error) {
    console.error('Could not create or scan the karma leaderboard:', error);
    return c.json({
      showToast: {
        text: 'Could not start the historical scan. Confirm moderator access and check the playtest logs.',
        appearance: 'neutral',
      },
    });
  }
});

app.post('/internal/menu/continue-scan', async (c) => {
  try {
    const subreddit = await reddit.getCurrentSubreddit();
    await assertSubredditModerator(subreddit.name);

    const status = await readScanStatus();
    if (status.state !== 'scanning') {
      return c.json({
        showToast: {
          text: status.state === 'complete'
            ? 'The historical scan is already complete.'
            : 'No historical scan is queued. Choose Create / Refresh Karma Leaderboard first.',
          appearance: 'neutral',
        },
      });
    }

    const progress = await processBackfillBatch();
    const text = progress.retryingPost
      ? 'Could not read post ' + progress.retryingPost + '. It will be retried automatically; progress is ' + progress.scanned + ' of ' + progress.total + '.'
      : progress.done
        ? 'Historical scan complete: ' + progress.scanned + ' posts checked; ' + progress.failed + ' unavailable posts skipped.'
        : 'Historical scan progress: ' + progress.scanned + ' of ' + progress.total + ' posts checked. Run Continue Historical Scan again for the next batch.';

    return c.json({
      showToast: {
        text,
        appearance: progress.retryingPost ? 'neutral' : 'success',
      },
    });
  } catch (error) {
    console.error('Could not continue the historical scan:', error);
    return c.json({
      showToast: {
        text: 'Could not continue the scan. Confirm moderator access and check the playtest logs.',
        appearance: 'neutral',
      },
    });
  }
});

app.post('/internal/scheduler/backfill', async (c) => {
  try {
    const result = await processBackfillBatch();
    return c.json({ status: 'ok', ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown backfill error';
    console.error('Karma leaderboard backfill failed:', message);
    return c.json({ status: 'error', error: message }, 500);
  }
});

app.post('/internal/scheduler/refresh-karma', async (c) => {
  try {
    const refreshed = await refreshKnownUsersBatch();
    const knownUsers = await redis.zCard(USERS_KEY);
    return c.json({ status: 'ok', refreshed, knownUsers });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown karma refresh error';
    console.error('Karma leaderboard refresh failed:', message);
    return c.json({ status: 'error', error: message }, 500);
  }
});

app.post('/internal/triggers/post-create', async (c) => {
  try {
    const payload = await c.req.json() as Record<string, unknown>;
    const postSnapshot = asRecord(payload.post);
    const id = readItemId(postSnapshot);
    if (!id) return c.json({ status: 'ignored' });
    // Re-fetch the post instead of trusting a public trigger payload's author field.
    const post = await reddit.getPostById(asPostId(id));
    const username = cleanUsername(post.authorName);
    await recordActivity('post', post.id, username);
    if (username) await refreshCommunityKarma(username);
    return c.json({ status: 'ok' });
  } catch (error) {
    console.error('Post-create trigger failed:', error);
    return c.json({ status: 'error' }, 500);
  }
});

app.post('/internal/triggers/comment-create', async (c) => {
  try {
    const payload = await c.req.json() as Record<string, unknown>;
    const commentSnapshot = asRecord(payload.comment);
    const id = readItemId(commentSnapshot);
    if (!id) return c.json({ status: 'ignored' });
    // Re-fetch the comment instead of trusting a public trigger payload's author field.
    const comment = await reddit.getCommentById(asCommentId(id));
    const username = cleanUsername(comment.authorName);
    await recordActivity('comment', comment.id, username);
    if (username) await refreshCommunityKarma(username);
    return c.json({ status: 'ok' });
  } catch (error) {
    console.error('Comment-create trigger failed:', error);
    return c.json({ status: 'error' }, 500);
  }
});

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
