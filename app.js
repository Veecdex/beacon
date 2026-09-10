// Point this at your deployed Worker before shipping. During local dev with
// `wrangler dev` this defaults to the standard local port.
const API_BASE = window.BEACON_API_BASE || "https://beacon.victorpalmtrees001.workers.dev";

const state = {
  code: null,
  name: "",
  photo: null, // small base64 data URL
  address: "",
  addressLatLng: null, // { lat, lng } chosen on the picker map
  selfId: null,
  peers: [], // latest state from the server
  ws: null,
  watchId: null,
};

// ---------- view routing ----------

const views = ["landing", "onboarding", "address", "live"];
function showView(name) {
  for (const v of views) {
    document.getElementById(`view-${v}`).classList.toggle("view--active", v === name);
  }
}

function showError(elId, message) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.hidden = !message;
}

// ---------- landing ----------

const landingError = "landing-error";

document.getElementById("btn-start").addEventListener("click", async () => {
  showError(landingError, "");
  try {
    const res = await fetch(`${API_BASE}/api/rooms`, { method: "POST" });
    if (!res.ok) throw new Error("Could not reach the server");
    const data = await res.json();
    state.code = data.code;
    enterOnboarding();
  } catch (err) {
    showError(landingError, "Couldn't start a beacon. Check your connection and try again.");
  }
});

document.getElementById("form-join").addEventListener("submit", (e) => {
  e.preventDefault();
  showError(landingError, "");
  const raw = document.getElementById("input-code").value.trim().toUpperCase();
  if (raw.length < 4) {
    showError(landingError, "Enter the full code your partner shared with you.");
    return;
  }
  state.code = raw;
  enterOnboarding();
});

function enterOnboarding() {
  document.getElementById("onboarding-code").textContent = state.code;
  showView("onboarding");
}

// ---------- onboarding ----------

const nameInput = document.getElementById("input-name");
const photoInput = document.getElementById("input-photo");
const photoPreview = document.getElementById("photo-preview");
const btnPhoto = document.getElementById("btn-photo");
const btnLocation = document.getElementById("btn-location");
const locationStatus = document.getElementById("location-status");
const btnOnboardingContinue = document.getElementById("btn-onboarding-continue");

let locationGranted = false;

nameInput.addEventListener("input", () => {
  state.name = nameInput.value.trim();
  refreshOnboardingButton();
});

btnPhoto.addEventListener("click", () => photoInput.click());

photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  if (!file) return;
  try {
    state.photo = await resizePhotoToDataUrl(file, 160);
    photoPreview.innerHTML = `<img src="${state.photo}" alt="Your photo" />`;
    refreshOnboardingButton();
  } catch {
    showError("onboarding-error", "Couldn't read that photo. Try a different one.");
  }
});

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
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

btnLocation.addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    locationStatus.textContent = "This browser can't share location.";
    return;
  }
  locationStatus.textContent = "Requesting access…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.addressLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      locationGranted = true;
      btnLocation.textContent = "Location on";
      btnLocation.classList.add("is-active");
      locationStatus.textContent = "Your partner will be able to see where you are.";
      refreshOnboardingButton();
    },
    () => {
      locationStatus.textContent = "Location was blocked. Allow it in your browser settings to continue.";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

function refreshOnboardingButton() {
  btnOnboardingContinue.disabled = !(state.name && state.photo && locationGranted);
}

btnOnboardingContinue.addEventListener("click", () => {
  showView("address");
  initAddressMap();
});

// ---------- address picker ----------

let addressMap, addressMarker;

function initAddressMap() {
  const start = state.addressLatLng || { lat: 6.5244, lng: 3.3792 }; // fallback: Lagos
  if (!addressMap) {
    addressMap = L.map("map-address", { zoomControl: false }).setView([start.lat, start.lng], 15);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 19,
    }).addTo(addressMap);

    addressMarker = L.marker([start.lat, start.lng], { draggable: true }).addTo(addressMap);
    addressMarker.on("dragend", () => {
      const ll = addressMarker.getLatLng();
      state.addressLatLng = { lat: ll.lat, lng: ll.lng };
      reverseGeocode(ll.lat, ll.lng);
    });
  } else {
    addressMap.invalidateSize();
    addressMap.setView([start.lat, start.lng], 15);
    addressMarker.setLatLng([start.lat, start.lng]);
  }
  reverseGeocode(start.lat, start.lng);
}

async function reverseGeocode(lat, lng) {
  const label = document.getElementById("address-label");
  label.textContent = "Locating you…";
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`
    );
    const data = await res.json();
    state.address = data.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch {
    state.address = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
  label.textContent = state.address;
}

document.getElementById("btn-address-search").addEventListener("click", searchAddress);
document.getElementById("input-address-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    searchAddress();
  }
});

async function searchAddress() {
  const q = document.getElementById("input-address-search").value.trim();
  if (!q) return;
  showError("address-error", "");
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=1`
    );
    const results = await res.json();
    if (!results.length) {
      showError("address-error", "No address matched that search.");
      return;
    }
    const { lat, lon, display_name } = results[0];
    state.addressLatLng = { lat: parseFloat(lat), lng: parseFloat(lon) };
    state.address = display_name;
    addressMap.setView([state.addressLatLng.lat, state.addressLatLng.lng], 16);
    addressMarker.setLatLng([state.addressLatLng.lat, state.addressLatLng.lng]);
    document.getElementById("address-label").textContent = state.address;
  } catch {
    showError("address-error", "Couldn't search right now. Try again in a moment.");
  }
}

document.getElementById("btn-confirm-address").addEventListener("click", () => {
  showView("live");
  goLive();
});

// ---------- live view ----------

let liveMap;
const markers = new Map(); // peer id -> L.marker

function goLive() {
  document.getElementById("live-code").textContent = state.code;

  if (!liveMap) {
    const start = state.addressLatLng;
    liveMap = L.map("map-live", { zoomControl: false }).setView([start.lat, start.lng], 15);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 19,
    }).addTo(liveMap);
  } else {
    liveMap.invalidateSize();
  }

  connectSocket();
  startWatchingPosition();
}

function connectSocket() {
  const url = `${API_BASE.replace(/^http/, "ws")}/api/rooms/${state.code}/ws`;
  const ws = new WebSocket(url);
  state.ws = ws;
  let welcomed = false;

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "welcome") {
      welcomed = true;
      state.selfId = msg.id;
      sendJoin();
    } else if (msg.type === "state") {
      state.peers = msg.peers;
      renderPeers();
    }
  });

  ws.addEventListener("close", () => {
    if (!welcomed) {
      showError("live-error", "This beacon already has two people. Ask them for a new code, or start your own.");
    } else {
      showError("live-error", "Connection lost. Refresh to try reconnecting.");
    }
  });

  ws.addEventListener("error", () => {
    if (!welcomed) showError("live-error", "Couldn't connect. Check your connection and try again.");
  });
}

function sendJoin() {
  state.ws.send(
    JSON.stringify({
      type: "join",
      name: state.name,
      photo: state.photo,
      address: state.address,
      lat: state.addressLatLng.lat,
      lng: state.addressLatLng.lng,
    })
  );
}

function startWatchingPosition() {
  if (!("geolocation" in navigator)) return;
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(
          JSON.stringify({ type: "location", lat: pos.coords.latitude, lng: pos.coords.longitude })
        );
      }
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 }
  );
}

function avatarHtml(peer, isYou) {
  const cls = `avatar-marker${isYou ? " avatar-marker--you" : ""}`;
  if (peer.photo) return `<img class="${cls}" src="${peer.photo}" alt="${peer.name || "Guest"}" />`;
  const initial = (peer.name || "?").charAt(0).toUpperCase();
  return `<div class="${cls} avatar-marker--fallback">${initial}</div>`;
}

function renderPeers() {
  const you = state.peers.find((p) => p.id === state.selfId);
  const others = state.peers.filter((p) => p.id !== state.selfId);
  const peer = others[0];

  // markers
  const seen = new Set();
  for (const p of state.peers) {
    if (p.lat == null || p.lng == null) continue;
    seen.add(p.id);
    const isYou = p.id === state.selfId;
    let marker = markers.get(p.id);
    const icon = L.divIcon({
      html: avatarHtml(p, isYou),
      className: "",
      iconSize: [44, 44],
    });
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

  // frame both points once we have two
  if (you && peer && you.lat != null && peer.lat != null) {
    const bounds = L.latLngBounds([
      [you.lat, you.lng],
      [peer.lat, peer.lng],
    ]);
    liveMap.fitBounds(bounds, { padding: [80, 80], maxZoom: 16 });
  }

  // distance pill
  const pill = document.getElementById("distance-pill");
  if (you && peer && you.lat != null && peer.lat != null) {
    const meters = haversineMeters(you.lat, you.lng, peer.lat, peer.lng);
    document.getElementById("distance-value").textContent = formatDistance(meters) + " apart";
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }

  // waiting panel
  const waiting = document.getElementById("waiting-panel");
  waiting.hidden = !!peer;

  // roster
  const roster = document.getElementById("roster");
  roster.hidden = state.peers.length === 0;
  roster.innerHTML = state.peers
    .map((p) => {
      const isYou = p.id === state.selfId;
      const img = p.photo
        ? `<img class="roster-chip__avatar" src="${p.photo}" alt="" />`
        : `<span class="roster-chip__avatar"></span>`;
      const label = isYou ? `${p.name || "You"} (you)` : p.name || "Guest";
      return `<div class="roster-chip roster-chip--${isYou ? "you" : "peer"}">${img}<span>${label}</span></div>`;
    })
    .join("");
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

document.getElementById("btn-copy-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.code);
    const el = document.querySelector(".code-chip__copy");
    const original = el.textContent;
    el.textContent = "Copied";
    setTimeout(() => (el.textContent = original), 1400);
  } catch {
    // clipboard API unavailable — the code is already visible on screen
  }
});
