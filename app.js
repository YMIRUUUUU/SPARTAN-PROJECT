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
  transform: { scale: 1, ox: 0, oy: 0 },
  img: null,
};

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  // Canvas
  board: $("#board"),
  canvasShell: $("#canvasShell"),
  emptyState: $("#emptyState"),
  watermark: $("#watermark"),
  privacyBlur: $("#privacyBlur"),
  
  // Toolbar
  strokeSize: $("#strokeSize"),
  strokeSizeValue: $("#strokeSizeValue"),
  strokeColor: $("#strokeColor"),
  
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
      this.clearActive();
      return;
    }
    els.planList.classList.remove("empty");

    state.plans
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
      .forEach((plan) => {
        const item = document.createElement("div");
        item.className = `plan-item ${plan.id === state.activePlanId ? "is-active" : ""}`;
        item.innerHTML = `
          <div class="plan-name">${plan.name}</div>
          <div class="plan-meta">${new Date(plan.uploadedAt).toLocaleString("fr-FR")}</div>
        `;
        item.addEventListener("click", () => this.select(plan.id));
        els.planList.appendChild(item);
      });
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

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.recomputeTransform();
    this.render();
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

    // Draw arrowhead
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const headLen = Math.max(12, width * 3);
    ctx.beginPath();
    ctx.moveTo(p2.x, p2.y);
    ctx.lineTo(
      p2.x - headLen * Math.cos(angle - Math.PI / 6),
      p2.y - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      p2.x - headLen * Math.cos(angle + Math.PI / 6),
      p2.y - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  },

  render() {
    els.emptyState.style.display = state.img ? "none" : "flex";
    this.drawBackground();
    if (!state.activePlanId) return;

    const layer = plans.ensureLayer(state.activePlanId);
    for (const s of layer.strokes) {
      if (s.type === "pencil") {
        this.drawPencil(s.points, s.color, s.width);
      } else if (s.type === "arrow") {
        this.drawArrow(s.x1, s.y1, s.x2, s.y2, s.color, s.width);
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

    // Preview arrow
    if (state.previewArrow) {
      const a = state.previewArrow;
      this.drawArrow(a.x1, a.y1, a.x2, a.y2, a.color, a.width);
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
    if (!this.insideImage(p.x, p.y) && state.tool !== "eraser") return;

    const layer = plans.ensureLayer(state.activePlanId);

    if (state.tool === "pencil") {
      state.drawing = true;
      state.currentStroke = {
        type: "pencil",
        color: els.strokeColor.value,
        width: Number(els.strokeSize.value),
        points: [this.canvasToImage(p.x, p.y)],
      };
    } else if (state.tool === "arrow") {
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
    } else if (state.tool === "eraser") {
      this.eraseNearby(p, layer);
    }
  },

  onPointerMove(ev) {
    if (!state.drawing) return;
    const p = this.pointerPos(ev);

    if (state.tool === "pencil" && state.currentStroke) {
      state.currentStroke.points.push(this.canvasToImage(p.x, p.y));
    } else if (state.tool === "arrow" && state.previewArrow) {
      const imgP = this.canvasToImage(p.x, p.y);
      state.previewArrow.x2 = imgP.x;
      state.previewArrow.y2 = imgP.y;
    }
    this.render();
  },

  onPointerUp(ev) {
    if (!state.drawing) return;
    const layer = plans.ensureLayer(state.activePlanId);

    if (state.tool === "pencil" && state.currentStroke) {
      if (state.currentStroke.points.length > 1) {
        layer.strokes.push(state.currentStroke);
      }
    } else if (state.tool === "arrow" && state.previewArrow) {
      layer.strokes.push({ ...state.previewArrow });
    }

    layer.redo = [];
    state.drawing = false;
    state.currentStroke = null;
    state.previewArrow = null;
    plans.save();
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
      } else if (s.type === "arrow") {
        const mid = { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
        if (dist(mid, target) < 20) {
          layer.strokes.splice(i, 1);
          break;
        }
      }
    }
    plans.save();
    this.render();
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
  },

  updateStrokeSize() {
    const value = els.strokeSize.value;
    els.strokeSizeValue.textContent = `${value}px`;
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
// EVENT HANDLERS
// ============================================================================

function bindEvents() {
  // Window events
  window.addEventListener("resize", () => canvas.resize());

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
}

// ============================================================================
// INITIALIZATION
// ============================================================================

function init() {
  auth.loadSession();
  plans.load();
  notes.load();
  bindEvents();
  security.initAntiScreenshot();
  canvas.resize();
  plans.renderList();
  if (state.activePlanId) {
    const plan = state.plans.find((p) => p.id === state.activePlanId);
    if (plan) canvas.loadImage(plan.dataUrl);
  }
  auth.updateSessionUI();
  security.setPrivacy(state.session.privacy);
  toolbar.updateStrokeSize();
}

// Start app
init();
