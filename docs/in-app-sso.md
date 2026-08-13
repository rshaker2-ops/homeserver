# In-app SSO — one Google account everywhere

The portal + [proxy forward-auth](nginx-proxy-manager-forward-auth.md) is the **perimeter**: it decides who can reach each app at all, per-user, enforced at NPM. This guide adds the second layer: making the **same Google account the identity inside each app**, so nobody manages per-app passwords.

Two mechanisms, depending on what each app supports:

| App | Mechanism | Result |
|---|---|---|
| FileBrowser | Trusted `Remote-User` header from the portal | Click tile → already signed in |
| 2FAuth | Trusted header (`reverse-proxy-guard`) | Click tile → already signed in |
| Immich | Native Google OIDC login | One click ("Sign in with Google"), or zero with auto-launch; mobile app included |
| Nextcloud | Google OIDC via the `user_oidc` app | "Continue with Google" on the login page |
| NPM admin | None supported | Portal gate + its own login |

## Where the identity headers come from — and the one safety rule

On every allowed request, the portal's authz endpoint returns `Remote-User` (email local-part, e.g. `rshaker2`), `Remote-Email`, `Remote-Name`, and `Remote-Groups`. The forward-auth snippet's `auth_request_set … / proxy_set_header Remote-User …` lines copy them onto the request that reaches the app — overwriting anything a client sent.

> ⚠️ **Header-trusting modes (FileBrowser, 2FAuth) are only safe behind the gate.** Enable them **after** the forward-auth snippet is live on that proxy host, and never expose those apps to the internet on another route. Direct LAN access stops working in these modes (no header = no login) — that's expected; the revert steps below are the escape hatch.

## Google OAuth client — full redirect URI list

Everything reuses the portal's OAuth client. Its **Authorized redirect URIs** end up as:

```
https://www.lordblight.com/auth/google/callback        # the portal itself
https://im.lordblight.com/auth/login                   # Immich web
https://im.lordblight.com/api/oauth/mobile-redirect    # Immich mobile bridge
https://nc.lordblight.com/apps/user_oidc/code          # Nextcloud user_oidc
```

## FileBrowser (`files.lordblight.com`)

FileBrowser isn't in the portal's seed set — it's the worked example of adding a service: portal **Admin → Services** entry with slug `files`, NPM proxy host `files.lordblight.com` → `http://192.168.89.106:8890`, and the standard full-gate snippet (the 2FAuth one from the forward-auth doc with `2fauth` → `files` swapped in the three places).

**Before switching auth modes**, while password login still works:

1. In FileBrowser (Settings → User Management) create a user named after each person's **email local-part** (`rshaker2` for `rshaker2@gmail.com` — that's the exact value `Remote-User` carries). Give your own user **admin** permission; scope family users to their folders.

**Switch to proxy auth.** Two gotchas make the obvious commands fail: FileBrowser's BoltDB allows one process at a time, so `docker exec … config set` against the running server dies with `Error: timeout`; and newer images bake a `/config/settings.json` pointing at `/database/filebrowser.db`, so an unpinned one-off container looks at the wrong path. The reliable sequence — stopped container, same image, explicit DB path:

```bash
docker stop filebrowser

IMG=$(docker inspect filebrowser --format '{{.Config.Image}}')
docker run --rm -v /mnt/user/appdata/filebrowser/filebrowser.db:/database.db \
  "$IMG" -d /database.db config set --auth.method=proxy --auth.header=Remote-User

docker start filebrowser
```

Success prints a settings summary with `Auth Method: proxy` / `Auth Header: Remote-User`. Revert to password login the same way with `--auth.method=json`.

## 2FAuth (`2fa.lordblight.com`)

2FAuth ships an auth-proxy guard that consumes exactly what the snippet forwards. With the gate already live, add to the container's environment and restart:

```
AUTHENTICATION_GUARD=reverse-proxy-guard
AUTH_PROXY_HEADER_FOR_USER=REMOTE_USER
AUTH_PROXY_HEADER_FOR_EMAIL=REMOTE_EMAIL
```

Clicking the tile now lands each person in their own vault, with accounts mapped/created from the forwarded identity. Notes:

- Password and WebAuthn login are **disabled** in this mode, including on the LAN (`http://192.168.89.106:8805` will refuse you). Escape hatch: remove `AUTHENTICATION_GUARD` and restart.
- This app holds 2FA seeds — after enabling, verify you landed in the account containing *your* tokens before adding more.

## Immich (`im.lordblight.com`)

No header auth here; instead Immich logs in against Google directly, which feels identical (the browser is already signed into Google):

1. Add the two `im.` redirect URIs above to the Google client.
2. Immich → **Administration → Settings → OAuth**: enable, then
   - Issuer URL: `https://accounts.google.com`
   - Client ID / Client secret: from the Google client
   - **Auto register**: on — family Google accounts create Immich users on first login
   - **Mobile redirect URI override**: on, set to `https://im.lordblight.com/api/oauth/mobile-redirect` (Google won't accept the app's custom-scheme URI; this bridges it so the phone app's OAuth works)
   - Optional **Auto launch**: skips Immich's login page straight to Google — effectively invisible SSO for the web UI
3. Anyone who already had a password-based Immich account can link it under Account Settings → OAuth so both identities are the same user.

Remember the forward-auth snippet for Immich deliberately bypasses `/api` and `/share`, so the mobile app and public share links keep working regardless.

## Nextcloud (`nc.lordblight.com`)

Install **"OpenID Connect user backend" (`user_oidc`)** from the app store, then Administration → OpenID Connect → register a provider:

- Identifier: `Google`
- Client ID / secret: from the Google client
- Discovery endpoint: `https://accounts.google.com/.well-known/openid-configuration`

Add the `nc.` redirect URI above to the Google client. The login page gains "Continue with Google"; desktop/mobile sync clients keep working because their login flow opens a real browser. Per the forward-auth doc, Nextcloud stays **un-gated at the proxy** by design — this in-app SSO is its whole story.

## NPM admin (`npm.lordblight.com`)

Nginx Proxy Manager's admin UI has no external-auth support of any kind. Keep it behind the portal gate and its own local login — for an admin tool, two prompts is a feature.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Google shows `redirect_uri_mismatch` | The exact URI (scheme, host, path) isn't on the OAuth client. Compare character-for-character with the list above. |
| FileBrowser/2FAuth shows an auth error instead of logging you in | The header didn't arrive: forward-auth snippet missing on that host, or its `auth_request_set`/`proxy_set_header Remote-User` lines were dropped. |
| Landed in a fresh/empty 2FAuth or FileBrowser account | Header value ≠ existing username. The portal sends the email local-part — check yours at `https://www.lordblight.com/api/me`, and rename the in-app user to match. |
| `filebrowser config set` says `Error: timeout` | The server is running and holds the DB lock — stop the container and use the one-off sequence above. |
| Immich mobile app fails after Google login | Mobile redirect URI override not enabled, or `…/api/oauth/mobile-redirect` missing from the Google client. |
