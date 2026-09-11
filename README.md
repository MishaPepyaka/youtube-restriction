# Intentional YouTube

A small Chromium extension that makes YouTube less attention-hungry.

## What it does

- Removes Shorts shelves, links, cards, and redirects direct Shorts pages.
- Redirects the YouTube Home page to the Subscriptions feed.
- Hides Subscribe, Like, Dislike, and comments UI.
- Automatically likes each watched video after three seconds without toggling
  videos that are already liked.
- Heavily blurs thumbnails so they cannot function as clickbait.
- Limits recommendations on the Home page and beside videos to channels the
  signed-in user subscribes to.
- Hides recommendations whose channel cannot be verified. This is deliberately
  strict to avoid leaking unrelated recommendations into the feed.

## Install for development

1. Open `chrome://extensions` in Chromium or Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project directory.
5. Open YouTube while signed in, then refresh the page.

The extension refreshes its cached subscription list every six hours. YouTube
changes its markup regularly, so selectors and subscription parsing may need to
be updated over time.

## Permissions

- `storage`: caches subscribed channel identifiers locally.
- `youtube.com`: modifies YouTube pages and reads the signed-in user's public
  subscriptions page. No information is sent anywhere else.
