'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const ADMIN = 'admin@example.com';
const FRIEND = 'friend@example.com';

function makeApp(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
  const config = loadConfig({
    BASE_URL: 'http://localhost:8899',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-secret',
    ADMIN_EMAILS: ADMIN,
    DATA_DIR: dataDir,
    NODE_ENV: 'test',
    PORTAL_TEST_LOGIN: '1',
    ...extraEnv,
  });
  return createApp(config);
}

// Serializes forms with repeated keys (checkbox groups) the way browsers do.
function formBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of [].concat(value)) params.append(key, v);
  }
  return params.toString();
}

// Registration is invitation-only, so tests invite non-admin emails before
// their first sign-in (subsequent sign-ins find the existing account).
function invite(queries, email, serviceIds = []) {
  return queries.createInvite({
    email,
    token: crypto.randomBytes(12).toString('base64url'),
    invitedBy: 'test-admin',
    expiryDays: 14,
    serviceIds,
  });
}

async function loginAgent(app, email) {
  const agent = request.agent(app);
  await agent.post('/test/login').type('form').send(formBody({ email })).expect(302);
  return agent;
}

async function csrfFrom(agent, url = '/') {
  const res = await agent.get(url).expect(200);
  const match = res.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, `csrf token present on ${url}`);
  return match[1];
}

function sessionCount(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
}

test('anonymous visitors are redirected to login', async () => {
  const { app } = makeApp();
  const res = await request(app).get('/').expect(302);
  assert.match(res.headers.location, /^\/login\?rd=/);
});

test('login page renders with the Google button', async () => {
  const { app } = makeApp();
  const res = await request(app).get('/login').expect(200);
  assert.match(res.text, /Sign in with Google/);
});

test('healthz responds without a session', async () => {
  const { app, db } = makeApp();
  const res = await request(app).get('/healthz').expect(200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(sessionCount(db), 0);
});

test('authz: anonymous is 401 and never creates a session row', async () => {
  const { app, db } = makeApp();
  await request(app).get('/api/authz/immich').expect(401);
  await request(app).post('/api/authz/immich').expect(401);
  assert.equal(sessionCount(db), 0);
});

test('admin sees all seeded services and passes authz with identity headers', async () => {
  const { app } = makeApp();
  const agent = await loginAgent(app, ADMIN);
  const dash = await agent.get('/').expect(200);
  for (const name of ['Immich', 'Nextcloud', '2FAuth']) assert.match(dash.text, new RegExp(name));
  assert.match(dash.text, /https:\/\/im\.lordblight\.com/);

  const az = await agent.get('/api/authz/immich').expect(200);
  assert.equal(az.headers['remote-email'], ADMIN);
  assert.equal(az.headers['remote-user'], 'admin');
  assert.equal(az.headers['remote-groups'], 'admins');
});

test('authz passes non-GET methods through (nginx auth_request contract)', async () => {
  const { app } = makeApp();
  const agent = await loginAgent(app, ADMIN);
  await agent.post('/api/authz/immich').expect(200);
  await agent.put('/api/authz/immich').expect(200);
  await agent.delete('/api/authz/immich').expect(200);
});

test('unknown service slug fails closed', async () => {
  const { app } = makeApp();
  const agent = await loginAgent(app, ADMIN);
  await agent.get('/api/authz/nope').expect(403);
});

test('new user is pending; admin grant flow works end to end', async () => {
  const { app, queries } = makeApp();
  invite(queries, FRIEND);
  const friendAgent = await loginAgent(app, FRIEND);

  const dash = await friendAgent.get('/').expect(200);
  assert.match(dash.text, /No services yet/);
  await friendAgent.get('/api/authz/immich').expect(403);

  const adminAgent = await loginAgent(app, ADMIN);
  const token = await csrfFrom(adminAgent, '/admin/users');
  const friend = queries.getUserByEmail(FRIEND);
  const immich = queries.getServiceBySlug('immich');
  await adminAgent
    .post(`/admin/users/${friend.id}`)
    .type('form')
    .send(formBody({ _csrf: token, services: String(immich.id) }))
    .expect(302);

  await friendAgent.get('/api/authz/immich').expect(200);
  await friendAgent.get('/api/authz/nextcloud').expect(403);

  const dash2 = await friendAgent.get('/').expect(200);
  assert.match(dash2.text, /Immich/);
  assert.doesNotMatch(dash2.text, /Nextcloud/);

  const me = await friendAgent.get('/api/me').expect(200);
  assert.deepEqual(me.body.services, ['immich']);
  assert.equal(me.body.admin, false);
});

test('revoking a grant bites existing sessions immediately', async () => {
  const { app, queries } = makeApp();
  invite(queries, FRIEND);
  const friendAgent = await loginAgent(app, FRIEND);
  const friend = queries.getUserByEmail(FRIEND);
  const immich = queries.getServiceBySlug('immich');

  queries.setUserServices(friend.id, [immich.id]);
  await friendAgent.get('/api/authz/immich').expect(200);

  queries.setUserServices(friend.id, []);
  await friendAgent.get('/api/authz/immich').expect(403);
});

test('blocking bites existing sessions immediately (live lookup)', async () => {
  const { app, queries } = makeApp();
  invite(queries, FRIEND);
  const friendAgent = await loginAgent(app, FRIEND);
  const friend = queries.getUserByEmail(FRIEND);
  queries.setUserServices(friend.id, [queries.getServiceBySlug('immich').id]);
  await friendAgent.get('/api/authz/immich').expect(200);

  queries.setUserFlags(friend.id, false, true);
  await friendAgent.get('/api/authz/immich').expect(403);
  const dash = await friendAgent.get('/').expect(200);
  assert.match(dash.text, /Access disabled/);
});

test('blocking via the admin UI also destroys the target sessions', async () => {
  const { app, queries } = makeApp();
  invite(queries, FRIEND);
  const friendAgent = await loginAgent(app, FRIEND);
  const adminAgent = await loginAgent(app, ADMIN);
  const token = await csrfFrom(adminAgent, '/admin/users');
  const friend = queries.getUserByEmail(FRIEND);

  await adminAgent
    .post(`/admin/users/${friend.id}`)
    .type('form')
    .send(formBody({ _csrf: token, is_blocked: 'on' }))
    .expect(302);

  // Session row was deleted, so the old cookie no longer authenticates at all.
  await friendAgent.get('/api/authz/immich').expect(401);
});

test('admin "sign out everywhere" kills the user session', async () => {
  const { app, queries } = makeApp();
  invite(queries, FRIEND);
  const friendAgent = await loginAgent(app, FRIEND);
  const adminAgent = await loginAgent(app, ADMIN);
  const token = await csrfFrom(adminAgent, '/admin/users');
  const friend = queries.getUserByEmail(FRIEND);

  await adminAgent
    .post(`/admin/users/${friend.id}/signout`)
    .type('form')
    .send(formBody({ _csrf: token }))
    .expect(302);
  await friendAgent.get('/').expect(302);
});

test('deleting a user removes them and their sessions; self-delete is refused', async () => {
  const { app, queries } = makeApp();
  invite(queries, FRIEND);
  const friendAgent = await loginAgent(app, FRIEND);
  const adminAgent = await loginAgent(app, ADMIN);
  const token = await csrfFrom(adminAgent, '/admin/users');
  const friend = queries.getUserByEmail(FRIEND);
  const admin = queries.getUserByEmail(ADMIN);

  const selfDelete = await adminAgent
    .post(`/admin/users/${admin.id}/delete`)
    .type('form')
    .send(formBody({ _csrf: token }))
    .expect(302);
  assert.match(selfDelete.headers.location, /error=/);
  assert.ok(queries.getUserByEmail(ADMIN));

  await adminAgent
    .post(`/admin/users/${friend.id}/delete`)
    .type('form')
    .send(formBody({ _csrf: token }))
    .expect(302);
  assert.equal(queries.getUserByEmail(FRIEND), undefined);
  await friendAgent.get('/api/authz/immich').expect(401);
});

test('admins cannot demote or block themselves', async () => {
  const { app, queries } = makeApp();
  const adminAgent = await loginAgent(app, ADMIN);
  const token = await csrfFrom(adminAgent, '/admin/users');
  const admin = queries.getUserByEmail(ADMIN);

  // Form posted with neither is_admin nor is_blocked ticked.
  await adminAgent
    .post(`/admin/users/${admin.id}`)
    .type('form')
    .send(formBody({ _csrf: token, is_blocked: 'on' }))
    .expect(302);

  const after = queries.getUserByEmail(ADMIN);
  assert.equal(after.is_admin, 1);
  assert.equal(after.is_blocked, 0);
});

test('non-admins cannot open admin pages or create invites', async () => {
  const { app, queries } = makeApp();
  invite(queries, FRIEND);
  const friendAgent = await loginAgent(app, FRIEND);
  await friendAgent.get('/admin/users').expect(403);
  await friendAgent.get('/admin/services').expect(403);

  // With a valid CSRF token, so it's the admin check that rejects.
  const token = await csrfFrom(friendAgent, '/');
  await friendAgent
    .post('/admin/invites')
    .type('form')
    .send(formBody({ _csrf: token, email: 'someone@example.com' }))
    .expect(403);
  assert.equal(queries.listPendingInvites().length, 0);
});

test('CSRF: POSTs without a valid token are rejected', async () => {
  const { app } = makeApp();
  const agent = await loginAgent(app, ADMIN);
  await agent.post('/logout').type('form').send(formBody({})).expect(403);
  await agent.post('/logout').type('form').send(formBody({ _csrf: 'wrong' })).expect(403);

  const token = await csrfFrom(agent, '/');
  await agent.post('/logout').type('form').send(formBody({ _csrf: token })).expect(302);
  await agent.get('/').expect(302); // signed out
});

test('service CRUD via the admin UI, including validation and fail-closed disable', async () => {
  const { app, queries } = makeApp();
  const adminAgent = await loginAgent(app, ADMIN);
  const token = await csrfFrom(adminAgent, '/admin/services');

  // Invalid URL rejected.
  const bad = await adminAgent
    .post('/admin/services')
    .type('form')
    .send(formBody({ _csrf: token, name: 'Bad', slug: 'bad', url: 'not-a-url' }))
    .expect(400);
  assert.match(bad.text, /valid http/);

  // Duplicate slug rejected.
  const dup = await adminAgent
    .post('/admin/services')
    .type('form')
    .send(formBody({ _csrf: token, name: 'Dup', slug: 'immich', url: 'https://x.lordblight.com' }))
    .expect(400);
  assert.match(dup.text, /already exists/);

  // Valid create (enabled) shows up on the dashboard and in authz.
  await adminAgent
    .post('/admin/services')
    .type('form')
    .send(
      formBody({
        _csrf: token,
        name: 'Uptime Kuma',
        slug: 'uptime',
        url: 'https://uptime.lordblight.com',
        description: 'Status monitoring',
        icon: '📈',
        sort_order: '40',
        enabled: 'on',
      })
    )
    .expect(302);
  const dash = await adminAgent.get('/').expect(200);
  assert.match(dash.text, /Uptime Kuma/);
  await adminAgent.get('/api/authz/uptime').expect(200);

  // Disabled service fails closed for everyone, grants included, admins included.
  await adminAgent
    .post('/admin/services')
    .type('form')
    .send(formBody({ _csrf: token, name: 'Hidden', slug: 'hidden', url: 'https://h.lordblight.com' }))
    .expect(302); // no enabled=on -> disabled
  invite(queries, FRIEND);
  const friendAgent = await loginAgent(app, FRIEND);
  const friend = queries.getUserByEmail(FRIEND);
  const hidden = queries.getServiceBySlug('hidden');
  queries.setUserServices(friend.id, [hidden.id]);
  await friendAgent.get('/api/authz/hidden').expect(403);
  await adminAgent.get('/api/authz/hidden').expect(403);

  // Delete the service; its authz endpoint now denies.
  await adminAgent
    .post(`/admin/services/${hidden.id}/delete`)
    .type('form')
    .send(formBody({ _csrf: token }))
    .expect(302);
  await friendAgent.get('/api/authz/hidden').expect(403);
});

test('rd redirect validation: same-site targets allowed, everything else falls back to /', async () => {
  const { app, queries } = makeApp({ BASE_URL: 'https://www.lordblight.com', COOKIE_DOMAIN: 'lordblight.com' });
  invite(queries, FRIEND); // consumed on the first login; later logins find the account
  const cases = [
    ['https://im.lordblight.com/photos', 'https://im.lordblight.com/photos'],
    ['https://lordblight.com/', 'https://lordblight.com/'],
    ['/admin', '/admin'],
    ['https://evil.com/x', '/'],
    ['//evil.com', '/'],
    ['https://lordblight.com.evil.com/x', '/'],
    ['javascript:alert(1)', '/'],
  ];
  for (const [rd, expected] of cases) {
    const res = await request(app)
      .post('/test/login')
      .set('X-Forwarded-Proto', 'https')
      .type('form')
      .send(formBody({ email: FRIEND, rd }))
      .expect(302);
    assert.equal(res.headers.location, expected, `rd=${rd}`);
  }
});

test('production cookie attributes (Domain, Secure, HttpOnly, SameSite=Lax)', async () => {
  const { app } = makeApp({ BASE_URL: 'https://www.lordblight.com', COOKIE_DOMAIN: 'lordblight.com' });
  const res = await request(app)
    .post('/test/login')
    .set('X-Forwarded-Proto', 'https')
    .type('form')
    .send(formBody({ email: ADMIN }))
    .expect(302);
  const cookie = (res.headers['set-cookie'] || []).join('; ');
  assert.match(cookie, /portal_session=/);
  assert.match(cookie, /Domain=lordblight\.com/i);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test('OAuth state is required and single-use', async () => {
  const { app } = makeApp();
  const agent = request.agent(app);
  const begin = await agent.get('/auth/google').expect(302);
  const realState = new URL(begin.headers.location).searchParams.get('state');
  assert.ok(realState);

  // Wrong state -> rejected, and the stored state is consumed.
  const first = await agent.get('/auth/google/callback?code=x&state=wrong').expect(302);
  assert.equal(first.headers.location, '/login?error=state');
  // The previously issued (real) state can no longer be replayed either.
  const second = await agent.get(`/auth/google/callback?code=x&state=${realState}`).expect(302);
  assert.equal(second.headers.location, '/login?error=state');
});

test('users are keyed by Google sub: email change updates the same account', async () => {
  const { queries } = makeApp();
  const first = queries.upsertGoogleUser({ sub: 'g-123', email: 'old@example.com', name: 'O' }, false);
  const second = queries.upsertGoogleUser({ sub: 'g-123', email: 'new@example.com', name: 'N' }, false);
  assert.equal(first.id, second.id);
  assert.equal(second.email, 'new@example.com');
  assert.equal(queries.getUserByEmail('old@example.com'), undefined);
});

test('allowlisted emails and admins may sign in without an invitation', async () => {
  const { app } = makeApp({
    ALLOWED_EMAILS: 'vip@example.com',
    ALLOWED_EMAIL_DOMAINS: 'family.example',
  });
  await loginAgent(app, 'vip@example.com');
  await loginAgent(app, ADMIN); // admins are always allowed
  await loginAgent(app, 'kid@family.example'); // domain allowlist
  await request(app)
    .post('/test/login')
    .type('form')
    .send(formBody({ email: 'stranger@example.com' }))
    .expect(403);
});

test('uninvited sign-in is rejected and creates no user or session', async () => {
  const { app, db, queries } = makeApp();
  await request(app)
    .post('/test/login')
    .type('form')
    .send(formBody({ email: 'stranger@example.com' }))
    .expect(403);
  assert.equal(queries.getUserByEmail('stranger@example.com'), undefined);
  assert.equal(sessionCount(db), 0);
});

test('invitation flow end to end: invite via UI, sign in, pre-grants applied, invite consumed', async () => {
  const { app, queries } = makeApp();
  const adminAgent = await loginAgent(app, ADMIN);
  const token = await csrfFrom(adminAgent, '/admin/users');
  const immich = queries.getServiceBySlug('immich');

  await adminAgent
    .post('/admin/invites')
    .type('form')
    .send(formBody({ _csrf: token, email: FRIEND.toUpperCase(), services: String(immich.id) }))
    .expect(302);

  // Pending list shows the invite (email lowercased) and its link.
  const pending = queries.listPendingInvites();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].email, FRIEND);
  const page = await adminAgent.get('/admin/users').expect(200);
  assert.match(page.text, new RegExp(`/invite/${pending[0].token}`));

  // The invited user signs in and starts with exactly the pre-granted service.
  const friendAgent = await loginAgent(app, FRIEND);
  await friendAgent.get('/api/authz/immich').expect(200);
  await friendAgent.get('/api/authz/nextcloud').expect(403);

  // Invite is consumed; signing in again finds the existing account.
  assert.equal(queries.listPendingInvites().length, 0);
  await loginAgent(app, FRIEND);
});

test('expired or revoked invitations do not allow sign-in', async () => {
  const { app, db, queries } = makeApp();

  const expired = invite(queries, 'late@example.com');
  db.prepare(`UPDATE invites SET expires_at = datetime('now', '-1 hour') WHERE id = ?`).run(expired.id);
  await request(app)
    .post('/test/login')
    .type('form')
    .send(formBody({ email: 'late@example.com' }))
    .expect(403);

  const revoked = invite(queries, 'gone@example.com');
  queries.deleteInvite(revoked.id);
  await request(app)
    .post('/test/login')
    .type('form')
    .send(formBody({ email: 'gone@example.com' }))
    .expect(403);
});

test('invite landing page: valid shows the email, unknown and expired do not sign anyone in', async () => {
  const { app, db, queries } = makeApp();
  const inv = invite(queries, FRIEND);

  const ok = await request(app).get(`/invite/${inv.token}`).expect(200);
  assert.match(ok.text, new RegExp(FRIEND));
  assert.match(ok.text, /Sign in with Google/);

  await request(app).get('/invite/not-a-real-token').expect(410);

  db.prepare(`UPDATE invites SET expires_at = datetime('now', '-1 hour') WHERE id = ?`).run(inv.id);
  const expired = await request(app).get(`/invite/${inv.token}`).expect(410);
  assert.match(expired.text, /expired/);
});

test('re-inviting an email replaces the pending invite and invalidates the old link', async () => {
  const { app, queries } = makeApp();
  const first = invite(queries, FRIEND);
  invite(queries, FRIEND);

  const pending = queries.listPendingInvites();
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].token, first.token);
  await request(app).get(`/invite/${first.token}`).expect(410);
  await request(app).get(`/invite/${pending[0].token}`).expect(200);
});

test('inviting an existing user or an invalid address is refused', async () => {
  const { app, queries } = makeApp();
  invite(queries, FRIEND);
  await loginAgent(app, FRIEND);

  const adminAgent = await loginAgent(app, ADMIN);
  const token = await csrfFrom(adminAgent, '/admin/users');

  const dup = await adminAgent
    .post('/admin/invites')
    .type('form')
    .send(formBody({ _csrf: token, email: FRIEND }))
    .expect(302);
  assert.match(dup.headers.location, /error=/);

  const bad = await adminAgent
    .post('/admin/invites')
    .type('form')
    .send(formBody({ _csrf: token, email: 'not-an-email' }))
    .expect(302);
  assert.match(bad.headers.location, /error=/);
  assert.equal(queries.listPendingInvites().length, 0);
});

test('admin can revoke a pending invitation from the UI', async () => {
  const { app, queries } = makeApp();
  const inv = invite(queries, 'newcomer@example.com');
  const adminAgent = await loginAgent(app, ADMIN);
  const token = await csrfFrom(adminAgent, '/admin/users');

  await adminAgent
    .post(`/admin/invites/${inv.id}/delete`)
    .type('form')
    .send(formBody({ _csrf: token }))
    .expect(302);
  assert.equal(queries.listPendingInvites().length, 0);
});

test('denied page names the service', async () => {
  const { app, queries } = makeApp();
  invite(queries, FRIEND);
  const friendAgent = await loginAgent(app, FRIEND);
  const res = await friendAgent.get('/denied?service=nextcloud').expect(403);
  assert.match(res.text, /Nextcloud/);
});

test('config validation fails fast on missing vars and weak secrets', () => {
  assert.throws(() => loadConfig({}), /Missing required environment variables/);
  assert.throws(
    () =>
      loadConfig({
        BASE_URL: 'https://www.lordblight.com',
        GOOGLE_CLIENT_ID: 'x',
        GOOGLE_CLIENT_SECRET: 'y',
        SESSION_SECRET: 'short',
      }),
    /SESSION_SECRET/
  );
});
