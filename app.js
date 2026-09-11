const API_BASE = window.BEACON_API_BASE || "https://beacon-1aek.onrender.com";
const WS_BASE = API_BASE.replace(/^http/, "ws");

const state = {
  token: localStorage.getItem("beacon_token") || null,
  user: null, // { id, name, photo }
  code: null,
  selfId: null,
  peers: [],
  ws: null,
  watchId: null,
  pendingCode: null,
};

// ---------- tiny helpers ----------

function el(id) { return document.getElementById(id); }

function showView(name) {
  for (const v of ["auth", "dashboard", "live"]) {
    el(`view-${v}`).classList.toggle("view--active", v === name);
  }
}

function showError(id, message) {
  const node = el(id);
  node.textContent = message;
  node.hidden = !message;
}

async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && state.token) headers["Authorization"] = `Bearer ${state.token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

function resizePhotoToDataUrl(file, maxDim) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- boot ----------

function readPendingCodeFromURL() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  return code ? code.trim().toUpperCase() : null;
}

async function boot() {
  state.pendingCode = readPendingCodeFromURL();

  if (!state.token) {
    showView("auth");
    return;
  }

  try {
    state.user = await api("/api/me");
    enterDashboard();
  } catch {
    localStorage.removeItem("beacon_token");
    state.token = null;
    showView("auth");
  }
}

// ---------- auth view ----------

el("tab-login").addEventListener("click", () => switchTab("login"));
el("tab-signup").addEventListener("click", () => switchTab("signup"));

function switchTab(which) {
  el("tab-login").classList.toggle("is-active", which === "login");
  el("tab-signup").classList.toggle("is-active", which === "signup");
  el("form-login").hidden = which !== "login";
  el("form-signup").hidden = which !== "signup";
  showError("auth-error", "");
}

let signupPhoto = "";
el("signup-photo-input").addEventListener("change", async () => {
  const file = el("signup-photo-input").files[0];
  if (!file) return;
  try {
    signupPhoto = await resizePhotoToDataUrl(file, 160);
    el("signup-photo-preview").innerHTML = `<img src="${signupPhoto}" alt="Your photo" />`;
  } catch {
    showError("auth-error", "Couldn't read that photo. Try a different one.");
  }
});
// No extra click handler needed here — signup-photo-input sits inside a
// <label>, so clicking anywhere in the label (the preview or the "Add a
// photo" text) already opens the file picker natively.

el("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("auth-error", "");
  try {
    const data = await api("/api/auth/login", {
      auth: false,
      method: "POST",
      body: { email: el("login-email").value.trim(), password: el("login-password").value },
    });
    onAuthed(data);
  } catch (err) {
    showError("auth-error", err.message);
  }
});

el("form-signup").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("auth-error", "");
  try {
    const data = await api("/api/auth/signup", {
      auth: false,
      method: "POST",
      body: {
        name: el("signup-name").value.trim(),
        email: el("signup-email").value.trim(),
        password: el("signup-password").value,
        photo: signupPhoto,
      },
    });
    onAuthed(data);
  } catch (err) {
    showError("auth-error", err.message);
  }
});

function onAuthed(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem("beacon_token", data.token);
  enterDashboard();
}

el("btn-logout").addEventListener("click", () => {
  disconnectLive();
  localStorage.removeItem("beacon_token");
  state.token = null;
  state.user = null;
  switchTab("login");
  el("form-login").reset();
  showView("auth");
});

// ---------- dashboard ----------

function enterDashboard() {
  el("dashboard-name").textContent = state.user.name || "there";
  showError("dashboard-error", "");

  const pending = el("pending-join");
  if (state.pendingCode) {
    pending.hidden = false;
    el("pending-join-code").textContent = state.pendingCode;
  } else {
    pending.hidden = true;
  }

  showView("dashboard");
}

el("btn-start").addEventListener("click", async () => {
  showError("dashboard-error", "");
  try {
    const room = await api("/api/rooms", { method: "POST" });
    enterLive(room.code);
  } catch (err) {
    showError("dashboard-error", err.message);
  }
});

el("form-join").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("dashboard-error", "");
  const code = el("input-code").value.trim().toUpperCase();
  if (code.length < 4) {
    showError("dashboard-error", "Enter the full code your partner shared with you.");
    return;
  }
  try {
    await api("/api/rooms/join", { method: "POST", body: { code } });
    enterLive(code);
  } catch (err) {
    showError("dashboard-error", err.message);
  }
});

el("btn-pending-join").addEventListener("click", async () => {
  showError("dashboard-error", "");
  try {
    await api("/api/rooms/join", { method: "POST", body: { code: state.pendingCode } });
    enterLive(state.pendingCode);
  } catch (err) {
    showError("dashboard-error", err.message);
  }
});

el("btn-live-back").addEventListener("click", () => {
  disconnectLive();
  state.pendingCode = null;
  window.history.replaceState({}, "", window.location.pathname);
  enterDashboard();
});

// ---------- live view ----------

let liveMap;
const markers = new Map(); // peer id -> L.marker

function enterLive(code) {
  state.code = code;
  el("live-code").textContent = code;
  showError("live-error", "");
  hidePanel("permission-primer");
  hidePanel("permission-denied");
  el("manual-location").hidden = false;
  el("manual-location-form").hidden = true;

  if (!liveMap) {
    liveMap = L.map("map-live", { zoomControl: false }).setView([20, 0], 3);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 19,
    }).addTo(liveMap);
  } else {
    for (const marker of markers.values()) liveMap.removeLayer(marker);
    markers.clear();
    liveMap.invalidateSize();
  }

  showView("live");
  connectSocket(code);
  initGeolocation();
}

function disconnectLive() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  if (state.watchId != null && "geolocation" in navigator) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  state.peers = [];
  state.selfId = null;
}

function connectSocket(code) {
  const ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  let opened = false;

  ws.addEventListener("open", () => { opened = true; });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "state") {
      state.selfId = msg.you;
      state.peers = msg.peers;
      renderPeers();
    }
  });

  ws.addEventListener("close", () => {
    if (!opened) {
      showError("live-error", "Couldn't connect to this beacon. Check your connection and try again.");
    }
  });

  ws.addEventListener("error", () => {
    if (!opened) showError("live-error", "Couldn't connect to this beacon.");
  });
}

function sendLocation(lat, lng) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "location", lat, lng }));
  }
}

// ---------- geolocation permission staging ----------
//
// The goals here: never surprise-prompt the user, always explain why we're
// asking before the browser's own dialog appears, and give a clear path
// forward if permission was already denied (browsers won't let a page
// re-prompt once denied — the person has to fix it in site settings).

function hidePanel(id) { el(id).hidden = true; }

async function initGeolocation() {
  if (!("geolocation" in navigator)) {
    showError("live-error", "This browser can't share location. You can still set a point manually below.");
    return;
  }

  if ("permissions" in navigator) {
    try {
      const status = await navigator.permissions.query({ name: "geolocation" });
      if (status.state === "granted") {
        startWatching();
        return;
      }
      if (status.state === "denied") {
        showPermissionDenied();
        return;
      }
    } catch {
      // Permissions API not fully supported (notably Safari) — fall through
      // to the primer, which still works fine via getCurrentPosition/watchPosition.
    }
  }

  showPermissionPrimer();
}

function showPermissionPrimer() {
  hidePanel("permission-denied");
  el("permission-primer").hidden = false;
}

function showPermissionDenied() {
  hidePanel("permission-primer");
  el("permission-denied").hidden = false;
}

el("btn-share-location").addEventListener("click", () => {
  // A single getCurrentPosition call, made directly inside this click
  // handler, is what actually triggers the browser's permission dialog on a
  // user gesture rather than silently failing on some mobile browsers.
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      hidePanel("permission-primer");
      sendLocation(pos.coords.latitude, pos.coords.longitude);
      startWatching();
    },
    (err) => handleGeolocationError(err),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

function startWatching() {
  hidePanel("permission-primer");
  hidePanel("permission-denied");
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => sendLocation(pos.coords.latitude, pos.coords.longitude),
    (err) => handleGeolocationError(err),
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 }
  );
}

function handleGeolocationError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    showPermissionDenied();
  } else {
    showError("live-error", "Couldn't get your location right now. You can set a point manually below.");
  }
}

// ---------- manual address fallback ----------

el("btn-manual-toggle").addEventListener("click", () => {
  el("manual-location-form").hidden = !el("manual-location-form").hidden;
});

el("btn-manual-search").addEventListener("click", async () => {
  const q = el("input-manual-address").value.trim();
  if (!q) return;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=1`);
    const results = await res.json();
    if (!results.length) {
      showError("live-error", "No address matched that search.");
      return;
    }
    sendLocation(parseFloat(results[0].lat), parseFloat(results[0].lon));
    el("manual-location-form").hidden = true;
  } catch {
    showError("live-error", "Couldn't search right now. Try again in a moment.");
  }
});

// ---------- rendering ----------

function avatarHtml(peer, isYou) {
  const cls = `avatar-marker${isYou ? " avatar-marker--you" : ""}`;
  if (peer.photo) return `<img class="${cls}" src="${peer.photo}" alt="${peer.name || "Guest"}" />`;
  const initial = (peer.name || "?").charAt(0).toUpperCase();
  return `<div class="${cls} avatar-marker--fallback">${initial}</div>`;
}

function renderPeers() {
  const you = state.peers.find((p) => p.id === state.selfId);
  const peer = state.peers.find((p) => p.id !== state.selfId);

  const seen = new Set();
  for (const p of state.peers) {
    if (p.lat == null || p.lng == null) continue;
    seen.add(p.id);
    const isYou = p.id === state.selfId;
    const icon = L.divIcon({ html: avatarHtml(p, isYou), className: "", iconSize: [44, 44] });
    let marker = markers.get(p.id);
    if (!marker) {
      marker = L.marker([p.lat, p.lng], { icon }).addTo(liveMap);
      markers.set(p.id, marker);
    } else {
      marker.setLatLng([p.lat, p.lng]);
      marker.setIcon(icon);
    }
  }
  for (const [id, marker] of markers) {
    if (!seen.has(id)) {
      liveMap.removeLayer(marker);
      markers.delete(id);
    }
  }

  if (you && peer && you.lat != null && peer.lat != null) {
    liveMap.fitBounds(
      L.latLngBounds([[you.lat, you.lng], [peer.lat, peer.lng]]),
      { padding: [80, 80], maxZoom: 16 }
    );
  } else if (you && you.lat != null && markers.size === 1) {
    liveMap.setView([you.lat, you.lng], 15);
  }

  const pill = el("distance-pill");
  if (you && peer && you.lat != null && peer.lat != null) {
    const meters = haversineMeters(you.lat, you.lng, peer.lat, peer.lng);
    el("distance-value").textContent = `${formatDistance(meters)} apart`;
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }

  el("waiting-panel").hidden = !!peer;

  const roster = el("roster");
  roster.hidden = state.peers.length === 0;
  roster.innerHTML = state.peers
    .map((p) => {
      const isYou = p.id === state.selfId;
      const img = p.photo
        ? `<img class="roster-chip__avatar" src="${p.photo}" alt="" />`
        : `<span class="roster-chip__avatar"></span>`;
      const label = isYou ? `${p.name || "You"} (you)` : p.online ? p.name || "Guest" : `${p.name || "Guest"} (offline)`;
      const offlineClass = !isYou && !p.online ? " roster-chip--offline" : "";
      return `<div class="roster-chip roster-chip--${isYou ? "you" : "peer"}${offlineClass}">${img}<span>${label}</span></div>`;
    })
    .join("");
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

el("btn-copy-code").addEventListener("click", () => copyText(state.code, ".code-chip__copy"));
el("btn-copy-link").addEventListener("click", () => {
  const link = `${window.location.origin}${window.location.pathname}?code=${state.code}`;
  copyText(link, "#btn-copy-link span");
});

async function copyText(text, feedbackSelector) {
  try {
    await navigator.clipboard.writeText(text);
    const node = document.querySelector(feedbackSelector);
    const original = node.textContent;
    node.textContent = "Copied";
    setTimeout(() => (node.textContent = original), 1400);
  } catch {
    // clipboard API unavailable — code/link are already visible on screen
  }
}

boot();
