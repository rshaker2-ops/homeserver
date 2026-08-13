'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { safeRedirectTarget, isEmailAllowlisted, asyncHandler } = require('../util');

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

  router.get(
    '/auth/google/callback',
    asyncHandler(async (req, res, next) => {
      const saved = req.session.oauth;
      delete req.session.oauth; // states are single-use
      if (!saved || typeof req.query.code !== 'string' || req.query.state !== saved.state) {
        return res.redirect('/login?error=state');
      }

      let profile;
      try {
        profile = await google.completeAuth(req.query.code, saved.codeVerifier);
      } catch (err) {
        console.error('Google token exchange failed:', err.message);
        return res.redirect('/login?error=google');
      }

      const email = (profile.email || '').toLowerCase();
      if (!email || profile.email_verified !== true) return res.redirect('/login?error=unverified');

      const gate = signInGate({ sub: profile.sub, email });
      if (!gate.allowed) return res.redirect('/login?error=notinvited');

      const user = queries.upsertGoogleUser(
        { sub: profile.sub, email, name: profile.name, picture: profile.picture },
        config.adminEmails.includes(email)
      );
      if (gate.invite) queries.acceptInvite(gate.invite.id, user.id);
      if (user.is_blocked) return res.redirect('/login?error=blocked');

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
