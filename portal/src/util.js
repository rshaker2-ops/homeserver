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

// Validates the ?rd= of the native-app token flow: a custom-scheme URL like
// hearth://portal-callback. Only allowlisted schemes are accepted and no
// query/fragment is allowed (the portal appends ?token=… itself), so a token
// can never be sent to an app the operator didn't opt into.
function safeAppRedirectTarget(raw, config) {
  if (!raw || typeof raw !== 'string' || raw.length > 200) return null;
  const match = /^([a-z][a-z0-9+.-]*):\/\/[A-Za-z0-9._~/-]*$/.exec(raw);
  if (!match || !config.appCallbackSchemes.includes(match[1])) return null;
  return raw;
}

// HTTP header values must be latin1 with no control characters.
function headerSafe(value) {
  return String(value ?? '').replace(/[^\x20-\x7E]/g, '').slice(0, 200);
}

// Emails that may sign in WITHOUT an invitation: admins (so the portal can
// always be bootstrapped) plus the optional ALLOWED_* lists. Everyone else
// needs a pending invite — registration is invitation-only.
function isEmailAllowlisted(email, config) {
  const { adminEmails, allowedEmails, allowedEmailDomains } = config;
  if (adminEmails.includes(email)) return true;
  if (allowedEmails.includes(email)) return true;
  const domain = email.split('@')[1] || '';
  return allowedEmailDomains.includes(domain);
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { safeRedirectTarget, safeAppRedirectTarget, headerSafe, isEmailAllowlisted, asyncHandler };
