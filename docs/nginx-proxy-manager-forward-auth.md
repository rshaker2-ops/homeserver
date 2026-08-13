# Enforcing portal grants in Nginx Proxy Manager

This wires each service's NPM proxy host to the portal, so every request is checked against the signed-in user's grants (`auth_request`). Result:

- Not signed in → redirected to `https://www.lordblight.com/login` and back again afterwards.
- Signed in, no grant for that service → sent to the portal's "no access" page.
- Signed in + granted → request proxied through; the app receives `Remote-User` / `Remote-Email` headers.

## Prerequisites

- The portal is running and reachable from the NPM container at `http://192.168.89.106:8899` (using the host LAN IP works no matter which Docker network NPM is on).
- `COOKIE_DOMAIN=lordblight.com` is set in the portal's `.env` — otherwise the session cookie never reaches `im.lordblight.com` etc. and you'll get a redirect loop.
- The service already works through NPM *without* the snippet.
- **Never** add a snippet to the portal's own proxy host (`www.lordblight.com`).

## Rules that make or break these snippets

1. **Each snippet must contain a complete `location /` block, including its own `proxy_pass`.** NPM skips generating its default `location /` whenever the Advanced config contains the text `location /` — and that check matches `location /api` too. So the moment you add *any* location, you own all of them. The snippets use NPM's own `$forward_scheme://$server:$port` variables, which inherit the upstream host/port you configured in the UI.
2. **Custom locations must re-declare all proxy headers.** nginx drops server-level `proxy_set_header` inheritance the moment a location declares any of its own — that's why every block repeats the Host/X-Forwarded/WebSocket headers.
3. After saving, NPM reloads nginx. If the host suddenly shows **"offline"**, the config has a syntax error — see Troubleshooting.

## 2FAuth (`2fa.lordblight.com`) — full gate

Paste into the proxy host's **Advanced** tab (slug: `2fauth`):

```nginx
# --- portal forward-auth: 2fauth ---
location = /portal-authz {
    internal;
    proxy_pass http://192.168.89.106:8899/api/authz/2fauth;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Uri $request_uri;
    proxy_set_header X-Real-IP $remote_addr;
}

error_page 401 =302 https://www.lordblight.com/login?rd=$scheme://$http_host$request_uri;
error_page 403 =302 https://www.lordblight.com/denied?service=2fauth;

location / {
    auth_request /portal-authz;
    auth_request_set $portal_user $upstream_http_remote_user;
    auth_request_set $portal_email $upstream_http_remote_email;
    proxy_set_header Remote-User $portal_user;
    proxy_set_header Remote-Email $portal_email;

    proxy_pass $forward_scheme://$server:$port;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Scheme $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
}
```

> ⚠️ **Lockout warning:** if the 2FA codes for your *Google account* live in 2FAuth, a broken portal could lock you out of both. Escape hatch: 2FAuth stays reachable on the LAN at `http://192.168.89.106:8805`.

## Immich (`im.lordblight.com`) — gate the web UI, keep the mobile app working

The Immich mobile app and API keys authenticate themselves against `/api`, and public share links live under `/share` — both are bypassed and rely on Immich's own auth. Slug: `immich`.

```nginx
# --- portal forward-auth: immich ---
client_max_body_size 0;
proxy_read_timeout 600s;
proxy_send_timeout 600s;

location = /portal-authz {
    internal;
    proxy_pass http://192.168.89.106:8899/api/authz/immich;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Uri $request_uri;
    proxy_set_header X-Real-IP $remote_addr;
}

error_page 401 =302 https://www.lordblight.com/login?rd=$scheme://$http_host$request_uri;
error_page 403 =302 https://www.lordblight.com/denied?service=immich;

# Mobile app / API keys / share-page data: Immich's own auth, no portal cookie.
location /api {
    proxy_pass $forward_scheme://$server:$port;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Scheme $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
}

# Public share links (immich share tokens do the auth).
location /share {
    proxy_pass $forward_scheme://$server:$port;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Scheme $scheme;
}

location / {
    auth_request /portal-authz;
    auth_request_set $portal_user $upstream_http_remote_user;
    auth_request_set $portal_email $upstream_http_remote_email;
    proxy_set_header Remote-User $portal_user;
    proxy_set_header Remote-Email $portal_email;

    proxy_pass $forward_scheme://$server:$port;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Scheme $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
}
```

## Nextcloud (`nc.lordblight.com`) — think twice

**Recommended: leave Nextcloud ungated** (launchpad-only). Its desktop/mobile sync clients, WebDAV, CalDAV and app passwords hit many endpoints with their own auth; a cookie gate breaks them unless you bypass so much that the gate is mostly symbolic. Nextcloud's own login + 2FA is solid.

If you only ever use the web UI and still want the gate (slug: `nextcloud`), use the 2FAuth snippet with the slug swapped, plus this bypass *above* the `location /` block so sync clients, public share links (`/s/…`) and the desktop-client login flow keep working:

```nginx
location ~ ^/(remote\.php|public\.php|ocs|status\.php|cron\.php|\.well-known|s/|index\.php/s/|login/v2|index\.php/login/v2) {
    proxy_pass $forward_scheme://$server:$port;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Scheme $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    client_max_body_size 0;
}
```

Also keep `client_max_body_size 0;` at the top of the Advanced config for large uploads.

## Adding a future service — worked example: the NPM admin UI

1. Portal **Admin → Services → Add service**: name `Proxy Manager`, slug `npm`, URL `https://npm.lordblight.com`.
2. DNS record + NPM proxy host `npm.lordblight.com` → `http://192.168.89.106:81`.
3. Paste the 2FAuth snippet with both occurrences of the slug changed to `npm` (and the `denied?service=` value).
4. Grant it on **Admin → Users** to whoever should see it.

> Gate the NPM admin UI only **after** the portal has proven itself — if the portal breaks, you'd otherwise be fixing NPM through its LAN address `http://192.168.89.106:81` (which is the escape hatch, and why LAN access should stay unforwarded but open).

## Verify it's actually enforcing

From outside your LAN (or a private window):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://www.lordblight.com/api/authz/immich   # 401 — anonymous
```

- Open `https://im.lordblight.com` in a private window → you land on the portal login.
- Sign in as a user **without** an Immich grant → you land on the portal's "no access" page.
- Sign in as a granted user → Immich loads; `Remote-Email` shows up in Immich's proxy headers.
- Immich mobile app (server URL `https://im.lordblight.com`) still syncs — `/api` is bypassed.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Host shows **offline** in NPM after saving | nginx syntax error in the snippet. `docker exec -it <npm-container> nginx -t` shows the line; logs: `/data/logs/proxy-host-*_error.log` inside the NPM container. |
| Redirect loop between service and portal | `COOKIE_DOMAIN` not set (or set wrong) in the portal `.env`, so the session cookie never reaches the subdomain. It must be `lordblight.com`, and you must access everything via `https://…lordblight.com` (cookies are `Secure`). |
| Everything gets 500 | Portal unreachable from NPM — `auth_request` failures turn into 500s. `curl http://192.168.89.106:8899/healthz` from the NPM container. |
| Granted user still bounced to "no access" | Wrong slug in `proxy_pass …/api/authz/<slug>` — it must exactly match the service's slug in the portal admin (shown on Admin → Services). |
| Immich uploads fail on big videos | Missing `client_max_body_size 0;` / timeout lines. |
| Login URL loses part of the original query string | nginx doesn't URL-encode `$request_uri` in the `error_page` redirect. Cosmetic — after login the user still lands on the right page for normal URLs. |
| Works on LAN IPs without login | By design: enforcement lives on the NPM vhosts. Only forward ports 80/443 from the internet and LAN access stays your escape hatch. |
