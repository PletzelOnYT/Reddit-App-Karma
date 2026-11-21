import './index.css';
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

type LeaderRow = {
  username: string;
  karma: number;
  postKarma: number;
  commentKarma: number;
  posts: number;
  comments: number;
  rank: number;
};

type LeaderboardResponse = {
  subreddit: string;
  page: number;
  pageCount: number;
  totalUsers: number;
  rows: LeaderRow[];
  viewer: {
    username: string;
    rank: number | null;
    karma: number;
  } | null;
  scan: {
    state: string;
    scanned: number;
    total: number;
  };
  lastUpdated: string | null;
  error?: string;
};

function awardMark(rank: number): string {
  if (rank === 1) return '💎';
  if (rank === 2) return '🥇';
  if (rank === 3) return '🥈';
  if (rank === 4) return '🟤';
  if (rank === 5) return '🪨';
  return '';
}

function number(value: number): string {
  return Math.round(value).toLocaleString();
}

function App() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (nextPage: number) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/leaderboard?page=' + nextPage);
      const result = await response.json() as LeaderboardResponse;
      if (!response.ok) throw new Error(result.error || 'Could not load the leaderboard.');
      setData(result);
      setPage(result.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the leaderboard.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(page);
    const timer = window.setInterval(() => void load(page), 60_000);
    return () => window.clearInterval(timer);
  }, [page, load]);

  const subredditLabel = data?.subreddit ? 'r/' + data.subreddit : 'this subreddit';

  return (
    <main className="app">
      <header className="header">
        <h1>Subreddit Karma</h1>
      </header>

      <div className="description">
        <p>Users with the highest karma in {subredditLabel}.</p>
      </div>

      {loading && !data ? (
        <div className="notice loading">Loading subreddit rankings…</div>
      ) : error ? (
        <div className="notice error">{error}</div>
      ) : data && data.rows.length ? (
        <>
          <section className="list" aria-label={'Karma rankings in ' + subredditLabel}>
            {data.rows.map((row) => (
              <article className="row" key={row.username}>
                <span className={'rank rank-' + row.rank}>{row.rank}.</span>
                <div className="user-block">
                  <span className="username">{row.username}</span>
                  {awardMark(row.rank) && (
                    <span className="award" aria-label={row.rank <= 5 ? 'Top five rank award' : undefined}>
                      {awardMark(row.rank)}
                    </span>
                  )}
                </div>
                <span
                  className="points"
                  aria-label={number(row.karma) + ' karma in ' + subredditLabel}
                >
                  {number(row.karma)}
                </span>
              </article>
            ))}
          </section>

          <nav className="pagination" aria-label="Leaderboard pages">
            <button
              className="page-button"
              onClick={() => void load(page - 1)}
              disabled={page <= 0 || loading}
              aria-label="Previous page"
            >
              ‹ Previous
            </button>
            <span className="page-count">
              {page + 1} of {Math.max(1, data.pageCount)}
            </span>
            <button
              className="page-button"
              onClick={() => void load(page + 1)}
              disabled={page + 1 >= data.pageCount || loading}
              aria-label="Next page"
            >
              Next ›
            </button>
          </nav>
        </>
      ) : (
        <div className="notice">
          {data?.scan.state === 'scanning'
            ? 'The historical scan is running. Earlier posts and comments will appear as batches are processed.'
            : 'No subreddit activity has been indexed yet. A moderator can start the historical scan from the subreddit menu.'}
        </div>
      )}

      {data?.scan.state === 'scanning' && (
        <p className="scan-status">
          Scanning earlier posts · {number(data.scan.scanned)} / {number(data.scan.total)}
          {(data.scan.failed ?? 0) > 0 ? ' · ' + number(data.scan.failed ?? 0) + ' unavailable' : ''}
        </p>
      )}

      <footer className="you-bar">
        <div className="you-identity">
          <div className="you-title">YOUR RANK IN {data?.subreddit ? 'r/' + data.subreddit : 'THIS SUBREDDIT'}</div>
          <div className="you-name">
            {data?.viewer?.username ? 'u/' + data.viewer.username : 'Sign in to see your rank'}
          </div>
        </div>
        <div className="you-stats">
          <div className="you-rank">{data?.viewer?.rank ? '#' + data.viewer.rank : 'Unranked'}</div>
          <div className="you-points">
            {data?.viewer ? number(data.viewer.karma) + ' subreddit karma' : '—'}
          </div>
        </div>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
