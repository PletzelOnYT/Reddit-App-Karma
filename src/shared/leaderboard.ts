export const PAGE_SIZE = 10;

export type PageWindow = {
  page: number;
  pageCount: number;
  start: number;
  stop: number;
};

export function getPageWindow(
  totalUsers: number,
  requestedPage: number,
  pageSize = PAGE_SIZE,
): PageWindow {
  const pageCount = Math.max(1, Math.ceil(totalUsers / pageSize));
  const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0, pageCount - 1));
  const start = page * pageSize;

  return {
    page,
    pageCount,
    start,
    stop: Math.min(start + pageSize - 1, totalUsers - 1),
  };
}

export function communityKarma(fromPosts?: number, fromComments?: number): number | null {
  const postKarma = fromPosts ?? 0;
  const commentKarma = fromComments ?? 0;
  if (!Number.isFinite(postKarma) || !Number.isFinite(commentKarma)) return null;
  return postKarma + commentKarma;
}

export function rankFromAscendingIndex(totalUsers: number, ascendingIndex: number | undefined): number | null {
  if (
    ascendingIndex === undefined
    || !Number.isInteger(ascendingIndex)
    || ascendingIndex < 0
    || ascendingIndex >= totalUsers
  ) return null;
  return totalUsers - ascendingIndex;
}

export async function recordUniqueActivity(
  markSeen: () => Promise<number>,
  onNewActivity: () => Promise<void>,
): Promise<boolean> {
  if (await markSeen() <= 0) return false;
  await onNewActivity();
  return true;
}


/**
 * Build a historical scan queue from Reddit's newest-post listing.
 * The leaderboard's own custom post is not community activity and must be skipped.
 */
export function getHistoricalPostIds(
  posts: readonly { id: string }[],
  leaderboardPostId: string,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const post of posts) {
    if (!post.id || post.id === leaderboardPostId || seen.has(post.id)) continue;
    seen.add(post.id);
    ids.push(post.id);
  }
  return ids;
}
