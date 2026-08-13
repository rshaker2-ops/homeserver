'use strict';

// Validates a post-login redirect target. Anything that fails validation
// falls back to "/" — this is the open-redirect defense for ?rd=.
function safeRedirectTarget(raw, config) {
  if (!raw || typeof raw !== 'string') return '/';
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')) return raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '/';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '/';
  const host = url.hostname.toLowerCase();
  if (host === config.baseHost) return url.toString();
  if (config.cookieDomain) {
    if (host === config.cookieDomain || host.endsWith(`.${config.cookieDomain}`)) {
      return url.toString();
    }
  }
  return '/';
}

// HTTP header values must be latin1 with no control characters.
function headerSafe(value) {
  return String(value ?? '').replace(/[^\x20-\x7E]/g, '').slice(0, 200);
}

function isEmailAllowed(email, config) {
  const { adminEmails, allowedEmails, allowedEmailDomains } = config;
  if (!allowedEmails.length && !allowedEmailDomains.length) return true;
  if (adminEmails.includes(email)) return true;
  if (allowedEmails.includes(email)) return true;
  const domain = email.split('@')[1] || '';
  return allowedEmailDomains.includes(domain);
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { safeRedirectTarget, headerSafe, isEmailAllowed, asyncHandler };
