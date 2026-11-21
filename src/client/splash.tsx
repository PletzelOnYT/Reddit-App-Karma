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

function badgeName(rank: number): string {
  if (rank === 1) return '💎 Diamond';
  if (rank === 2) return '🥇 Gold';
  if (rank === 3) return '🥈 Silver';
  if (rank === 4) return '🟤 Copper';
  if (rank === 5) return '🪨 Stone';
  return '';
}

function materialClass(rank: number): string {
  if (rank >= 1 && rank <= 5) return 'material ' + ['','diamond','gold','silver','copper','stone'][rank];
  return 'material';
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

  const firstRank = data && data.rows.length ? data.rows[0].rank : page * 10 + 1;
  const lastRank = data ? page * 10 + data.rows.length : 0;

  return (
    <main className="app">
      <header className="header">
        <div>
          <div className="eyebrow">Community rankings</div>
          <h1>Karma Leaderboard</h1>
          <p className="subtitle">{data ? 'r/' + data.subreddit : 'Subreddit karma' } · Top contributors</p>
        </div>
        <span className="updated">{data?.lastUpdated ? 'Updated ' + new Date(data.lastUpdated).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : 'LIVE'}</span>
      </header>

      {loading && !data ? (
        <div className="notice loading">Loading community rankings…</div>
      ) : error ? (
        <div className="notice error">{error}</div>
      ) : data && data.rows.length ? (
        <>
          <section className="list" aria-label="Community karma rankings">
            {data.rows.map((row) => (
              <article className={'row ' + materialClass(row.rank)} key={row.username}>
                <div className="rank">{row.rank}</div>
                <div className="user-block">
                  <div className="username">u/{row.username}</div>
                  <div className="meta">{badgeName(row.rank) || ('Community member')} · {number(row.posts)} posts · {number(row.comments)} comments</div>
                </div>
                <div className="score">
                  <div className="points">{number(row.karma)}</div>
                  <div className="label">community karma</div>
                </div>
              </article>
            ))}
          </section>
          <nav className="pagination" aria-label="Leaderboard pages">
            <button className="page-button" onClick={() => void load(page - 1)} disabled={page <= 0 || loading}>← Previous</button>
            <span className="page-count">{page + 1} / {Math.max(1,data.pageCount)}</span>
            <button className="page-button" onClick={() => void load(page + 1)} disabled={page + 1 >= data.pageCount || loading}>Next →</button>
          </nav>
          {data.scan.state !== 'complete' && (
            <p className="subtitle">Scanning recent posts and comments · {number(data.scan.scanned)} / {number(data.scan.total)}</p>
          )}
        </>
      ) : (
        <div className="notice">No community activity indexed yet. A moderator can start the first scan from the subreddit menu.</div>
      )}

      <footer className="you-bar">
        <div>
          <div className="you-title">YOUR COMMUNITY RANK</div>
          <div className="you-name">{data?.viewer?.username ? 'u/' + data.viewer.username : 'Sign in to see your rank'}</div>
        </div>
        <div className="you-stats">
          <div className="you-rank">{data?.viewer?.rank ? '#' + data.viewer.rank : 'Unranked'}</div>
          <div className="you-points">{data?.viewer ? number(data.viewer.karma) + ' karma' : '—'}</div>
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
