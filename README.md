# Karma Leaderboard — Reddit Devvit app

A subreddit-specific leaderboard, hosted inside Reddit as a pinned interactive post.

## How scoring works

The app uses Reddit's own community-karma endpoint for each discovered member. It reads the member's karma **from this subreddit only**, combining:
- Post karma in this subreddit
- Comment karma in this subreddit

This is not global Reddit karma. Reddit does not reveal which individual accounts upvoted or downvoted a post or comment, so the app cannot award points for named voters or count each voter's votes. Reddit's aggregate community-karma totals already include the votes that Reddit counts.

The app also records how many posts and comments each member has contributed. Those counts are displayed alongside their karma.

## Leaderboard interface

- Top 10 per page, with Previous / Next page controls.
- Every page keeps the signed-in viewer's own rank and community karma in a footer.
- Places have distinct materials: 1 Diamond, 2 Gold, 3 Silver, 4 Copper, 5 Stone.
- The app creates and pins its leaderboard post from a subreddit moderator menu item.

## Initial scan and ongoing updates

When a moderator chooses **Create / Refresh Karma Leaderboard**, the app queues up to the newest 1,000 subreddit posts for an initial history scan. A scheduled worker processes those posts in batches and scans up to 1,000 comments per post. This follows Reddit's listing limits; it is not a complete archive scan of every item ever posted if the subreddit has more than 1,000 posts or a thread has more than 1,000 comments.

After the initial scan, Reddit post/comment creation triggers add new contributors automatically. A scheduled refresh periodically re-queries known members' current subreddit karma so vote-score changes are reflected. The app de-duplicates content IDs atomically to avoid counting trigger retries twice. Post/comment activity totals count detected creations (including items later deleted); the karma total itself is Reddit's current subreddit-specific karma.

## Moderator requirement

The app requests Reddit API and Redis access. Devvit's `moderator` Reddit scope is deprecated and treated as `user`; retrieving another member's community karma is authorized by Reddit only when the requesting account is a moderator of the current subreddit. Set up and playtest the app while signed in as a moderator of `spice_shop_watch_dev`. The viewer's own footer uses the same subreddit-specific karma endpoint. This does not grant access to overall Reddit karma or voter identities.

## Run from Codespaces

1. Open https://github.com/PletzelOnYT/Reddit-App-Karma.
2. Create a Codespace on the `main` branch.
3. In the terminal run:

       npm ci
       npm test
       npm run type-check
       npm run build
       npm run login

   The login command uses Devvit's copy-paste flow so the OAuth callback works
   from a Codespace. When prompted, copy the authorization code from Reddit's
   redirect page and paste it into the terminal. Do not share that code.

4. This project uses the existing `karma-board` app account. Do not run
   `devvit init --force` in this existing project.
5. Run `npm run deploy` to privately upload the development version, then
   `npm run dev` to playtest on `spice_shop_watch_dev`.
6. Open the playtest URL, then use the subreddit moderator menu and choose
   **Create / Refresh Karma Leaderboard** to create and pin the post and start the
   historical scan.

The playtest account must be logged in and a moderator of `spice_shop_watch_dev`.
`npm run dev` watches local changes and streams logs; it does not publish the app
to production.

## Production

After playtesting and verifying subreddit karma access:

       npm run deploy
       npx devvit publish

Complete Reddit's app review and install the approved app in the production subreddit you moderate. The scheduler and triggers run on Reddit's infrastructure; Codespaces is only needed to develop and upload new versions.
