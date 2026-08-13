'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware');
const { asyncHandler } = require('../util');

// Anchored and whitespace-free so a crafted address can't smuggle SMTP headers.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function newInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function parseServiceForm(body) {
  const errors = [];
  const name = String(body.name || '').trim();
  const slug = String(body.slug || '').trim().toLowerCase();
  const url = String(body.url || '').trim();
  const description = String(body.description || '').trim();
  const icon = String(body.icon || '').trim() || '🔗';
  const sortOrder = Number.parseInt(body.sort_order, 10);

  if (!name || name.length > 100) errors.push('Name is required (max 100 characters).');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
    errors.push('Slug must be lowercase letters, numbers, dashes or underscores (it becomes /api/authz/<slug>).');
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
  } catch {
    errors.push('URL must be a valid http(s) address.');
  }
  if (description.length > 300) errors.push('Description is too long (max 300 characters).');
  if (icon.length > 300) errors.push('Icon is too long (use an emoji or an image URL).');

  return {
    errors,
    values: {
      slug,
      name,
      description,
      url,
      icon,
      sort_order: Number.isFinite(sortOrder) ? sortOrder : 100,
      enabled: body.enabled === 'on' ? 1 : 0,
    },
  };
}

function adminRoutes({ queries, config, mailer }) {
  const router = express.Router();
  router.use('/admin', requireAuth, requireAdmin);

  router.get('/admin', (req, res) => res.redirect('/admin/users'));

  // ----- Users -----

  router.get('/admin/users', (req, res) => {
    res.render('admin/users', {
      title: 'Users',
      users: queries.listUsers(),
      services: queries.listServices(),
      grants: queries.grantsByUser(),
      invites: queries.listPendingInvites(),
      inviteServices: queries.inviteServicesByInvite(),
      mailEnabled: mailer.enabled,
      baseUrl: config.baseUrl,
      saved: req.query.saved === '1',
      invited: typeof req.query.invited === 'string' ? req.query.invited : null,
      error: typeof req.query.error === 'string' ? req.query.error : null,
    });
  });

  // ----- Invitations -----

  // Creating (or re-creating) an invite always succeeds; emailing it is
  // best-effort. The pending list always shows a copyable link, so the flow
  // works even with no SMTP configured.
  async function emailInvite(req, invite) {
    if (!mailer.enabled) return 'link';
    try {
      await mailer.sendInvite({
        to: invite.email,
        inviteUrl: `${config.baseUrl}/invite/${invite.token}`,
        invitedBy: req.user.name || req.user.email,
        expiryDays: config.inviteExpiryDays,
      });
      return 'sent';
    } catch (err) {
      console.error('Invite email failed:', err.message);
      return 'failed';
    }
  }

  router.post(
    '/admin/invites',
    asyncHandler(async (req, res) => {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 200) {
        return res.redirect('/admin/users?error=' + encodeURIComponent('Enter a valid email address.'));
      }
      if (queries.getUserByEmail(email)) {
        return res.redirect(
          '/admin/users?error=' + encodeURIComponent('That person already has an account — grant services below instead.')
        );
      }
      const validIds = new Set(queries.listServices().map((s) => s.id));
      const serviceIds = []
        .concat(req.body.services || [])
        .map((value) => Number(value))
        .filter((id) => validIds.has(id));

      const invite = queries.createInvite({
        email,
        token: newInviteToken(),
        invitedBy: req.user.email,
        expiryDays: config.inviteExpiryDays,
        serviceIds,
      });
      res.redirect(`/admin/users?invited=${await emailInvite(req, invite)}`);
    })
  );

  router.post(
    '/admin/invites/:id/resend',
    asyncHandler(async (req, res) => {
      const invite = queries.getInviteById(Number(req.params.id));
      if (!invite || invite.accepted_at) {
        return res.redirect('/admin/users?error=' + encodeURIComponent('Invitation not found.'));
      }
      queries.refreshInvite(invite.id, newInviteToken(), config.inviteExpiryDays);
      const fresh = queries.getInviteById(invite.id);
      res.redirect(`/admin/users?invited=${await emailInvite(req, fresh)}`);
    })
  );

  router.post('/admin/invites/:id/delete', (req, res) => {
    queries.deleteInvite(Number(req.params.id));
    res.redirect('/admin/users?saved=1');
  });

  router.post('/admin/users/:id', (req, res) => {
    const target = queries.getUserById(Number(req.params.id));
    if (!target) return res.redirect('/admin/users?error=User not found.');

    // Admins cannot demote or block themselves, so at least one active
    // admin always remains.
    const isSelf = target.id === req.user.id;
    const isAdmin = isSelf ? true : req.body.is_admin === 'on';
    const isBlocked = isSelf ? false : req.body.is_blocked === 'on';

    const validIds = new Set(queries.listServices().map((s) => s.id));
    const serviceIds = []
      .concat(req.body.services || [])
      .map((value) => Number(value))
      .filter((id) => validIds.has(id));

    queries.setUserFlags(target.id, isAdmin, isBlocked);
    queries.setUserServices(target.id, serviceIds);
    if (isBlocked) queries.deleteSessionsForUser(target.id); // sign them out everywhere
    res.redirect('/admin/users?saved=1');
  });

  router.post('/admin/users/:id/signout', (req, res) => {
    const target = queries.getUserById(Number(req.params.id));
    if (target) queries.deleteSessionsForUser(target.id);
    res.redirect('/admin/users?saved=1');
  });

  router.post('/admin/users/:id/delete', (req, res) => {
    const target = queries.getUserById(Number(req.params.id));
    if (!target) return res.redirect('/admin/users?error=User not found.');
    if (target.id === req.user.id) return res.redirect('/admin/users?error=You cannot delete yourself.');
    queries.deleteSessionsForUser(target.id);
    queries.deleteUser(target.id);
    res.redirect('/admin/users?saved=1');
  });

  // ----- Services -----

  router.get('/admin/services', (req, res) => {
    res.render('admin/services', {
      title: 'Services',
      services: queries.listServices(),
      counts: queries.grantCountByService(),
      saved: req.query.saved === '1',
    });
  });

  router.get('/admin/services/new', (req, res) => {
    res.render('admin/service-form', {
      title: 'Add service',
      heading: 'Add a service',
      action: '/admin/services',
      service: { slug: '', name: '', description: '', url: '', icon: '', sort_order: 100, enabled: 1 },
      errors: [],
    });
  });

  router.get('/admin/services/:id/edit', (req, res) => {
    const service = queries.getServiceById(Number(req.params.id));
    if (!service) return res.redirect('/admin/services');
    res.render('admin/service-form', {
      title: 'Edit service',
      heading: `Edit ${service.name}`,
      action: `/admin/services/${service.id}`,
      service,
      errors: [],
    });
  });

  router.post('/admin/services', (req, res) => {
    const { errors, values } = parseServiceForm(req.body);
    if (!errors.length) {
      try {
        queries.createService(values);
        return res.redirect('/admin/services?saved=1');
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) errors.push('A service with that slug already exists.');
        else throw err;
      }
    }
    res.status(400).render('admin/service-form', {
      title: 'Add service',
      heading: 'Add a service',
      action: '/admin/services',
      service: { ...values, id: null },
      errors,
    });
  });

  router.post('/admin/services/:id', (req, res) => {
    const existing = queries.getServiceById(Number(req.params.id));
    if (!existing) return res.redirect('/admin/services');
    const { errors, values } = parseServiceForm(req.body);
    if (!errors.length) {
      try {
        queries.updateService({ ...values, id: existing.id });
        return res.redirect('/admin/services?saved=1');
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) errors.push('A service with that slug already exists.');
        else throw err;
      }
    }
    res.status(400).render('admin/service-form', {
      title: 'Edit service',
      heading: `Edit ${existing.name}`,
      action: `/admin/services/${existing.id}`,
      service: { ...values, id: existing.id },
      errors,
    });
  });

  router.post('/admin/services/:id/delete', (req, res) => {
    queries.deleteService(Number(req.params.id));
    res.redirect('/admin/services?saved=1');
  });

  return router;
}

module.exports = { adminRoutes };
