// src/spotify.js
// Spotify API helpers — search, add to playlist, OAuth flow

const PLAYLIST_ID = "0ZT6N4Jr8pcF6wLpVlSKPA"; // Sacred Path Worship playlist
const SCOPES = [
  "playlist-modify-public",
  "playlist-modify-private",
  "playlist-read-collaborative",
].join(" ");

const TOKEN_KEY  = "sp_spotify_token";
const EXPIRE_KEY = "sp_spotify_expires";
const REFRESH_KEY = "sp_spotify_refresh";

// ── Auth ──────────────────────────────────────────────────────────────────────
export function getClientId() {
  return process.env.REACT_APP_SPOTIFY_CLIENT_ID || "";
}

export function getRedirectUri() {
  return window.location.origin + "/callback";
}

export function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id:     getClientId(),
    response_type: "code",
    redirect_uri:  getRedirectUri(),
    scope:         SCOPES,
    show_dialog:   "false",
  });
  return "https://accounts.spotify.com/authorize?" + params.toString();
}

export function saveTokens({ access_token, refresh_token, expires_in }) {
  localStorage.setItem(TOKEN_KEY, access_token);
  localStorage.setItem(REFRESH_KEY, refresh_token);
  localStorage.setItem(EXPIRE_KEY, String(Date.now() + expires_in * 1000));
}

export function getAccessToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}

export function isTokenExpired() {
  const exp = localStorage.getItem(EXPIRE_KEY);
  if (!exp) return true;
  return Date.now() > parseInt(exp, 10) - 60000; // refresh 1 min early
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRE_KEY);
}

export function isConnected() {
  return !!getAccessToken() && !isTokenExpired();
}

// ── Token refresh ─────────────────────────────────────────────────────────────
export async function refreshAccessToken() {
  const refresh_token = getRefreshToken();
  if (!refresh_token) return null;
  try {
    const resp = await fetch("/.netlify/functions/spotify-refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token }),
    });
    const data = await resp.json();
    if (data.access_token) {
      localStorage.setItem(TOKEN_KEY, data.access_token);
      localStorage.setItem(EXPIRE_KEY, String(Date.now() + data.expires_in * 1000));
      return data.access_token;
    }
  } catch (e) {}
  return null;
}

// ── API call wrapper ──────────────────────────────────────────────────────────
async function spotifyFetch(url, options = {}) {
  let token = getAccessToken();
  if (isTokenExpired()) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Not authenticated");
  }
  const resp = await fetch("https://api.spotify.com/v1" + url, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || "Spotify error " + resp.status);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

// ── Search ────────────────────────────────────────────────────────────────────
export async function searchTracks(query) {
  if (!query.trim()) return [];
  const data = await spotifyFetch(
    "/search?q=" + encodeURIComponent(query) + "&type=track&limit=6"
  );
  return (data?.tracks?.items || []).map(t => ({
    id:       t.id,
    uri:      t.uri,
    name:     t.name,
    artist:   t.artists.map(a => a.name).join(", "),
    album:    t.album.name,
    image:    t.album.images?.[2]?.url || t.album.images?.[0]?.url || null,
    preview:  t.preview_url,
    spotifyUrl: t.external_urls.spotify,
  }));
}

// ── Add to playlist ───────────────────────────────────────────────────────────
export async function addToPlaylist(trackUri) {
  await spotifyFetch("/playlists/" + PLAYLIST_ID + "/tracks", {
    method: "POST",
    body: JSON.stringify({ uris: [trackUri] }),
  });
}

// ── Get playlist tracks ───────────────────────────────────────────────────────
export async function getPlaylistTracks() {
  const data = await spotifyFetch(
    "/playlists/" + PLAYLIST_ID + "/tracks?fields=items(track(id,name,artists,album,external_urls,preview_url))&limit=50"
  );
  return (data?.items || [])
    .filter(i => i.track)
    .map(i => ({
      id:         i.track.id,
      name:       i.track.name,
      artist:     i.track.artists.map(a => a.name).join(", "),
      album:      i.track.album.name,
      spotifyUrl: i.track.external_urls.spotify,
    }));
}
