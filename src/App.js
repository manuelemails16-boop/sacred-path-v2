import { useState, useEffect, useCallback } from "react";
import { ref, onValue, set, get, remove } from "firebase/database";
import { db } from "./firebase";
import {
  SCHEDULE, getTotalRead, getCompletionPct, getStreak,
  AVATAR_COLORS, MEDALS
} from "./planData";
import { getTodaysVerse } from "./verses";
import SpotifyCallback from "./SpotifyCallback";
import {
  buildAuthUrl, isConnected, clearTokens,
  searchTracks, addToPlaylist, getPlaylistTracks,
  getAccessToken, isTokenExpired, refreshAccessToken
} from "./spotify";

const MAX_USERS = 20;
const ADMIN_NAME = "Manny";
const ROOT = "sacredpath_v2";
// memberships = [{mode:'solo'|'group', groupId?, userIdx}]
// activeCtx = index into memberships
const SESSION_KEY = "sp_session_v3";
const USER_ID_KEY = "sp_user_id";
function getOrCreateUserId() {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) { id = mkId()+mkId(); localStorage.setItem(USER_ID_KEY, id); }
  return id;
}

function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; } }
function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }
function mkId() { return Math.random().toString(36).slice(2, 9); }
function buildLeaderboard(users) {
  return [...(users||[])].map((u,i)=>({...u,idx:i,total:getTotalRead(u.checked||{}),streak:getStreak(u.checked||{}),pct:getCompletionPct(u.checked||{})})).sort((a,b)=>b.total-a.total||b.streak-a.streak);
}

export default function App() {
  const [groups, setGroups]         = useState({});
  const [soloData, setSoloData]     = useState({users:[],startDate:null});
  const [memberships, setMemberships] = useState([]); // [{mode,groupId?,userIdx}]
  const [activeCtx, setActiveCtx]   = useState(0);
  const [view, setView]             = useState("home");
  const [planDay, setPlanDay]       = useState(1);
  const [toast, setToast]           = useState(null);
  const [expandWeek, setExpandWeek] = useState(null);
  const [loaded, setLoaded]         = useState(false);
  const [syncing, setSyncing]       = useState(false);
  const [modal, setModal]           = useState(null);
  const [music, setMusic]           = useState([]); // [{id,name,artist,note,addedBy,addedAt}]
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [playlistTracks, setPlaylistTracks] = useState([]);
  const [spotifyUrl, setSpotifyUrl] = useState(""); // admin-set collaborative playlist URL
  const [progress, setProgress]     = useState({}); // {userId: {checked:{}}}

  // Firebase
  useEffect(() => {
    const u1 = onValue(ref(db, ROOT+"/groups"), snap => setGroups(snap.exists()?snap.val():{}));
    const u2 = onValue(ref(db, ROOT+"/solo"),   snap => setSoloData(snap.exists()?snap.val():{users:[],startDate:null}));
    const u3 = onValue(ref(db, ROOT+"/progress"), snap => setProgress(snap.exists()?snap.val():{}));
    const u4 = onValue(ref(db, ROOT+"/music"), snap => {
      if (snap.exists()) {
        const d = snap.val();
        setMusic(d.songs ? Object.entries(d.songs).map(([id,v])=>({id,...v})).sort((a,b)=>b.addedAt-a.addedAt) : []);
        setSpotifyUrl(d.playlistUrl || "");
      }
    });
    setSpotifyConnected(isConnected());
    const s = loadSession();
    if (s) { setMemberships(s.memberships||[]); setActiveCtx(s.activeCtx||0); }
    setLoaded(true);
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  // Persist session
  useEffect(() => {
    if (memberships.length > 0) saveSession({memberships, activeCtx});
  }, [memberships, activeCtx]);

  // Current context
  const ctx = memberships[activeCtx] || null;
  const activeGroup = ctx?.groupId ? groups[ctx.groupId] : null;
  const startDate = ctx?.mode==="group" ? activeGroup?.startDate : soloData.startDate;

  useEffect(() => {
    if (!startDate) { setPlanDay(1); return; }
    const diff = Math.floor((Date.now()-new Date(startDate).getTime())/86400000)+1;
    setPlanDay(Math.max(1,Math.min(365,diff)));
  }, [startDate]);

  const showToast = (msg) => { setToast(msg); setTimeout(()=>setToast(null),3000); };

  // Current user object
  const me = (() => {
    if (!ctx) return null;
    let baseUser = null;
    if (ctx.mode==="solo") baseUser = soloData.users?.[ctx.userIdx]||null;
    if (ctx.mode==="group"&&ctx.groupId) baseUser = groups[ctx.groupId]?.users?.[ctx.userIdx]||null;
    if (!baseUser) return null;
    // Read progress from central store using userId
    const userId = baseUser.userId || getOrCreateUserId();
    const checked = (progress[userId]||{}).checked || {};
    return {...baseUser, checked, userId};
  })();

  const isAdmin = me?.name===ADMIN_NAME||me?.role==="admin";
  const activeUsers = ctx?.mode==="group" ? (activeGroup?.users||[]) : (soloData.users||[]);
  // Enrich users with their progress from central store
  const enrichedUsers = activeUsers.map(u => {
    const uid = u.userId;
    const checked = uid ? ((progress[uid]||{}).checked||{}) : (u.checked||{});
    return {...u, checked};
  });
  const leaderboard = buildLeaderboard(enrichedUsers);

  // Save helpers
  const saveGroup = useCallback(async (gid, data) => {
    setSyncing(true); await set(ref(db,ROOT+"/groups/"+gid),data); setSyncing(false);
  },[]);
  const saveSolo = useCallback(async (data) => {
    setSyncing(true); await set(ref(db,ROOT+"/solo"),data); setSyncing(false);
  },[]);
  const saveProgress = useCallback(async (userId, checked) => {
    await set(ref(db,ROOT+"/progress/"+userId), {checked});
  },[]);

  // Music helpers
  const addSong = async (name, artist, note) => {
    if (!name||!artist) return "Enter song name and artist.";
    const snap = await get(ref(db, ROOT+"/music/songs"));
    const existing = snap.exists() ? snap.val() : {};
    if (Object.keys(existing).length >= 100) return "Playlist is full (100 songs max).";
    const id = mkId();
    await set(ref(db, ROOT+"/music/songs/"+id), {
      name: name.trim(), artist: artist.trim(),
      note: note.trim(), addedBy: me?.name||"Anonymous",
      addedAt: Date.now()
    });
    return null;
  };
  const deleteSong = async (id) => {
    await remove(ref(db, ROOT+"/music/songs/"+id));
    showToast("Song removed.");
  };
  const setPlaylistUrl = async (url) => {
    await set(ref(db, ROOT+"/music/playlistUrl"), url);
    showToast("Playlist link saved!");
  };
  const connectSpotify = () => { window.location.href = buildAuthUrl(); };
  const disconnectSpotify = () => { clearTokens(); setSpotifyConnected(false); setPlaylistTracks([]); showToast("Spotify disconnected."); };
  const loadPlaylistTracks = async () => {
    try { const tracks = await getPlaylistTracks(); setPlaylistTracks(tracks); } catch(e) {}
  };

  const toggleMusicPermission = async (mode, groupId, userIdx) => {
    // Toggle musicDisabled flag on a user
    if (mode==="solo") {
      const snap = await get(ref(db, ROOT+"/solo"));
      const fresh = snap.exists()?snap.val():soloData;
      const users = (fresh.users||[]).map((u,i)=>i===userIdx?{...u,musicDisabled:!u.musicDisabled}:u);
      await saveSolo({...fresh,users});
    } else {
      const snap = await get(ref(db, ROOT+"/groups/"+groupId));
      const fresh = snap.exists()?snap.val():groups[groupId];
      const users = (fresh.users||[]).map((u,i)=>i===userIdx?{...u,musicDisabled:!u.musicDisabled}:u);
      await saveGroup(groupId,{...fresh,users});
    }
    showToast("Music permission updated.");
  };
  const canAddMusic = me && !me.musicDisabled;

  // Check if already member of a context
  const alreadyMember = (mode, groupId=null) =>
    memberships.some(m => m.mode===mode && m.groupId===groupId);

  // Join solo
  const joinSolo = async (name, pin) => {
    if (!name) return "Enter a name.";
    if (pin.length<3) return "PIN must be at least 3 characters.";
    const users = soloData.users||[];
    if (users.some(u=>u.name.toLowerCase()===name.toLowerCase())) return "Name already taken.";
    const color = AVATAR_COLORS[users.length%AVATAR_COLORS.length];
    const userId = getOrCreateUserId();
    const newUsers = [...users,{name,color,pin,role:"member",userId}];
    const sd = soloData.startDate||new Date().toISOString().split("T")[0];
    await saveSolo({users:newUsers,startDate:sd});
    const newCtx = {mode:"solo",userIdx:newUsers.length-1};
    const newM = [...memberships,newCtx];
    setMemberships(newM); setActiveCtx(newM.length-1);
    setModal(null); showToast("Welcome, "+name+"! 🙏"); setView("plan");
    return null;
  };

  // Sign in solo
  const signInSolo = async (idx, pin) => {
    const u = (soloData.users||[])[idx];
    if (!u) return "User not found.";
    if (String(u.pin)!==String(pin)) return "Wrong PIN.";
    if (alreadyMember("solo")) return "You're already signed in as a solo reader.";
    const newCtx = {mode:"solo",userIdx:idx};
    const newM = [...memberships,newCtx];
    setMemberships(newM); setActiveCtx(newM.length-1);
    setModal(null); showToast("Welcome back, "+u.name+"! 🙏"); setView("plan");
    return null;
  };

  // Join group
  const joinGroup = async (groupId, password, name, pin, skipPass=false) => {
    const g = groups[groupId];
    if (!g) return "Group not found.";
    if (!skipPass && String(g.password)!==String(password)) return "Wrong group password.";
    if (!name) return "Enter your name.";
    if (pin.length<3) return "PIN must be at least 3 characters.";
    const users = g.users||[];
    if (users.length>=MAX_USERS) return "Group is full.";
    if (users.some(u=>u.name.toLowerCase()===name.toLowerCase())) return "Name already taken in this group.";
    const color = AVATAR_COLORS[users.length%AVATAR_COLORS.length];
    const userId = getOrCreateUserId();
    const newUsers = [...users,{name,color,pin,role:"member",userId}];
    await saveGroup(groupId,{...g,users:newUsers});
    const newCtx = {mode:"group",groupId,userIdx:newUsers.length-1};
    const newM = [...memberships,newCtx];
    setMemberships(newM); setActiveCtx(newM.length-1);
    setModal(null); showToast("Joined "+g.name+"! 🙏"); setView("plan");
    return null;
  };

  // Sign in to group
  const signInGroup = async (groupId, idx, pin) => {
    const g = groups[groupId];
    const u = (g?.users||[])[idx];
    if (!u) return "User not found.";
    if (String(u.pin)!==String(pin)) return "Wrong PIN.";
    if (alreadyMember("group",groupId)) return "Already signed into this group.";
    const newCtx = {mode:"group",groupId,userIdx:idx};
    const newM = [...memberships,newCtx];
    setMemberships(newM); setActiveCtx(newM.length-1);
    setModal(null); showToast("Welcome back, "+u.name+"! 🙏"); setView("plan");
    return null;
  };

  // Switch active context
  const switchCtx = (idx) => { setActiveCtx(idx); setExpandWeek(null); setView("plan"); };

  // Leave a context (sign out of one)
  const leaveCtx = (idx) => {
    const newM = memberships.filter((_,i)=>i!==idx);
    setMemberships(newM);
    const newActive = Math.min(activeCtx, newM.length-1);
    setActiveCtx(Math.max(0,newActive));
    if (newM.length===0) { clearSession(); setView("home"); }
    showToast("Left context.");
  };

  // Full sign out
  const signOut = () => { clearSession(); setMemberships([]); setActiveCtx(0); setView("home"); showToast("Signed out of all groups."); };

  // Toggle chapter - writes to central progress node, reflects across ALL groups
  const toggleDay = async (dayNum) => {
    if (!ctx||!me) return;
    const entry = SCHEDULE[dayNum-1];
    if (!entry||entry.rest) return;
    try {
      const userId = me.userId || localStorage.getItem(USER_ID_KEY) || getOrCreateUserId();
      const currentChecked = (progress[userId]||{}).checked||{};
      const wasChecked = !!currentChecked[dayNum];
      const newChecked = {...currentChecked, [dayNum]: !wasChecked};
      await saveProgress(userId, newChecked);
      if (!wasChecked) showToast("✓ "+entry.ch+" read!");
    } catch(e) { showToast("Error saving — try again"); }
  };

  // Admin
  const createGroup = async (name, password) => {
    if (!name) return "Enter a group name.";
    if (!password||password.length<3) return "Password must be at least 3 characters.";
    const id = mkId();
    const sd = new Date().toISOString().split("T")[0];
    await saveGroup(id,{name,password,users:[],startDate:sd});
    showToast("Group \""+name+"\" created!"); return null;
  };
  const deleteGroup = async (gid) => {
    await remove(ref(db,ROOT+"/groups/"+gid));
    const newM = memberships.filter(m=>m.groupId!==gid);
    setMemberships(newM); setActiveCtx(0);
    showToast("Group deleted.");
  };
  const removeGroupUser = async (gid, idx) => {
    const g = groups[gid]; if (!g) return;
    const newUsers = (g.users||[]).filter((_,i)=>i!==idx).map((u,i)=>({...u,color:AVATAR_COLORS[i%AVATAR_COLORS.length]}));
    await saveGroup(gid,{...g,users:newUsers});
    showToast("User removed.");
  };
  const removeSoloUser = async (idx) => {
    const newUsers = (soloData.users||[]).filter((_,i)=>i!==idx).map((u,i)=>({...u,color:AVATAR_COLORS[i%AVATAR_COLORS.length]}));
    await saveSolo({...soloData,users:newUsers});
    showToast("User removed.");
  };

  // Context label helper
  const ctxLabel = (m) => {
    if (m.mode==="solo") {
      const u = soloData.users?.[m.userIdx];
      return u ? "Solo · "+u.name : "Solo";
    }
    const g = groups[m.groupId];
    const u = g?.users?.[m.userIdx];
    return g ? (g.name+(u?" · "+u.name:"")) : "Group";
  };

  // Handle Spotify OAuth callback — tokens land on home page in hash
  const _hash = window.location.hash.slice(1);
  const _hashParams = new URLSearchParams(_hash);
  if (_hashParams.get("access_token") || window.location.pathname === "/callback") {
    return <SpotifyCallback onDone={(success) => {
      setSpotifyConnected(success);
      window.history.replaceState({}, "", "/");
      window.location.href = "/";
    }} />;
  }

  if (!loaded) return <Loading />;

  return (
    <div style={S.root}>
      {toast && <div style={S.toast}>{toast}</div>}
      {syncing && <div style={S.syncDot}>⟳</div>}

      {modal && (
        <Modal modal={modal} closeModal={()=>setModal(null)} groups={groups} soloData={soloData}
          joinSolo={joinSolo} signInSolo={signInSolo} joinGroup={joinGroup}
          signInGroup={signInGroup} createGroup={createGroup} isAdmin={isAdmin} me={me} memberships={memberships} />
      )}

      <header style={S.header}>
        <div style={S.headerInner}>
          <div style={S.logo}>
            <span style={S.logoIcon}>✦</span>
            <span style={S.logoText}>Sacred Path</span>
            {isAdmin && <span style={S.adminBadge}>Admin</span>}
          </div>
          <nav style={S.nav}>
            {[["home","Home"],["plan","My Plan"],["leaderboard","Rankings"]].map(([v,l])=>(
              <button key={v} style={{...S.navBtn,...(view===v?S.navActive:{})}} onClick={()=>setView(v)}>{l}</button>
            ))}
            {isAdmin && <button style={{...S.navBtn,...(view==="admin"?S.navActive:{})}} onClick={()=>setView("admin")}>⚙ Admin</button>}
          </nav>
          <div style={S.headerRight}>
            {memberships.length>0 ? (
              <>
                {me && <span style={{...S.avatarSm,background:me.color,width:28,height:28,fontSize:13}}>{me.name[0].toUpperCase()}</span>}
                <button style={S.signOutBtn} onClick={()=>setModal({type:"switch"})}>
                  {ctx ? ctxLabel(ctx) : "Switch"} ▾
                </button>
                <button style={S.signOutBtn} onClick={signOut} title="Sign out of all">✕</button>
              </>
            ) : (
              <button style={S.primaryBtn} onClick={()=>setModal({type:"landing"})}>Get started →</button>
            )}
          </div>
        </div>
        {me && (
          <div style={S.activeBanner}>
            {activeGroup ? activeGroup.name+" · " : "Solo · "}
            Reading as <strong style={{color:me.color}}>{me.name}</strong>
            {memberships.length>1 && <span style={S.activeHint}> · <button style={S.switchBtn} onClick={()=>setModal({type:"switch"})}>switch context</button></span>}
            <span style={S.activeHint}> · <button style={S.switchBtn} onClick={()=>setModal({type:"landing"})}>+ join another</button></span>
          </div>
        )}
      </header>

      <main style={S.main}>
        {view==="home"        && <HomeView me={me} leaderboard={leaderboard} planDay={planDay} setView={setView} setModal={setModal} ctx={ctx} activeGroup={activeGroup} groups={groups} memberships={memberships} ctxLabel={ctxLabel} switchCtx={switchCtx} music={music} spotifyUrl={spotifyUrl} addSong={addSong} deleteSong={deleteSong} isAdmin={isAdmin} canAddMusic={canAddMusic} spotifyConnected={spotifyConnected} connectSpotify={connectSpotify} disconnectSpotify={disconnectSpotify} playlistTracks={playlistTracks} loadPlaylistTracks={loadPlaylistTracks} setSpotifyConnected={setSpotifyConnected} />}
        {view==="plan"        && <PlanView me={me} ctx={ctx} activeUsers={enrichedUsers} planDay={planDay} toggleDay={toggleDay} expandWeek={expandWeek} setExpandWeek={setExpandWeek} setModal={setModal} />}
        {view==="leaderboard" && <LeaderboardView leaderboard={leaderboard} planDay={planDay} ctx={ctx} activeGroup={activeGroup} />}
        {view==="admin"       && isAdmin && <AdminView groups={groups} soloData={soloData} deleteGroup={deleteGroup} removeGroupUser={removeGroupUser} removeSoloUser={removeSoloUser} createGroup={createGroup} spotifyUrl={spotifyUrl} setPlaylistUrl={setPlaylistUrl} toggleMusicPermission={toggleMusicPermission} />}
      </main>
    </div>
  );
}

// ── Switch Context Modal ───────────────────────────────────────────────────────
function SwitchModal({ memberships, activeCtx, switchCtx, leaveCtx, closeModal, ctxLabel, setModal }) {
  return (
    <>
      <div style={S.modalTitle}>Your contexts</div>
      <div style={S.modalSub}>Switch between groups and solo reading.</div>
      <div style={S.pickList}>
        {memberships.map((m,i) => (
          <div key={i} style={{...S.pickBtn,...(i===activeCtx?{...S.pickBtnActive,borderColor:"#C9922A"}:{}),justifyContent:"space-between"}}>
            <button style={{background:"none",border:"none",cursor:"pointer",flex:1,textAlign:"left",fontFamily:"Georgia,serif",fontSize:14,color:"#1B2A4A",padding:0}}
              onClick={()=>{switchCtx(i);closeModal();}}>
              {i===activeCtx && <span style={{color:"#C9922A",marginRight:6}}>●</span>}
              {ctxLabel(m)}
            </button>
            <button style={{...S.deleteBtn,fontSize:11,padding:"2px 8px"}} onClick={()=>leaveCtx(i)}>Leave</button>
          </div>
        ))}
      </div>
      <button style={S.primaryBtn} onClick={()=>setModal({type:"landing"})}>+ Join another group</button>
      <button style={S.textBtn} onClick={closeModal}>Close</button>
    </>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function Modal({ modal, closeModal, groups, soloData, joinSolo, signInSolo, joinGroup, signInGroup, isAdmin, me, memberships }) {
  const [step, setStep]     = useState(modal.step||"landing");
  const [name, setName]     = useState(me?.name||"");
  const [pin, setPin]       = useState("");
  const [gpass, setGpass]   = useState("");
  const [selGroup, setSelGroup] = useState(null);
  const [selUser, setSelUser]   = useState(null);
  const [err, setErr]       = useState("");

  const go = (s) => { setErr(""); setStep(s); };

  const submit = async () => {
    setErr("");
    let e = null;
    if (step==="solo-join")    e = await joinSolo(name, pin);
    if (step==="solo-signin")  e = await signInSolo(selUser, pin);
    if (step==="group-join")   e = await joinGroup(selGroup, gpass, name, pin, isAdmin&&!gpass);
    if (step==="group-signin") e = await signInGroup(selGroup, selUser, pin);
    if (e) setErr(e);
  };

  const groupList = Object.entries(groups);

  return (
    <div style={S.modalOverlay} onClick={closeModal}>
      <div style={S.modal} onClick={e=>e.stopPropagation()}>

        {step==="landing" && (<>
          <div style={S.modalTitle}>Join Sacred Path</div>
          <div style={S.modalSub}>Add a new reading context to your account.</div>
          <button style={S.bigOptionBtn} onClick={()=>go("solo-choose")}>
            <span style={S.bigOptionIcon}>📖</span>
            <div><div style={S.bigOptionLabel}>Solo reading</div><div style={S.bigOptionSub}>Track your own progress privately</div></div>
          </button>
          <button style={S.bigOptionBtn} onClick={()=>go("group-choose")}>
            <span style={S.bigOptionIcon}>👥</span>
            <div><div style={S.bigOptionLabel}>Join a group</div><div style={S.bigOptionSub}>Read & compete with friends</div></div>
          </button>
          <button style={S.textBtn} onClick={closeModal}>Cancel</button>
        </>)}

        {step==="solo-choose" && (<>
          <div style={S.modalTitle}>Solo Reading</div>
          <button style={S.bigOptionBtn} onClick={()=>go("solo-join")}>
            <span style={S.bigOptionIcon}>✨</span>
            <div><div style={S.bigOptionLabel}>New reader</div><div style={S.bigOptionSub}>Create a solo profile</div></div>
          </button>
          <button style={S.bigOptionBtn} onClick={()=>go("solo-signin")}>
            <span style={S.bigOptionIcon}>🔑</span>
            <div><div style={S.bigOptionLabel}>Returning reader</div><div style={S.bigOptionSub}>Sign back in</div></div>
          </button>
          <button style={S.textBtn} onClick={()=>go("landing")}>← Back</button>
        </>)}

        {step==="solo-join" && (<>
          <div style={S.modalTitle}>Create Solo Profile</div>
          <input style={S.input} placeholder="Your name" value={name} onChange={e=>{setName(e.target.value);setErr("");}} maxLength={20} />
          <input style={S.input} placeholder="Set a PIN" value={pin} onChange={e=>{setPin(e.target.value);setErr("");}} maxLength={10} />
          {err && <div style={S.authError}>{err}</div>}
          <div style={S.modalBtns}>
            <button style={S.secondaryBtn} onClick={()=>go("solo-choose")}>← Back</button>
            <button style={S.primaryBtn} onClick={submit}>Create →</button>
          </div>
        </>)}

        {step==="solo-signin" && (<>
          <div style={S.modalTitle}>Solo Sign In</div>
          <div style={S.pickList}>
            {(soloData.users||[]).map((u,i)=>(
              <button key={i} style={{...S.pickBtn,...(selUser===i?{...S.pickBtnActive,borderColor:u.color}:{})}} onClick={()=>{setSelUser(i);setErr("");}}>
                <span style={{...S.pickAvatar,background:u.color}}>{u.name[0].toUpperCase()}</span>{u.name}
              </button>
            ))}
          </div>
          <input style={S.input} placeholder="Your PIN" value={pin} onChange={e=>{setPin(e.target.value);setErr("");}} maxLength={10} />
          {err && <div style={S.authError}>{err}</div>}
          <div style={S.modalBtns}>
            <button style={S.secondaryBtn} onClick={()=>go("solo-choose")}>← Back</button>
            <button style={S.primaryBtn} onClick={submit}>Sign in →</button>
          </div>
        </>)}

        {step==="group-choose" && (<>
          <div style={S.modalTitle}>Choose a Group</div>
          {groupList.length===0 && <div style={S.emptySmall}>No groups exist yet. Ask your admin.</div>}
          <div style={S.pickList}>
            {groupList.map(([id,g])=>(
              <button key={id} style={{...S.pickBtn,...(selGroup===id?S.pickBtnActive:{})}} onClick={()=>{setSelGroup(id);setErr("");}}>
                <span style={S.groupIcon}>👥</span>
                <div style={{textAlign:"left"}}>
                  <div style={{fontWeight:"bold"}}>{g.name}</div>
                  <div style={{fontSize:12,color:"#8A9BB0",fontFamily:"system-ui"}}>{(g.users||[]).length}/{MAX_USERS} members</div>
                </div>
              </button>
            ))}
          </div>
          {selGroup
            ? <div style={S.modalBtns}><button style={S.secondaryBtn} onClick={()=>go("landing")}>← Back</button><button style={S.primaryBtn} onClick={()=>go("group-action")}>Continue →</button></div>
            : <button style={S.textBtn} onClick={()=>go("landing")}>← Back</button>}
        </>)}

        {step==="group-action" && selGroup && (<>
          <div style={S.modalTitle}>{groups[selGroup]?.name}</div>
          <button style={S.bigOptionBtn} onClick={()=>go("group-join")}>
            <span style={S.bigOptionIcon}>✨</span>
            <div><div style={S.bigOptionLabel}>New member</div><div style={S.bigOptionSub}>Join and create your profile</div></div>
          </button>
          <button style={S.bigOptionBtn} onClick={()=>go("group-signin")}>
            <span style={S.bigOptionIcon}>🔑</span>
            <div><div style={S.bigOptionLabel}>Already a member</div><div style={S.bigOptionSub}>Sign back in</div></div>
          </button>
          <button style={S.textBtn} onClick={()=>go("group-choose")}>← Back</button>
        </>)}

        {step==="group-join" && (<>
          <div style={S.modalTitle}>Join {groups[selGroup]?.name}</div>
          {isAdmin
            ? <div style={{fontSize:13,color:"#5C8C6A",fontFamily:"system-ui",background:"#D4EDE1",padding:"8px 12px",borderRadius:6}}>Admin — password not required</div>
            : <input style={S.input} placeholder="Group password" value={gpass} onChange={e=>{setGpass(e.target.value);setErr("");}} maxLength={30} />
          }
          <input style={S.input} placeholder="Your name in this group" value={name} onChange={e=>{setName(e.target.value);setErr("");}} maxLength={20} />
          <input style={S.input} placeholder="Set a PIN" value={pin} onChange={e=>{setPin(e.target.value);setErr("");}} maxLength={10} />
          {err && <div style={S.authError}>{err}</div>}
          <div style={S.modalBtns}>
            <button style={S.secondaryBtn} onClick={()=>go("group-action")}>← Back</button>
            <button style={S.primaryBtn} onClick={submit}>Join →</button>
          </div>
        </>)}

        {step==="group-signin" && (<>
          <div style={S.modalTitle}>Sign in to {groups[selGroup]?.name}</div>
          <div style={S.pickList}>
            {(groups[selGroup]?.users||[]).map((u,i)=>(
              <button key={i} style={{...S.pickBtn,...(selUser===i?{...S.pickBtnActive,borderColor:u.color}:{})}} onClick={()=>{setSelUser(i);setErr("");}}>
                <span style={{...S.pickAvatar,background:u.color}}>{u.name[0].toUpperCase()}</span>{u.name}
              </button>
            ))}
          </div>
          <input style={S.input} placeholder="Your PIN" value={pin} onChange={e=>{setPin(e.target.value);setErr("");}} maxLength={10} />
          {err && <div style={S.authError}>{err}</div>}
          <div style={S.modalBtns}>
            <button style={S.secondaryBtn} onClick={()=>go("group-action")}>← Back</button>
            <button style={S.primaryBtn} onClick={submit}>Sign in →</button>
          </div>
        </>)}

      </div>
    </div>
  );
}

function VerseOfDay() {
  const verse = getTodaysVerse();
  const now = new Date();
  const eastern = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dateStr = eastern.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" });
  return (
    <div style={VS.card}>
      <div style={VS.eyebrow}>✦ Verse of the Day · {dateStr}</div>
      <blockquote style={VS.verse}>"{verse.text}"</blockquote>
      <div style={VS.ref}>{verse.reference}</div>
    </div>
  );
}

// ── Music Section (Spotify-powered) ──────────────────────────────────────────
const SPOTIFY_INVITE_URL = "https://open.spotify.com/playlist/0ZT6N4Jr8pcF6wLpVlSKPA?si=61b686cea4d5406d&pt=1e4013f2954abc691e59429e50030f2e";

function MusicSection({ music, spotifyUrl, addSong, deleteSong, isAdmin, canAddMusic, me, spotifyConnected, connectSpotify, disconnectSpotify, playlistTracks, loadPlaylistTracks }) {
  const [query, setQuery]           = useState("");
  const [results, setResults]       = useState([]);
  const [searching, setSearching]   = useState(false);
  const [adding, setAdding]         = useState(null); // track id being added
  const [addedIds, setAddedIds]     = useState(new Set());
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [loadingPl, setLoadingPl]   = useState(false);
  const [searchErr, setSearchErr]   = useState("");
  // Fallback manual form (for non-spotify users)
  const [showManual, setShowManual] = useState(false);
  const [manName, setManName]       = useState("");
  const [manArtist, setManArtist]   = useState("");
  const [manNote, setManNote]       = useState("");
  const [manErr, setManErr]         = useState("");

  // Debounced Spotify search
  useEffect(() => {
    if (!spotifyConnected || query.length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true); setSearchErr("");
      try {
        const r = await searchTracks(query);
        setResults(r);
      } catch(e) { setSearchErr("Search failed — try reconnecting Spotify."); }
      setSearching(false);
    }, 400);
    return () => clearTimeout(t);
  }, [query, spotifyConnected]);

  const handleAdd = async (track) => {
    setAdding(track.id);
    try {
      // Save to Firebase so everyone in the app sees it
      await addSong(track.name, track.artist, "");
      setAddedIds(prev => new Set([...prev, track.id]));
      setQuery(""); setResults([]);
      // Open Spotify so user can add to playlist manually if desired
      // window.open(track.spotifyUrl, "_blank");
    } catch(e) {
      setSearchErr("Could not save song. Try again.");
    }
    setAdding(null);
  };

  const handleLoadPlaylist = async () => {
    setLoadingPl(true);
    await loadPlaylistTracks();
    setShowPlaylist(true);
    setLoadingPl(false);
  };

  const handleManualAdd = async () => {
    const e = await addSong(manName, manArtist, manNote);
    if (e) { setManErr(e); return; }
    setManName(""); setManArtist(""); setManNote(""); setManErr(""); setShowManual(false);
  };

  return (
    <div style={MS.wrap}>
      {/* Header */}
      <div style={MS.header}>
        <div style={MS.titleRow}>
          <span style={MS.icon}>🎵</span>
          <div>
            <div style={MS.title}>Worship Music</div>
            <div style={MS.sub}>Songs the group is listening to</div>
          </div>
        </div>
        <div style={MS.headerBtns}>
          {spotifyConnected ? (
            <>
              <span style={MS.connectedBadge}>✓ Spotify connected</span>
              <button style={MS.viewPlBtn} onClick={handleLoadPlaylist} disabled={loadingPl}>
                {loadingPl ? "Loading…" : "View playlist"}
              </button>
              <a href={SPOTIFY_INVITE_URL} target="_blank" rel="noreferrer" style={{...MS.viewPlBtn, textDecoration:"none", display:"flex", alignItems:"center"}}>
                + Join playlist
              </a>
              <button style={MS.disconnectBtn} onClick={disconnectSpotify}>Disconnect</button>
            </>
          ) : (
            <button style={MS.spotifyBtn} onClick={connectSpotify}>
              <span style={MS.spotifyLogo}>♪</span> Connect Spotify
            </button>
          )}
          {!spotifyConnected && canAddMusic && (
            <button style={MS.addBtn} onClick={() => setShowManual(!showManual)}>+ Add manually</button>
          )}
          <a href={SPOTIFY_INVITE_URL} target="_blank" rel="noreferrer" style={{...MS.addBtn, textDecoration:"none", display:"inline-flex", alignItems:"center", color:"#1DB954", borderColor:"#1DB954"}}>
            ♪ Join Spotify playlist
          </a>
        </div>
      </div>

      {/* Spotify search bar */}
      {spotifyConnected && canAddMusic && (
        <div style={MS.searchWrap}>
          <div style={MS.searchRow}>
            <span style={MS.searchIcon}>🔍</span>
            <input style={MS.searchInput} placeholder="Search for a worship song on Spotify…"
              value={query} onChange={e => setQuery(e.target.value)} />
            {searching && <span style={MS.spinner}>⟳</span>}
          </div>
          {searchErr && <div style={S.authError}>{searchErr}</div>}
          {results.length > 0 && (
            <div style={MS.resultsList}>
              {results.map(track => (
                <div key={track.id} style={MS.resultRow}>
                  {track.image && <img src={track.image} alt="" style={MS.albumImg} />}
                  <div style={MS.resultInfo}>
                    <div style={MS.resultName}>{track.name}</div>
                    <div style={MS.resultArtist}>{track.artist}</div>
                  </div>
                  <button
                    style={{...MS.addTrackBtn, ...(addedIds.has(track.id)?MS.addedBtn:{})}}
                    onClick={() => handleAdd(track)}
                    disabled={adding===track.id || addedIds.has(track.id)}>
                    {adding===track.id ? "Adding…" : addedIds.has(track.id) ? "✓ Added" : "+ Add"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Manual form fallback */}
      {showManual && (
        <div style={MS.form}>
          <div style={MS.formRow}>
            <input style={{...S.input,flex:1}} placeholder="Song title" value={manName} onChange={e=>{setManName(e.target.value);setManErr("");}} maxLength={60} />
            <input style={{...S.input,flex:1}} placeholder="Artist" value={manArtist} onChange={e=>{setManArtist(e.target.value);setManErr("");}} maxLength={60} />
          </div>
          <input style={S.input} placeholder="Why this song? (optional)" value={manNote} onChange={e=>setManNote(e.target.value)} maxLength={120} />
          {manErr && <div style={S.authError}>{manErr}</div>}
          <div style={MS.formBtns}>
            <button style={S.secondaryBtn} onClick={()=>setShowManual(false)}>Cancel</button>
            <button style={S.primaryBtn} onClick={handleManualAdd}>Add →</button>
          </div>
        </div>
      )}

      {/* Playlist tracks */}
      {showPlaylist && playlistTracks.length > 0 && (
        <div style={MS.playlistSection}>
          <div style={MS.playlistTitle}>🎧 Sacred Path Worship Playlist ({playlistTracks.length} songs)</div>
          {playlistTracks.map(t => (
            <div key={t.id} style={MS.plRow}>
              <div style={MS.plInfo}>
                <span style={MS.plName}>{t.name}</span>
                <span style={MS.plArtist}> · {t.artist}</span>
              </div>
              <a href={t.spotifyUrl} target="_blank" rel="noreferrer" style={MS.plLink}>Open ↗</a>
            </div>
          ))}
        </div>
      )}

      {/* Recommended songs from Firebase */}
      {music.length > 0 && (
        <div>
          <div style={MS.recTitle}>Recently recommended</div>
          <div style={MS.grid}>
            {music.map(song => (
              <div key={song.id} style={MS.card}>
                <div style={MS.cardTop}>
                  <div style={MS.songInfo}>
                    <div style={MS.songName}>{song.name}</div>
                    <div style={MS.songArtist}>{song.artist}</div>
                    {song.note && <div style={MS.songNote}>"{song.note}"</div>}
                  </div>
                  <div style={MS.cardActions}>
                    <a href={"https://open.spotify.com/search/"+encodeURIComponent(song.name+" "+song.artist)} target="_blank" rel="noreferrer" style={MS.spotifyIconBtn} title="Find on Spotify">
                      <span style={MS.spotifyIconTxt}>▶</span>
                    </a>
                    {isAdmin && (
                      <button style={MS.deleteIconBtn} onClick={() => deleteSong(song.id)} title="Remove">✕</button>
                    )}
                  </div>
                </div>
                <div style={MS.addedBy}>Added by {song.addedBy}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {music.length === 0 && !spotifyConnected && (
        <div style={MS.empty}>Connect Spotify to search and add worship songs 🎶</div>
      )}
    </div>
  );
}

const MS = {
  wrap:           { background:"#fff", border:"1px solid #E0D9CF", borderRadius:12, padding:"20px 24px", display:"flex", flexDirection:"column", gap:16 },
  header:         { display:"flex", alignItems:"flex-start", justifyContent:"space-between", flexWrap:"wrap", gap:12 },
  titleRow:       { display:"flex", alignItems:"center", gap:12 },
  icon:           { fontSize:28 },
  title:          { fontWeight:"bold", fontSize:17, color:"#1B2A4A" },
  sub:            { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", marginTop:2 },
  headerBtns:     { display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" },
  spotifyBtn:     { display:"flex", alignItems:"center", gap:6, background:"#1DB954", color:"#fff", padding:"8px 16px", borderRadius:20, fontSize:13, fontFamily:"system-ui,sans-serif", fontWeight:700, border:"none", cursor:"pointer", whiteSpace:"nowrap" },
  spotifyLogo:    { fontSize:16 },
  connectedBadge: { fontSize:12, color:"#1DB954", fontFamily:"system-ui,sans-serif", fontWeight:600 },
  viewPlBtn:      { background:"none", border:"1px solid #1DB954", color:"#1DB954", padding:"6px 12px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"system-ui,sans-serif" },
  disconnectBtn:  { background:"none", border:"1px solid #D8D2C8", color:"#8A9BB0", padding:"6px 12px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"system-ui,sans-serif" },
  addBtn:         { background:"none", border:"1px solid #C9922A", color:"#C9922A", padding:"6px 14px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"system-ui,sans-serif" },
  searchWrap:     { background:"#F7F3EC", borderRadius:10, padding:"12px 14px", display:"flex", flexDirection:"column", gap:8 },
  searchRow:      { display:"flex", alignItems:"center", gap:10 },
  searchIcon:     { fontSize:16, flexShrink:0 },
  searchInput:    { flex:1, border:"none", background:"transparent", fontSize:15, fontFamily:"Georgia,serif", color:"#1B2A4A", outline:"none" },
  spinner:        { fontSize:16, color:"#1DB954" },
  resultsList:    { background:"#fff", borderRadius:8, border:"1px solid #E0D9CF", overflow:"hidden" },
  resultRow:      { display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderBottom:"1px solid #F7F3EC" },
  albumImg:       { width:40, height:40, borderRadius:4, objectFit:"cover", flexShrink:0 },
  resultInfo:     { flex:1, minWidth:0 },
  resultName:     { fontWeight:"bold", fontSize:14, color:"#1B2A4A", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  resultArtist:   { fontSize:12, color:"#5C8C6A", fontFamily:"system-ui,sans-serif" },
  addTrackBtn:    { background:"#1DB954", color:"#fff", border:"none", padding:"6px 14px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"system-ui,sans-serif", fontWeight:600, whiteSpace:"nowrap", flexShrink:0 },
  addedBtn:       { background:"#ccc", cursor:"default" },
  form:           { background:"#F7F3EC", borderRadius:10, padding:"16px", display:"flex", flexDirection:"column", gap:10 },
  formRow:        { display:"flex", gap:10, flexWrap:"wrap" },
  formBtns:       { display:"flex", gap:10, justifyContent:"flex-end" },
  playlistSection:{ background:"#F7F3EC", borderRadius:10, padding:"14px 16px", display:"flex", flexDirection:"column", gap:6 },
  playlistTitle:  { fontWeight:"bold", fontSize:14, color:"#1B2A4A", marginBottom:8, fontFamily:"system-ui,sans-serif" },
  plRow:          { display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, padding:"6px 0", borderBottom:"1px solid #E8E4DD" },
  plInfo:         { flex:1, fontSize:13, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  plName:         { fontWeight:600, color:"#1B2A4A", fontFamily:"system-ui,sans-serif" },
  plArtist:       { color:"#8A9BB0", fontFamily:"system-ui,sans-serif" },
  plLink:         { fontSize:12, color:"#1DB954", fontFamily:"system-ui,sans-serif", textDecoration:"none", whiteSpace:"nowrap" },
  recTitle:       { fontWeight:"bold", fontSize:13, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:8 },
  empty:          { color:"#8A9BB0", fontFamily:"system-ui,sans-serif", fontSize:14, textAlign:"center", padding:"16px 0" },
  grid:           { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))", gap:12 },
  card:           { background:"#F7F3EC", border:"1px solid #E0D9CF", borderRadius:10, padding:"14px 16px", display:"flex", flexDirection:"column", gap:8 },
  cardTop:        { display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8 },
  songInfo:       { flex:1 },
  songName:       { fontWeight:"bold", fontSize:15, color:"#1B2A4A", lineHeight:1.3 },
  songArtist:     { fontSize:13, color:"#5C8C6A", fontFamily:"system-ui,sans-serif", marginTop:2 },
  songNote:       { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", fontStyle:"italic", marginTop:6, lineHeight:1.4 },
  cardActions:    { display:"flex", gap:6, flexShrink:0 },
  spotifyIconBtn: { width:32, height:32, borderRadius:"50%", background:"#1DB954", display:"flex", alignItems:"center", justifyContent:"center", textDecoration:"none" },
  spotifyIconTxt: { color:"#fff", fontSize:11 },
  deleteIconBtn:  { width:32, height:32, borderRadius:"50%", background:"none", border:"1px solid #D8D2C8", cursor:"pointer", fontSize:12, color:"#C0514A", display:"flex", alignItems:"center", justifyContent:"center" },
  addedBy:        { fontSize:11, color:"#B0A898", fontFamily:"system-ui,sans-serif" },
};

const VS = {
  card: { background:"#1B2A4A", borderRadius:12, padding:"24px 28px", display:"flex", flexDirection:"column", gap:12 },
  eyebrow: { fontSize:11, color:"#C9922A", fontFamily:"system-ui,sans-serif", textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:600 },
  verse: { fontSize:17, color:"#F7F3EC", lineHeight:1.7, margin:0, fontStyle:"italic", borderLeft:"3px solid #C9922A", paddingLeft:16 },
  ref: { fontSize:13, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", fontWeight:600, textAlign:"right" },
};

function Loading() {
  return <div style={S.loadingWrap}><div style={S.loadingIcon}>✦</div><div style={S.loadingText}>Connecting…</div></div>;
}

function HomeView({ me, leaderboard, planDay, setView, setModal, ctx, activeGroup, groups, memberships, ctxLabel, switchCtx, music, spotifyUrl, addSong, deleteSong, isAdmin, canAddMusic, spotifyConnected, connectSpotify, disconnectSpotify, playlistTracks, loadPlaylistTracks, setSpotifyConnected }) {
  const leader = leaderboard[0];
  const checked = me?.checked || {};
  // Find the next unread non-rest day from day 1 onwards
  const nextUnread = SCHEDULE.find(e => !e.rest && !checked[e.day]) || SCHEDULE[planDay-1];
  const today = nextUnread;
  return (
    <div style={S.homeWrap}>
      <div style={S.hero}>
        <div style={S.heroEyebrow}>
          {me && Object.values(checked).filter(Boolean).length > 0
            ? "Up next · Day " + today?.day + " of 365"
            : "Day " + planDay + " of 365"}
        </div>
        <h1 style={S.heroTitle}>{today?.rest?"Rest & Reflect":today?.ch}</h1>
        <div style={S.heroSub}>{today?.rest?"Take a breath. Rest is part of the journey.":today?.track==="T1"?"Gospels & Acts":"Epistles & Revelation"}</div>
      </div>

      {/* Verse of the Day */}
      <VerseOfDay />

      {/* Context switcher strip */}
      {memberships.length>1 && (
        <div style={S.ctxStrip}>
          <span style={S.ctxStripLabel}>Viewing:</span>
          {memberships.map((m,i)=>(
            <button key={i} style={{...S.ctxChip,...(i===(ctx?memberships.indexOf(ctx):0)?S.ctxChipActive:{})}} onClick={()=>{switchCtx(i);setView("plan");}}>
              {ctxLabel(m)}
            </button>
          ))}
          <button style={S.ctxChipAdd} onClick={()=>setModal({type:"landing"})}>+ Join another</button>
        </div>
      )}

      {me && (
        <div style={S.statsRow}>
          <StatCard label={activeGroup?"Group":"Mode"} value={activeGroup?activeGroup.name:"Solo"} sub={activeGroup?(activeGroup.users||[]).length+"/"+MAX_USERS+" members":"personal"} />
          <StatCard label="Leading" value={leader?.name||"—"} sub={(leader?.total||0)+" chapters"} color={leader?.color} />
          <StatCard label="Your streak" value={String(leaderboard.find(u=>u.name===me?.name)?.streak||0)} sub="days in a row" />
          <StatCard label="Plan day" value={planDay} sub="of 365" />
        </div>
      )}

      <div style={S.quickRow}>
        <QuickCard icon="📖" title="Today's reading" desc={today?.rest?"Rest day":today?.ch} action={()=>setView("plan")} actionLabel="Open plan" />
        <QuickCard icon="🏆" title="Leaderboard" desc={leader?leader.name+" is leading":"No readers yet"} action={()=>setView("leaderboard")} actionLabel="View rankings" />
        <QuickCard icon="👥" title="Groups" desc={Object.keys(groups).length+" group"+(Object.keys(groups).length!==1?"s":"")+" available"} action={()=>setModal({type:"landing",step:"group-choose"})} actionLabel="Join a group" />
      </div>

      {!me && (
        <div style={S.emptyHero}>
          <div style={S.emptyIcon}>✦</div>
          <h2 style={S.emptyTitle}>Welcome to Sacred Path</h2>
          <p style={S.emptyText}>Read through the New Testament in a year — solo or with a group. Join multiple groups and track each separately.</p>
          <button style={S.primaryBtn} onClick={()=>setModal({type:"landing"})}>Get started →</button>
        </div>
      )}

      <MusicSection music={music} spotifyUrl={spotifyUrl} addSong={addSong} deleteSong={deleteSong} isAdmin={isAdmin} canAddMusic={canAddMusic} me={me} spotifyConnected={spotifyConnected} connectSpotify={connectSpotify} disconnectSpotify={disconnectSpotify} playlistTracks={playlistTracks} loadPlaylistTracks={loadPlaylistTracks} />
    </div>
  );
}

function StatCard({label,value,sub,color}) {
  return <div style={S.statCard}><div style={S.statLabel}>{label}</div><div style={{...S.statValue,...(color?{color}:{})}}>{value}</div><div style={S.statSub}>{sub}</div></div>;
}
function QuickCard({icon,title,desc,action,actionLabel}) {
  return <div style={S.quickCard}><div style={S.quickIcon}>{icon}</div><div style={S.quickTitle}>{title}</div><div style={S.quickDesc}>{desc}</div><button style={S.quickBtn} onClick={action}>{actionLabel} →</button></div>;
}

function PlanView({ me, ctx, activeUsers, planDay, toggleDay, expandWeek, setExpandWeek, setModal }) {
  const checked = me?.checked||{};
  const weeks = [];
  for (let w=0;w<52;w++) weeks.push(SCHEDULE.slice(w*7,w*7+7));
  if (SCHEDULE[364]) weeks[51]=[...weeks[51],SCHEDULE[364]];
  const currentWeek = Math.ceil(planDay/7)-1;
  useEffect(()=>{ if(expandWeek===null) setExpandWeek(currentWeek); },[]);

  if (!me) return (
    <div style={S.signInPrompt}>
      <div style={S.emptyIcon}>📖</div>
      <h2 style={S.emptyTitle}>Sign in to track your reading</h2>
      <button style={S.primaryBtn} onClick={()=>setModal({type:"landing"})}>Get started →</button>
    </div>
  );

  return (
    <div style={S.planWrap}>
      <div style={S.planHeader}>
        <h2 style={S.sectionTitle}>Reading Plan</h2>
        <div style={S.planMeta}>
          <span style={{...S.avatarSm,background:me.color}}>{me.name[0]}</span>
          <span style={S.planMetaName}>{me.name}</span>
          <span style={S.planMetaStat}>{getCompletionPct(checked)}% · {getStreak(checked)}🔥</span>
        </div>
      </div>
      <div style={S.progressWrap}>
        <div style={S.progressBar}><div style={{...S.progressFill,width:getCompletionPct(checked)+"%"}} /></div>
        <span style={S.progressLabel}>{getTotalRead(checked)} / 260 chapters</span>
      </div>
      <div style={S.legendRow}>
        <span style={{...S.legendDot,background:"#3A7EBD"}} /><span style={S.legendTxt}>Gospels & Acts</span>
        <span style={{...S.legendDot,background:"#5C8C6A",marginLeft:16}} /><span style={S.legendTxt}>Epistles & Revelation</span>
        <span style={{...S.legendDot,background:"#E8E4DD",border:"1px solid #ccc",marginLeft:16}} /><span style={S.legendTxt}>Rest day</span>
      </div>
      {weeks.map((week,wi)=>{
        const isOpen=expandWeek===wi, weekDone=week.filter(e=>!e.rest&&checked[e.day]).length, weekTotal=week.filter(e=>!e.rest).length, isCurrent=wi===currentWeek;
        return (
          <div key={wi} style={{...S.weekBlock,...(isCurrent?S.weekBlockCurrent:{})}}>
            <button style={S.weekHeader} onClick={()=>setExpandWeek(isOpen?null:wi)}>
              <span style={S.weekLabel}>{isCurrent&&<span style={S.currentBadge}>NOW</span>}Week {wi+1}</span>
              <span style={S.weekProgress}>{weekDone}/{weekTotal}</span>
              <span style={S.weekChevron}>{isOpen?"▲":"▼"}</span>
            </button>
            {isOpen&&(
              <div style={S.weekBody}>
                {week.map(entry=>{
                  const isDone=!!checked[entry.day], isPast=entry.day<planDay, isToday=entry.day===planDay, isMissed=isPast&&!entry.rest&&!isDone;
                  const readers=activeUsers.filter((u,i)=>i!==ctx?.userIdx&&(u.checked||{})[entry.day]);
                  return (
                    <div key={entry.day} style={{...S.dayRow,...(isToday?S.dayRowToday:{}),...(entry.rest?S.dayRowRest:{})}}>
                      <span style={S.dayNum}>Day {entry.day}</span>
                      {entry.rest?<span style={S.restLabel}>Rest day</span>:(
                        <>
                          <span style={{...S.trackDot,background:entry.track==="T1"?"#3A7EBD":"#5C8C6A"}} />
                          <span style={S.dayChapter}>{entry.ch}</span>
                          {isMissed&&<span style={S.missedBadge}>missed</span>}
                          <div style={S.readerDots}>{readers.map((u,i)=><span key={i} style={{...S.readerDot,background:u.color}} title={u.name+" read this"} />)}</div>
                          <button style={{...S.checkBtn,...(isDone?S.checkBtnDone:{})}} onClick={()=>toggleDay(entry.day)}>{isDone?"✓":"○"}</button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LeaderboardView({ leaderboard, planDay, ctx, activeGroup }) {
  return (
    <div style={S.lbWrap}>
      <h2 style={S.sectionTitle}>Rankings</h2>
      <p style={S.lbSub}>{activeGroup?activeGroup.name+" · ":"Solo · "}Day {planDay} of 365</p>
      {leaderboard.length===0&&<div style={S.emptySmall}>No readers yet.</div>}
      {leaderboard.map((u,rank)=>(
        <div key={u.idx} style={{...S.lbRow,...(rank===0?S.lbRowFirst:{})}}>
          <div style={S.lbRank}>{rank<3?MEDALS[rank]:<span style={S.lbRankNum}>{rank+1}</span>}</div>
          <div style={{...S.lbAvatar,background:u.color}}>{u.name[0].toUpperCase()}</div>
          <div style={S.lbInfo}>
            <div style={S.lbName}>{u.name}</div>
            <div style={S.lbStats}>{u.streak} day streak · {u.pct}% complete</div>
            <div style={S.flameBarWrap}><div style={{...S.flameBar,width:u.pct+"%",background:u.color}} /></div>
          </div>
          <div style={S.lbCount}><div style={S.lbBig}>{u.total}</div><div style={S.lbSmall}>chapters</div></div>
        </div>
      ))}
      {leaderboard.length>1&&(
        <div style={S.gapCard}>
          <div style={S.gapTitle}>📊 Gap to leader</div>
          {leaderboard.slice(1).map(u=>{const gap=leaderboard[0].total-u.total;return(
            <div key={u.idx} style={S.gapRow}><span style={{...S.gapDot,background:u.color}} /><span style={S.gapName}>{u.name}</span><span style={S.gapAmt}>{gap===0?"Tied!":gap+" ch behind "+leaderboard[0].name}</span></div>
          );})}
        </div>
      )}
      <div style={S.achieveWrap}>
        <div style={S.achieveTitle}>Milestones earned</div>
        <div style={S.achieveGrid}>
          {[{label:"First step",req:1,icon:"🌱"},{label:"1-week streak",req:7,icon:"🔥",streak:true},{label:"Matthew done",req:28,icon:"✝️"},{label:"Halfway",req:130,icon:"⚡"},{label:"Gospels done",req:89,icon:"📖"},{label:"Finished!",req:260,icon:"👑"}
          ].flatMap(a=>leaderboard.filter(u=>a.streak?u.streak>=a.req:u.total>=a.req).map(u=>(
            <div key={a.label+u.idx} style={S.achieveBadge}><span style={S.achieveIcon}>{a.icon}</span><span style={{...S.achieveName,color:u.color}}>{u.name}</span><span style={S.achieveLabel}>{a.label}</span></div>
          )))}
        </div>
        {leaderboard.every(u=>u.total===0)&&<div style={S.emptySmall}>Milestones appear as readers make progress.</div>}
      </div>
    </div>
  );
}

function AdminView({ groups, soloData, deleteGroup, removeGroupUser, removeSoloUser, createGroup, spotifyUrl, setPlaylistUrl, toggleMusicPermission }) {
  const [gname,setGname]=useState(""); const [gpass,setGpass]=useState(""); const [err,setErr]=useState(""); const [conf,setConf]=useState(null);
  const [plUrl,setPlUrl]=useState(spotifyUrl||"");
  const handleCreate=async()=>{const e=await createGroup(gname.trim(),gpass.trim());if(e){setErr(e);return;}setGname("");setGpass("");setErr("");};
  const handleConf=async()=>{if(!conf)return;if(conf.type==="group")await deleteGroup(conf.gid);if(conf.type==="gu")await removeGroupUser(conf.gid,conf.idx);if(conf.type==="su")await removeSoloUser(conf.idx);setConf(null);};
  return (
    <div style={S.adminWrap}>
      {conf&&<div style={S.modalOverlay}><div style={S.modal}><div style={S.modalTitle}>Are you sure?</div><div style={S.modalSub}>This cannot be undone.</div><div style={S.modalBtns}><button style={S.secondaryBtn} onClick={()=>setConf(null)}>Cancel</button><button style={{...S.primaryBtn,background:"#C0514A"}} onClick={handleConf}>Confirm</button></div></div></div>}
      <h2 style={S.sectionTitle}>⚙ Admin Panel</h2>

      {/* Spotify playlist */}
      <div style={S.adminCard}>
        <div style={S.adminCardTitle}>🎵 Group Spotify Playlist</div>
        <div style={{fontSize:13,color:"#8A9BB0",fontFamily:"system-ui",marginBottom:10}}>
          Create a collaborative playlist in Spotify, copy the share link, and paste it here. Members will see an "Open group playlist" button on the home screen.
        </div>
        <div style={S.adminRow}>
          <input style={{...S.input,flex:1}} placeholder="https://open.spotify.com/playlist/..." value={plUrl}
            onChange={e=>setPlUrl(e.target.value)} />
          <button style={S.primaryBtn} onClick={()=>setPlaylistUrl(plUrl)}>Save</button>
        </div>
      </div>

      <div style={S.adminCard}>
        <div style={S.adminCardTitle}>Create a new group</div>
        <div style={S.adminRow}>
          <input style={{...S.input,flex:1}} placeholder="Group name" value={gname} onChange={e=>{setGname(e.target.value);setErr("");}} maxLength={30} />
          <input style={{...S.input,flex:1}} placeholder="Group password" value={gpass} onChange={e=>{setGpass(e.target.value);setErr("");}} maxLength={30} />
          <button style={S.primaryBtn} onClick={handleCreate}>Create</button>
        </div>
        {err&&<div style={S.authError}>{err}</div>}
      </div>
      {Object.entries(groups).map(([gid,g])=>(
        <div key={gid} style={S.adminCard}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div><div style={S.adminCardTitle}>{g.name}</div><div style={{fontSize:12,color:"#8A9BB0",fontFamily:"system-ui"}}>Password: <strong>{g.password}</strong> · {(g.users||[]).length}/{MAX_USERS} members</div></div>
            <button style={S.deleteBtn} onClick={()=>setConf({type:"group",gid})}>Delete group</button>
          </div>
          {(g.users||[]).map((u,i)=>(
            <div key={i} style={S.adminUserRow}>
              <span style={{...S.pickAvatar,background:u.color,width:34,height:34,fontSize:15}}>{u.name[0].toUpperCase()}</span>
              <div style={S.adminUserInfo}><span style={S.adminUserName}>{u.name}</span><span style={S.adminUserStat}>{getCompletionPct(u.checked||{})}% · {getTotalRead(u.checked||{})} chapters</span></div>
              <button style={{...S.deleteBtn,borderColor:"#8A9BB0",color:"#8A9BB0",marginRight:4}}
                onClick={()=>toggleMusicPermission("group",gid,i)}
                title={u.musicDisabled?"Enable music submissions":"Disable music submissions"}>
                {u.musicDisabled?"🎵 Off":"🎵 On"}
              </button>
              <button style={S.deleteBtn} onClick={()=>setConf({type:"gu",gid,idx:i})}>Remove</button>
            </div>
          ))}
          {(g.users||[]).length===0&&<div style={S.emptySmall}>No members yet.</div>}
        </div>
      ))}
      <div style={S.adminCard}>
        <div style={S.adminCardTitle}>Solo readers ({(soloData.users||[]).length})</div>
        {(soloData.users||[]).map((u,i)=>(
          <div key={i} style={S.adminUserRow}>
            <span style={{...S.pickAvatar,background:u.color,width:34,height:34,fontSize:15}}>{u.name[0].toUpperCase()}</span>
            <div style={S.adminUserInfo}><span style={S.adminUserName}>{u.name}</span><span style={S.adminUserStat}>{getCompletionPct(u.checked||{})}% · {getTotalRead(u.checked||{})} chapters</span></div>
            <button style={{...S.deleteBtn,borderColor:"#8A9BB0",color:"#8A9BB0",marginRight:4}}
              onClick={()=>toggleMusicPermission("solo",null,i)}
              title={u.musicDisabled?"Enable music submissions":"Disable music submissions"}>
              {u.musicDisabled?"🎵 Off":"🎵 On"}
            </button>
            <button style={S.deleteBtn} onClick={()=>setConf({type:"su",idx:i})}>Remove</button>
          </div>
        ))}
        {(soloData.users||[]).length===0&&<div style={S.emptySmall}>No solo readers yet.</div>}
      </div>
    </div>
  );
}

const S = {
  root:           { fontFamily:'Georgia,"Times New Roman",serif', background:"#F7F3EC", minHeight:"100vh", color:"#1B2A4A" },
  loadingWrap:    { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100vh", gap:16 },
  loadingIcon:    { fontSize:36, color:"#C9922A" },
  loadingText:    { fontSize:16, color:"#8A9BB0", fontFamily:"system-ui,sans-serif" },
  modalOverlay:   { position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:500, display:"flex", alignItems:"center", justifyContent:"center", padding:20 },
  modal:          { background:"#F7F3EC", borderRadius:12, padding:28, maxWidth:440, width:"100%", display:"flex", flexDirection:"column", gap:14, boxShadow:"0 20px 60px rgba(0,0,0,0.3)", maxHeight:"90vh", overflowY:"auto" },
  modalTitle:     { fontSize:20, fontWeight:"bold", color:"#1B2A4A" },
  modalSub:       { fontSize:14, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", marginTop:-8 },
  modalBtns:      { display:"flex", gap:10, justifyContent:"flex-end", marginTop:4 },
  authError:      { fontSize:13, color:"#C0514A", fontFamily:"system-ui,sans-serif", background:"#FEE8E6", padding:"8px 12px", borderRadius:6 },
  bigOptionBtn:   { display:"flex", alignItems:"center", gap:14, padding:"14px 16px", border:"1.5px solid #E0D9CF", borderRadius:10, background:"#fff", cursor:"pointer", textAlign:"left", width:"100%" },
  bigOptionIcon:  { fontSize:28, flexShrink:0 },
  bigOptionLabel: { fontWeight:"bold", fontSize:15, color:"#1B2A4A", fontFamily:"system-ui,sans-serif" },
  bigOptionSub:   { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", marginTop:2 },
  textBtn:        { background:"none", border:"none", color:"#8A9BB0", cursor:"pointer", fontSize:13, fontFamily:"system-ui,sans-serif", padding:"4px 0", textAlign:"center" },
  pickList:       { display:"flex", flexDirection:"column", gap:8, maxHeight:220, overflowY:"auto" },
  pickBtn:        { display:"flex", alignItems:"center", gap:10, padding:"10px 14px", border:"2px solid #E0D9CF", borderRadius:8, background:"#fff", cursor:"pointer", fontFamily:"Georgia,serif", fontSize:14, color:"#1B2A4A", textAlign:"left" },
  pickBtnActive:  { background:"#FFFCF5" },
  pickAvatar:     { width:28, height:28, borderRadius:"50%", color:"#fff", fontWeight:700, fontSize:13, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"system-ui,sans-serif", flexShrink:0 },
  groupIcon:      { fontSize:20, flexShrink:0 },
  header:         { background:"#1B2A4A", borderBottom:"1px solid #2C3E60", position:"sticky", top:0, zIndex:100 },
  headerInner:    { maxWidth:960, margin:"0 auto", padding:"12px 20px", display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" },
  logo:           { display:"flex", alignItems:"center", gap:8, flex:1 },
  logoIcon:       { color:"#C9922A", fontSize:18 },
  logoText:       { color:"#F7F3EC", fontSize:17, fontWeight:"bold", letterSpacing:"0.02em" },
  adminBadge:     { background:"#C9922A", color:"#fff", fontSize:10, fontWeight:700, padding:"2px 7px", borderRadius:4, fontFamily:"system-ui,sans-serif" },
  nav:            { display:"flex", gap:4, flexWrap:"wrap" },
  navBtn:         { background:"none", border:"none", color:"#8A9BB0", padding:"6px 12px", cursor:"pointer", fontSize:14, borderRadius:6, fontFamily:"system-ui,sans-serif" },
  navActive:      { color:"#F7F3EC", background:"rgba(255,255,255,0.1)" },
  headerRight:    { display:"flex", alignItems:"center", gap:8 },
  avatarSm:       { width:26, height:26, borderRadius:"50%", color:"#fff", fontWeight:700, fontSize:12, display:"inline-flex", alignItems:"center", justifyContent:"center", fontFamily:"system-ui,sans-serif" },
  meName:         { color:"#F7F3EC", fontSize:14, fontFamily:"system-ui,sans-serif" },
  signOutBtn:     { background:"rgba(255,255,255,0.08)", border:"1px solid rgba(255,255,255,0.15)", color:"#F7F3EC", padding:"5px 12px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"system-ui,sans-serif" },
  activeBanner:   { background:"#13203A", color:"#8A9BB0", fontSize:12, textAlign:"center", padding:"4px 0", fontFamily:"system-ui,sans-serif" },
  activeHint:     { opacity:0.7 },
  switchBtn:      { background:"none", border:"none", color:"#C9922A", cursor:"pointer", fontSize:12, fontFamily:"system-ui,sans-serif", textDecoration:"underline", padding:0 },
  syncDot:        { position:"fixed", top:12, right:12, fontSize:16, color:"#C9922A", zIndex:200 },
  toast:          { position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)", background:"#1B2A4A", color:"#F7F3EC", padding:"10px 22px", borderRadius:8, fontSize:14, fontFamily:"system-ui,sans-serif", zIndex:999, boxShadow:"0 4px 20px rgba(0,0,0,0.2)", whiteSpace:"nowrap" },
  main:           { maxWidth:960, margin:"0 auto", padding:"24px 20px" },
  signInPrompt:   { display:"flex", flexDirection:"column", alignItems:"center", gap:12, padding:"60px 20px", textAlign:"center" },
  ctxStrip:       { display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", background:"#fff", border:"1px solid #E0D9CF", borderRadius:10, padding:"10px 16px" },
  ctxStripLabel:  { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", whiteSpace:"nowrap" },
  ctxChip:        { background:"#F0EAE0", border:"1.5px solid #D8D2C8", color:"#1B2A4A", padding:"4px 12px", borderRadius:20, cursor:"pointer", fontSize:13, fontFamily:"system-ui,sans-serif" },
  ctxChipActive:  { background:"#1B2A4A", border:"1.5px solid #1B2A4A", color:"#fff" },
  ctxChipAdd:     { background:"none", border:"1.5px dashed #C9922A", color:"#C9922A", padding:"4px 12px", borderRadius:20, cursor:"pointer", fontSize:13, fontFamily:"system-ui,sans-serif" },
  homeWrap:       { display:"flex", flexDirection:"column", gap:20 },
  hero:           { background:"#1B2A4A", borderRadius:12, padding:"36px 32px", color:"#F7F3EC" },
  heroEyebrow:    { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:8 },
  heroTitle:      { fontSize:36, fontWeight:"bold", margin:"0 0 8px", color:"#F7F3EC", lineHeight:1.2 },
  heroSub:        { fontSize:15, color:"#C9922A", fontStyle:"italic" },
  statsRow:       { display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:12 },
  statCard:       { background:"#fff", border:"1px solid #E0D9CF", borderRadius:10, padding:16, textAlign:"center" },
  statLabel:      { fontSize:11, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 },
  statValue:      { fontSize:20, fontWeight:"bold", color:"#1B2A4A", marginBottom:2, wordBreak:"break-word" },
  statSub:        { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif" },
  quickRow:       { display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))", gap:12 },
  quickCard:      { background:"#fff", border:"1px solid #E0D9CF", borderRadius:10, padding:20, display:"flex", flexDirection:"column", gap:6 },
  quickIcon:      { fontSize:24 },
  quickTitle:     { fontWeight:"bold", fontSize:15, color:"#1B2A4A" },
  quickDesc:      { fontSize:13, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", flexGrow:1, lineHeight:1.5, wordBreak:"break-word" },
  quickBtn:       { background:"none", border:"1px solid #C9922A", color:"#C9922A", padding:"6px 12px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"system-ui,sans-serif", marginTop:4, textAlign:"left" },
  emptyHero:      { background:"#fff", border:"1px dashed #D8D2C8", borderRadius:12, padding:"48px 32px", textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:12 },
  emptyIcon:      { fontSize:36, color:"#C9922A" },
  emptyTitle:     { fontSize:22, fontWeight:"bold", color:"#1B2A4A", margin:0 },
  emptyText:      { fontSize:15, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", maxWidth:400, lineHeight:1.6, margin:0 },
  planWrap:       { display:"flex", flexDirection:"column", gap:16 },
  planHeader:     { display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:12 },
  sectionTitle:   { fontSize:22, fontWeight:"bold", color:"#1B2A4A", margin:0 },
  planMeta:       { display:"flex", alignItems:"center", gap:8 },
  planMetaName:   { fontWeight:"bold", fontSize:14, fontFamily:"system-ui,sans-serif" },
  planMetaStat:   { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif" },
  progressWrap:   { display:"flex", alignItems:"center", gap:12 },
  progressBar:    { flex:1, height:8, background:"#E0D9CF", borderRadius:4, overflow:"hidden" },
  progressFill:   { height:"100%", background:"#C9922A", borderRadius:4, transition:"width .4s ease" },
  progressLabel:  { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", whiteSpace:"nowrap" },
  legendRow:      { display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" },
  legendDot:      { width:10, height:10, borderRadius:"50%", display:"inline-block" },
  legendTxt:      { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif" },
  weekBlock:      { background:"#fff", border:"1px solid #E0D9CF", borderRadius:10, overflow:"hidden" },
  weekBlockCurrent:{ border:"2px solid #C9922A" },
  weekHeader:     { width:"100%", background:"none", border:"none", padding:"12px 16px", display:"flex", alignItems:"center", gap:12, cursor:"pointer", textAlign:"left" },
  weekLabel:      { fontWeight:"bold", fontSize:14, color:"#1B2A4A", fontFamily:"system-ui,sans-serif", flex:1, display:"flex", alignItems:"center", gap:8 },
  currentBadge:   { background:"#C9922A", color:"#fff", fontSize:10, fontWeight:700, padding:"2px 6px", borderRadius:4, fontFamily:"system-ui,sans-serif" },
  weekProgress:   { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif" },
  weekChevron:    { fontSize:10, color:"#8A9BB0" },
  weekBody:       { borderTop:"1px solid #F0EAE0", padding:"4px 0" },
  dayRow:         { display:"flex", alignItems:"center", gap:10, padding:"8px 16px", borderBottom:"1px solid #F7F3EC" },
  dayRowToday:    { background:"#FFF8EE" },
  dayRowRest:     { background:"#F9F7F3", opacity:0.7 },
  dayNum:         { fontSize:11, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", minWidth:44 },
  trackDot:       { width:8, height:8, borderRadius:"50%", flexShrink:0 },
  dayChapter:     { flex:1, fontSize:14, color:"#1B2A4A" },
  restLabel:      { flex:1, fontSize:13, color:"#B0A898", fontStyle:"italic", fontFamily:"system-ui,sans-serif" },
  missedBadge:    { fontSize:10, color:"#C0514A", background:"#FEE8E6", padding:"2px 6px", borderRadius:4, fontFamily:"system-ui,sans-serif" },
  readerDots:     { display:"flex", gap:3 },
  readerDot:      { width:8, height:8, borderRadius:"50%", flexShrink:0 },
  checkBtn:       { width:28, height:28, borderRadius:"50%", border:"2px solid #D8D2C8", background:"none", cursor:"pointer", fontSize:14, color:"#B0A898", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  checkBtnDone:   { background:"#5C8C6A", border:"2px solid #5C8C6A", color:"#fff" },
  lbWrap:         { display:"flex", flexDirection:"column", gap:16 },
  lbSub:          { fontSize:13, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", margin:"-8px 0 0" },
  lbRow:          { background:"#fff", border:"1px solid #E0D9CF", borderRadius:10, padding:"16px 20px", display:"flex", alignItems:"center", gap:16 },
  lbRowFirst:     { border:"2px solid #C9922A", background:"#FFFCF5" },
  lbRank:         { fontSize:22, minWidth:32, textAlign:"center" },
  lbRankNum:      { fontSize:15, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", fontWeight:700 },
  lbAvatar:       { width:44, height:44, borderRadius:"50%", color:"#fff", fontWeight:700, fontSize:18, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"system-ui,sans-serif", flexShrink:0 },
  lbInfo:         { flex:1, display:"flex", flexDirection:"column", gap:4 },
  lbName:         { fontWeight:"bold", fontSize:16, color:"#1B2A4A" },
  lbStats:        { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif" },
  flameBarWrap:   { height:6, background:"#F0EAE0", borderRadius:3, overflow:"hidden", marginTop:4 },
  flameBar:       { height:"100%", borderRadius:3, transition:"width .4s ease", minWidth:4 },
  lbCount:        { textAlign:"right" },
  lbBig:          { fontSize:26, fontWeight:"bold", color:"#1B2A4A" },
  lbSmall:        { fontSize:11, color:"#8A9BB0", fontFamily:"system-ui,sans-serif" },
  gapCard:        { background:"#F0EAE0", borderRadius:10, padding:"16px 20px" },
  gapTitle:       { fontWeight:"bold", fontSize:14, color:"#1B2A4A", fontFamily:"system-ui,sans-serif", marginBottom:10 },
  gapRow:         { display:"flex", alignItems:"center", padding:"6px 0", borderBottom:"1px solid #E0D9CF", gap:10 },
  gapDot:         { width:10, height:10, borderRadius:"50%", flexShrink:0 },
  gapName:        { fontSize:14, fontWeight:"bold", color:"#1B2A4A", fontFamily:"system-ui,sans-serif", minWidth:80 },
  gapAmt:         { fontSize:13, color:"#8A9BB0", fontFamily:"system-ui,sans-serif" },
  achieveWrap:    { background:"#fff", border:"1px solid #E0D9CF", borderRadius:10, padding:"16px 20px" },
  achieveTitle:   { fontWeight:"bold", fontSize:14, color:"#1B2A4A", marginBottom:12 },
  achieveGrid:    { display:"flex", flexWrap:"wrap", gap:10 },
  achieveBadge:   { background:"#F7F3EC", border:"1px solid #E0D9CF", borderRadius:8, padding:"8px 12px", display:"flex", flexDirection:"column", alignItems:"center", gap:2, minWidth:80 },
  achieveIcon:    { fontSize:20 },
  achieveName:    { fontSize:12, fontWeight:700, fontFamily:"system-ui,sans-serif" },
  achieveLabel:   { fontSize:10, color:"#8A9BB0", fontFamily:"system-ui,sans-serif", textAlign:"center" },
  emptySmall:     { color:"#8A9BB0", fontFamily:"system-ui,sans-serif", fontSize:14, padding:"16px 0", textAlign:"center" },
  adminWrap:      { display:"flex", flexDirection:"column", gap:20 },
  adminCard:      { background:"#fff", border:"1px solid #E0D9CF", borderRadius:10, padding:"20px" },
  adminCardTitle: { fontWeight:"bold", fontSize:15, color:"#1B2A4A", marginBottom:14 },
  adminRow:       { display:"flex", gap:10, flexWrap:"wrap" },
  adminUserRow:   { display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #F0EAE0" },
  adminUserInfo:  { flex:1, display:"flex", flexDirection:"column", gap:3 },
  adminUserName:  { fontWeight:"bold", fontSize:14, color:"#1B2A4A", fontFamily:"system-ui,sans-serif" },
  adminUserStat:  { fontSize:12, color:"#8A9BB0", fontFamily:"system-ui,sans-serif" },
  deleteBtn:      { background:"none", border:"1px solid #C0514A", color:"#C0514A", padding:"4px 12px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"system-ui,sans-serif", whiteSpace:"nowrap" },
  input:          { padding:"9px 14px", border:"1px solid #D8D2C8", borderRadius:8, fontSize:15, fontFamily:"Georgia,serif", color:"#1B2A4A", background:"#FFFCF8", outline:"none" },
  primaryBtn:     { background:"#C9922A", color:"#fff", border:"none", padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:14, fontFamily:"system-ui,sans-serif", fontWeight:600, whiteSpace:"nowrap" },
  secondaryBtn:   { background:"none", color:"#8A9BB0", border:"1px solid #D8D2C8", padding:"9px 20px", borderRadius:8, cursor:"pointer", fontSize:14, fontFamily:"system-ui,sans-serif" },
};
