/**
 * SPARTAN - Plans Sécurisés & Annotations
 * Application front-end pour la gestion sécurisée de plans avec annotations
 */

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const CONFIG = {
  DEFAULT_PASSWORD_HASH: "0eb0cb8f59e4effdedab83e44e320301c413a24573cb1606f83d8f2a1778e58b", // sha256("shadow123")
  KEY_EXPIRY_HOURS: 24,
  STORAGE_VERSION: "v2",
  MIN_STROKE_SIZE: 2,
  MAX_STROKE_SIZE: 20,
  DEFAULT_STROKE_SIZE: 4,
  DEFAULT_STROKE_COLOR: "#ff3b30",
};

const STORAGE_KEYS = {
  session: `spartan_session_${CONFIG.STORAGE_VERSION}`,
  plans: `spartan_plans_${CONFIG.STORAGE_VERSION}`,
  annotations: `spartan_annotations_${CONFIG.STORAGE_VERSION}`,
  notes: `spartan_notes_${CONFIG.STORAGE_VERSION}`,
  shareKeys: `spartan_share_keys_${CONFIG.STORAGE_VERSION}`,
  alliances: `spartan_alliances_${CONFIG.STORAGE_VERSION}`,
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const state = {
  session: {
    authed: false,
    label: "",
    privacy: false,
  },
  plans: [],
  annotations: {}, // planId => { strokes: [], redo: [] }
  activePlanId: null,
  tool: "pencil",
  drawing: false,
  currentStroke: null,
  previewArrow: null,
  previewLine: null,
  textEditing: null, // { x, y, text, fontSize, fontFamily, color, bgColor, bgOpacity }
  eraserMode: "vector", // "vector" or "pixel"
  eraserStroke: null, // For pixel eraser
  selection: {
    box: null, // { x1, y1, x2, y2 }
    selectedItems: [], // Array of { type, index, originalData }
    dragging: false,
    dragOffset: { x: 0, y: 0 },
  },
  ruler: { enabled: false, gridSize: 20 },
  transform: { scale: 1, ox: 0, oy: 0 },
  img: null,
  alliances: [],
};

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  // Canvas
  board: $("#board"),
  rulerCanvas: $("#rulerCanvas"),
  canvasShell: $("#canvasShell"),
  emptyState: $("#emptyState"),
  watermark: $("#watermark"),
  privacyBlur: $("#privacyBlur"),
  textInputOverlay: $("#textInputOverlay"),
  textInput: $("#textInput"),
  
  // Toolbar
  strokeSize: $("#strokeSize"),
  strokeSizeValue: $("#strokeSizeValue"),
  strokeColor: $("#strokeColor"),
  textFontSize: $("#textFontSize"),
  textFontSizeValue: $("#textFontSizeValue"),
  textFontFamily: $("#textFontFamily"),
  textBgColor: $("#textBgColor"),
  textBgOpacity: $("#textBgOpacity"),
  textBgOpacityValue: $("#textBgOpacityValue"),
  strokeControls: $("#strokeControls"),
  colorControls: $("#colorControls"),
  textControls: $("#textControls"),
  textControls2: $("#textControls2"),
  textControls3: $("#textControls3"),
  
  // Sidebar
  planList: $("#planList"),
  notes: $("#notes"),
  shareKey: $("#shareKey"),
  keyExpiry: $("#keyExpiry"),
  
  // Auth
  sessionPill: $("#sessionPill"),
  loginModal: $("#loginModal"),
  loginForm: $("#loginForm"),
  loginLabel: $("#loginLabel"),
  loginSecret: $("#loginSecret"),
  loginError: $("#loginError"),
};

const ctx = els.board.getContext("2d", { alpha: false });
const rulerCtx = els.rulerCanvas.getContext("2d", { alpha: true });

// ============================================================================
// UTILITIES
// ============================================================================

const utils = {
  async sha256(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  },

  nowMs() {
    return Date.now();
  },

  loadJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
      console.warn(`[Storage] Parse error for ${key}:`, err);
    return fallback;
  }
  },

  saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.error(`[Storage] Save error for ${key}:`, err);
    }
  },

  generateKey() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr))
      .replace(/\W/g, "")
      .slice(0, 24);
  },
};

// ============================================================================
// SECURITY & PRIVACY
// ============================================================================

const security = {
  createWatermark(label) {
    const text = `${label} • ${new Date().toLocaleString("fr-FR")}`;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">
        <text x="50%" y="50%" 
              fill="rgba(255,255,255,0.15)" 
              font-size="24" 
              font-family="Arial, sans-serif" 
              text-anchor="middle" 
              dominant-baseline="middle"
              transform="rotate(-15 200 100)">
          ${text}
        </text>
      </svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  },

  updateWatermark() {
  if (!state.session.authed) return;
    els.watermark.style.backgroundImage = this.createWatermark(
      state.session.label || "SPARTAN"
    );
  els.watermark.classList.toggle("is-hidden", !state.session.privacy);
  },

  setPrivacy(enabled) {
  state.session.privacy = enabled;
  els.privacyBlur.classList.toggle("is-hidden", !enabled);
    this.updateWatermark();
    auth.persistSession();
  },

  // Anti-screenshot measures
  initAntiScreenshot() {
    // Block PrintScreen key
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "PrintScreen") {
        ev.preventDefault();
        this.setPrivacy(true);
        els.privacyBlur.querySelector(".privacy-text").textContent = "Capture bloquée";
        setTimeout(() => {
          if (state.session.privacy) {
            els.privacyBlur.querySelector(".privacy-text").textContent = "Mode discret actif";
          }
        }, 2000);
      }
    });

    // Detect DevTools (basic)
    let devtools = { open: false };
    const threshold = 160;
    setInterval(() => {
      if (window.outerHeight - window.innerHeight > threshold || 
          window.outerWidth - window.innerWidth > threshold) {
        if (!devtools.open) {
          devtools.open = true;
          this.setPrivacy(true);
        }
      } else {
        devtools.open = false;
      }
    }, 500);

    // Blur on window blur
    window.addEventListener("blur", () => {
  if (state.session.privacy) {
    els.privacyBlur.classList.remove("is-hidden");
  }
    });

    window.addEventListener("focus", () => {
  if (state.session.privacy) {
    els.privacyBlur.classList.add("is-hidden");
  }
    });

    // Disable right-click context menu on canvas
    els.board.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
    });

    // Disable text selection
    document.addEventListener("selectstart", (ev) => {
      if (ev.target === els.board || ev.target.closest(".canvas-shell")) {
    ev.preventDefault();
      }
    });
  },
};

// ============================================================================
// AUTHENTICATION
// ============================================================================

const auth = {
  async validateSecret(secret) {
    const hash = await utils.sha256(secret.trim());
    if (hash === CONFIG.DEFAULT_PASSWORD_HASH) return true;

    const shareKeys = this.loadShareKeys();
    const validKey = shareKeys.find(
      (k) => k.hash === hash && k.expiresAt > utils.nowMs()
    );
  return Boolean(validKey);
  },

  loadShareKeys() {
    const keys = utils.loadJSON(STORAGE_KEYS.shareKeys, []);
    const filtered = keys.filter((k) => k.expiresAt > utils.nowMs());
    if (filtered.length !== keys.length) {
      utils.saveJSON(STORAGE_KEYS.shareKeys, filtered);
    }
  return filtered;
  },

  async generateShareKey() {
    const rawKey = utils.generateKey();
    const hash = await utils.sha256(rawKey);
    const expiresAt = utils.nowMs() + CONFIG.KEY_EXPIRY_HOURS * 60 * 60 * 1000;
    
    const keys = this.loadShareKeys();
  keys.push({ hash, expiresAt });
    utils.saveJSON(STORAGE_KEYS.shareKeys, keys);

  els.shareKey.value = rawKey;
    els.keyExpiry.textContent = `Expire le ${new Date(expiresAt).toLocaleString("fr-FR")}`;
    els.keyExpiry.classList.remove("is-hidden");
    return { rawKey, expiresAt };
  },

  persistSession() {
    utils.saveJSON(STORAGE_KEYS.session, state.session);
  },

  loadSession() {
    const saved = utils.loadJSON(STORAGE_KEYS.session, null);
  if (saved) {
    state.session = { ...state.session, ...saved };
  }
  },

  updateSessionUI() {
  if (state.session.authed) {
    els.sessionPill.textContent = `Connecté: ${state.session.label}`;
    els.sessionPill.className = "pill pill-ok";
    els.loginModal.classList.add("is-hidden");
  } else {
    els.sessionPill.textContent = "Non authentifié";
    els.sessionPill.className = "pill pill-warn";
    els.loginModal.classList.remove("is-hidden");
  }
    security.updateWatermark();
  },

  async handleLogin(ev) {
  ev.preventDefault();
  const label = els.loginLabel.value.trim() || "Opérateur";
  const secret = els.loginSecret.value.trim();
  if (!secret) return;

    const ok = await this.validateSecret(secret);
  if (!ok) {
    els.loginError.classList.remove("is-hidden");
    return;
  }

  els.loginError.classList.add("is-hidden");
  state.session.authed = true;
  state.session.label = label;
    this.persistSession();
    this.updateSessionUI();
    
    // Clear form
    els.loginLabel.value = "";
    els.loginSecret.value = "";
  },

  logout() {
  state.session = { authed: false, label: "", privacy: false };
    this.persistSession();
    this.updateSessionUI();
    plans.clearActive();
  },
};

// ============================================================================
// PLANS MANAGEMENT
// ============================================================================

const plans = {
  load() {
    state.plans = utils.loadJSON(STORAGE_KEYS.plans, []);
    state.annotations = utils.loadJSON(STORAGE_KEYS.annotations, {});
  state.activePlanId = state.plans[0]?.id || null;
  },

  save() {
    utils.saveJSON(STORAGE_KEYS.plans, state.plans);
    utils.saveJSON(STORAGE_KEYS.annotations, state.annotations);
  },

  ensureLayer(planId) {
  if (!state.annotations[planId]) {
    state.annotations[planId] = { strokes: [], redo: [] };
  }
  return state.annotations[planId];
  },

  renderList() {
    els.planList.innerHTML = "";
    if (!state.plans.length) {
      els.planList.classList.add("empty");
      els.planList.innerHTML = "<p>Aucun plan chargé</p>";
      $("#planActions").style.display = "none";
      this.clearActive();
      return;
    }
    els.planList.classList.remove("empty");

    state.plans
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
      .forEach((plan, index) => {
        const item = document.createElement("div");
        item.className = `plan-item ${plan.id === state.activePlanId ? "is-active" : ""}`;
        item.innerHTML = `
          <div class="plan-name">${plan.name}</div>
          <div class="plan-meta">Page ${state.plans.length - index} • ${new Date(plan.uploadedAt).toLocaleString("fr-FR")}</div>
        `;
        item.addEventListener("click", () => this.select(plan.id));
        els.planList.appendChild(item);
      });
    
    // Show actions if a plan is selected
    $("#planActions").style.display = state.activePlanId ? "flex" : "none";
  },

  select(planId) {
  state.activePlanId = planId;
    this.renderList();
  const plan = state.plans.find((p) => p.id === planId);
  if (!plan) return;
    canvas.loadImage(plan.dataUrl);
  },

  add(name, dataUrl) {
    const id = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    state.plans.push({
      id,
      name,
      dataUrl,
      uploadedAt: utils.nowMs(),
    });
    this.ensureLayer(id);
    this.save();
    this.select(id);
  },

  createNewPage() {
    // Create a blank white canvas
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = 1920;
    tempCanvas.height = 1080;
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.fillStyle = "#ffffff";
    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    
    const dataUrl = tempCanvas.toDataURL("image/png");
    const pageNumber = state.plans.length + 1;
    this.add(`Page ${pageNumber}`, dataUrl);
    this.renderList();
  },

  deleteCurrent() {
    if (!state.activePlanId) return;
    if (!confirm("Supprimer cette page ? Les annotations seront également supprimées.")) return;
    
    const index = state.plans.findIndex((p) => p.id === state.activePlanId);
    if (index === -1) return;
    
    state.plans.splice(index, 1);
    delete state.annotations[state.activePlanId];
    
    if (state.plans.length > 0) {
      const newActive = state.plans[Math.min(index, state.plans.length - 1)];
      this.select(newActive.id);
    } else {
      this.clearActive();
    }
    this.save();
    this.renderList();
  },

  duplicateCurrent() {
    if (!state.activePlanId) return;
    const plan = state.plans.find((p) => p.id === state.activePlanId);
    if (!plan) return;
    
    const id = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const newPlan = {
      id,
      name: `${plan.name} (copie)`,
      dataUrl: plan.dataUrl,
      uploadedAt: utils.nowMs(),
    };
    
    state.plans.push(newPlan);
    
    // Duplicate annotations
    if (state.annotations[state.activePlanId]) {
      state.annotations[id] = {
        strokes: JSON.parse(JSON.stringify(state.annotations[state.activePlanId].strokes)),
        redo: [],
      };
    }
    
    this.save();
    this.select(id);
    this.renderList();
  },

  clearActive() {
    state.img = null;
    state.activePlanId = null;
    canvas.clear();
    els.emptyState.style.display = "flex";
  },
};

// ============================================================================
// CANVAS & DRAWING
// ============================================================================

const canvas = {
  resize() {
  const rect = els.canvasShell.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  els.board.width = Math.floor(rect.width * dpr);
  els.board.height = Math.floor(rect.height * dpr);
  els.board.style.width = `${rect.width}px`;
  els.board.style.height = `${rect.height}px`;

    els.rulerCanvas.width = Math.floor(rect.width * dpr);
    els.rulerCanvas.height = Math.floor(rect.height * dpr);
    els.rulerCanvas.style.width = `${rect.width}px`;
    els.rulerCanvas.style.height = `${rect.height}px`;
    els.rulerCanvas.style.position = "absolute";
    els.rulerCanvas.style.top = "0";
    els.rulerCanvas.style.left = "0";
    els.rulerCanvas.style.pointerEvents = "none";
    els.rulerCanvas.style.zIndex = "5";

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rulerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.recomputeTransform();
    this.render();
    this.renderRuler();
  },

  recomputeTransform() {
    if (!state.img) return;
    const cw = els.board.clientWidth;
    const ch = els.board.clientHeight;
    const iw = state.img.naturalWidth;
    const ih = state.img.naturalHeight;
    const scale = Math.min(cw / iw, ch / ih, 1);
    const ox = (cw - iw * scale) / 2;
    const oy = (ch - ih * scale) / 2;
    state.transform = { scale, ox, oy };
    this.renderRuler();
  },

  imageToCanvas(ix, iy) {
  const { scale, ox, oy } = state.transform;
  return { x: ix * scale + ox, y: iy * scale + oy };
  },

  canvasToImage(px, py) {
  const { scale, ox, oy } = state.transform;
  return { x: (px - ox) / scale, y: (py - oy) / scale };
  },

  insideImage(px, py) {
  if (!state.img) return false;
    const { x, y } = this.canvasToImage(px, py);
    return (
      x >= 0 &&
      y >= 0 &&
      x <= state.img.naturalWidth &&
      y <= state.img.naturalHeight
    );
  },

  clear() {
  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0, 0, els.board.clientWidth, els.board.clientHeight);
  },

  drawBackground() {
    this.clear();
  if (!state.img) return;
  const { scale, ox, oy } = state.transform;
  ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      state.img,
      ox,
      oy,
      state.img.naturalWidth * scale,
      state.img.naturalHeight * scale
    );
  },

  drawPencil(points, color, width) {
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
    const p0 = this.imageToCanvas(points[0].x, points[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < points.length; i++) {
      const p = this.imageToCanvas(points[i].x, points[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  },

  drawLine(x1, y1, x2, y2, color, width) {
    const p1 = this.imageToCanvas(x1, y1);
    const p2 = this.imageToCanvas(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  },

  drawArrow(x1, y1, x2, y2, color, width) {
    const p1 = this.imageToCanvas(x1, y1);
    const p2 = this.imageToCanvas(x2, y2);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

    // Draw line
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();

    // Draw arrowhead (improved)
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const headLen = Math.max(14, width * 3.5);
    const headWidth = headLen * 0.6;
    
    ctx.save();
    ctx.translate(p2.x, p2.y);
    ctx.rotate(angle);
  ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-headLen, -headWidth);
    ctx.lineTo(-headLen * 0.7, 0);
    ctx.lineTo(-headLen, headWidth);
  ctx.closePath();
  ctx.fill();
    ctx.restore();
  },

  drawText(textObj) {
    const { x, y, text, fontSize, fontFamily, color, bgColor, bgOpacity } = textObj;
    const p = this.imageToCanvas(x, y);
    
    ctx.save();
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const textHeight = fontSize * 1.2;
    
    // Draw background
    if (bgColor && bgOpacity > 0) {
      const alpha = bgOpacity / 100;
      ctx.fillStyle = bgColor;
      ctx.globalAlpha = alpha;
      ctx.fillRect(p.x - 4, p.y - 2, textWidth + 8, textHeight + 4);
      ctx.globalAlpha = 1;
    }
    
    // Draw text
    ctx.fillStyle = color;
    ctx.fillText(text, p.x, p.y);
    ctx.restore();
  },

  drawSelectionBox(box) {
    if (!box) return;
    const { x1, y1, x2, y2 } = box;
    const p1 = this.imageToCanvas(x1, y1);
    const p2 = this.imageToCanvas(x2, y2);
    
    const left = Math.min(p1.x, p2.x);
    const top = Math.min(p1.y, p2.y);
    const width = Math.abs(p2.x - p1.x);
    const height = Math.abs(p2.y - p1.y);
    
    ctx.save();
    ctx.strokeStyle = "#4a9eff";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(left, top, width, height);
    
    // Fill with semi-transparent
    ctx.fillStyle = "rgba(74, 158, 255, 0.1)";
    ctx.fillRect(left, top, width, height);
    
    ctx.setLineDash([]);
    ctx.restore();
  },

  drawSelectionHandles(items) {
    if (!items || items.length === 0) return;
    
    ctx.save();
    ctx.strokeStyle = "#4a9eff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 2;
    
    items.forEach((item) => {
      const layer = plans.ensureLayer(state.activePlanId);
      const stroke = layer.strokes[item.index];
      if (!stroke) return;
      
      let bounds = null;
      if (stroke.type === "pencil" && stroke.points.length > 0) {
        const points = stroke.points.map(p => this.imageToCanvas(p.x, p.y));
        const xs = points.map(p => p.x);
        const ys = points.map(p => p.y);
        bounds = {
          left: Math.min(...xs),
          top: Math.min(...ys),
          right: Math.max(...xs),
          bottom: Math.max(...ys),
        };
      } else if (stroke.type === "line" || stroke.type === "arrow") {
        const p1 = this.imageToCanvas(stroke.x1, stroke.y1);
        const p2 = this.imageToCanvas(stroke.x2, stroke.y2);
        bounds = {
          left: Math.min(p1.x, p2.x),
          top: Math.min(p1.y, p2.y),
          right: Math.max(p1.x, p2.x),
          bottom: Math.max(p1.y, p2.y),
        };
      } else if (stroke.type === "text") {
        const p = this.imageToCanvas(stroke.x, stroke.y);
        ctx.font = `${stroke.fontSize}px ${stroke.fontFamily}`;
        const metrics = ctx.measureText(stroke.text);
        bounds = {
          left: p.x - 4,
          top: p.y - 2,
          right: p.x + metrics.width + 4,
          bottom: p.y + stroke.fontSize * 1.2 + 2,
        };
      }
      
      if (bounds) {
        const w = bounds.right - bounds.left;
        const h = bounds.bottom - bounds.top;
        ctx.strokeRect(bounds.left - 2, bounds.top - 2, w + 4, h + 4);
      }
    });
    
    ctx.restore();
  },

  renderRuler() {
    if (!state.ruler.enabled) {
      rulerCtx.clearRect(0, 0, els.rulerCanvas.width, els.rulerCanvas.height);
      return;
    }

    rulerCtx.clearRect(0, 0, els.rulerCanvas.width, els.rulerCanvas.height);
    const gridSize = state.ruler.gridSize * state.transform.scale;
    const { ox, oy } = state.transform;

    rulerCtx.strokeStyle = "rgba(255, 211, 77, 0.3)";
    rulerCtx.lineWidth = 1;

    // Vertical lines
    for (let x = ox; x < els.rulerCanvas.width; x += gridSize) {
      rulerCtx.beginPath();
      rulerCtx.moveTo(x, 0);
      rulerCtx.lineTo(x, els.rulerCanvas.height);
      rulerCtx.stroke();
    }
    for (let x = ox; x >= 0; x -= gridSize) {
      rulerCtx.beginPath();
      rulerCtx.moveTo(x, 0);
      rulerCtx.lineTo(x, els.rulerCanvas.height);
      rulerCtx.stroke();
    }

    // Horizontal lines
    for (let y = oy; y < els.rulerCanvas.height; y += gridSize) {
      rulerCtx.beginPath();
      rulerCtx.moveTo(0, y);
      rulerCtx.lineTo(els.rulerCanvas.width, y);
      rulerCtx.stroke();
    }
    for (let y = oy; y >= 0; y -= gridSize) {
      rulerCtx.beginPath();
      rulerCtx.moveTo(0, y);
      rulerCtx.lineTo(els.rulerCanvas.width, y);
      rulerCtx.stroke();
    }
  },

  render() {
    els.emptyState.style.display = state.img ? "none" : "flex";
    this.drawBackground();
    if (!state.activePlanId) return;

    const layer = plans.ensureLayer(state.activePlanId);
    for (const s of layer.strokes) {
      if (s.type === "pencil") {
        this.drawPencil(s.points, s.color, s.width);
      } else if (s.type === "line") {
        this.drawLine(s.x1, s.y1, s.x2, s.y2, s.color, s.width);
      } else if (s.type === "arrow") {
        this.drawArrow(s.x1, s.y1, s.x2, s.y2, s.color, s.width);
      } else if (s.type === "text") {
        this.drawText(s);
      }
    }

    // Preview current stroke
    if (state.currentStroke && state.currentStroke.type === "pencil") {
      this.drawPencil(
        state.currentStroke.points,
        state.currentStroke.color,
        state.currentStroke.width
      );
    }

    // Preview line
    if (state.previewLine) {
      const l = state.previewLine;
      this.drawLine(l.x1, l.y1, l.x2, l.y2, l.color, l.width);
    }

    // Preview arrow
    if (state.previewArrow) {
      const a = state.previewArrow;
      this.drawArrow(a.x1, a.y1, a.x2, a.y2, a.color, a.width);
    }

    // Draw selection box
    if (state.selection.box) {
      this.drawSelectionBox(state.selection.box);
    }

    // Draw selection handles
    if (state.selection.selectedItems.length > 0) {
      this.drawSelectionHandles(state.selection.selectedItems);
    }

    // Draw pixel eraser preview
    if (state.eraserStroke && state.eraserStroke.points.length > 0) {
      const lastPoint = state.eraserStroke.points[state.eraserStroke.points.length - 1];
      const p = this.imageToCanvas(lastPoint.x, lastPoint.y);
      const size = state.eraserStroke.size;
      
      ctx.save();
      ctx.strokeStyle = "rgba(255, 59, 48, 0.6)";
      ctx.fillStyle = "rgba(255, 59, 48, 0.2)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  },

  loadImage(dataUrl) {
    const img = new Image();
    img.onload = () => {
      state.img = img;
      this.recomputeTransform();
      this.render();
    };
    img.src = dataUrl;
  },

  pointerPos(ev) {
  const rect = els.board.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  },

  onPointerDown(ev) {
    if (!state.session.authed || !state.img) return;
    const p = this.pointerPos(ev);
    const layer = plans.ensureLayer(state.activePlanId);

    if (state.tool === "select") {
      const imgP = this.canvasToImage(p.x, p.y);
      
      // Check if clicking on a selected item
      if (state.selection.selectedItems.length > 0) {
        const clickedItem = this.getItemAtPoint(imgP.x, imgP.y, layer);
        if (clickedItem && state.selection.selectedItems.some(item => item.index === clickedItem.index)) {
          // Start dragging selected items
          state.selection.dragging = true;
          state.selection.dragOffset = { x: imgP.x, y: imgP.y };
          return;
        }
      }
      
      // Start new selection box
      state.selection.box = { x1: imgP.x, y1: imgP.y, x2: imgP.x, y2: imgP.y };
      state.selection.selectedItems = [];
      state.drawing = true;
    } else if (state.tool === "pencil") {
      if (!this.insideImage(p.x, p.y)) return;
      state.drawing = true;
      state.currentStroke = {
        type: "pencil",
        color: els.strokeColor.value,
        width: Number(els.strokeSize.value),
        points: [this.canvasToImage(p.x, p.y)],
      };
    } else if (state.tool === "line") {
      if (!this.insideImage(p.x, p.y)) return;
      state.drawing = true;
      const imgP = this.canvasToImage(p.x, p.y);
      state.previewLine = {
        x1: imgP.x,
        y1: imgP.y,
        x2: imgP.x,
        y2: imgP.y,
        color: els.strokeColor.value,
        width: Number(els.strokeSize.value),
      };
    } else if (state.tool === "arrow") {
      if (!this.insideImage(p.x, p.y)) return;
      state.drawing = true;
      const imgP = this.canvasToImage(p.x, p.y);
      state.previewArrow = {
        x1: imgP.x,
        y1: imgP.y,
        x2: imgP.x,
        y2: imgP.y,
        color: els.strokeColor.value,
        width: Number(els.strokeSize.value),
      };
    } else if (state.tool === "text") {
      if (!this.insideImage(p.x, p.y)) return;
      const imgP = this.canvasToImage(p.x, p.y);
      this.startTextEdit(imgP.x, imgP.y);
    } else if (state.tool === "eraser") {
      state.eraserMode = "vector";
      this.eraseNearby(p, layer);
    } else if (state.tool === "eraser-pixel") {
      state.eraserMode = "pixel";
      state.drawing = true;
      const imgP = this.canvasToImage(p.x, p.y);
      state.eraserStroke = {
        points: [imgP],
        size: Number(els.strokeSize.value) || 10,
      };
      this.erasePixel(imgP.x, imgP.y, layer);
    }
  },

  onPointerMove(ev) {
    const p = this.pointerPos(ev);
    const layer = plans.ensureLayer(state.activePlanId);

    if (state.tool === "select" && state.selection.dragging) {
      // Move selected items
      const imgP = this.canvasToImage(p.x, p.y);
      const dx = imgP.x - state.selection.dragOffset.x;
      const dy = imgP.y - state.selection.dragOffset.y;
      
      state.selection.selectedItems.forEach((item) => {
        const stroke = layer.strokes[item.index];
        if (!stroke) return;
        
        if (stroke.type === "pencil" && stroke.points) {
          stroke.points.forEach(point => {
            point.x += dx;
            point.y += dy;
          });
        } else if (stroke.type === "line" || stroke.type === "arrow") {
          stroke.x1 += dx;
          stroke.y1 += dy;
          stroke.x2 += dx;
          stroke.y2 += dy;
        } else if (stroke.type === "text") {
          stroke.x += dx;
          stroke.y += dy;
        }
      });
      
      state.selection.dragOffset = { x: imgP.x, y: imgP.y };
      plans.save();
      this.render();
      return;
    }

    if (state.tool === "eraser-pixel" && state.eraserStroke) {
      const imgP = this.canvasToImage(p.x, p.y);
      state.eraserStroke.points.push(imgP);
      this.erasePixel(imgP.x, imgP.y, layer);
      this.render();
      return;
    }

    if (!state.drawing) return;

    if (state.tool === "select" && state.selection.box) {
      const imgP = this.canvasToImage(p.x, p.y);
      state.selection.box.x2 = imgP.x;
      state.selection.box.y2 = imgP.y;
      // Update selected items based on box
      this.updateSelectionFromBox(layer);
    } else if (state.tool === "pencil" && state.currentStroke) {
      state.currentStroke.points.push(this.canvasToImage(p.x, p.y));
    } else if (state.tool === "line" && state.previewLine) {
      const imgP = this.canvasToImage(p.x, p.y);
      state.previewLine.x2 = imgP.x;
      state.previewLine.y2 = imgP.y;
    } else if (state.tool === "arrow" && state.previewArrow) {
      const imgP = this.canvasToImage(p.x, p.y);
      state.previewArrow.x2 = imgP.x;
      state.previewArrow.y2 = imgP.y;
    }
    this.render();
  },

  onPointerUp(ev) {
    if (state.tool === "select") {
      if (state.selection.dragging) {
        state.selection.dragging = false;
        plans.save();
        this.render();
        return;
      }
      if (state.selection.box) {
        // Finalize selection
        const layer = plans.ensureLayer(state.activePlanId);
        this.updateSelectionFromBox(layer);
        state.selection.box = null;
        state.drawing = false;
        this.render();
        return;
      }
    }

    if (state.tool === "eraser-pixel") {
      state.eraserStroke = null;
      state.drawing = false;
      plans.save();
      this.render();
      return;
    }

    if (!state.drawing) return;
    const layer = plans.ensureLayer(state.activePlanId);

    if (state.tool === "pencil" && state.currentStroke) {
      if (state.currentStroke.points.length > 1) {
        layer.strokes.push(state.currentStroke);
      }
    } else if (state.tool === "line" && state.previewLine) {
      layer.strokes.push({ ...state.previewLine, type: "line" });
    } else if (state.tool === "arrow" && state.previewArrow) {
      layer.strokes.push({ ...state.previewArrow, type: "arrow" });
    }

    layer.redo = [];
    state.drawing = false;
    state.currentStroke = null;
    state.previewLine = null;
    state.previewArrow = null;
    plans.save();
    this.render();
  },

  startTextEdit(x, y) {
    state.textEditing = {
      x,
      y,
      text: "",
      fontSize: Number(els.textFontSize.value),
      fontFamily: els.textFontFamily.value,
      color: els.strokeColor.value,
      bgColor: els.textBgColor.value,
      bgOpacity: Number(els.textBgOpacity.value),
    };
    const p = this.imageToCanvas(x, y);
    els.textInputOverlay.style.left = `${p.x}px`;
    els.textInputOverlay.style.top = `${p.y}px`;
    els.textInputOverlay.classList.remove("is-hidden");
    els.textInput.value = "";
    els.textInput.focus();
  },

  finishTextEdit() {
    if (!state.textEditing || !state.textEditing.text.trim()) {
      state.textEditing = null;
      els.textInputOverlay.classList.add("is-hidden");
      return;
    }

    const layer = plans.ensureLayer(state.activePlanId);
    layer.strokes.push({
      type: "text",
      ...state.textEditing,
    });
    layer.redo = [];
    plans.save();
    state.textEditing = null;
    els.textInputOverlay.classList.add("is-hidden");
    this.render();
  },

  eraseNearby(p, layer) {
    const target = this.canvasToImage(p.x, p.y);
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    for (let i = layer.strokes.length - 1; i >= 0; i--) {
      const s = layer.strokes[i];
      if (s.type === "pencil") {
        if (s.points.some((pt) => dist(pt, target) < 15)) {
          layer.strokes.splice(i, 1);
          break;
        }
      } else if (s.type === "line" || s.type === "arrow") {
        const mid = { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
        if (dist(mid, target) < 20) {
          layer.strokes.splice(i, 1);
          break;
        }
      } else if (s.type === "text") {
        const textP = this.imageToCanvas(s.x, s.y);
        const rect = els.board.getBoundingClientRect();
        const canvasP = { x: p.x, y: p.y };
        if (Math.abs(textP.x - canvasP.x) < 50 && Math.abs(textP.y - canvasP.y) < 30) {
          layer.strokes.splice(i, 1);
          break;
        }
      }
    }
    plans.save();
    this.render();
  },

  erasePixel(x, y, layer) {
    const eraserSize = state.eraserStroke?.size || 10;
    const threshold = eraserSize / 2;

    for (let i = layer.strokes.length - 1; i >= 0; i--) {
      const s = layer.strokes[i];
      
      if (s.type === "pencil" && s.points) {
        // Remove points that are within eraser radius
        const originalLength = s.points.length;
        s.points = s.points.filter((pt) => {
          const dist = Math.hypot(pt.x - x, pt.y - y);
          return dist > threshold;
        });
        
        // If too many points removed, split the stroke or remove it
        if (s.points.length < originalLength * 0.3 && s.points.length < 3) {
          layer.strokes.splice(i, 1);
        } else if (s.points.length < 2) {
          layer.strokes.splice(i, 1);
        }
      } else if (s.type === "line" || s.type === "arrow") {
        // Check if eraser is near the line
        const distToLine = this.distanceToLineSegment(x, y, s.x1, s.y1, s.x2, s.y2);
        if (distToLine < threshold) {
          // Split or remove the line
          const dist1 = Math.hypot(s.x1 - x, s.y1 - y);
          const dist2 = Math.hypot(s.x2 - x, s.y2 - y);
          
          if (dist1 < threshold && dist2 < threshold) {
            // Eraser covers both ends, remove
            layer.strokes.splice(i, 1);
          } else if (dist1 < threshold) {
            // Move start point away
            const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
            s.x1 = x + Math.cos(angle) * threshold;
            s.y1 = y + Math.sin(angle) * threshold;
          } else if (dist2 < threshold) {
            // Move end point away
            const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
            s.x2 = x - Math.cos(angle) * threshold;
            s.y2 = y - Math.sin(angle) * threshold;
          } else {
            // Eraser is in the middle, split into two lines
            const midX = (s.x1 + s.x2) / 2;
            const midY = (s.y1 + s.y2) / 2;
            const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
            
            // Create two new lines
            const line1 = {
              type: s.type,
              x1: s.x1,
              y1: s.y1,
              x2: midX - Math.cos(angle) * threshold,
              y2: midY - Math.sin(angle) * threshold,
              color: s.color,
              width: s.width,
            };
            const line2 = {
              type: s.type,
              x1: midX + Math.cos(angle) * threshold,
              y1: midY + Math.sin(angle) * threshold,
              x2: s.x2,
              y2: s.y2,
              color: s.color,
              width: s.width,
            };
            
            layer.strokes.splice(i, 1, line1, line2);
          }
        }
      }
    }
  },

  distanceToLineSegment(px, py, x1, y1, x2, y2) {
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    if (lenSq !== 0) param = dot / lenSq;

    let xx, yy;

    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }

    const dx = px - xx;
    const dy = py - yy;
    return Math.sqrt(dx * dx + dy * dy);
  },

  getItemAtPoint(x, y, layer) {
    const threshold = 20;
    for (let i = layer.strokes.length - 1; i >= 0; i--) {
      const s = layer.strokes[i];
      if (s.type === "pencil" && s.points) {
        if (s.points.some((pt) => Math.hypot(pt.x - x, pt.y - y) < threshold)) {
          return { type: s.type, index: i };
        }
      } else if (s.type === "line" || s.type === "arrow") {
        const dist = this.distanceToLineSegment(x, y, s.x1, s.y1, s.x2, s.y2);
        if (dist < threshold) {
          return { type: s.type, index: i };
        }
      } else if (s.type === "text") {
        const dist = Math.hypot(s.x - x, s.y - y);
        if (dist < 50) {
          return { type: s.type, index: i };
        }
      }
    }
    return null;
  },

  updateSelectionFromBox(layer) {
    if (!state.selection.box) return;
    const { x1, y1, x2, y2 } = state.selection.box;
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);

    state.selection.selectedItems = [];
    layer.strokes.forEach((stroke, index) => {
      let isInside = false;
      
      if (stroke.type === "pencil" && stroke.points) {
        isInside = stroke.points.some((pt) => 
          pt.x >= left && pt.x <= right && pt.y >= top && pt.y <= bottom
        );
      } else if (stroke.type === "line" || stroke.type === "arrow") {
        const midX = (stroke.x1 + stroke.x2) / 2;
        const midY = (stroke.y1 + stroke.y2) / 2;
        isInside = midX >= left && midX <= right && midY >= top && midY <= bottom;
      } else if (stroke.type === "text") {
        isInside = stroke.x >= left && stroke.x <= right && stroke.y >= top && stroke.y <= bottom;
      }
      
      if (isInside) {
        state.selection.selectedItems.push({ type: stroke.type, index });
      }
    });
  },

  undo() {
    const layer = plans.ensureLayer(state.activePlanId);
  const last = layer.strokes.pop();
  if (last) layer.redo.push(last);
    plans.save();
    this.render();
  },

  redo() {
    const layer = plans.ensureLayer(state.activePlanId);
  const item = layer.redo.pop();
  if (item) layer.strokes.push(item);
    plans.save();
    this.render();
  },

  clearAnnotations() {
    const layer = plans.ensureLayer(state.activePlanId);
  layer.strokes = [];
  layer.redo = [];
    plans.save();
    this.render();
  },

  exportPNG() {
    if (!state.session.authed || !state.img) return;
  const url = els.board.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
    a.download = `spartan_${state.session.label || "plan"}_${Date.now()}.png`;
  a.click();
  },
};

// ============================================================================
// TOOLBAR
// ============================================================================

const toolbar = {
  setTool(tool) {
    state.tool = tool;
    $$(".toolbtn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.tool === tool);
    });
    this.updateToolControls();
  },

  updateToolControls() {
    const isText = state.tool === "text";
    const isDrawing = ["pencil", "line", "arrow", "eraser-pixel"].includes(state.tool);
    const isEraser = ["eraser", "eraser-pixel"].includes(state.tool);
    
    els.strokeControls.classList.toggle("is-hidden", !isDrawing);
    els.colorControls.classList.toggle("is-hidden", !isDrawing && !isEraser);
    els.textControls.classList.toggle("is-hidden", !isText);
    els.textControls2.classList.toggle("is-hidden", !isText);
    els.textControls3.classList.toggle("is-hidden", !isText);
  },

  updateStrokeSize() {
    const value = els.strokeSize.value;
    els.strokeSizeValue.textContent = `${value}px`;
  },

  updateTextFontSize() {
    const value = els.textFontSize.value;
    els.textFontSizeValue.textContent = `${value}px`;
  },

  updateTextBgOpacity() {
    const value = els.textBgOpacity.value;
    els.textBgOpacityValue.textContent = `${value}%`;
  },
};

// ============================================================================
// NOTES
// ============================================================================

const notes = {
  load() {
    els.notes.value = utils.loadJSON(STORAGE_KEYS.notes, "");
  },

  save() {
    utils.saveJSON(STORAGE_KEYS.notes, els.notes.value);
  },
};

// ============================================================================
// ALLIANCES
// ============================================================================

const alliances = {
  load() {
    state.alliances = utils.loadJSON(STORAGE_KEYS.alliances, []);
  },

  save() {
    utils.saveJSON(STORAGE_KEYS.alliances, state.alliances);
  },

  renderList() {
    const allianceList = $("#allianceList");
    allianceList.innerHTML = "";
    
    if (!state.alliances.length) {
      allianceList.classList.add("empty");
      allianceList.innerHTML = "<p>Aucune alliance</p>";
      return;
    }
    
    allianceList.classList.remove("empty");
    
    state.alliances.forEach((alliance, index) => {
      const item = document.createElement("div");
      item.className = "alliance-item";
      item.innerHTML = `
        <div class="alliance-name">${alliance.name || "Alliance sans nom"}</div>
        <div class="alliance-meta">${alliance.key ? `Clé: ${alliance.key.slice(0, 8)}...` : "Aucune clé"}</div>
        <div class="alliance-actions">
          <button class="btn-ghost btn-tiny" data-action="copy" data-index="${index}" title="Copier la clé">📋</button>
          <button class="btn-ghost btn-tiny" data-action="delete" data-index="${index}" title="Supprimer">🗑️</button>
        </div>
      `;
      allianceList.appendChild(item);
    });
  },

  add(name, key) {
    const alliance = {
      id: `alliance_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      name: name || `Alliance ${state.alliances.length + 1}`,
      key: key || "",
      createdAt: utils.nowMs(),
    };
    state.alliances.push(alliance);
    this.save();
    this.renderList();
    return alliance;
  },

  remove(index) {
    if (index >= 0 && index < state.alliances.length) {
      state.alliances.splice(index, 1);
      this.save();
      this.renderList();
    }
  },
};

// ============================================================================
// EVENT HANDLERS
// ============================================================================

function bindEvents() {
  // Window events
  window.addEventListener("resize", () => {
    canvas.resize();
    canvas.renderRuler();
  });

  // Canvas events
  els.board.addEventListener("pointerdown", (ev) => canvas.onPointerDown(ev));
  window.addEventListener("pointermove", (ev) => canvas.onPointerMove(ev));
  window.addEventListener("pointerup", (ev) => canvas.onPointerUp(ev));

  // Toolbar
  $$(".toolbtn").forEach((btn) => {
    btn.addEventListener("click", () => toolbar.setTool(btn.dataset.tool));
  });

  els.strokeSize.addEventListener("input", () => {
    toolbar.updateStrokeSize();
  });

  els.textFontSize.addEventListener("input", () => {
    toolbar.updateTextFontSize();
  });

  els.textBgOpacity.addEventListener("input", () => {
    toolbar.updateTextBgOpacity();
  });

  // Text input
  els.textInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      if (state.textEditing) {
        state.textEditing.text = els.textInput.value;
        canvas.finishTextEdit();
      }
    } else if (ev.key === "Escape") {
      state.textEditing = null;
      els.textInputOverlay.classList.add("is-hidden");
    }
  });

  els.textInput.addEventListener("blur", () => {
    if (state.textEditing) {
      state.textEditing.text = els.textInput.value;
      canvas.finishTextEdit();
    }
  });

  // Ruler
  $("#btnRuler").addEventListener("click", () => {
    state.ruler.enabled = !state.ruler.enabled;
    $("#btnRuler").classList.toggle("is-active", state.ruler.enabled);
    canvas.renderRuler();
  });

  $("#btnUndo").addEventListener("click", () => canvas.undo());
  $("#btnRedo").addEventListener("click", () => canvas.redo());
  $("#btnClear").addEventListener("click", () => canvas.clearAnnotations());
  $("#btnExport").addEventListener("click", () => canvas.exportPNG());

  // File upload
  $("#btnUpload").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      plans.add(file.name, reader.result);
    };
    reader.readAsDataURL(file);
    ev.target.value = "";
  });

  // Page management
  $("#btnNewPage").addEventListener("click", () => {
    plans.createNewPage();
  });
  $("#btnDeletePlan").addEventListener("click", () => {
    plans.deleteCurrent();
  });
  $("#btnDuplicatePlan").addEventListener("click", () => {
    plans.duplicateCurrent();
  });

  // Auth
  $("#btnGenKey").addEventListener("click", () => auth.generateShareKey());
  $("#btnCopyKey").addEventListener("click", () => {
    const val = els.shareKey.value;
    if (val) {
      navigator.clipboard?.writeText(val);
      $("#btnCopyKey").textContent = "✓";
      setTimeout(() => {
        $("#btnCopyKey").textContent = "📋";
      }, 1000);
    }
  });
  $("#btnFullscreen").addEventListener("click", () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  });
  $("#btnPrivacy").addEventListener("click", () => {
    security.setPrivacy(!state.session.privacy);
  });
  $("#btnLogout").addEventListener("click", () => auth.logout());
  els.loginForm.addEventListener("submit", (ev) => auth.handleLogin(ev));

  // Notes
  els.notes.addEventListener("input", () => notes.save());

  // Alliances
  $("#btnAddAlliance").addEventListener("click", () => {
    const name = prompt("Nom de l'alliance :");
    if (name) {
      const key = prompt("Clé de partage (optionnel) :") || "";
      alliances.add(name.trim(), key.trim());
    }
  });

  // Delegation for alliance actions
  $("#allianceList").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    
    const action = btn.dataset.action;
    const index = parseInt(btn.dataset.index);
    
    if (action === "copy" && state.alliances[index]) {
      const key = state.alliances[index].key;
      if (key) {
        navigator.clipboard?.writeText(key);
        btn.textContent = "✓";
        setTimeout(() => {
          btn.textContent = "📋";
        }, 1000);
      }
    } else if (action === "delete") {
      if (confirm("Supprimer cette alliance ?")) {
        alliances.remove(index);
      }
    }
  });

  // Keyboard shortcuts
  window.addEventListener("keydown", (ev) => {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const ctrlKey = isMac ? ev.metaKey : ev.ctrlKey;
    
    // Don't trigger shortcuts when typing in inputs
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") {
      if (ev.key === "Escape") {
        ev.target.blur();
      }
      return;
    }

    // Ctrl+Z / Cmd+Z - Undo
    if (ctrlKey && ev.key === "z" && !ev.shiftKey) {
      ev.preventDefault();
      canvas.undo();
      return;
    }

    // Ctrl+Shift+Z / Cmd+Shift+Z or Ctrl+Y / Cmd+Y - Redo
    if ((ctrlKey && ev.shiftKey && ev.key === "z") || (ctrlKey && ev.key === "y")) {
      ev.preventDefault();
      canvas.redo();
      return;
    }

    // Delete / Backspace - Delete selected items
    if ((ev.key === "Delete" || ev.key === "Backspace") && state.selection.selectedItems.length > 0) {
      ev.preventDefault();
      const layer = plans.ensureLayer(state.activePlanId);
      state.selection.selectedItems
        .sort((a, b) => b.index - a.index)
        .forEach((item) => {
          layer.strokes.splice(item.index, 1);
        });
      state.selection.selectedItems = [];
      plans.save();
      canvas.render();
      return;
    }

    // Ctrl+A / Cmd+A - Select all
    if (ctrlKey && ev.key === "a") {
      ev.preventDefault();
      const layer = plans.ensureLayer(state.activePlanId);
      state.selection.selectedItems = layer.strokes.map((_, index) => ({ index }));
      canvas.render();
      return;
    }

    // Escape - Clear selection
    if (ev.key === "Escape") {
      state.selection.selectedItems = [];
      state.selection.box = null;
      canvas.render();
      return;
    }

    // Tool shortcuts (only when not in input)
    if (!ctrlKey && !ev.shiftKey && !ev.altKey) {
      if (ev.key === "v" || ev.key === "V") {
        ev.preventDefault();
        toolbar.setTool("select");
      } else if (ev.key === "p" || ev.key === "P") {
        ev.preventDefault();
        toolbar.setTool("pencil");
      } else if (ev.key === "l" || ev.key === "L") {
        ev.preventDefault();
        toolbar.setTool("line");
      } else if (ev.key === "a" || ev.key === "A") {
        ev.preventDefault();
        toolbar.setTool("arrow");
      } else if (ev.key === "t" || ev.key === "T") {
        ev.preventDefault();
        toolbar.setTool("text");
      } else if (ev.key === "e" || ev.key === "E") {
        ev.preventDefault();
        toolbar.setTool("eraser");
      }
    }
  });
}

// ============================================================================
// INITIALIZATION
// ============================================================================

function init() {
  auth.loadSession();
  plans.load();
  notes.load();
  alliances.load();
  bindEvents();
  security.initAntiScreenshot();
  canvas.resize();
  plans.renderList();
  alliances.renderList();
  if (state.activePlanId) {
    const plan = state.plans.find((p) => p.id === state.activePlanId);
    if (plan) canvas.loadImage(plan.dataUrl);
  }
  auth.updateSessionUI();
  security.setPrivacy(state.session.privacy);
  toolbar.updateStrokeSize();
  toolbar.updateTextFontSize();
  toolbar.updateTextBgOpacity();
  toolbar.updateToolControls();
  canvas.renderRuler();
}

// Start app
init();
