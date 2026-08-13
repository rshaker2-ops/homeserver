'use strict';

const path = require('node:path');
const express = require('express');
const session = require('express-session');

const { openDb } = require('./db');
const { createQueries } = require('./queries');
const { SqliteSessionStore } = require('./session-store');
const { createGoogleAuth } = require('./google');
const { securityHeaders, attachUser, csrfProtection } = require('./middleware');
const { authRoutes } = require('./routes/auth');
const { portalRoutes } = require('./routes/portal');
const { authzRoutes } = require('./routes/authz');
const { adminRoutes } = require('./routes/admin');

function createApp(config) {
  const db = openDb(config.dataDir);
  const queries = createQueries(db);
  const google = createGoogleAuth(config);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', true); // behind Nginx Proxy Manager
  app.disable('x-powered-by');
  app.locals.portalName = config.portalName;

  app.use(securityHeaders);
  app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(
    session({
      store: new SqliteSessionStore(db),
      secret: config.sessionSecret,
      name: 'portal_session',
      resave: false,
      saveUninitialized: false,
      rolling: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax', // Lax is required for the Google OAuth redirect back
        secure: config.secureCookies,
        domain: config.cookieDomain || undefined,
        maxAge: config.sessionMaxAgeDays * 86_400_000,
      },
    })
  );
  app.use(express.urlencoded({ extended: false }));
  app.use(attachUser(queries));
  app.use(csrfProtection(config));
  app.use((req, res, next) => {
    res.locals.user = req.user;
    res.locals.currentPath = req.path;
    next();
  });

  app.use(authRoutes({ config, queries, google }));
  app.use(authzRoutes({ queries }));
  app.use(portalRoutes({ queries }));
  app.use(adminRoutes({ queries }));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', status: 404, message: "That page doesn't exist." });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).render('error', { title: 'Error', status: 500, message: 'Something went wrong.' });
  });

  return { app, db, queries, config };
}

module.exports = { createApp };
