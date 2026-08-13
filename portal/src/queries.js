'use strict';

function createQueries(db) {
  const stmts = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userBySub: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ? ORDER BY id LIMIT 1'),
    insertUser: db.prepare(
      `INSERT INTO users (google_sub, email, name, picture, is_admin, last_login_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ),
    updateUserLogin: db.prepare(
      `UPDATE users SET email = ?, name = ?, picture = ?, is_admin = MAX(is_admin, ?),
         last_login_at = datetime('now')
       WHERE google_sub = ?`
    ),
    listUsers: db.prepare('SELECT * FROM users ORDER BY created_at DESC, id DESC'),
    setFlags: db.prepare('UPDATE users SET is_admin = ?, is_blocked = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),

    listServices: db.prepare('SELECT * FROM services ORDER BY sort_order, name'),
    listEnabledServices: db.prepare('SELECT * FROM services WHERE enabled = 1 ORDER BY sort_order, name'),
    serviceById: db.prepare('SELECT * FROM services WHERE id = ?'),
    serviceBySlug: db.prepare('SELECT * FROM services WHERE slug = ?'),
    insertService: db.prepare(
      `INSERT INTO services (slug, name, description, url, icon, sort_order, enabled)
       VALUES (@slug, @name, @description, @url, @icon, @sort_order, @enabled)`
    ),
    updateService: db.prepare(
      `UPDATE services SET slug = @slug, name = @name, description = @description, url = @url,
         icon = @icon, sort_order = @sort_order, enabled = @enabled
       WHERE id = @id`
    ),
    deleteService: db.prepare('DELETE FROM services WHERE id = ?'),

    allGrants: db.prepare('SELECT user_id, service_id FROM user_services'),
    grantCounts: db.prepare('SELECT service_id, COUNT(*) AS count FROM user_services GROUP BY service_id'),
    clearGrants: db.prepare('DELETE FROM user_services WHERE user_id = ?'),
    addGrant: db.prepare('INSERT OR IGNORE INTO user_services (user_id, service_id) VALUES (?, ?)'),
    hasGrant: db.prepare('SELECT 1 AS yes FROM user_services WHERE user_id = ? AND service_id = ?'),
    servicesForUser: db.prepare(
      `SELECT s.* FROM services s
       JOIN user_services us ON us.service_id = s.id
       WHERE us.user_id = ? AND s.enabled = 1
       ORDER BY s.sort_order, s.name`
    ),

    deleteSessionsForUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  };

  // Users are keyed by the immutable Google `sub`; email/name/picture refresh
  // on every login, and ADMIN_EMAILS promotion is applied on every login too
  // (it never demotes — admins made via the UI stay admins).
  function upsertGoogleUser({ sub, email, name, picture }, isAdminEmail) {
    const existing = stmts.userBySub.get(sub);
    if (existing) {
      stmts.updateUserLogin.run(email, name || null, picture || null, isAdminEmail ? 1 : 0, sub);
    } else {
      stmts.insertUser.run(sub, email, name || null, picture || null, isAdminEmail ? 1 : 0);
    }
    return stmts.userBySub.get(sub);
  }

  const setUserServices = db.transaction((userId, serviceIds) => {
    stmts.clearGrants.run(userId);
    for (const serviceId of serviceIds) stmts.addGrant.run(userId, serviceId);
  });

  function servicesVisibleTo(user) {
    if (!user || user.is_blocked) return [];
    if (user.is_admin) return stmts.listEnabledServices.all();
    return stmts.servicesForUser.all(user.id);
  }

  // Single source of truth for enforcement (dashboard tiles AND the
  // forward-auth endpoint). Fails closed on unknown or disabled services.
  function userCanAccess(user, slug) {
    if (!user || user.is_blocked) return false;
    const service = stmts.serviceBySlug.get(slug);
    if (!service || !service.enabled) return false;
    if (user.is_admin) return true;
    return Boolean(stmts.hasGrant.get(user.id, service.id));
  }

  function grantsByUser() {
    const map = new Map();
    for (const row of stmts.allGrants.all()) {
      if (!map.has(row.user_id)) map.set(row.user_id, new Set());
      map.get(row.user_id).add(row.service_id);
    }
    return map;
  }

  function grantCountByService() {
    const map = new Map();
    for (const row of stmts.grantCounts.all()) map.set(row.service_id, row.count);
    return map;
  }

  return {
    getUserById: (id) => stmts.userById.get(id),
    getUserByEmail: (email) => stmts.userByEmail.get(email),
    listUsers: () => stmts.listUsers.all(),
    upsertGoogleUser,
    setUserFlags: (id, isAdmin, isBlocked) => stmts.setFlags.run(isAdmin ? 1 : 0, isBlocked ? 1 : 0, id),
    deleteUser: (id) => stmts.deleteUser.run(id),
    listServices: () => stmts.listServices.all(),
    listEnabledServices: () => stmts.listEnabledServices.all(),
    getServiceById: (id) => stmts.serviceById.get(id),
    getServiceBySlug: (slug) => stmts.serviceBySlug.get(slug),
    createService: (service) => stmts.insertService.run(service),
    updateService: (service) => stmts.updateService.run(service),
    deleteService: (id) => stmts.deleteService.run(id),
    setUserServices,
    servicesVisibleTo,
    userCanAccess,
    grantsByUser,
    grantCountByService,
    deleteSessionsForUser: (userId) => stmts.deleteSessionsForUser.run(userId),
  };
}

module.exports = { createQueries };
