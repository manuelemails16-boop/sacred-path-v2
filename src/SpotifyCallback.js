// src/SpotifyCallback.js
// This page handles the OAuth redirect from Spotify
import { useEffect, useState } from "react";
import { saveTokens } from "./spotify";

export default function SpotifyCallback({ onDone }) {
  const [status, setStatus] = useState("Connecting to Spotify…");

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const access_token  = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    const expires_in    = params.get("expires_in");
    const error         = params.get("error") || new URLSearchParams(window.location.search).get("spotify_error");

    if (error) {
      setStatus("Spotify connection failed: " + error);
      setTimeout(() => onDone(false), 2500);
      return;
    }

    if (access_token) {
      saveTokens({ access_token, refresh_token, expires_in: parseInt(expires_in, 10) });
      setStatus("Connected! Redirecting…");
      setTimeout(() => onDone(true), 800);
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
