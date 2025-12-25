/* Shadow Of Intent - Plan Viewer + Annotations
   Demo front only
   Vrai securite => serveur (tokens, expiration, chiffrement, watermark serveur)
*/

const $ = (sel) => document.querySelector(sel);

const state = {
  session: {
    label: "",
    privacy: false
  },
  plans: [],
  activePlanId: null,
  tool: "pencil",
  strokes: [],
  redo: [],
  drawing: false,
  currentStroke: null,
  arrowStart: null,
  img: null,
  transform: { scale: 1, ox: 0, oy: 0 },
};

const storageKeys = {
  plans: "soi_plans_v1",
  lastPlan: "soi_last_plan_v1"
};

// demo password hash of "demo123"
const DEMO_HASH = "8f3fefb2c5f06a58d0aeb7b3f00b2bb2d1b6b9f4b1c1c2a2b3b7a7e0e9c8bdfd";

const board = $("#board");
const ctx = board.getContext("2d", { alpha: false });

function resizeCanvas(){
  const shell = $("#canvasShell");
  const rect = shell.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  board.width = Math.floor(rect.width * dpr);
  board.height = Math.floor(rect.height * dpr);
  board.style.width = rect.width + "px";
  board.style.height = rect.height + "px";

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  recomputeTransform();
  render();
}

function recomputeTransform(){
  if(!state.img) return;
  const cw = board.clientWidth;
  const ch = board.clientHeight;
  const iw = state.img.naturalWidth || state.img.width;
  const ih = state.img.naturalHeight || state.img.height;

  const scale = Math.min(cw / iw, ch / ih);
  const ox = (cw - iw * scale) / 2;
  const oy = (ch - ih * scale) / 2;

  state.transform = { scale, ox, oy };
}

function canvasToImageCoords(px, py){
  const { scale, ox, oy } = state.transform;
  return { x: (px - ox) / scale, y: (py - oy) / scale };
}

function imageToCanvasCoords(ix, iy){
  const { scale, ox, oy } = state.transform;
  return { x: ix * scale + ox, y: iy * scale + oy };
}

function insideImage(px, py){
  if(!state.img) return false;
  const iw = state.img.naturalWidth || state.img.width;
  const ih = state.img.naturalHeight || state.img.height;
  const p = canvasToImageCoords(px, py);
  return p.x >= 0 && p.y >= 0 && p.x <= iw && p.y <= ih;
}

function clearBoard(){
  ctx.clearRect(0,0,board.clientWidth, board.clientHeight);
}

function drawBackground(){
  const cw = board.clientWidth;
  const ch = board.clientHeight;

  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0,0,cw,ch);

  if(!state.img) return;

  const iw = state.img.naturalWidth || state.img.width;
  const ih = state.img.naturalHeight || state.img.height;
  const { scale, ox, oy } = state.transform;

  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(state.img, ox, oy, iw * scale, ih * scale);
}

function drawArrow(x1, y1, x2, y2, color, width){
  const p1 = imageToCanvasCoords(x1, y1);
  const p2 = imageToCanvasCoords(x2, y2);

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
  const headLen = Math.max(10, width * 3.2);

  const hx1 = p2.x - headLen * Math.cos(angle - Math.PI / 7);
  const hy1 = p2.y - headLen * Math.sin(angle - Math.PI / 7);
  const hx2 = p2.x - headLen * Math.cos(angle + Math.PI / 7);
  const hy2 = p2.y - headLen * Math.sin(angle + Math.PI / 7);

  ctx.beginPath();
  ctx.moveTo(p2.x, p2.y);
  ctx.lineTo(hx1, hy1);
  ctx.lineTo(hx2, hy2);
  ctx.closePath();
  ctx.fill();
}

function drawPencil(points, color, width){
  if(points.length < 2) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  const p0 = imageToCanvasCoords(points[0].x, points[0].y);
  ctx.moveTo(p0.x, p0.y);

  for(let i=1;i<points.length;i++){
    const p = imageToCanvasCoords(points[i].x, points[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function render(){
  $("#emptyState").style.display = state.img ? "none" : "flex";

  drawBackground();

  for(const s of state.strokes){
    if(s.type === "pencil"){
      drawPencil(s.points, s.color, s.width);
    } else if(s.type === "arrow"){
      drawArrow(s.x1, s.y1, s.x2, s.y2, s.color, s.width);
    }
  }

  if(state.drawing && state.currentStroke && state.currentStroke.type === "pencil"){
    drawPencil(state.currentStroke.points, state.currentStroke.color, state.currentStroke.width);
  }

  if(state.drawing && state.arrowStart && state.tool === "arrow" && state.previewArrow){
    const a = state.previewArrow;
    drawArrow(a.x1, a.y1, a.x2, a.y2, a.color, a.width);
  }
}

function setTool(tool){
  state.tool = tool;
  document.querySelectorAll(".toolbtn").forEach(b => {
    b.classList.toggle("is-active", b.dataset.tool === tool);
  });
}

function getStrokeWidth(){
  return parseInt($("#strokeSize").value, 10) || 4;
}
function getStrokeColor(){
  return $("#strokeColor").value || "#ff2b2b";
}

function pointerPos(ev){
  const rect = board.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function onPointerDown(ev){
  if(!state.img) return;
  const p = pointerPos(ev);
  if(!insideImage(p.x, p.y)) return;

  state.drawing = true;
  state.redo = [];

  const imgP = canvasToImageCoords(p.x, p.y);
  const color = getStrokeColor();
  const width = getStrokeWidth();

  if(state.tool === "pencil" || state.tool === "eraser"){
    const c = (state.tool === "eraser") ? "#000000" : color; // gomme simple en noir (sur fond image ca reste utile)
    state.currentStroke = { type:"pencil", points:[imgP], color: c, width };
  }

  if(state.tool === "arrow"){
    state.arrowStart = imgP;
    state.previewArrow = { type:"arrow", x1: imgP.x, y1: imgP.y, x2: imgP.x, y2: imgP.y, color, width };
  }

  render();
}

function onPointerMove(ev){
  if(!state.drawing || !state.img) return;
  const p = pointerPos(ev);

  const imgP = canvasToImageCoords(p.x, p.y);

  if(state.tool === "pencil" || state.tool === "eraser"){
    if(!state.currentStroke) return;
    state.currentStroke.points.push(imgP);
  }

  if(state.tool === "arrow"){
    if(!state.arrowStart) return;
    const color = getStrokeColor();
    const width = getStrokeWidth();
    state.previewArrow = { type:"arrow", x1: state.arrowStart.x, y1: state.arrowStart.y, x2: imgP.x, y2: imgP.y, color, width };
  }

  render();
}

function onPointerUp(){
  if(!state.drawing) return;
  state.drawing = false;

  if(state.tool === "pencil" || state.tool === "eraser"){
    if(state.currentStroke && state.currentStroke.points.length > 1){
      state.strokes.push(state.currentStroke);
      saveActivePlanStrokes();
    }
    state.currentStroke = null;
  }

  if(state.tool === "arrow"){
    if(state.previewArrow){
      state.strokes.push({ ...state.previewArrow });
      saveActivePlanStrokes();
    }
    state.arrowStart = null;
    state.previewArrow = null;
  }

  render();
}

function undo(){
  if(state.strokes.length === 0) return;
  const s = state.strokes.pop();
  state.redo.push(s);
  saveActivePlanStrokes();
  render();
}

function redo(){
  if(state.redo.length === 0) return;
  const s = state.redo.pop();
  state.strokes.push(s);
  saveActivePlanStrokes();
  render();
}

function clearAnnotations(){
  state.strokes = [];
  state.redo = [];
  saveActivePlanStrokes();
  render();
}

function formatDate(ts){
  const d = new Date(ts);
  return d.toLocaleString("fr-FR");
}

function loadPlans(){
  try{
    const raw = localStorage.getItem(storageKeys.plans);
    state.plans = raw ? JSON.parse(raw) : [];
  }catch{
    state.plans = [];
  }

  // first run seed example plan slot
  if(state.plans.length === 0){
    state.plans.push({
      id: crypto.randomUUID(),
      name: "Exemple (uploadez le png)",
      imageDataUrl: null,
      createdAt: Date.now(),
      strokes: []
    });
    persistPlans();
  }
}

function persistPlans(){
  localStorage.setItem(storageKeys.plans, JSON.stringify(state.plans));
}

function renderPlanList(){
  const list = $("#planList");
  list.innerHTML = "";

  state.plans.forEach(p => {
    const el = document.createElement("div");
    el.className = "plan-item" + (p.id === state.activePlanId ? " is-active" : "");
    el.innerHTML = `
      <div class="plan-name">${escapeHtml(p.name)}</div>
      <div class="plan-meta">${p.imageDataUrl ? "PNG charge" : "Pas de fichier"} · ${formatDate(p.createdAt)}</div>
    `;
    el.addEventListener("click", () => openPlan(p.id));
    list.appendChild(el);
  });
}

function escapeHtml(s){
  return (s || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[c]));
}

function findPlan(id){
  return state.plans.find(p => p.id === id) || null;
}

function openPlan(id){
  const plan = findPlan(id);
  if(!plan) return;

  state.activePlanId = id;
  localStorage.setItem(storageKeys.lastPlan, id);

  state.strokes = Array.isArray(plan.strokes) ? plan.strokes : [];
  state.redo = [];

  if(!plan.imageDataUrl){
    state.img = null;
    renderPlanList();
    render();
    return;
  }

  const img = new Image();
  img.onload = () => {
    state.img = img;
    recomputeTransform();
    renderPlanList();
    render();
  };
  img.src = plan.imageDataUrl;
}

function saveActivePlanStrokes(){
  const plan = findPlan(state.activePlanId);
  if(!plan) return;
  plan.strokes = state.strokes;
  persistPlans();
}

function createPlanFromFile(name, file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Lecture impossible"));
    reader.onload = () => {
      const plan = {
        id: crypto.randomUUID(),
        name: name || "Plan sans nom",
        imageDataUrl: reader.result,
        createdAt: Date.now(),
        strokes: []
      };
      state.plans.unshift(plan);
      persistPlans();
      resolve(plan);
    };
    reader.readAsDataURL(file);
  });
}

function exportPNG(){
  if(!state.img) return;

  const iw = state.img.naturalWidth || state.img.width;
  const ih = state.img.naturalHeight || state.img.height;

  const out = document.createElement("canvas");
  out.width = iw;
  out.height = ih;
  const octx = out.getContext("2d");

  octx.drawImage(state.img, 0, 0, iw, ih);

  for(const s of state.strokes){
    if(s.type === "pencil"){
      octx.strokeStyle = s.color;
      octx.lineWidth = s.width;
      octx.lineCap = "round";
      octx.lineJoin = "round";
      octx.beginPath();
      octx.moveTo(s.points[0].x, s.points[0].y);
      for(let i=1;i<s.points.length;i++){
        octx.lineTo(s.points[i].x, s.points[i].y);
      }
      octx.stroke();
    } else if(s.type === "arrow"){
      // arrow on export
      const x1=s.x1,y1=s.y1,x2=s.x2,y2=s.y2;
      octx.strokeStyle = s.color;
      octx.fillStyle = s.color;
      octx.lineWidth = s.width;
      octx.lineCap = "round";
      octx.lineJoin = "round";
      octx.beginPath();
      octx.moveTo(x1,y1);
      octx.lineTo(x2,y2);
      octx.stroke();

      const angle = Math.atan2(y2-y1, x2-x1);
      const headLen = Math.max(16, s.width * 4);
      const hx1 = x2 - headLen * Math.cos(angle - Math.PI / 7);
      const hy1 = y2 - headLen * Math.sin(angle - Math.PI / 7);
      const hx2 = x2 - headLen * Math.cos(angle + Math.PI / 7);
      const hy2 = y2 - headLen * Math.sin(angle + Math.PI / 7);

      octx.beginPath();
      octx.moveTo(x2,y2);
      octx.lineTo(hx1,hy1);
      octx.lineTo(hx2,hy2);
      octx.closePath();
      octx.fill();
    }
  }

  // watermark in export si mode discret
  if(state.session.privacy && state.session.label){
    octx.globalAlpha = 0.16;
    octx.fillStyle = "#ffffff";
    octx.font = "bold 28px Arial";
    octx.translate(iw/2, ih/2);
    octx.rotate(-Math.PI/8);
    const text = state.session.label + " - confidentiel";
    for(let y=-ih; y<ih; y+=160){
      for(let x=-iw; x<iw; x+=420){
        octx.fillText(text, x, y);
      }
    }
    octx.setTransform(1,0,0,1,0,0);
    octx.globalAlpha = 1;
  }

  const url = out.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = `plan_${Date.now()}.png`;
  a.click();
}

function setPrivacyMode(on){
  state.session.privacy = on;
  $("#btnPrivacy").classList.toggle("btn-primary", on);

  const wm = $("#watermark");
  const blur = $("#privacyBlur");

  if(on){
    wm.classList.remove("is-hidden");
    wm.style.backgroundImage = makeWatermarkPattern(state.session.label || "confidentiel");
  }else{
    wm.classList.add("is-hidden");
    blur.classList.add("is-hidden");
  }
}

function makeWatermarkPattern(text){
  const c = document.createElement("canvas");
  c.width = 280;
  c.height = 160;
  const cctx = c.getContext("2d");

  cctx.clearRect(0,0,c.width,c.height);
  cctx.globalAlpha = 1;
  cctx.fillStyle = "rgba(255,255,255,.9)";
  cctx.font = "bold 16px Arial";
  cctx.translate(30, 80);
  cctx.rotate(-Math.PI/10);
  cctx.fillText(text, 0, 0);
  cctx.fillText("no share", 0, 24);
  return `url(${c.toDataURL("image/png")})`;
}

function blurOn(){
  if(!state.session.privacy) return;
  $("#privacyBlur").classList.remove("is-hidden");
}
function blurOff(){
  if(!state.session.privacy) return;
  $("#privacyBlur").classList.add("is-hidden");
}

async function sha256Hex(str){
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,"0")).join("");
}

async function login(){
  const label = ($("#loginLabel").value || "").trim() || "invite";
  const secret = ($("#loginSecret").value || "").trim();

  if(!secret){
    alert("Entrez un mot de passe ou une cle");
    return;
  }

  const hash = await sha256Hex(secret);
  const ok = (hash === DEMO_HASH);

  if(!ok){
    alert("Acces refuse");
    return;
  }

  state.session.label = label;
  $("#loginModal").style.display = "none";
  setPrivacyMode(true);
  initAfterLogin();
}

function logout(){
  state.session.label = "";
  state.session.privacy = false;
  $("#loginModal").style.display = "flex";
}

function openUploadModal(){
  $("#uploadModal").classList.remove("is-hidden");
  $("#planName").value = "";
  $("#planFile").value = "";
}

function closeUploadModal(){
  $("#uploadModal").classList.add("is-hidden");
}

async function createPlan(){
  const name = ($("#planName").value || "").trim() || "Plan";
  const file = $("#planFile").files?.[0];
  if(!file){
    alert("Choisissez un fichier");
    return;
  }

  const plan = await createPlanFromFile(name, file);
  closeUploadModal();
  renderPlanList();
  openPlan(plan.id);
}

function genShareKey(){
  // demo key format
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const key = "SOI-" + [...bytes].map(b => b.toString(16).padStart(2,"0")).join("").toUpperCase();
  $("#shareKey").value = key;
}

async function copyShareKey(){
  const v = $("#shareKey").value;
  if(!v) return;
  try{
    await navigator.clipboard.writeText(v);
  }catch{
    // fallback
    $("#shareKey").select();
    document.execCommand("copy");
  }
}

async function toggleFullscreen(){
  try{
    if(!document.fullscreenElement){
      await document.documentElement.requestFullscreen();
    }else{
      await document.exitFullscreen();
    }
  }catch{
    // ignore
  }
}

function initAfterLogin(){
  loadPlans();
  renderPlanList();

  const last = localStorage.getItem(storageKeys.lastPlan);
  const fallback = state.plans.find(p => p.imageDataUrl)?.id || state.plans[0]?.id;
  openPlan(last && findPlan(last) ? last : fallback);

  resizeCanvas();
}

function bindUI(){
  // tools
  document.querySelectorAll(".toolbtn").forEach(btn => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
  });

  $("#btnUndo").addEventListener("click", undo);
  $("#btnRedo").addEventListener("click", redo);
  $("#btnClear").addEventListener("click", clearAnnotations);
  $("#btnExport").addEventListener("click", exportPNG);

  // auth
  $("#btnLogin").addEventListener("click", login);
  $("#btnLogout").addEventListener("click", logout);

  // privacy
  $("#btnPrivacy").addEventListener("click", () => setPrivacyMode(!state.session.privacy));
  $("#btnFullscreen").addEventListener("click", toggleFullscreen);

  // upload
  $("#btnNewPlan").addEventListener("click", openUploadModal);
  $("#btnCancelPlan").addEventListener("click", closeUploadModal);
  $("#btnCreatePlan").addEventListener("click", createPlan);

  // share key
  $("#btnGenKey").addEventListener("click", genShareKey);
  $("#btnCopyKey").addEventListener("click", copyShareKey);

  // canvas events
  board.addEventListener("pointerdown", onPointerDown);
  board.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  // blur deterrence
  window.addEventListener("blur", blurOn);
  window.addEventListener("focus", blurOff);
  document.addEventListener("visibilitychange", () => {
    if(document.hidden) blurOn();
    else blurOff();
  });

  // resize
  window.addEventListener("resize", resizeCanvas);

  // block context menu (dissuasion)
  document.addEventListener("contextmenu", (e) => {
    if(state.session.privacy) e.preventDefault();
  });
}

bindUI();
// start locked
$("#loginModal").style.display = "flex";
setTool("pencil");
resizeCanvas();
render();
