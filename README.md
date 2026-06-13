# Sacred Path v2 — Netlify + Spotify

## Deploy to Netlify

### Step 1 — Get your Spotify Client Secret
1. Go to https://developer.spotify.com/dashboard
2. Click your Sacred Path app
3. Click "View client secret" — copy it

### Step 2 — Deploy on Netlify
1. Go to https://netlify.com and sign up (free)
2. Click "Add new site" → "Deploy manually"
3. Drag your entire `sacred-path-netlify` folder onto the upload area
4. Wait for it to deploy — you'll get a URL like `random-name.netlify.app`

### Step 3 — Rename your site
1. In Netlify → Site configuration → Site details → Change site name
2. Set it to `sacred-path` so your URL is `sacred-path.netlify.app`

### Step 4 — Set environment variables
1. In Netlify → Site configuration → Environment variables → Add variable:
   - `SPOTIFY_CLIENT_ID` = `688c788429e44c29bedb5169d098a980`
   - `SPOTIFY_CLIENT_SECRET` = (paste your secret from Step 1)
   - `SPOTIFY_REDIRECT_URI` = `https://sacred-path.netlify.app/callback`
   - `REACT_APP_SPOTIFY_CLIENT_ID` = `688c788429e44c29bedb5169d098a980`

### Step 5 — Update Spotify redirect URI
1. Go back to https://developer.spotify.com/dashboard → your app → Edit
2. Add redirect URI: `https://sacred-path.netlify.app/callback`
3. Save

### Step 6 — Trigger a redeploy
In Netlify → Deploys → Trigger deploy → Deploy site

### Step 7 — Update Firebase config
Open `src/firebase.js` and make sure your Firebase config is pasted in (same as before).

---

## How it works
- Users click "Connect Spotify" → logs in with their Spotify account
- Type any song → live results appear from Spotify's library
- Click "+ Add" → song is added directly to the Sacred Path Worship playlist
- Everyone can see the playlist and play songs on Spotify
