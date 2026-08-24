# Hearth mobile app behind the portal

The Hearth app (the Flutter fork of the Immich app) reaches `im.lordblight.com` **only through the portal perimeter** — the same invitation-only, instantly-revocable Google gate the browser goes through. Nothing about Immich's own login changes; the portal is an *outer* credential the app carries on every request.

## How it works

```
Hearth app                    portal (www.lordblight.com)          NPM (im.lordblight.com)
    |                                   |                                  |
    |-- in-app browser: /auth/app/start?rd=hearth://portal-callback ----->|
    |        Google sign-in + the same invitation gate as the web         |
    |<- 302 hearth://portal-callback?token=<opaque per-device token> ----|
    |  (stored in the platform keystore / flutter_secure_storage)         |
    |                                                                     |
    |-- every request: X-Portal-Token: <token> --------------------------->|
    |                                   |<---- auth_request /api/authz/immich
    |                                   |  200 (invited + granted) or 401/403
    |<------------------------- proxied to Immich ------------------------|
    |     ... then Immich's own OIDC login/session works as before ...    |
```

1. **Portal sign-in (new).** Entering the server URL in the app probes the server; the portal's redirect challenge tells the app where the portal lives, and the app opens `GET /auth/app/start?rd=hearth://portal-callback&device=<model>` in an `ASWebAuthenticationSession` / Custom Tab. That route runs the exact same Google OAuth and `signInGate` (invitation / allowlist / blocked checks) as the browser flow, then 302s back into the app with an **opaque, DB-backed, per-device token** instead of a cookie. If the ephemeral browser already holds a portal session, no Google round-trip happens at all.
2. **Every request carries the token.** The app injects `X-Portal-Token` through its global custom-header pipeline, so all API, image, video and websocket traffic presents it. NPM's `auth_request` forwards it to `/api/authz/immich`; the portal resolves the token with a **live DB lookup** — blocking the user, revoking the grant, or revoking that one device token bites on the very next request.
3. **Then Immich auth as usual.** With the perimeter satisfied, the app performs the stock Immich OIDC login (`/api/oauth/*`) and ends up carrying two credentials per request: the portal token (past NPM) and the Immich access token (auth to Hearth itself).

## Token properties

| Property | Value |
|---|---|
| Format | 32 random bytes, base64url — opaque, no claims |
| Storage | Only the SHA-256 hash is stored (`app_tokens` table) |
| Lifetime | Sliding 30-day expiry (`APP_TOKEN_EXPIRY_DAYS`), refreshed on use (throttled to one write/hour) |
| Scope | One token per device; listed per user in **Admin → Users** |
| Revocation | Per-device **Revoke** button; also purged by *Sign out everywhere*, *Blocked*, and user deletion |
| App-side sign-out | `POST /api/app/logout` with the token revokes it server-side |

## Portal configuration

Nothing is required beyond the defaults; two knobs exist in `.env`:

```bash
#APP_TOKEN_EXPIRY_DAYS=30      # sliding per-device token lifetime
#APP_CALLBACK_SCHEMES=hearth   # custom URL schemes /auth/app/start may redirect to
```

The scheme allowlist is why a token can only ever be handed to the Hearth app: `rd` must be `<allowlisted-scheme>://…` with no query, and the portal appends `?token=…` itself.

## NPM configuration

Use the Immich snippet in [nginx-proxy-manager-forward-auth.md](nginx-proxy-manager-forward-auth.md): `/api` sits behind `auth_request` like everything else, and only two narrow bypasses remain:

- `/api/oauth/mobile-redirect` — the one hop of the app's Immich OIDC login made by the *system* browser (no cookie, no token); it just 302s back into the app.
- `/share` — public share links, authenticated by Immich's own share tokens.

## Failure modes seen by the app

| Portal answer | Cause | App behavior |
|---|---|---|
| `302` to `https://www.lordblight.com/login?...` | No/invalid/revoked/expired token | Re-runs the portal sign-in (server-URL step shows the portal browser again) |
| `hearth://portal-callback?error=notinvited` | Google account has no invitation | Shows the error; ask the admin for an invite |
| `hearth://portal-callback?error=blocked` | Account disabled by the admin | Shows the error |
| `302` to `/denied?service=immich` (403) | Signed in but Immich not granted | Shows the error; ask the admin for the grant |

## Related

- App-side implementation: `Hearth/mobile` — `PortalAuthService` (sign-in, secure storage, header injection) wired into the login form before the stock Immich OIDC flow.
- Browser-side gate and per-service snippets: [nginx-proxy-manager-forward-auth.md](nginx-proxy-manager-forward-auth.md)
- In-app SSO for the other services: [in-app-sso.md](in-app-sso.md)
