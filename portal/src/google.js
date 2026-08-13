'use strict';

const { OAuth2Client } = require('google-auth-library');

function createGoogleAuth(config) {
  const redirectUri = `${config.baseUrl}/auth/google/callback`;
  const newClient = () => new OAuth2Client(config.googleClientId, config.googleClientSecret, redirectUri);

  return {
    async beginAuth(state) {
      const client = newClient();
      const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
      const url = client.generateAuthUrl({
        scope: ['openid', 'email', 'profile'],
        state,
        prompt: 'select_account',
        code_challenge_method: 'S256',
        code_challenge: codeChallenge,
      });
      return { url, codeVerifier };
    },

    // Exchanges the authorization code and returns the verified ID-token
    // payload (sub, email, email_verified, name, picture).
    async completeAuth(code, codeVerifier) {
      const client = newClient();
      const { tokens } = await client.getToken({ code, codeVerifier });
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.googleClientId,
      });
      return ticket.getPayload();
    },
  };
}

module.exports = { createGoogleAuth };
