'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { safeRedirectTarget, safeAppRedirectTarget, isEmailAllowlisted, asyncHandler } = require('../util');

const LOGIN_ERRORS = {
  state: 'Your sign-in attempt expired — please try again.',
  google: 'Google sign-in failed — please try again.',
  unverified: 'Your Google account email address is not verified.',
  notinvited:
    'This portal is invitation-only. Ask the administrator to send an invitation to your Google account email.',
  blocked: 'Your access has been disabled by the administrator.',
};

function authRoutes({ config, queries, google }) {
  const router = express.Router();

  // Registration is invitation-only. Sign-in proceeds when the Google account
  // already has a portal account, is allowlisted (admins always are), or has a
  // pending invitation — which gets consumed on this first sign-in.
  function signInGate({ sub, email }) {
    if (queries.getUserBySub(sub)) return { allowed: true, invite: null };
    if (isEmailAllowlisted(email, config)) return { allowed: true, invite: null };
    const invite = queries.getPendingInviteByEmail(email);
    return invite ? { allowed: true, invite } : { allowed: false, invite: null };
  }

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(safeRedirectTarget(req.query.rd, config));
    res.render('login', {
      title: 'Sign in',
      rd: typeof req.query.rd === 'string' ? req.query.rd : '',
      error: LOGIN_ERRORS[req.query.error] || null,
      signedOut: req.query.signedout === '1',
    });
  });

  // Landing page for emailed invitation links. The link itself grants nothing —
  // the sign-in gate matches on the invited email — so an expired or replaced
  // token only affects this page, never an existing account.
  router.get('/invite/:token', (req, res) => {
    if (req.user) return res.redirect('/');
    const invite = queries.getInviteByToken(String(req.params.token));
    const state = !invite || invite.accepted_at
      ? 'invalid'
      : queries.getPendingInviteByEmail(invite.email)?.id === invite.id
        ? 'valid'
        : 'expired';
    res.status(state === 'valid' ? 200 : 410).render('invite', {
      title: 'Invitation',
      state,
      email: state === 'valid' ? invite.email : null,
    });
  });

  router.get(
    '/auth/google',
    asyncHandler(async (req, res) => {
      const state = crypto.randomBytes(16).toString('hex');
      const { url, codeVerifier } = await google.beginAuth(state);
      req.session.oauth = {
        state,
        codeVerifier,
        rd: safeRedirectTarget(req.query.rd, config),
      };
      res.redirect(url);
    })
  );

  // Native-app sign-in (the Hearth mobile app). Same Google OAuth and the same
  // invitation gate as the browser, but instead of a session cookie the flow
  // ends by handing an opaque per-device token back to the app via its custom
  // scheme: <rd>?token=… — or <rd>?error=<code> when the gate refuses.
  router.get(
    '/auth/app/start',
    asyncHandler(async (req, res) => {
      const appRd = safeAppRedirectTarget(req.query.rd, config);
      if (!appRd) {
        return res.status(400).render('error', {
          title: 'Bad request',
          status: 400,
          message: 'Unknown app callback. The rd parameter must use an allowlisted app scheme.',
        });
      }
      const deviceName = String(req.query.device || '').replace(/[^\x20-\x7E]/g, '').slice(0, 80) || null;

      // The in-app browser may already hold a portal session (it shares
      // cookies with the system browser) — then no Google round-trip is needed.
      if (req.user) {
        if (req.user.is_blocked) return res.redirect(`${appRd}?error=blocked`);
        const token = queries.createAppToken({
          userId: req.user.id,
          deviceName,
          expiryDays: config.appTokenExpiryDays,
        });
        return res.redirect(`${appRd}?token=${encodeURIComponent(token)}`);
      }

      const state = crypto.randomBytes(16).toString('hex');
      const { url, codeVerifier } = await google.beginAuth(state);
      req.session.oauth = { state, codeVerifier, appRd, deviceName };
      res.redirect(url);
    })
  );

  router.get(
    '/auth/google/callback',
    asyncHandler(async (req, res, next) => {
      const saved = req.session.oauth;
      delete req.session.oauth; // states are single-use
      // App-flow failures go back into the app so it can show the reason;
      // browser failures go to the login page as before.
      const fail = (code) =>
        saved && saved.appRd
          ? res.redirect(`${saved.appRd}?error=${code}`)
          : res.redirect(`/login?error=${code}`);

      if (!saved || typeof req.query.code !== 'string' || req.query.state !== saved.state) {
        return fail('state');
      }

      let profile;
      try {
        profile = await google.completeAuth(req.query.code, saved.codeVerifier);
      } catch (err) {
        console.error('Google token exchange failed:', err.message);
        return fail('google');
      }

      const email = (profile.email || '').toLowerCase();
      if (!email || profile.email_verified !== true) return fail('unverified');

      const gate = signInGate({ sub: profile.sub, email });
      if (!gate.allowed) return fail('notinvited');

      const user = queries.upsertGoogleUser(
        { sub: profile.sub, email, name: profile.name, picture: profile.picture },
        config.adminEmails.includes(email)
      );
      if (gate.invite) queries.acceptInvite(gate.invite.id, user.id);
      if (user.is_blocked) return fail('blocked');

      if (saved.appRd) {
        const token = queries.createAppToken({
          userId: user.id,
          deviceName: saved.deviceName,
          expiryDays: config.appTokenExpiryDays,
        });
        // The ephemeral in-app browser needs no portal session — the token is
        // the app's credential from here on.
        return req.session.destroy(() => {
          res.redirect(`${saved.appRd}?token=${encodeURIComponent(token)}`);
        });
      }

      const rd = saved.rd || '/';
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          res.redirect(rd);
        });
      });
    })
  );

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('portal_session', {
        path: '/',
        domain: config.cookieDomain || undefined,
      });
      res.redirect('/login?signedout=1');
    });
  });

  // Test-only login used by the automated tests so Google isn't needed.
  // Registered exclusively when NODE_ENV=test AND PORTAL_TEST_LOGIN=1.
  // Goes through the same signInGate as the real callback.
  if (config.testLogin) {
    router.post('/test/login', (req, res, next) => {
      const email = String((req.body && req.body.email) || '').toLowerCase();
      if (!email) return res.status(400).send('email required');
      const sub = `test:${email}`;
      const gate = signInGate({ sub, email });
      if (!gate.allowed) return res.status(403).send('not invited');
      const user = queries.upsertGoogleUser(
        { sub, email, name: req.body.name || email, picture: null },
        config.adminEmails.includes(email)
      );
      if (gate.invite) queries.acceptInvite(gate.invite.id, user.id);
      const rd = safeRedirectTarget(req.body.rd, config);
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          res.redirect(rd);
        });
      });
    });
  }

  return router;
}

module.exports = { authRoutes };
