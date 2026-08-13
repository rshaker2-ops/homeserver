'use strict';

const crypto = require('node:crypto');

function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; " +
      "form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
  );
  next();
}

// Loads the user fresh from the DB on every request, so blocking a user or
// revoking a grant takes effect immediately — sessions never cache roles.
function attachUser(queries) {
  return (req, res, next) => {
    req.user = null;
    const id = req.session && req.session.userId;
    if (id) {
      const user = queries.getUserById(id);
      if (user) req.user = user;
      else req.session.userId = null;
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.redirect(`/login?rd=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin || req.user.is_blocked) {
    return res.status(403).render('error', {
      title: 'Forbidden',
      status: 403,
      message: 'You need administrator access for this page.',
    });
  }
  next();
}

function tokensMatch(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Session-token CSRF for the portal's own forms. /api/* is exempt: the
// forward-auth endpoint must stay side-effect-free and never mint sessions.
function csrfProtection(config) {
  return (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    if (config.testLogin && req.path === '/test/login') return next();

    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      // Mint tokens only for signed-in page views: forms only exist there,
      // and anonymous GETs must not create session rows.
      if (req.user && req.session && !req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(24).toString('hex');
      }
      res.locals.csrfToken = (req.session && req.session.csrfToken) || '';
      return next();
    }

    const expected = req.session && req.session.csrfToken;
    const provided = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
    if (!expected || !provided || !tokensMatch(provided, expected)) {
      return res.status(403).render('error', {
        title: 'Forbidden',
        status: 403,
        message: 'Invalid or expired form token. Go back, reload the page and try again.',
      });
    }
    res.locals.csrfToken = expected;
    next();
  };
}

module.exports = { securityHeaders, attachUser, requireAuth, requireAdmin, csrfProtection };
