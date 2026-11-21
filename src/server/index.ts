import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort, reddit, redis } from '@devvit/web/server';
import {
  communityKarma,
  getPageWindow,
  rankFromAscendingIndex,
  recordUniqueActivity,
} from '../shared/leaderboard.ts';

const app = new Hono();

const LEADERBOARD_KEY = 'karma:leaderboard:v1';
const USERS_KEY = 'karma:users:v1';
const POST_QUEUE_KEY = 'karma:backfill:posts:v1';
const POST_CURSOR_KEY = 'karma:backfill:cursor:v1';
const SCAN_STATUS_KEY = 'karma:scan:status:v1';
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

  const prior = await getUserStats(username);
  const countKey = activityCountsKey(username);
  await redis.hSetNX(countKey, 'posts', String(prior?.posts ?? 0));
  await redis.hSetNX(countKey, 'comments', String(prior?.comments ?? 0));

  await recordUniqueActivity(
    () => redis.zAdd(seenKey(kind), { member: itemId, score: 1 }),
    async () => {
      const field = kind === 'post' ? 'posts' : 'comments';
      await redis.hIncrBy(countKey, field, 1);
      const [posts, comments] = await redis.hMGet(countKey, ['posts', 'comments']);
      await saveUserStats({
        username,
        postKarma: prior?.postKarma ?? 0,
        commentKarma: prior?.commentKarma ?? 0,
        totalKarma: prior?.totalKarma ?? 0,
        posts: Number(posts),
        comments: Number(comments),
        lastUpdated: prior?.lastUpdated ?? '',
      });
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

    await post.sticky(1);

    const posts = await reddit.getNewPosts({
      subredditName,
      limit: 1000,
      pageSize: 100,
    }).all();

    const postIds = posts.map((item) => item.id);
    await redis.set(POST_QUEUE_KEY, JSON.stringify(postIds));
    await redis.set(POST_CURSOR_KEY, '0');
    await redis.set(SCAN_STATUS_KEY, JSON.stringify({
      state: postIds.length > 0 ? 'scanning' : 'complete',
      scanned: 0,
      total: postIds.length,
    } satisfies ScanStatus));

    return c.json({
      showToast: {
        text: 'Leaderboard pinned. Scanning ' + postIds.length + ' recent posts and their comments in the background.',
        appearance: 'success',
      },
    });
  } catch (error) {
    console.error('Could not create the karma leaderboard:', error);
    return c.json({
      showToast: {
        text: 'Could not create the leaderboard. Confirm the app has moderator access and check the logs.',
        appearance: 'neutral',
      },
    });
  }
});

app.post('/internal/scheduler/backfill', async (c) => {
  try {
    const queueRaw = await redis.get(POST_QUEUE_KEY);
    if (!queueRaw) return c.json({ status: 'ok', done: true });

    const postIds = JSON.parse(queueRaw) as string[];
    const cursor = Number(await redis.get(POST_CURSOR_KEY) ?? '0');
    const batch = postIds.slice(cursor, cursor + BATCH_POSTS);

    for (const postId of batch) {
      try {
        const post = await reddit.getPostById(asPostId(postId));
        await recordActivity('post', post.id, post.authorName);

        const comments = await reddit.getComments({
          postId: asPostId(postId),
          limit: 1000,
          pageSize: 100,
        }).all();

        for (const comment of comments) {
          await recordActivity('comment', comment.id, comment.authorName);
        }
      } catch (error) {
        console.error('Could not backfill post ' + postId + ':', error);
      }
    }

    const nextCursor = cursor + batch.length;
    const done = nextCursor >= postIds.length;
    await redis.set(POST_CURSOR_KEY, String(nextCursor));
    await redis.set(SCAN_STATUS_KEY, JSON.stringify({
      state: done ? 'complete' : 'scanning',
      scanned: nextCursor,
      total: postIds.length,
    } satisfies ScanStatus));

    if (done) await redis.del(POST_QUEUE_KEY);
    return c.json({ status: 'ok', done, scanned: nextCursor, total: postIds.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown backfill error';
    console.error('Karma leaderboard backfill failed:', message);
    return c.json({ status: 'error', error: message }, 500);
  }
});

app.post('/internal/scheduler/refresh-karma', async (c) => {
  try {
    const total = await redis.zCard(USERS_KEY);
    if (total === 0) return c.json({ status: 'ok', refreshed: 0 });

    const cursorRaw = Number(await redis.get('karma:refresh:cursor:v1') ?? '0');
    const start = cursorRaw >= total ? 0 : cursorRaw;
    const stop = Math.min(start + BATCH_USERS - 1, total - 1);
    const users = await redis.zRange(USERS_KEY, start, stop, { by: 'rank' });

    for (let i = 0; i < users.length; i += 5) {
      const group = users.slice(i, i + 5);
      await Promise.all(group.map((user) => refreshCommunityKarma(user.member)));
    }

    const nextCursor = start + users.length >= total ? 0 : start + users.length;
    await redis.set('karma:refresh:cursor:v1', String(nextCursor));
    return c.json({ status: 'ok', refreshed: users.length, knownUsers: total });
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
