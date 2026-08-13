'use strict';

const express = require('express');
const { headerSafe } = require('../util');

// Forward-auth endpoint consumed by Nginx Proxy Manager's auth_request.
// Contract: 200 = allow (with identity headers), 401 = not signed in,
// 403 = signed in but denied (no grant / blocked / unknown / disabled).
// nginx passes the original request method through on subrequests, so this
// must accept ALL methods — a GET-only route would 404 on proxied POSTs.
function authzRoutes({ queries }) {
  const router = express.Router();

  router.all('/api/authz/:slug', (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).type('text').send('unauthenticated');
    if (!queries.userCanAccess(user, req.params.slug)) {
      return res.status(403).type('text').send('forbidden');
    }
    res.set('Remote-User', headerSafe(user.email.split('@')[0]));
    res.set('Remote-Email', headerSafe(user.email));
    res.set('Remote-Name', headerSafe(user.name || ''));
    res.set('Remote-Groups', user.is_admin ? 'admins' : 'users');
    res.status(200).type('text').send('ok');
  });

  // Small identity endpoint, handy when debugging proxy configuration.
  router.get('/api/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    res.json({
      email: req.user.email,
      name: req.user.name,
      admin: Boolean(req.user.is_admin),
      blocked: Boolean(req.user.is_blocked),
      services: queries.servicesVisibleTo(req.user).map((s) => s.slug),
    });
  });

  return router;
}

module.exports = { authzRoutes };
