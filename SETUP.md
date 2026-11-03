# Setup runbook

Bringing up a new deployment, start to finish. The order matters, because Meta checks the
webhook and the legal pages while you save its settings.

## Before you start

- An Instagram **professional** account (business or creator), linked to a Facebook Page, in a
  verified Meta Business Portfolio where you have full control.
- A Cloudflare account and a zone for the custom domain.
- Node 22.5+ (the tests use `node:sqlite`): run `npm ci && npm test`.

**Secrets rule:** values like the app secret, tokens and the verify token never go in chat,
commits or the shell history. Copy them to the clipboard and pipe them in:
`pbpaste | npx wrangler secret put NAME`.

## 1. Cloudflare resources

```bash
cp wrangler.example.toml wrangler.toml       # your config; gitignored
npx wrangler login
npx wrangler d1 create instagram-dm            # put the id in wrangler.toml
npx wrangler r2 bucket create instagram-dm-media
npx wrangler d1 migrations apply instagram-dm --remote
```

Fill `wrangler.toml`: `routes` (custom domain), `BRAND_NAME`, `CONTACT_EMAIL`, `PUBLIC_BASE_URL`.
Generate a verify token (`openssl rand -hex 24`), set it with `wrangler secret put VERIFY_TOKEN`,
then `npx wrangler deploy`. `/privacy` and `/data-deletion` should now load.

## 2. Protect the admin (Zero Trust recommended)

The admin is protected by Cloudflare Access, and the Worker verifies the Access JWT itself.

- Access application on the whole host, with a policy for your team's emails.
- Bypass application on the paths Meta and Instagram must reach: `/webhook`, `/privacy`,
  `/data-deletion` and `/media/` (staged post images that Meta downloads).
- Put the team domain and the application AUD in `ACCESS_TEAM` and `ACCESS_AUD`.

No Zero Trust? Leave `ACCESS_TEAM` and `ACCESS_AUD` empty and set a long random `ADMIN_PASSWORD`
secret: the admin then asks for it (HTTP Basic auth, over HTTPS only). Zero Trust is stronger:
per-person access, email codes, and nothing to leak or rotate.

## 3. The Meta app

1. developers.facebook.com → **Create App**, use case **Manage messaging & content on Instagram**,
   attached to the business portfolio. Keep "Instagram" and "IG" out of the app name.
2. New apps get **Facebook Login for Business** only (`graph.facebook.com`), which is what the code calls.
3. **App settings → Basic**: privacy policy URL `…/privacy`, data deletion URL `…/data-deletion`,
   icon and category. Copy the **App secret** → `wrangler secret put IG_APP_SECRET`.

## 4. Tokens

Do not use the use-case screen's "Generate token": it creates an app-scoped system user with no
access to the account, and every call answers "does not exist". Instead, in **Business settings**:

1. **System users → Add**, role Employee.
2. **Assign assets**: the Page and the Instagram account (content, community activity, messages)
   and the app (develop).
3. **Generate token**, expiry **Never**, scopes `instagram_basic`, `instagram_manage_messages`,
   `instagram_manage_comments` → `IG_ACCESS_TOKEN`.
4. A second token for publishing, scopes `instagram_content_publish`, `pages_read_engagement`,
   `ads_read` → `IG_PUBLISH_TOKEN`. The last two are required when Page access comes through the portfolio.

Check a token without printing it: `GET /{IG_USER_ID}?fields=id,username` returns the handle, and
the publish token can read `/{IG_USER_ID}/content_publishing_limit`.

Put `IG_USER_ID` (and optionally `PAGE_ID`) in `wrangler.toml`, then deploy.

## 5. Webhooks

**Configure webhooks**, object **Instagram**: callback `https://<host>/webhook`, the verify token
from step 1. **Verify and save**, then subscribe to `comments`, `messages` and
`messaging_postbacks`. Match `GRAPH_VERSION` to the version shown there.

## 6. Connect and test

1. Open `/admin` through Access and press **בדיקת חיבור** (check connection). It verifies the token,
   caches the username and, with `PAGE_ID`, subscribes the Page to webhooks.
2. Add an automation and comment its keyword **from another account**. Watch **פעילות אחרונה**
   (recent activity) in the admin, or `npx wrangler tail`.
3. Comments from accounts with no role on the app arrive only after **App Review** grants Advanced
   Access to `instagram_manage_comments` and `instagram_manage_messages`. Prepare a short screencast
   of the flow and a one-paragraph justification per permission.

## Operating notes

- One tool per keyword: the same keyword in ManyChat or another bot means two DMs.
- Over `MAX_PER_HOUR` (150), sends queue and the cron drains them every 5 minutes.
- Posts are capped at `MAX_POSTS_PER_DAY` (10). Meta's own 24-hour quota is checked as well.
- Personal data is deleted after 90 days (`forgetOld`), and staged images after 7.
