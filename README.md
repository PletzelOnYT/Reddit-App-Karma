# Karma Leaderboard — Reddit Devvit app

A simple subreddit-specific karma leaderboard, shown in an interactive Reddit post.

## How scoring works

The app uses Reddit's current-subreddit karma API. Each member's leaderboard score is their post karma plus comment karma **from this subreddit only**. It is not their overall Reddit karma.

The app also counts the number of posts and comments created by each member. Those counts are displayed separately from their karma.

Reddit does not expose the identity of individual voters, so the app cannot award named users for each upvote or downvote.

## Leaderboard

- Shows 10 members per page, ordered by subreddit karma.
- Previous / Next controls navigate between pages.
- The signed-in viewer's rank and subreddit karma stay in a footer at the bottom.
- The first five ranks have subtle diamond, gold, silver, copper, and stone markers.
- The interface follows the browser's light/dark color scheme and does not scroll the list internally.
- The app creates its leaderboard post but does **not** automatically pin it. Reddit's sticky slots are shared with the community's existing pinned posts, so the app must not replace another community sticky.

## Historical scan

A moderator chooses **Create / Refresh Karma Leaderboard** from the subreddit menu. The app:
1. Creates or reuses the leaderboard post without taking a sticky slot.
2. Requests Reddit's existing newest-post listing, including posts created before the app was installed.
3. Excludes the leaderboard's own post from its history queue.
4. Begins processing the first batch immediately.
5. Records each post author and the authors of comments on that post.
6. Refreshes a bounded batch of discovered members' current subreddit karma.

The moderator can choose **Continue Historical Scan** to manually process the next batch. The recurring backfill task also advances the queue automatically where scheduled jobs are running. Failed posts are retried up to three times; a post that remains unavailable is skipped and recorded in the scan status so it cannot block the entire queue.

**Reddit API history limits:** the app can request up to the 1,000 newest posts and up to 1,000 comments per post from the available listing endpoints. It cannot retrieve an unlimited all-time archive beyond the items Reddit makes available through those listings. Deleted, removed, or otherwise unavailable content may not be readable.

The app also uses post/comment creation triggers for new activity after installation. Activity IDs are de-duplicated so trigger retries do not count the same post or comment more than once. Activity counts represent detected creations, including content later deleted; karma is refreshed from Reddit's current subreddit-specific totals.

## Permissions

The account using the moderator menu must be a moderator of the subreddit. Reddit restricts reading another member's community-karma total to moderators. The viewer can still request their own subreddit karma through the same endpoint.

## Run from Codespaces

1. Open https://github.com/PletzelOnYT/Reddit-App-Karma.
2. Create or open a Codespace on `main`.
3. Run:

       npm ci
       npm test
       npm run type-check
       npm run build
       npm run login

4. Complete Devvit login in the browser if prompted. Never share the authorization code or credentials.
5. Upload a private development version:

       npm run deploy

6. Start a playtest:

       npm run dev

7. Open the playtest URL and refresh the subreddit. From the subreddit moderator menu, choose **Create / Refresh Karma Leaderboard**. To manually advance the historical scan during testing, choose **Continue Historical Scan** again as needed.

Do not run `devvit init --force` in this existing project.

## Production

After testing, run:

       npm run deploy
       npx devvit publish

Complete Reddit's app review and install the approved app in the production subreddit you moderate. The scheduler and triggers run within the installed Reddit app; Codespaces is only needed for development and uploads.
