'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { safeRedirectTarget, isEmailAllowed, asyncHandler } = require('../util');

const LOGIN_ERRORS = {
  state: 'Your sign-in attempt expired — please try again.',
  google: 'Google sign-in failed — please try again.',
  unverified: 'Your Google account email address is not verified.',
  notallowed: 'This Google account is not allowed to sign in here.',
  blocked: 'Your access has been disabled by the administrator.',
};

function authRoutes({ config, queries, google }) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(safeRedirectTarget(req.query.rd, config));
    res.render('login', {
      title: 'Sign in',
      rd: typeof req.query.rd === 'string' ? req.query.rd : '',
      error: LOGIN_ERRORS[req.query.error] || null,
      signedOut: req.query.signedout === '1',
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
      if (!isEmailAllowed(email, config)) return res.redirect('/login?error=notallowed');

      const user = queries.upsertGoogleUser(
        { sub: profile.sub, email, name: profile.name, picture: profile.picture },
        config.adminEmails.includes(email)
      );
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
  if (config.testLogin) {
    router.post('/test/login', (req, res, next) => {
      const email = String((req.body && req.body.email) || '').toLowerCase();
      if (!email) return res.status(400).send('email required');
      if (!isEmailAllowed(email, config)) return res.status(403).send('not allowed');
      const user = queries.upsertGoogleUser(
        { sub: `test:${email}`, email, name: req.body.name || email, picture: null },
        config.adminEmails.includes(email)
      );
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
