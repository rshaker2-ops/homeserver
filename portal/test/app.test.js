'use strict';

const test = require('node:test');
const assert = require('node:assert');
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

test('non-admins cannot open admin pages', async () => {
  const { app } = makeApp();
  const friendAgent = await loginAgent(app, FRIEND);
  await friendAgent.get('/admin/users').expect(403);
  await friendAgent.get('/admin/services').expect(403);
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
  const { app } = makeApp({ BASE_URL: 'https://www.lordblight.com', COOKIE_DOMAIN: 'lordblight.com' });
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

test('sign-in allowlist blocks unlisted accounts when configured', async () => {
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

test('denied page names the service', async () => {
  const { app } = makeApp();
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
