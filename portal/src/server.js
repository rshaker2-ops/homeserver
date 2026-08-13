'use strict';

const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const { app } = createApp(config);

app.listen(config.port, '0.0.0.0', () => {
  console.log(`${config.portalName} portal listening on :${config.port} (public URL: ${config.baseUrl})`);
  if (!config.adminEmails.length) {
    console.warn('WARNING: ADMIN_EMAILS is empty — nobody will have admin access to manage users.');
  }
});
