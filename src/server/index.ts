import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort, reddit, redis } from '@devvit/web/server';

const app = new Hono();

const LEADERBOARD_KEY = 'karma:leaderboard:v1';
const USERS_KEY = 'karma:users:v1';
const POST_QUEUE_KEY = 'karma:backfill:posts:v1';
const POST_CURSOR_KEY = 'karma:backfill:cursor:v1';
const SCAN_STATUS_KEY = 'karma:scan:status:v1';
const LEADERBOARD_POST_KEY = 'karma:leaderboard:post-id:v1';
const ACTIVITY_ITEMS_KEY = 'karma:activity:items:v1';
const BATCH_POSTS = 12;
const BATCH_USERS = 40;
const PAGE_SIZE = 10;

type CommunityKarma = {
  fromPosts?: number;
  fromComments?: number;
};

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

function readAuthorUsername(itemValue: unknown, rootValue?: unknown): string {
  const item = asRecord(itemValue);
  const author = asRecord(item.author);
  const root = asRecord(rootValue);
  const eventAuthor = asRecord(root.author);
  const user = asRecord(root.user);
  return cleanUsername(item.authorName)
    || cleanUsername(author.name)
    || cleanUsername(author.username)
    || cleanUsername(item.username)
    || cleanUsername(eventAuthor.name)
    || cleanUsername(eventAuthor.username)
    || cleanUsername(user.name)
    || cleanUsername(root.authorName);
}

function readItemId(itemValue: unknown): string {
  const item = asRecord(itemValue);
  return typeof item.id === 'string' ? item.id : '';
}

function profileKey(username: string): string {
  return 'karma:user:' + username.toLowerCase();
}

function seenKey(kind: 'post' | 'comment'): string {
  return 'karma:seen:' + kind + ':v1';
}

async function getUserStats(username: string): Promise<UserStats | null> {
  const raw = await redis.get(profileKey(username));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserStats;
  } catch {
    return null;
  }
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
    const result = await reddit.getUserKarmaFromCurrentSubreddit(username) as CommunityKarma;
    const prior = await getUserStats(username);
    const postKarma = Number(result?.fromPosts ?? 0);
    const commentKarma = Number(result?.fromComments ?? 0);
    const totalKarma = postKarma + commentKarma;

    const stats: UserStats = {
      username,
      postKarma: Number.isFinite(postKarma) ? postKarma : 0,
      commentKarma: Number.isFinite(commentKarma) ? commentKarma : 0,
      totalKarma: Number.isFinite(totalKarma) ? totalKarma : 0,
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

  const activityKey = kind + ':' + itemId;
  const alreadySeen = await redis.zScore(seenKey(kind), itemId);
  if (alreadySeen !== null && alreadySeen !== undefined) return;

  await redis.zAdd(seenKey(kind), { member: itemId, score: 1 });
  await redis.set(ACTIVITY_ITEMS_KEY + ':' + activityKey, username);

  const prior = await getUserStats(username);
  const stats: UserStats = {
    username,
    postKarma: prior?.postKarma ?? 0,
    commentKarma: prior?.commentKarma ?? 0,
    totalKarma: prior?.totalKarma ?? 0,
    posts: (prior?.posts ?? 0) + (kind === 'post' ? 1 : 0),
    comments: (prior?.comments ?? 0) + (kind === 'comment' ? 1 : 0),
    lastUpdated: prior?.lastUpdated ?? '',
  };
  await saveUserStats(stats);
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
  if (!stats) {
    await refreshCommunityKarma(username);
    stats = await getUserStats(username);
  }

  const count = await redis.zCard(LEADERBOARD_KEY);
  const ascendingRank = await redis.zRank(LEADERBOARD_KEY, username);
  const rank = ascendingRank === null || ascendingRank === undefined ? null : count - ascendingRank;

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
    const pageCount = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE));
    const page = Math.max(0, Math.min(Number.isFinite(rawPage) ? rawPage : 0, pageCount - 1));
    const start = page * PAGE_SIZE;
    const stop = Math.min(start + PAGE_SIZE - 1, totalUsers - 1);

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

    const existingId = await redis.get(LEADERBOARD_POST_KEY);
    let post = existingId ? await reddit.getPostById(asPostId(existingId)) : null;

    if (!post) {
      post = await reddit.submitCustomPost({
        subredditName,
        title: '🏆 Community Karma Leaderboard',
        entry: 'default',
        textFallback: {
          text: 'Community Karma Leaderboard · Top 10 per page · Your rank stays at the bottom.',
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

    const postIds = posts.map((item) => item.id).filter((id): id is string => typeof id === 'string');
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
    const post = asRecord(payload.post);
    const username = readAuthorUsername(post, payload);
    const id = readItemId(post);
    await recordActivity('post', id, username);
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
    const comment = asRecord(payload.comment);
    const username = readAuthorUsername(comment, payload);
    const id = readItemId(comment);
    await recordActivity('comment', id, username);
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
