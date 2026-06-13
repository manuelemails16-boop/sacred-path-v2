// netlify/functions/spotify-refresh.js
// Refreshes an expired Spotify access token
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const { refresh_token } = JSON.parse(event.body || "{}");
  if (!refresh_token) return { statusCode: 400, body: "Missing refresh_token" };

  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const creds = Buffer.from(clientId + ":" + clientSecret).toString("base64");

  try {
    const resp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + creds,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token,
      }).toString(),
    });

    const data = await resp.json();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: data.access_token,
        expires_in:   data.expires_in,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: "Refresh failed" };
  }
};
