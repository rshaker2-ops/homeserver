'use strict';

const nodemailer = require('nodemailer');

// Invitation email delivery. SMTP is optional: without SMTP_HOST the portal
// still creates invites and the admin copies the invite link out of the UI.
function createMailer(config) {
  if (!config.smtpHost) {
    return {
      enabled: false,
      sendInvite: async () => {
        throw new Error('SMTP is not configured (set SMTP_HOST)');
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });

  async function sendInvite({ to, inviteUrl, invitedBy, expiryDays }) {
    const name = config.portalName;
    const text = [
      `${invitedBy} invited you to ${name}.`,
      '',
      `Open your invitation and sign in with your Google account (${to}):`,
      inviteUrl,
      '',
      `The invitation expires in ${expiryDays} days. If you weren't expecting this, you can ignore it.`,
    ].join('\n');
    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1f2430">
        <h2 style="margin:0 0 12px">You're invited to ${escapeHtml(name)}</h2>
        <p style="margin:0 0 16px">${escapeHtml(invitedBy)} invited you to ${escapeHtml(name)}.
        Open the invitation and sign in with your Google account (<strong>${escapeHtml(to)}</strong>).</p>
        <p style="margin:0 0 24px">
          <a href="${escapeHtml(inviteUrl)}" style="background:#5b54e8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Open your invitation</a>
        </p>
        <p style="margin:0;color:#6b7280;font-size:13px">Or paste this link into your browser:<br>${escapeHtml(inviteUrl)}</p>
        <p style="margin:16px 0 0;color:#6b7280;font-size:13px">The invitation expires in ${Number(expiryDays)} days.
        If you weren't expecting this, you can ignore it.</p>
      </div>`;

    await transport.sendMail({
      from: config.mailFrom,
      to,
      subject: `${invitedBy} invited you to ${name}`,
      text,
      html,
    });
  }

  return { enabled: true, sendInvite };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

module.exports = { createMailer };
