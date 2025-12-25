// Front-only prototype for secured plans + annotations
// Rien ne part au serveur : stockage local + dissuasion visuelle

const $ = (sel) => document.querySelector(sel);

const els = {
  board: $("#board"),
  canvasShell: $("#canvasShell"),
  planList: $("#planList"),
  emptyState: $("#emptyState"),
  watermark: $("#watermark"),
  privacyBlur: $("#privacyBlur"),
  strokeSize: $("#strokeSize"),
  strokeColor: $("#strokeColor"),
  notes: $("#notes"),
  sessionPill: $("#sessionPill"),
  shareKey: $("#shareKey"),
  loginModal: $("#loginModal"),
  loginForm: $("#loginForm"),
  loginLabel: $("#loginLabel"),
  loginSecret: $("#loginSecret"),
  loginError: $("#loginError"),
};

const DEFAULT_HASH = "0eb0cb8f59e4effdedab83e44e320301c413a24573cb1606f83d8f2a1778e58b"; // sha256("shadow123")

const storageKeys = {
  session: "soi_session_v2",
  plans: "soi_plans_v2",
  annotations: "soi_annotations_v1",
  notes: "soi_notes_v1",
  shareKeys: "soi_share_keys_v1",
};

const state = {
  session: { authed: false, label: "", privacy: false },
  plans: [],
  annotations: {}, // planId => { strokes: [], redo: [] }
  activePlanId: null,
  tool: "pencil",
  drawing: false,
  currentStroke: null,
  previewArrow: null,
  transform: { scale: 1, ox: 0, oy: 0 },
  img: null,
};

const ctx = els.board.getContext("2d", { alpha: false });

// Utils
const sha256 = async (text) => {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

const loadJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn("Storage parse error", err);
    return fallback;
  }
};

const saveJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));

const nowMs = () => Date.now();

function createWatermark(label) {
  const text = `${label} • ${new Date().toLocaleString()}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><text x="20" y="60" fill="rgba(255,255,255,0.16)" font-size="22" font-family="Arial" transform="rotate(-12 160 90)">${text}</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function updateWatermark() {
  if (!state.session.authed) return;
  els.watermark.style.backgroundImage = createWatermark(state.session.label || "Shadow");
  els.watermark.classList.toggle("is-hidden", !state.session.privacy);
}

function setPrivacy(enabled) {
  state.session.privacy = enabled;
  els.privacyBlur.classList.toggle("is-hidden", !enabled);
  updateWatermark();
  persistSession();
}

function handleBlur() {
  if (state.session.privacy) {
    els.privacyBlur.classList.remove("is-hidden");
  }
}

function handleFocus() {
  if (state.session.privacy) {
    els.privacyBlur.classList.add("is-hidden");
  }
}

function preventPrintScreen(ev) {
  if (ev.key === "PrintScreen") {
    ev.preventDefault();
    setPrivacy(true);
    els.privacyBlur.textContent = "Capture bloquée";
    setTimeout(() => {
      els.privacyBlur.textContent = "Mode discret actif";
    }, 2000);
  }
}

// Authentication
async function validateSecret(secret) {
  const hash = await sha256(secret.trim());
  if (hash === DEFAULT_HASH) return true;

  const shareKeys = loadShareKeys();
  const validKey = shareKeys.find((k) => k.hash === hash && k.expiresAt > nowMs());
  return Boolean(validKey);
}

function loadShareKeys() {
  const keys = loadJSON(storageKeys.shareKeys, []);
  const filtered = keys.filter((k) => k.expiresAt > nowMs());
  if (filtered.length !== keys.length) saveJSON(storageKeys.shareKeys, filtered);
  return filtered;
}

function addShareKey(rawKey, hash) {
  const keys = loadShareKeys();
  const expiresAt = nowMs() + 24 * 60 * 60 * 1000; // 24h
  keys.push({ hash, expiresAt });
  saveJSON(storageKeys.shareKeys, keys);
  return { rawKey, expiresAt };
}

async function generateShareKey() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  const rawKey = btoa(String.fromCharCode(...arr)).replace(/\W/g, "").slice(0, 24);
  const hash = await sha256(rawKey);
  const { expiresAt } = addShareKey(rawKey, hash);
  els.shareKey.value = rawKey;
  els.shareKey.dataset.expires = new Date(expiresAt).toLocaleString();
  els.shareKey.title = `Expire le ${els.shareKey.dataset.expires}`;
}

function persistSession() {
  saveJSON(storageKeys.session, state.session);
}

function loadSession() {
  const saved = loadJSON(storageKeys.session, null);
  if (saved) {
    state.session = { ...state.session, ...saved };
  }
}

function updateSessionUI() {
  if (state.session.authed) {
    els.sessionPill.textContent = `Connecté: ${state.session.label}`;
    els.sessionPill.className = "pill pill-ok";
    els.loginModal.classList.add("is-hidden");
  } else {
    els.sessionPill.textContent = "Non authentifié";
    els.sessionPill.className = "pill pill-warn";
    els.loginModal.classList.remove("is-hidden");
  }
  updateWatermark();
}

async function handleLogin(ev) {
  ev.preventDefault();
  const label = els.loginLabel.value.trim() || "Opérateur";
  const secret = els.loginSecret.value.trim();
  if (!secret) return;

  const ok = await validateSecret(secret);
  if (!ok) {
    els.loginError.classList.remove("is-hidden");
    return;
  }
  els.loginError.classList.add("is-hidden");

  state.session.authed = true;
  state.session.label = label;
  persistSession();
  updateSessionUI();
}

function logout() {
  state.session = { authed: false, label: "", privacy: false };
  persistSession();
  updateSessionUI();
}

// Plans & annotations
function loadPlans() {
  state.plans = loadJSON(storageKeys.plans, []);
  state.annotations = loadJSON(storageKeys.annotations, {});
  state.activePlanId = state.plans[0]?.id || null;
}

function savePlans() {
  saveJSON(storageKeys.plans, state.plans);
  saveJSON(storageKeys.annotations, state.annotations);
}

function ensureLayer(planId) {
  if (!state.annotations[planId]) {
    state.annotations[planId] = { strokes: [], redo: [] };
  }
  return state.annotations[planId];
}

function renderPlanList() {
  els.planList.innerHTML = "";
  if (!state.plans.length) {
    els.planList.classList.add("empty");
    els.planList.textContent = "Aucun plan pour l'instant.";
    els.emptyState.style.display = "flex";
    state.img = null;
    clearBoard();
    return;
  }
  els.planList.classList.remove("empty");

  state.plans
    .sort((a, b) => b.uploadedAt - a.uploadedAt)
    .forEach((plan) => {
      const item = document.createElement("div");
      item.className = "plan-item" + (plan.id === state.activePlanId ? " is-active" : "");
      item.innerHTML = `<div class="plan-name">${plan.name}</div><div class="plan-meta">${new Date(plan.uploadedAt).toLocaleString()}</div>`;
      item.addEventListener("click", () => selectPlan(plan.id));
      els.planList.appendChild(item);
    });
}

function selectPlan(planId) {
  state.activePlanId = planId;
  renderPlanList();
  const plan = state.plans.find((p) => p.id === planId);
  if (!plan) return;
  loadImage(plan.dataUrl);
}

function addPlan(name, dataUrl) {
  const id = `plan_${Date.now()}`;
  state.plans.push({ id, name, dataUrl, uploadedAt: nowMs() });
  ensureLayer(id);
  savePlans();
  selectPlan(id);
}

function loadImage(dataUrl) {
  const img = new Image();
  img.onload = () => {
    state.img = img;
    recomputeTransform();
    render();
  };
  img.src = dataUrl;
}

// Canvas helpers
function resizeCanvas() {
  const rect = els.canvasShell.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  els.board.width = Math.floor(rect.width * dpr);
  els.board.height = Math.floor(rect.height * dpr);
  els.board.style.width = `${rect.width}px`;
  els.board.style.height = `${rect.height}px`;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  recomputeTransform();
  render();
}

function recomputeTransform() {
  if (!state.img) return;
  const cw = els.board.clientWidth;
  const ch = els.board.clientHeight;
  const iw = state.img.naturalWidth;
  const ih = state.img.naturalHeight;
  const scale = Math.min(cw / iw, ch / ih);
  const ox = (cw - iw * scale) / 2;
  const oy = (ch - ih * scale) / 2;
  state.transform = { scale, ox, oy };
}

function imageToCanvas(ix, iy) {
  const { scale, ox, oy } = state.transform;
  return { x: ix * scale + ox, y: iy * scale + oy };
}

function canvasToImage(px, py) {
  const { scale, ox, oy } = state.transform;
  return { x: (px - ox) / scale, y: (py - oy) / scale };
}

function insideImage(px, py) {
  if (!state.img) return false;
  const { x, y } = canvasToImage(px, py);
  return x >= 0 && y >= 0 && x <= state.img.naturalWidth && y <= state.img.naturalHeight;
}

function clearBoard() {
  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0, 0, els.board.clientWidth, els.board.clientHeight);
}

function drawBackground() {
  clearBoard();
  if (!state.img) return;
  const { scale, ox, oy } = state.transform;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(state.img, ox, oy, state.img.naturalWidth * scale, state.img.naturalHeight * scale);
}

function drawPencil(points, color, width) {
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const p0 = imageToCanvas(points[0].x, points[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < points.length; i++) {
    const p = imageToCanvas(points[i].x, points[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function drawArrow(x1, y1, x2, y2, color, width) {
  const p1 = imageToCanvas(x1, y1);
  const p2 = imageToCanvas(x2, y2);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();

  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const headLen = Math.max(10, width * 3);
  ctx.beginPath();
  ctx.moveTo(p2.x, p2.y);
  ctx.lineTo(p2.x - headLen * Math.cos(angle - Math.PI / 7), p2.y - headLen * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(p2.x - headLen * Math.cos(angle + Math.PI / 7), p2.y - headLen * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function render() {
  els.emptyState.style.display = state.img ? "none" : "flex";
  drawBackground();
  if (!state.activePlanId) return;
  const layer = ensureLayer(state.activePlanId);
  for (const s of layer.strokes) {
    if (s.type === "pencil") drawPencil(s.points, s.color, s.width);
    if (s.type === "arrow") drawArrow(s.x1, s.y1, s.x2, s.y2, s.color, s.width);
  }
  if (state.currentStroke && state.currentStroke.type === "pencil") {
    drawPencil(state.currentStroke.points, state.currentStroke.color, state.currentStroke.width);
  }
  if (state.previewArrow) {
    const a = state.previewArrow;
    drawArrow(a.x1, a.y1, a.x2, a.y2, a.color, a.width);
  }
}

// Pointer handling
function pointerPos(ev) {
  const rect = els.board.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function onPointerDown(ev) {
  if (!state.session.authed || !state.img) return;
  const p = pointerPos(ev);
  if (!insideImage(p.x, p.y) && state.tool !== "eraser") return;
  const layer = ensureLayer(state.activePlanId);

  if (state.tool === "pencil") {
    state.drawing = true;
    state.currentStroke = { type: "pencil", color: els.strokeColor.value, width: Number(els.strokeSize.value), points: [canvasToImage(p.x, p.y)] };
  } else if (state.tool === "arrow") {
    state.drawing = true;
    const imgP = canvasToImage(p.x, p.y);
    state.previewArrow = { x1: imgP.x, y1: imgP.y, x2: imgP.x, y2: imgP.y, color: els.strokeColor.value, width: Number(els.strokeSize.value) };
  } else if (state.tool === "eraser") {
    eraseNearby(p, layer);
  }
}

function onPointerMove(ev) {
  if (!state.drawing) return;
  const p = pointerPos(ev);
  if (state.tool === "pencil" && state.currentStroke) {
    state.currentStroke.points.push(canvasToImage(p.x, p.y));
  }
  if (state.tool === "arrow" && state.previewArrow) {
    const imgP = canvasToImage(p.x, p.y);
    state.previewArrow.x2 = imgP.x;
    state.previewArrow.y2 = imgP.y;
  }
  render();
}

function onPointerUp(ev) {
  if (!state.drawing) return;
  const layer = ensureLayer(state.activePlanId);
  if (state.tool === "pencil" && state.currentStroke) {
    layer.strokes.push(state.currentStroke);
  }
  if (state.tool === "arrow" && state.previewArrow) {
    layer.strokes.push({ ...state.previewArrow });
  }
  layer.redo = [];
  state.drawing = false;
  state.currentStroke = null;
  state.previewArrow = null;
  savePlans();
  render();
}

function eraseNearby(p, layer) {
  const target = canvasToImage(p.x, p.y);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  for (let i = layer.strokes.length - 1; i >= 0; i--) {
    const s = layer.strokes[i];
    if (s.type === "pencil") {
      if (s.points.some((pt) => dist(pt, target) < 14)) {
        layer.strokes.splice(i, 1);
        break;
      }
    } else if (s.type === "arrow") {
      const mid = { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
      if (dist(mid, target) < 18) {
        layer.strokes.splice(i, 1);
        break;
      }
    }
  }
  savePlans();
  render();
}

// Toolbar actions
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll(".toolbtn").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.tool === tool));
}

function undo() {
  const layer = ensureLayer(state.activePlanId);
  const last = layer.strokes.pop();
  if (last) layer.redo.push(last);
  savePlans();
  render();
}

function redo() {
  const layer = ensureLayer(state.activePlanId);
  const item = layer.redo.pop();
  if (item) layer.strokes.push(item);
  savePlans();
  render();
}

function clearAnnotations() {
  const layer = ensureLayer(state.activePlanId);
  layer.strokes = [];
  layer.redo = [];
  savePlans();
  render();
}

function exportPNG() {
  if (!state.session.authed) return;
  const url = els.board.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.session.label || "plan"}.png`;
  a.click();
}

function copyShareKey() {
  const val = els.shareKey.value;
  if (!val) return;
  navigator.clipboard?.writeText(val);
}

function enterFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
}

// File upload
function handleFileChange(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    addPlan(file.name, reader.result);
  };
  reader.readAsDataURL(file);
  ev.target.value = "";
}

// Notes
function loadNotes() {
  els.notes.value = loadJSON(storageKeys.notes, "");
}

function saveNotes() {
  saveJSON(storageKeys.notes, els.notes.value);
}

// Init
function bindEvents() {
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("blur", handleBlur);
  window.addEventListener("focus", handleFocus);
  window.addEventListener("keydown", preventPrintScreen);

  els.board.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  document.querySelectorAll(".toolbtn").forEach((btn) => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
  });

  $("#btnUndo").addEventListener("click", undo);
  $("#btnRedo").addEventListener("click", redo);
  $("#btnClear").addEventListener("click", clearAnnotations);
  $("#btnExport").addEventListener("click", exportPNG);
  $("#btnUpload").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", handleFileChange);
  $("#btnGenKey").addEventListener("click", generateShareKey);
  $("#btnCopyKey").addEventListener("click", copyShareKey);
  $("#btnFullscreen").addEventListener("click", enterFullscreen);
  $("#btnPrivacy").addEventListener("click", () => setPrivacy(!state.session.privacy));
  $("#btnLogout").addEventListener("click", logout);
  els.loginForm.addEventListener("submit", handleLogin);
  els.notes.addEventListener("input", saveNotes);
}

function init() {
  loadSession();
  loadPlans();
  loadNotes();
  bindEvents();
  resizeCanvas();
  renderPlanList();
  if (state.activePlanId) selectPlan(state.activePlanId);
  updateSessionUI();
  setPrivacy(state.session.privacy);
}

init();
