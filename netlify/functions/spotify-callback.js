// netlify/functions/spotify-callback.js
// Handles the OAuth callback from Spotify, exchanges code for tokens
exports.handler = async (event) => {
  const { code, error } = event.queryStringParameters || {};

  if (error) {
    return {
      statusCode: 302,
      headers: { Location: "/?spotify_error=" + error },
    };
  }

  if (!code) {
    return { statusCode: 400, body: "Missing code" };
  }

  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri  = process.env.SPOTIFY_REDIRECT_URI;

  const creds = Buffer.from(clientId + ":" + clientSecret).toString("base64");

  try {
    const resp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + creds,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:   "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    const data = await resp.json();

    if (data.error) {
      return {
        statusCode: 302,
        headers: { Location: "/?spotify_error=" + data.error },
      };
    }

    // Pass tokens back to the app via URL hash (never in query string for security)
    const params = new URLSearchParams({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_in:    data.expires_in,
    });

    return {
      statusCode: 302,
      headers: { Location: "/callback#" + params.toString() },
    };
  } catch (err) {
    return {
      statusCode: 302,
      headers: { Location: "/?spotify_error=server_error" },
    };
  }
};
