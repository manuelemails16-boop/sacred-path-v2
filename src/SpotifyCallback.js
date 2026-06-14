// src/SpotifyCallback.js
import { useEffect, useState } from "react";
import { saveTokens } from "./spotify";

export default function SpotifyCallback({ onDone }) {
  const [status, setStatus] = useState("Connecting to Spotify…");

  useEffect(() => {
    // Tokens come in the hash fragment
    const hash = window.location.hash.slice(1);
    const hashParams = new URLSearchParams(hash);
    const access_token  = hashParams.get("access_token");
    const refresh_token = hashParams.get("refresh_token");
    const expires_in    = hashParams.get("expires_in");

    // Only treat as error if there are NO tokens
    const queryError = new URLSearchParams(window.location.search).get("spotify_error");

    if (access_token) {
      // Success — save tokens regardless of any query string error
      saveTokens({ access_token, refresh_token, expires_in: parseInt(expires_in, 10) });
      setStatus("Connected! Redirecting…");
      setTimeout(() => onDone(true), 800);
    } else if (queryError) {
      setStatus("Spotify connection failed: " + queryError);
      setTimeout(() => onDone(false), 2500);
    } else {
      setStatus("Something went wrong. Please try again.");
      setTimeout(() => onDone(false), 2500);
    }
  }, []);

  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:16, fontFamily:"Georgia,serif", background:"#F7F3EC", color:"#1B2A4A" }}>
      <div style={{ fontSize:32, color:"#1DB954" }}>♪</div>
      <div style={{ fontSize:16 }}>{status}</div>
    </div>
  );
}
