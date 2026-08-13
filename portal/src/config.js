'use strict';

function parseList(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  const missing = [];
  const need = (name) => {
    const value = (env[name] || '').trim();
    if (!value) missing.push(name);
    return value;
  };

  const baseUrl = need('BASE_URL').replace(/\/+$/, '');
  const googleClientId = need('GOOGLE_CLIENT_ID');
  const googleClientSecret = need('GOOGLE_CLIENT_SECRET');
  const sessionSecret = need('SESSION_SECRET');

  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. See portal/.env.example.`
    );
  }

  const isTest = env.NODE_ENV === 'test';
  if (sessionSecret.length < 32 && !isTest) {
    throw new Error('SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32');
  }

  let baseHost;
  try {
    baseHost = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`BASE_URL is not a valid URL: ${baseUrl}`);
  }

  const cookieDomain = (env.COOKIE_DOMAIN || '').trim().replace(/^\./, '').toLowerCase() || null;

  const smtpPort = Number(env.SMTP_PORT) || 587;
  const smtpUser = (env.SMTP_USER || '').trim() || null;

  return {
    baseUrl,
    baseHost,
    port: Number(env.PORT) || 8899,
    dataDir: env.DATA_DIR || './data',
    googleClientId,
    googleClientSecret,
    sessionSecret,
    adminEmails: parseList(env.ADMIN_EMAILS),
    allowedEmails: parseList(env.ALLOWED_EMAILS),
    allowedEmailDomains: parseList(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.replace(/^@/, '')),
    cookieDomain,
    portalName: env.PORTAL_NAME || 'lordblight.com',
    sessionMaxAgeDays: Number(env.SESSION_MAX_AGE_DAYS) || 7,
    secureCookies: baseUrl.startsWith('https://'),
    testLogin: env.PORTAL_TEST_LOGIN === '1' && isTest,
    inviteExpiryDays: Number(env.INVITE_EXPIRY_DAYS) || 14,
    smtpHost: (env.SMTP_HOST || '').trim() || null,
    smtpPort,
    // Explicit SMTP_SECURE wins; otherwise implicit TLS on 465, STARTTLS elsewhere.
    smtpSecure: env.SMTP_SECURE != null ? env.SMTP_SECURE === 'true' : smtpPort === 465,
    smtpUser,
    smtpPass: env.SMTP_PASS || null,
    mailFrom: (env.MAIL_FROM || '').trim() || smtpUser,
  };
}

module.exports = { loadConfig, parseList };
