'use strict';

const express = require('express');
const { requireAuth } = require('../middleware');

function portalRoutes({ queries }) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    res.render('dashboard', {
      title: 'Your services',
      services: queries.servicesVisibleTo(req.user),
    });
  });

  // Target of the proxy's 403 redirect: signed in, but no grant for that service.
  router.get('/denied', requireAuth, (req, res) => {
    const slug = typeof req.query.service === 'string' ? req.query.service : '';
    const service = slug ? queries.getServiceBySlug(slug) : null;
    res.status(403).render('denied', {
      title: 'No access',
      serviceName: service ? service.name : null,
    });
  });

  return router;
}

module.exports = { portalRoutes };
