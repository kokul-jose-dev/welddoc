/* WeldDoc shared application module (loaded by every page). */
const TODAY = new Date();
const TODAY_ISO = new Date().toISOString().split('T')[0];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ROLE_KEY = 'weldoc_role';        // 'office' | 'vendor'
const CURRENT_USER_KEY = 'weldoc_user'; // logged-in person id (for the vendor role)

/* ---- Cache helpers (sessionStorage with TTL) ---- */
function getCached(key){
  try {
    const raw = sessionStorage.getItem('weldoc_cache_' + key);
    if (!raw) return null;
    const { val, exp } = JSON.parse(raw);
    if (Date.now() > exp) { sessionStorage.removeItem('weldoc_cache_' + key); return null; }
    return val;
  } catch(e) { return null; }
}
function setCached(key, val, ttlMs = 60000){
  try { sessionStorage.setItem('weldoc_cache_' + key, JSON.stringify({ val, exp: Date.now() + ttlMs })); } catch(e){}
}
function invalidateCache(keyPrefix){
  try {
    if (!keyPrefix) {
      Object.keys(sessionStorage).forEach(k => { if(k.startsWith('weldoc_cache_')) sessionStorage.removeItem(k); });
    } else {
      sessionStorage.removeItem('weldoc_cache_' + keyPrefix);
    }
  } catch(e){}
}

/* ---- API helpers & Global Loading ---- */
const API_BASE = '/api';

let _progressCount = 0;
function showGlobalProgress(){
  _progressCount++;
  let bar = document.getElementById('global-progress-bar');
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'global-progress-bar';
    document.body.appendChild(bar);
  }
  bar.style.display = 'block';
}

function hideGlobalProgress(){
  _progressCount = Math.max(0, _progressCount - 1);
  if(_progressCount === 0){
    const bar = document.getElementById('global-progress-bar');
    if(bar) bar.style.display = 'none';
  }
}

function setButtonLoading(btn, isLoading, text){
  if(!btn) return;
  if(isLoading){
    btn.disabled = true;
    btn.classList.add('is-loading');
    if(!btn._originalHtml) btn._originalHtml = btn.innerHTML;
    const label = text || t('saving', 'Saving…');
    btn.innerHTML = `<span class="btn-spinner-wrap"><span class="spinner"></span> <span>${escapeHtml(label)}</span></span>`;
    showGlobalProgress();
  } else {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    if(btn._originalHtml){
      btn.innerHTML = btn._originalHtml;
      delete btn._originalHtml;
    }
    hideGlobalProgress();
  }
}

async function apiGet(path){
  showGlobalProgress();
  try {
    const r=await fetch(API_BASE+path);
    if(!r.ok) throw new Error(r.statusText);
    return await r.json();
  } finally {
    hideGlobalProgress();
  }
}

async function apiPost(path, data){
  showGlobalProgress();
  try {
    const r=await fetch(API_BASE+path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
    if(!r.ok) throw new Error(r.statusText);
    return await r.json();
  } finally {
    hideGlobalProgress();
  }
}
async function apiBulk(includes, opts={}){ const p=new URLSearchParams({include:includes.join(',')}); if(opts.pipelineId) p.set('pipelineId',opts.pipelineId); if(opts.projectId) p.set('projectId',opts.projectId); if(opts.clientId) p.set('clientId',opts.clientId); if(opts.archived) p.set('archived','true'); return apiGet('/bulk?'+p.toString()); }
function computeProjectStatus(p){
  const pls = (DB.pipelines||[]).filter(pl => pl.projectId === p.id && !pl.archived);
  if(!pls.length) return 'not-started';
  const allCompleted = pls.every(pl => pl.status === 5);
  if(allCompleted) return 'completed';
  const allNotStarted = pls.every(pl => pl.status === 0);
  if(allNotStarted) return 'not-started';
  return 'ongoing';
}
function normalizeProject(p){
  p.order=p.orderNo||p.order||'';
  p.status=computeProjectStatus(p);
  return p;
}
function normalizeProjects(arr){ return arr.map(normalizeProject); }
function normalizeMaterial(m){
  if(m.category && !m.piece) m.piece=m.category;
  if(m.dn1 && !m.dimension) m.dimension=m.dn1;
  for(let i=2;i<=6;i++){ if(m[`dn${i}`] && !m[`dimension${i}`]) m[`dimension${i}`]=m[`dn${i}`]; }
  if(typeof m.position==='string'){ const code=m.position.charCodeAt(0); m.position=code>=65&&code<=90?code-64:parseInt(m.position)||1; }
  if(!m.connections) m.connections=[];
  if(!m.materialCode && m.material_code) m.materialCode=m.material_code;
  if(!m.itemDescription && m.item_description) m.itemDescription=m.item_description;
  if(!m.dienNo && m.dien_no) m.dienNo=m.dien_no;
  if(!m.heatNo && m.heat_no) m.heatNo=m.heat_no;
  if(!m.wazNo && m.waz_no) m.wazNo=m.waz_no;
  if(!m.wazPdfUrl && m.waz_pdf_url) m.wazPdfUrl=m.waz_pdf_url;
  if(m.startOfPlumbing===undefined && m.start_of_plumbing!==undefined) m.startOfPlumbing=m.start_of_plumbing;
  if(m.endOfPlumbing===undefined && m.end_of_plumbing!==undefined) m.endOfPlumbing=m.end_of_plumbing;
  if(m.pipelineId===undefined && m.pipeline_id!==undefined) m.pipelineId=m.pipeline_id;
  return m;
}
function normalizeMaterials(arr){ return arr.map(normalizeMaterial); }
function normalizeWeld(w){
  if(!w.materialIds) w.materialIds=[];
  if(!w.welderIds) w.welderIds=w.welderId?[w.welderId]:[];
  if(!w.inspectorIds) w.inspectorIds=w.inspectorId?[w.inspectorId]:[];
  if(w.pipelineId===undefined && w.pipeline_id!==undefined) w.pipelineId=w.pipeline_id;
  if(w.weldNo===undefined && w.weld_no!==undefined) w.weldNo=w.weld_no;
  if(w.welder===undefined && w.welderName!==undefined) w.welder=w.welderName;
  if(w.inspector===undefined && w.inspectorName!==undefined) w.inspector=w.inspectorName;
  if(!w.welder) w.welder='';
  if(!w.inspector) w.inspector='';
  if(!w.visual) w.visual='n/a';
  if(!w.endoscopy) w.endoscopy='n/a';
  if(!w.ferrite) w.ferrite='n/a';
  if(!w.photoUrl) w.photoUrl='';
  if(!w.endoscopyUrl) w.endoscopyUrl='';
  if(!w.endoscopyVideoUrl) w.endoscopyVideoUrl=w.endoscopy_video_url||'';
  if(!w.endoscopyImageUrl) w.endoscopyImageUrl=w.endoscopy_image_url||'';
  if(!w.remarks) w.remarks='';
  if(!w.noteImageNo) w.noteImageNo='';
  if(w.weldingWire===undefined && w.welding_wire!==undefined) w.weldingWire=w.welding_wire;
  if(!w.weldingWire) w.weldingWire='';
  return w;
}
function normalizeWelds(arr){ return arr.map(normalizeWeld); }
/* Rebuild materialIds on welds and connections on materials from betweenA/betweenB */
function rebuildRelationships(){
  if(!DB||!DB.materials||!DB.welds) return;
  /* Build position→material map per pipeline */
  const matByPipePos={};
  DB.materials.forEach(m=>{
    const key=m.pipelineId+'_'+posLetter(m.position);
    matByPipePos[key]=m;
  });
  /* Rebuild weld.materialIds from betweenA/betweenB */
  DB.welds.forEach(w=>{
    if(w.materialIds&&w.materialIds.length) return; /* already has IDs */
    const a=matByPipePos[w.pipelineId+'_'+(w.betweenA||'')];
    const b=matByPipePos[w.pipelineId+'_'+(w.betweenB||'')];
    w.materialIds=[];
    if(a) w.materialIds.push(a.id);
    if(b) w.materialIds.push(b.id);
  });
  /* Rebuild material.connections from welds */
  DB.materials.forEach(m=>{ if(!m.connections||!m.connections.length) m.connections=[]; });
  DB.welds.filter(w=>!w.archived&&w.materialIds.length===2).forEach(w=>{
    const [aId,bId]=w.materialIds;
    const a=DB.materials.find(m=>m.id===aId);
    const b=DB.materials.find(m=>m.id===bId);
    if(a&&b){
      const aIsWire = (a.piece||a.category||'').toLowerCase()==='welding wire';
      const bIsWire = (b.piece||b.category||'').toLowerCase()==='welding wire';
      if(!aIsWire && !bIsWire){
        if(!a.connections.includes(bId)) a.connections.push(bId);
        if(!b.connections.includes(aId)) b.connections.push(aId);
      }
    }
  });
  /* Ensure no wire material IDs remain in any material connections */
  const wireIds = new Set(DB.materials.filter(x=>(x.piece||x.category||'').toLowerCase()==='welding wire').map(x=>x.id));
  DB.materials.forEach(m=>{
    if(m.connections && m.connections.length){
      m.connections = m.connections.filter(cid => !wireIds.has(cid));
    }
  });
  /* Build welderIds and inspectorIds on pipelines from welds */
  (DB.pipelines || []).forEach(pl => {
    const pipeWelds = (DB.welds || []).filter(w => w.pipelineId === pl.id && !w.archived);
    const wIds = new Set();
    const iIds = new Set();
    pipeWelds.forEach(w => {
      if (w.welderId) wIds.add(w.welderId);
      if (w.welderIds) w.welderIds.forEach(id => wIds.add(id));
      if (w.inspectorId) iIds.add(w.inspectorId);
      if (w.inspectorIds) w.inspectorIds.forEach(id => iIds.add(id));
    });
    pl.welderIds = Array.from(wIds);
    pl.inspectorIds = Array.from(iIds);
  });
  /* Compute automatic project statuses */
  (DB.projects||[]).forEach(p => { p.status = computeProjectStatus(p); });
}

/* ---- catalogs for dropdown + free-text fields ---- */
const PIECE_OPTIONS = ["Pipe","Flange","Blind Flange","Elbow","Reducer","Tee","Pipe extruded outlet","Pipe 2 extruded outlet","Equipment","2-Way Valve","3-Way Valve","4-Way Valve","6-Way Valve","Welding Wire"];
/* Required number of welds (connections) per category */
const PIECE_WELDS = {
  "pipe":2, "flange":1, "blind flange":0, "elbow":2, "reducer":2,
  "tee":3, "pipe extruded outlet":3, "pipe 2 extruded outlet":4,
  "equipment":2, "2-way valve":2, "3-way valve":3, "4-way valve":4, "6-way valve":6,
  "ferrule":2, "welding wire":0, "valve":2
};
function requiredWelds(piece){ return PIECE_WELDS[(piece||'').toLowerCase()] ?? 2; }
/* Number of DN fields per category (matches ports that can differ in size) */
const PIECE_DNS = {
  "pipe":1, "flange":1, "blind flange":1, "elbow":1, "reducer":2,
  "tee":2, "pipe extruded outlet":2, "pipe 2 extruded outlet":3,
  "equipment":1, "2-way valve":2, "3-way valve":3, "4-way valve":4, "6-way valve":6,
  "ferrule":1, "welding wire":0, "valve":1
};
function requiredDns(piece){ return PIECE_DNS[(piece||'').toLowerCase()] ?? 1; }
/* Whether category shows outer diameter field */
const PIECE_HAS_DIAMETER = {
  "pipe":true, "flange":true, "blind flange":false, "elbow":true, "reducer":true,
  "tee":true, "pipe extruded outlet":true, "pipe 2 extruded outlet":true,
  "equipment":false, "2-way valve":false, "3-way valve":false, "4-way valve":false, "6-way valve":false,
  "ferrule":true, "welding wire":true, "valve":false
};
/* Whether category shows thickness field */
const PIECE_HAS_THICKNESS = {
  "pipe":true, "flange":true, "blind flange":false, "elbow":true, "reducer":true,
  "tee":true, "pipe extruded outlet":true, "pipe 2 extruded outlet":true,
  "equipment":false, "2-way valve":false, "3-way valve":false, "4-way valve":false, "6-way valve":false,
  "ferrule":true, "welding wire":false, "valve":false
};
function hasDiameter(piece){ return PIECE_HAS_DIAMETER[(piece||'').toLowerCase()] !== false; }
function hasThickness(piece){ return PIECE_HAS_THICKNESS[(piece||'').toLowerCase()] !== false; }
const DIMENSION_OPTIONS = ["DN 8","DN 10","DN 15","DN 20","DN 25","DN 32","DN 40","DN 50","DN 65","DN 80","DN 100","DN 125","DN 150","DN 200","DN 250","DN 300","DN 350","DN 400","DN 450","DN 500","DN 550","DN 600","DN 700","DN 800","DN 900"];
const CERT_OPTIONS = ["EN 10204 3.1","EN 10204 3.2","EN 10204 2.2"];
const PROC_OPTIONS = ["141","147"];
const DEFAULT_WPS_PROCESSES = [
  { wpsNo: "SP2", process: "141" },
  { wpsNo: "SP5", process: "135" },
  { wpsNo: "SP6", process: "136" },
  { wpsNo: "SP13", process: "141" },
  { wpsNo: "SP14", process: "147" },
  { wpsNo: "VP7", process: "135 / 136" },
  { wpsNo: "VP7", process: "135" },
  { wpsNo: "VP7", process: "136" },
  { wpsNo: "VP9", process: "141 / 136" },
  { wpsNo: "VP9", process: "141" },
  { wpsNo: "VP9", process: "136" },
  { wpsNo: "VP11", process: "145" },
  { wpsNo: "VP14", process: "142" },
  { wpsNo: "VP14.1", process: "142" },
  { wpsNo: "VP15", process: "141" },
  { wpsNo: "VP16.1", process: "141" },
  { wpsNo: "VP17", process: "141" },
  { wpsNo: "VP18", process: "136" },
  { wpsNo: "VP21", process: "145" }
];

/* ================================================================ PERSISTENCE ================================================================ */
let DB = null;
function saveDB(){ /* no-op: data is in Azure SQL now */ }
function initDB(){ DB = DB || { clients:[], projects:[], people:[], certificates:[], pipelines:[], materials:[], welds:[], globalMaterials:[], projectMaterials:[], wpsProcesses:[...DEFAULT_WPS_PROCESSES], globalMaterialCount:0, counters:{ client:1, project:1, person:1, cert:1, pipeline:1, material:1, weld:1 } };
  if(DB && (!DB.wpsProcesses || !DB.wpsProcesses.length)) DB.wpsProcesses = [...DEFAULT_WPS_PROCESSES];
}

/* ---- role / current-user (mockup auth) ---- */
function getRole(){ try { return localStorage.getItem(ROLE_KEY)||'office'; } catch(e){ return 'office'; } }
function setRole(r){ try { localStorage.setItem(ROLE_KEY,r); } catch(e){} }
function getCurrentUserId(){ try { return Number(localStorage.getItem(CURRENT_USER_KEY))||1; } catch(e){ return 1; } }
function setCurrentUserId(id){ try { localStorage.setItem(CURRENT_USER_KEY,String(id)); } catch(e){} }

/* ---- shared client/project filter (persisted across Projects / Pipelines pages) ---- */
const CLIENT_FILTER_KEY='weldoc_client_filter';
const PROJECT_FILTER_KEY='weldoc_project_filter';
function getSharedClientFilter(){ try { return localStorage.getItem(CLIENT_FILTER_KEY)||''; } catch(e){ return ''; } }
function setSharedClientFilter(v){ try { localStorage.setItem(CLIENT_FILTER_KEY,v||''); } catch(e){} }
function getSharedProjectFilter(){ try { return localStorage.getItem(PROJECT_FILTER_KEY)||''; } catch(e){ return ''; } }
function setSharedProjectFilter(v){ try { localStorage.setItem(PROJECT_FILTER_KEY,v||''); } catch(e){} }

/* data accessors — exclude archived items from all list views (get* by id still resolve archived records) */
function clients(){ return DB.clients.filter(c=>!c.archived); }
function projects(){ return DB.projects.filter(p=>!p.archived); }
function people(){ return DB.people.filter(p=>!p.archived); }
function certificates(){ return DB.certificates.filter(c=>!c.archived); }
function pipelines(){ return DB.pipelines.filter(p=>!p.archived); }
function materials(){ return DB.materials.filter(m=>!m.archived); }
function welds(){ return DB.welds.filter(w=>!w.archived); }
function nextId(key){ return DB.counters[key]++; }

function getClient(id){ return DB.clients.find(c=>c.id===id); }
function getProject(id){ return DB.projects.find(p=>p.id===id); }
function getPerson(id){ return DB.people.find(p=>p.id===id); }
function getPipeline(id){ return DB.pipelines.find(p=>p.id===id); }
function getMaterial(id){ return DB.materials.find(m=>m.id===id); }
function getWeld(id){ return DB.welds.find(w=>w.id===id); }
function getClientName(id){ const c=getClient(id); return c?c.name:t('unknown_client','Unknown client'); }
function pipelineMaterials(pid){ return materials().filter(m=>m.pipelineId===pid).sort((a,b)=>a.position-b.position); }
function pipelineWelds(pid){ return welds().filter(w=>w.pipelineId===pid).sort((a,b)=>Number(a.weldNo)-Number(b.weldNo)); }
function materialWelds(mid){ const m=getMaterial(mid); return welds().filter(w=>w.pipelineId===m.pipelineId && w.materialIds.includes(mid)); }
function personCerts(pid){ return certificates().filter(c=>c.personId===pid); }
function projectPipelines(prid){ return pipelines().filter(p=>p.projectId===prid); }
function clientProjects(cid){ return projects().filter(p=>p.clientId===cid); }
function uniqueLocations(){ return [...new Set(DB.projects.map(p=>p.location).filter(Boolean))].sort(); }
function uniqueHeats(){ return [...new Set(DB.materials.map(m=>m.heatNo).filter(Boolean))].sort(); }
function uniqueWaz(){ return [...new Set(DB.materials.map(m=>m.wazNo).filter(Boolean))].sort(); }
function uniqueProcedures(){ return [...new Set([...PROC_OPTIONS, ...DB.welds.map(w=>w.procedure).filter(Boolean)])]; }

/* ================================================================ SHARED HELPERS ================================================================ */
function escapeHtml(str){ if(str===null||str===undefined) return ''; const d=document.createElement('div'); d.textContent=String(str); return d.innerHTML; }
function initials(name){ return (name||'').split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase(); }
function posLetter(n){
  if(n===null||n===undefined||n==='') return '';
  if(typeof n==='string'){
    const s=n.trim();
    if(/^[A-Za-z]+$/.test(s)) return s.toUpperCase();
    const num=Number(s);
    if(!isNaN(num)&&num>=1&&num<=26) return String.fromCharCode(64+num);
    return s;
  }
  const num=Number(n);
  if(!isNaN(num)&&num>=1&&num<=26) return String.fromCharCode(64+num);
  return String(n);
}
function fmtDia(v){ if(!v) return ''; const s=String(v).trim(); return 'Ø '+s+(s.toLowerCase().includes('mm')?'':' mm'); }
/* Documents and UI both print dates as DD/MM/YYYY (see app/dates.py). */
function formatDate(iso){
  if(!iso) return '—';
  const s=String(iso).trim(); if(!s) return '—';
  const base=s.split('T')[0].split(' ')[0];
  let y,m,d;
  let mt=base.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if(mt){ y=+mt[1]; m=+mt[2]; d=+mt[3]; }
  else {
    mt=base.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if(mt){ d=+mt[1]; m=+mt[2]; y=+mt[3]; }
  }
  if(!y||!m||!d) return s;
  return `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
}
function daysUntil(iso){
  if(!iso) return 9999;
  const [y,m,d]=iso.split('-').map(Number);
  const target = new Date(y, m-1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}
function certStatus(cert){ if(!cert.validUntil) return 'valid'; const n=daysUntil(cert.validUntil); if(n<0) return 'expired'; if(n<=30) return 'expiring'; return 'valid'; }
function personCertRank(pid){ const s=personCerts(pid).map(certStatus); if(s.includes('valid')) return 'valid'; if(s.includes('expiring')) return 'expiring'; return 'expired'; }
function personNameClass(pid, pipeStatus){ if(pipeStatus===3) return ''; const r=personCertRank(pid); return r==='expired'?'expired':r==='expiring'?'warn':''; }
function tile(num,label,cls){ return `<div class="stat-tile ${cls||''}"><div class="stat-num">${num}</div><div class="stat-label">${typeof t==='function'?t(label,label):label}</div></div>`; }
const ARCHIVE_SVG='<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="4" rx="1" stroke="currentColor" stroke-width="1.8"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M10 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
function archiveBtn(type,id){ const arcLabel=typeof t==='function'?t('archive','Archive'):'Archive'; return `<button class="btn-archive" onclick="openArchiveModal('${type}',${id})" title="${arcLabel}">${ARCHIVE_SVG}${arcLabel}</button>`; }

/* ---- pipeline lifecycle (6 states) ---- */
const _RAW_PIPE_STATUS = [
  "New",                           // 0  → pending material list creation
  "Material list done",          // 1  → pending weld list creation
  "Weld list done",              // 2  → pending welder document (print / download)
  "Welder document downloaded", // 3  → pending welding detail update
  "Welding details updated",     // 4  → pending export of final document
  "Exported"                     // 5  → complete
];
const PIPE_STATUS = new Proxy(_RAW_PIPE_STATUS, {
  get(target, prop) {
    if (typeof prop === 'string' && !isNaN(prop)) {
      const idx = Number(prop);
      return typeof t === 'function' ? t(`status_${idx}`, target[idx]) : target[idx];
    }
    return target[prop];
  }
});

/* office-staff "what's pending" labels, indexed by status */
const _RAW_PENDING_LABEL = [
  "Pending material list creation",
  "Pending weld list creation",
  "Pending welder document",
  "Pending welding detail update",
  "Pending export of final document",
  "Completed"
];
const PENDING_LABEL = new Proxy(_RAW_PENDING_LABEL, {
  get(target, prop) {
    if (typeof prop === 'string' && !isNaN(prop)) {
      const idx = Number(prop);
      return typeof t === 'function' ? t(`pending_${idx}`, target[idx]) : target[idx];
    }
    return target[prop];
  }
});

const _RAW_STATUS_LABELS = { 'not-started':'Not started','ongoing':'Ongoing','completed':'Completed' };
const STATUS_LABELS = new Proxy(_RAW_STATUS_LABELS, {
  get(target, prop) {
    if (prop === 'not-started') return typeof t === 'function' ? t('status_not_started', 'Not started') : 'Not started';
    if (prop === 'ongoing') return typeof t === 'function' ? t('status_ongoing', 'Ongoing') : 'Ongoing';
    if (prop === 'completed') return typeof t === 'function' ? t('status_completed', 'Completed') : 'Completed';
    return target[prop];
  }
});
const STATUS_SEQUENCE = ['not-started','ongoing','completed'];
function statusPill(s){ return `<span class="pill pill-${s}"><span class="dot"></span>${PIPE_STATUS[s]}</span>`; }
function certStatusPill(cert){ const s=certStatus(cert); const label=s==='valid'?(typeof t==='function'?t('cert_valid','Valid'):'Valid'):s==='expiring'?(typeof t==='function'?t('cert_expiring','Expiring'):'Expiring'):(typeof t==='function'?t('cert_expired','Expired'):'Expired'); return `<span class="cpill cpill-${s}">${label}</span>`; }

/* person cell: first name + "+N" badge, colour-coded (unless pipeline completed) */
function personCellHtml(ids, pipeStatus, popupCall){
  if(!ids || !ids.length) return '<span class="muted">—</span>';
  const first=getPerson(ids[0]); if(!first) return '<span class="muted">—</span>';
  const cls=personNameClass(first.id, pipeStatus);
  let html=`<a class="person-name ${cls}" href="welder-profile.html?id=${first.id}">${escapeHtml(first.name)}</a>`;
  if(ids.length>1) html+=`<button class="plus-badge" onclick="${popupCall}">+${ids.length-1}</button>`;
  html+=`<span class="person-sub">No. ${escapeHtml(first.no)}</span>`;
  return html;
}
const _uploadingIsoPipelines = new Set();
function docCell(pl){
  const slot=t=>`<span class="doc-slot" title="${t}">—</span>`;
  let iso;
  if(_uploadingIsoPipelines.has(pl.id)){
    iso = `<span class="doc-chip doc-iso is-loading" title="${t('uploading','Uploading…')}"><span class="doc-spinner"></span>ISO</span>`;
  } else if(pl.docIso){
    iso = `<a class="doc-chip doc-iso" href="${escapeHtml(pl.docIso)}" target="_blank" rel="noopener" title="${t('upload_iso','Isometric drawing (SharePoint)')}">ISO</a>`;
  } else {
    iso = `<button class="btn btn-primary btn-sm" onclick="uploadIsoDoc(${pl.id})" title="${t('upload_iso','Upload ISO document')}">+</button>`;
  }
  let builder;
  if(pl.status >= 3 && pl.docBuilder){
    builder = `<a class="doc-chip doc-weld" href="${escapeHtml(pl.docBuilder)}" target="_blank" rel="noopener" title="${t('doc_welder','Welder document (SharePoint)')}">${t('doc_welder','Welder')}</a>`;
  } else {
    builder = slot(t('doc_welder','Welder document'));
  }
  const fin = pl.docFinal
    ? `<a class="doc-chip doc-final" href="${escapeHtml(pl.docFinal)}" target="_blank" rel="noopener" title="${t('doc_final_title','Final documentation package (SharePoint)')}">${t('doc_final','Final')}</a>`
    : slot(t('doc_final_pending','Final document available after export'));
  return `<div class="docs">${iso}${builder}${fin}</div>`;
}
/* Upload ISO document for a pipeline */
function uploadIsoDoc(plId){
  const input=document.createElement('input');
  input.type='file'; input.accept='application/pdf';
  input.onchange=async()=>{
    const f=input.files[0]; if(!f) return;
    _uploadingIsoPipelines.add(plId);
    rerenderPage();
    showGlobalProgress();
    const formData=new FormData();
    formData.append('file', f);
    try {
      const resp=await fetch(`${API_BASE}/pipelines/${plId}/upload-iso`,{method:'POST',body:formData});
      let result;
      try {
        result=await resp.json();
      } catch(e){
        throw new Error(resp.statusText || 'Server returned invalid response');
      }
      if(!resp.ok){ alert(result.error||t('upload_failed','Upload failed')); return; }
      const pl=getPipeline(plId);
      if(pl){
        pl.docIso=result.docIso;
        pl.isoUploaded=true;
      }
      saveDB();
    } catch(ex){ alert('Upload failed: '+ex.message); }
    finally {
      _uploadingIsoPipelines.delete(plId);
      hideGlobalProgress();
      rerenderPage();
    }
  };
  input.click();
}

/* ================================================================ WORKFLOW STATE MACHINE ================================================================ */
function setPipelineStatus(id,status){ const pl=getPipeline(id); if(!pl) return; pl.status=status;
  saveDB();
  apiPost('/pipelines', {id, status}).catch(e=>console.error('Pipeline status update failed:', e));
}
function markMaterialDone(id){ const pl=getPipeline(id); if(pl&&pl.status===0){ setPipelineStatus(id,1); rerenderPage(); } }
function markWeldlistDone(id){ const pl=getPipeline(id); if(pl&&pl.status===1){ setPipelineStatus(id,2); rerenderPage(); } }
function downloadBuilderDoc(id){ const pl=getPipeline(id); if(!pl) return; if(pl.status===2) setPipelineStatus(id,3); window.open(API_BASE+'/pipelines/'+id+'/builder-doc','_blank','noopener'); rerenderPage(); }
const _exportingFinalPipelines = new Set();
let _exportingPipelineId = null;

function openExportFinalModal(id){
  const pl=getPipeline(id);
  if(!pl || pl.status<4 || _exportingFinalPipelines.has(id)) return;
  _exportingPipelineId = id;
  const cbWelder = document.getElementById('input-exp-welder-sign');
  const cbInsp = document.getElementById('input-exp-inspector-sign');
  if(cbWelder) cbWelder.checked = true;
  if(cbInsp) cbInsp.checked = true;
  openModal('modal-export-final');
}

async function exportFinalDoc(id, includeWelder=true, includeInspector=true){
  const pl=getPipeline(id);
  if(!pl || pl.status<4 || _exportingFinalPipelines.has(id)) return;
  _exportingFinalPipelines.add(id);
  renderWorkflowBar(pl);
  showGlobalProgress();
  try {
    const params = new URLSearchParams({
      include_welder_sign: includeWelder ? 'true' : 'false',
      include_inspector_sign: includeInspector ? 'true' : 'false'
    });
    const resp=await fetch(`${API_BASE}/pipelines/${id}/export-final?${params.toString()}`);
    if(!resp.ok){
      const errData=await resp.json().catch(()=>({}));
      throw new Error(errData.error || resp.statusText || 'Export failed');
    }
    const blob=await resp.blob();
    const cd=resp.headers.get('Content-Disposition');
    let filename=`${pl.no}_final_documentation.pdf`;
    if(cd && cd.includes('filename=')){
      filename=cd.split('filename=')[1].replace(/["']/g,'').trim();
    }
    const url=window.URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    // Refresh pipeline state from server
    const fresh=await apiGet('/pipelines/'+id);
    if(fresh){
      pl.status=fresh.status;
      pl.docFinal=fresh.docFinal;
    }
  } catch(ex){
    console.error('Export final document error:', ex);
    alert('Export failed: '+ex.message);
  } finally {
    _exportingFinalPipelines.delete(id);
    hideGlobalProgress();
    rerenderPage();
  }
}

/* workflow / assignment queries used by the home dashboards */
function pipelineHasUnassignedWelder(pl){
  const wlds = pipelineWelds(pl.id);
  if(!wlds.length) return !(pl.welderIds||[]).length;
  return wlds.some(w => !w.welderId && !w.welder);
}
function pipelineHasUnassignedInspector(pl){
  const wlds = pipelineWelds(pl.id);
  if(!wlds.length) return !(pl.inspectorIds||[]).length;
  return wlds.some(w => !w.inspectorId && !w.inspector);
}
function pipelineExpiredWelder(pl){ return (pl.welderIds||[]).some(wid=>personCerts(wid).length===0 || personCerts(wid).every(c=>certStatus(c)==='expired')); }
function pipelinesPendingCert(){ return pipelines().filter(pl=>(pl.welderIds||[]).length>0 && pipelineExpiredWelder(pl)); }
function pipelinesUnassignedWelder(){ return pipelines().filter(pipelineHasUnassignedWelder); }
function pipelinesUnassignedInspector(){ return pipelines().filter(pipelineHasUnassignedInspector); }
function pipelinesUnassignedAny(){ return pipelines().filter(pl=>pipelineHasUnassignedWelder(pl) || pipelineHasUnassignedInspector(pl)); }
function materialPendingWaz(m){ return !m.wazNo || !m.wazPdfUrl; }
function pipelinesPendingWaz(){ return pipelines().filter(pl=>{ const mats=pipelineMaterials(pl.id); return mats.length>0 && mats.some(materialPendingWaz); }); }
function certsExpiringWithin(days){ return certificates().filter(c=>{ const n=daysUntil(c.validUntil); return n>=0 && n<=days; }); }
function pipelinesForUser(uid){ return pipelines().filter(pl=>(pl.welderIds||[]).includes(uid)||(pl.inspectorIds||[]).includes(uid)); }

/* ---- dropdown + free-text helper ---- */
function buildSelectSimple(selectId, options, value){
  const sel=document.getElementById(selectId);
  sel.innerHTML = '<option value="">Select…</option>' + options.map(o=>`<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  sel.value=value||'';
}
function buildSelectOther(selectId, textId, options, value, noOther){
  const sel=document.getElementById(selectId), txt=document.getElementById(textId);
  const opts = options.slice();
  const inList = value && opts.includes(value);
  sel.innerHTML = '<option value="">Select…</option>' + opts.map(o=>`<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('') + (noOther?'':'<option value="__other__">+ Other (type it)…</option>');
  if(value && !inList && !noOther){ sel.value='__other__'; txt.style.display='block'; txt.value=value; }
  else if(value && !inList && noOther){ sel.value=''; }
  else { sel.value=value||''; txt.style.display='none'; txt.value=''; }
}
function toggleSelectOther(selectId, textId){ const sel=document.getElementById(selectId), txt=document.getElementById(textId); if(sel.value==='__other__'){ txt.style.display='block'; txt.focus(); } else { txt.style.display='none'; } }
function readSelectOther(selectId, textId){ const sel=document.getElementById(selectId); if(!sel) return ''; const txt=document.getElementById(textId); return sel.value==='__other__'? (txt ? txt.value.trim() : '') : sel.value; }

/* ---- checklist helper ---- */
function buildPersonChecklist(containerId, selectedIds){
  document.getElementById(containerId).innerHTML = people().map(p=>{
    const certs = personCerts(p.id);
    const rank = personCertRank(p.id);
    let badge = '';
    if(certs.length === 0){
      badge = ` <span class="cpill cpill-expired" style="margin-left:6px;font-size:0.75rem;padding:2px 6px;">⚠️ ${t('no_cert_on_file','No certificate')}</span>`;
    } else if(rank === 'expired'){
      badge = ` <span class="cpill cpill-expired" style="margin-left:6px;font-size:0.75rem;padding:2px 6px;">⚠️ ${t('cert_expired','Expired')}</span>`;
    } else if(rank === 'expiring'){
      badge = ` <span class="cpill cpill-expiring" style="margin-left:6px;font-size:0.75rem;padding:2px 6px;">⏳ ${t('cert_expiring','Expiring')}</span>`;
    }
    return `<label class="check-item"><input type="checkbox" value="${p.id}" ${selectedIds.includes(p.id)?'checked':''}> ${escapeHtml(p.name)} · No. ${escapeHtml(p.no)}${badge}</label>`;
  }).join('');
}
function getChecked(containerId){ return [...document.querySelectorAll('#'+containerId+' input:checked')].map(i=>Number(i.value)); }

/* ================================================================ CONNECTIONS → WELDS ================================================================ */
function pairKey(a,b){ return [a,b].sort((x,y)=>x-y).join('-'); }
function weldForPair(pipelineId, aId, bId){
  return DB.welds.find(w=>w.pipelineId===pipelineId && w.materialIds.length===2 && pairKey(w.materialIds[0],w.materialIds[1])===pairKey(aId,bId));
}
function ensureWeldForPair(pipelineId, aId, bId){
  if(weldForPair(pipelineId,aId,bId)) return;
  const count = DB.welds.filter(w=>w.pipelineId===pipelineId).length;
  const a=getMaterial(aId);
  DB.welds.push({ id:nextId('weld'), pipelineId, weldNo:`${count+1}`, materialIds:[aId,bId], type:"", procedure:"", welderIds:[], inspectorIds:[], date:"", visual:"n/a", endoscopy:"n/a", ferrite:"n/a", photoUrl:"", endoscopyUrl:"", remarks:"", noteImageNo:"" });
}
/* make connections reciprocal, create welds for new connections, remove welds for removed connections */
function syncMaterialConnections(materialId){
  const m=getMaterial(materialId); if(!m) return;
  const currentConns=m.connections||[];
  /* add reciprocal links and create welds for new connections */
  currentConns.forEach(cid=>{
    const c=getMaterial(cid); if(!c) return;
    c.connections = c.connections || [];
    if(!c.connections.includes(materialId)) c.connections.push(materialId);
    ensureWeldForPair(m.pipelineId, materialId, cid);
  });
  /* remove welds for connections that were removed */
  DB.welds.filter(w=>w.pipelineId===m.pipelineId && w.materialIds.includes(materialId)).forEach(w=>{
    const otherId=w.materialIds.find(id=>id!==materialId);
    if(otherId && !currentConns.includes(otherId)){
      /* connection was removed — delete this weld */
      const idx=DB.welds.indexOf(w);
      if(idx!==-1) DB.welds.splice(idx,1);
      /* also remove reciprocal link from the other material */
      const other=getMaterial(otherId);
      if(other && other.connections){
        other.connections=other.connections.filter(id=>id!==materialId);
      }
    }
  });
  renumberWelds(m.pipelineId);
  reorderMaterialPositions(m.pipelineId);
}
/* Renumber and reorder all welds in a pipeline by following the material connection chain */
function renumberWelds(pipelineId){
  const mats=pipelineMaterials(pipelineId);
  const pipeWelds=DB.welds.filter(w=>w.pipelineId===pipelineId && !w.archived);
  if(!pipeWelds.length) return;
  /* walk the connection chain to determine weld order */
  const startMat=mats.find(m=>m.startOfPlumbing)||mats[0];
  if(!startMat){ pipeWelds.forEach((w,i)=>{ w.weldNo=String(i+1); }); return; }
  const visited=new Set();
  const orderedWelds=[];
  const branches=[];
  function walk(matId){
    const mat=getMaterial(matId); if(!mat || visited.has(mat.id)) return;
    visited.add(mat.id);
    const conns=(mat.connections||[]).map(getMaterial).filter(c=>c&&!visited.has(c.id));
    conns.sort((a,b)=>(a.endOfPlumbing?1:0)-(b.endOfPlumbing?1:0));
    conns.forEach((next,i)=>{
      const w=pipeWelds.find(wl=>wl.materialIds.includes(mat.id)&&wl.materialIds.includes(next.id));
      if(w && !orderedWelds.includes(w)) orderedWelds.push(w);
      if(i===0) walk(next.id);
      else branches.push(next.id);
    });
  }
  walk(startMat.id);
  /* walk branches */
  while(branches.length){
    const bid=branches.shift();
    walk(bid);
  }
  /* add any remaining welds not reached by the walk */
  pipeWelds.forEach(w=>{ if(!orderedWelds.includes(w)) orderedWelds.push(w); });
  /* assign sequential numbers */
  orderedWelds.forEach((w,i)=>{ w.weldNo=String(i+1); });
}

/* Auto-reorder material positions by walking the connection chain from start → end.
   Branch materials (connected to Tee etc.) are placed right after the junction piece,
   and "end of plumbing" pieces always come last on their branch. */
function reorderMaterialPositions(pipelineId){
  const mats=pipelineMaterials(pipelineId);
  if(mats.length<=1) return;
  const startMat=mats.find(m=>m.startOfPlumbing);
  if(!startMat) return;
  const visited=new Set();
  const ordered=[];
  function walk(mat){
    if(!mat || visited.has(mat.id)) return;
    visited.add(mat.id);
    ordered.push(mat);
    const conns=(mat.connections||[]).map(getMaterial).filter(c=>c&&!visited.has(c.id));
    /* sort: non-end pieces first, end pieces last */
    conns.sort((a,b)=>(a.endOfPlumbing?1:0)-(b.endOfPlumbing?1:0));
    conns.forEach(c=>walk(c));
  }
  walk(startMat);
  /* add any unvisited materials at the end */
  mats.filter(m=>!visited.has(m.id)).forEach(m=>ordered.push(m));
  /* reassign positions */
  ordered.forEach((m,i)=>{ m.position=i+1; });
}

/* ================================================================ SHARED CHROME (topbar + nav + modals) ================================================================ */
const NAV_ICONS = {
  home:'<path d="M3 10.5 12 3l9 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M5 9.5V20h14V9.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  clients:'<circle cx="12" cy="8" r="3.2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5 20c0-3.3 3.1-6 7-6s7 2.7 7 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
  projects:'<rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M8 9h8M8 13h8M8 17h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  pipelines:'<path d="M4 8h9a3 3 0 0 1 3 3v0a3 3 0 0 0 3 3h1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><circle cx="4" cy="8" r="1.6" fill="currentColor"/><circle cx="20" cy="14" r="1.6" fill="currentColor"/>',
  waz:'<path d="M6 3h8l4 4v14H6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/><path d="M14 3v4h4" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/><path d="M9 13h6M9 16h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  materials:'<path d="M12 3 3 7.5 12 12l9-4.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><path d="M3 12l9 4.5L21 12M3 16.5 12 21l9-4.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>',
  welders:'<circle cx="12" cy="7" r="3" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M6 20c0-3 2.7-5.5 6-5.5s6 2.5 6 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="m17 4 2 2-1 1-2-2z" fill="currentColor"/>'
};
function icon(key){ return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${NAV_ICONS[key]||''}</svg>`; }
function updateSidebarBadges(counts){
  if(!counts) return;
  const map={ 'index.html':counts.clients, 'projects.html':counts.projects, 'pipelines.html':counts.pipelines, 'welders.html':counts.welders, 'materials.html':counts.materials };
  Object.entries(map).forEach(([href,count])=>{
    if(count!==undefined && count!==''){
      const el=document.querySelector(`.nav-tab[href^="${href}"] .nav-count`);
      if(el) el.textContent=count;
    }
  });
}

function renderChrome(activeNav, breadcrumbHtml){
  const cachedCounts = getCached('counts') || {};
  const counts = {
    clients: clients().length || cachedCounts.clients || '',
    projects: projects().length || cachedCounts.projects || '',
    pipelines: pipelines().length || cachedCounts.pipelines || '',
    welders: people().length || cachedCounts.welders || '',
    materials: DB.globalMaterialCount || materials().length || cachedCounts.materials || '',
    waz: uniqueWaz().length || ''
  };

  // If counts are missing in cache, fetch lightweight /api/counts in background (takes ~20ms)
  if(cachedCounts.clients===undefined && !clients().length){
    apiGet('/counts').then(cnt=>{
      setCached('counts', cnt, 60000);
      updateSidebarBadges(cnt);
    }).catch(()=>{});
  }
  const nav=(key,label,href,showCount)=>`<a class="nav-tab ${activeNav===key?'active':''}" href="${href}"><span class="nav-icon">${icon(key)}</span><span class="nav-label">${label}</span>${showCount?`<span class="nav-count">${counts[key]}</span>`:''}</a>`;
  const role=getRole();
  const lang=typeof getLang==='function'?getLang():'de';
  const roleName = role==='vendor' ? escapeHtml((getPerson(getCurrentUserId())||{}).name||'Vendor') : (typeof t==='function'?t('office_staff','Office staff'):'Office staff');
  function getUserName(auth, fallback){
    if(auth && auth.name && auth.name.trim()) return auth.name.trim();
    if(auth && auth.email){
      const local = auth.email.split('@')[0];
      return local.replace(/[._-]/g, ' ').replace(/\b\w/g, c=>c.toUpperCase());
    }
    return fallback;
  }
  const cachedAuth = getCached('auth_user') || {};
  let userDisplay = getUserName(cachedAuth, roleName);

  // Check auth session in background if not cached
  if(!cachedAuth.name && !cachedAuth.email){
    fetch('/auth/me').then(r=>r.ok?r.json():null).then(u=>{
      if(u && u.logged_in){
        setCached('auth_user', u, 3600000);
        const nameEl = document.getElementById('topbar-username');
        if(nameEl) nameEl.textContent = getUserName(u, roleName);
      }
    }).catch(()=>{});
  }

  const activeClient = PAGE.clientId ? String(PAGE.clientId) : getSharedClientFilter();
  const activeProject = PAGE.projectId ? String(PAGE.projectId) : getSharedProjectFilter();

  document.getElementById('chrome').innerHTML = `
    <div class="accent-bar"></div>
    <header class="topbar">
      <a class="brand" href="home.html">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4H10V14C10 17.3137 12.6863 20 16 20H20" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="4" cy="4" r="1.7" fill="currentColor"/><circle cx="20" cy="20" r="1.7" fill="currentColor"/></svg>
        <span class="brand-text"><span class="brand-name">WELDDOC</span><span class="brand-tagline" data-i18n="brand_tagline">${t('brand_tagline','Pharma Piping Documentation')}</span></span>
      </a>
      <div class="topbar-divider"></div>
      <div class="breadcrumb">${breadcrumbHtml||''}</div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:12px;">
        <div class="lang-toggle" style="display:inline-flex;border:1px solid rgba(255,255,255,0.25);border-radius:4px;overflow:hidden;font-size:0.8rem;font-weight:600;">
          <button onclick="setLang('de')" style="padding:4px 10px;border:none;background:${lang==='de'?'var(--copper, #d97706)':'transparent'};color:${lang==='de'?'#fff':'#ccc'};cursor:pointer;">DE</button>
          <button onclick="setLang('en')" style="padding:4px 10px;border:none;background:${lang==='en'?'var(--copper, #d97706)':'transparent'};color:${lang==='en'?'#fff':'#ccc'};cursor:pointer;">EN</button>
        </div>
        <div class="topbar-user-badge" style="display:inline-flex;align-items:center;gap:7px;padding:4px 12px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);border-radius:20px;color:#f3f4f6;font-size:0.82rem;font-weight:500;">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,0.14);color:#fff;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </span>
          <span id="topbar-username">${escapeHtml(userDisplay)}</span>
        </div>
      </div>
    </header>
    <nav class="sidebar">
      <div class="nav-section-label" data-i18n="nav_workspace">${t('nav_workspace','Workspace')}</div>
      ${nav('home',t('nav_home','Home'),'home.html',false)}
      ${nav('clients',t('clients','Clients'),'index.html',true)}
      ${nav('projects',t('projects','Projects'),'projects.html'+(activeClient?'?client='+activeClient:''),true)}
      ${nav('pipelines',t('pipelines','Pipelines'),'pipelines.html'+(activeProject?'?project='+activeProject:(activeClient?'?client='+activeClient:'')),true)}
      <div class="nav-section-label" data-i18n="nav_documents">${t('nav_documents','Documents')}</div>
      ${nav('materials',t('nav_materials','Materials'),'materials.html',true)}
      ${nav('welders',t('welders','Welders'),'welders.html',true)}
      <div class="sidebar-role">
        <div class="role-line"><span data-i18n="signed_in_as">${t('signed_in_as','Signed in as')}</span><br><strong>${roleName}</strong></div>
        <a href="role.html" data-i18n="switch_role">${t('switch_role','Switch role')}</a>
      </div>
    </nav>`;
}

/* All modals live in one template, injected into #modal-root on every page. */
function mountModals(){
  document.getElementById('modal-root').innerHTML = `
  <div class="modal-overlay" id="modal-client"><div class="modal">
    <button class="modal-close" onclick="closeModal('modal-client')">&times;</button><h2 id="modal-client-title" data-i18n="new_client">New client</h2>
    <form id="client-form"><div class="form-grid">
      <label class="field wide"><span class="lbl" data-i18n="client_name">Client name <span class="req">*</span></span><input type="text" id="input-name" required></label>
      <label class="field wide"><span class="lbl" data-i18n="street">Street <span class="req">*</span></span><input type="text" id="input-street" required></label>
      <label class="field"><span class="lbl" data-i18n="zip_code">Zip Code <span class="req">*</span></span><input type="text" id="input-zip" required></label>
      <label class="field"><span class="lbl" data-i18n="location">Location <span class="req">*</span></span><input type="text" id="input-place" required></label>
      <label class="field wide"><span class="lbl" data-i18n="remarks">Remarks</span><textarea id="input-remarks"></textarea></label>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-client')" data-i18n="cancel">Cancel</button><button type="submit" class="btn btn-primary" data-i18n="save_client">Save client</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-project"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-project')">&times;</button><h2 id="modal-project-title" data-i18n="new_project">New project</h2>
    <form id="project-form"><div class="form-grid">
      <label class="field"><span class="lbl" data-i18n="ist_project_no">IST Project number <span class="req">*</span></span><input type="text" id="input-project-istno" placeholder="e.g. 926xxxx" data-i18n-placeholder="ist_project_no_placeholder" required></label>
      <div class="field"><span class="lbl" data-i18n="client">Client <span class="req">*</span></span><select id="input-project-client" required></select><input type="text" id="input-project-client-readonly" disabled style="display:none"></div>
      <label class="field"><span class="lbl" data-i18n="project_title">Project title <span class="req">*</span></span><input type="text" id="input-project-title" required></label>
      <div class="field"><span class="lbl" data-i18n="location">Location</span><select id="input-project-location" onchange="toggleSelectOther('input-project-location','input-project-location-new')"></select><input type="text" id="input-project-location-new" class="select-other-text" style="display:none" placeholder="Type new location…" data-i18n-placeholder="type_new_location"></div>
      <label class="field"><span class="lbl" data-i18n="order_number">Order number</span><input type="text" id="input-project-order"></label>
      <div class="field"><span class="lbl" data-i18n="sharepoint_folder">SharePoint folder <span class="req">*</span></span><div id="input-project-sp-folder"><button type="button" class="btn btn-ghost btn-sm" onclick="pickProjectFolder()" data-i18n="select_folder">Select folder</button></div></div>
      <label class="field wide"><span class="lbl" data-i18n="description">Description</span><textarea id="input-project-description"></textarea></label>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-project')" data-i18n="cancel">Cancel</button><button type="submit" class="btn btn-primary" data-i18n="save_project">Save project</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-pipeline"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-pipeline')">&times;</button><h2 id="modal-pipeline-title" data-i18n="new_pipeline">New pipeline</h2>
    <form id="pipeline-form"><div class="form-grid">
      <label class="field wide"><span class="lbl" data-i18n="pipeline_number">Pipeline number <span class="req">*</span></span><input type="text" id="input-pl-no" required></label>
      <label class="field"><span class="lbl" data-i18n="project">Project <span class="req">*</span></span><select id="input-pl-project" onchange="onPipelineProjectChange()" required></select></label>
      <label class="field"><span class="lbl" data-i18n="order_no_from_project">Order number (from project)</span><input type="text" id="input-pl-order" disabled></label>
      <label class="field"><span class="lbl" data-i18n="plant">Plant</span><input type="text" id="input-pl-plant"></label>
      <label class="field"><span class="lbl" data-i18n="status">Status</span><select id="input-pl-status"></select></label>
      <div class="modal-note" data-i18n="order_inherited_note">Order number is inherited from the project.</div>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-pipeline')" data-i18n="cancel">Cancel</button><button type="submit" class="btn btn-primary" data-i18n="save_pipeline">Save pipeline</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-export-final"><div class="modal" style="max-width:440px;">
    <button class="modal-close" onclick="closeModal('modal-export-final')">&times;</button>
    <h2 data-i18n="export_final_doc">Export final document</h2>
    <p style="font-size:0.86rem;color:var(--text-muted);margin:0 0 16px;" data-i18n="export_final_modal_sub">Choose which signatures should be included in the exported PDF.</p>
    <form id="export-final-form">
      <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:20px;padding:12px;background:#F8FAFC;border:1px solid var(--border);border-radius:6px;">
        <label style="display:flex;align-items:center;gap:10px;font-size:0.9rem;cursor:pointer;">
          <input type="checkbox" id="input-exp-welder-sign" checked style="width:16px;height:16px;accent-color:var(--copper,#C85A17);cursor:pointer;">
          <span data-i18n="include_welder_signature">Include welder signature in PDF</span>
        </label>
        <label style="display:flex;align-items:center;gap:10px;font-size:0.9rem;cursor:pointer;">
          <input type="checkbox" id="input-exp-inspector-sign" checked style="width:16px;height:16px;accent-color:var(--copper,#C85A17);cursor:pointer;">
          <span data-i18n="include_inspector_signature">Include inspector signature in PDF</span>
        </label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal('modal-export-final')" data-i18n="cancel">Cancel</button>
        <button type="submit" class="btn btn-success" data-i18n="export_pdf">Export PDF</button>
      </div>
    </form>
  </div></div>

  <div class="modal-overlay" id="modal-welder"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-welder')">&times;</button><h2 id="modal-welder-title" data-i18n="new_welder">New welder</h2>
    <form id="welder-form" onsubmit="submitWelderModal(event); return false;" novalidate><div class="form-grid">
      <label class="field"><span class="lbl" data-i18n="welder_name">Welder name <span class="req">*</span></span><input type="text" id="input-w-name" required></label>
      <label class="field"><span class="lbl" data-i18n="welder_no">Welder number <span class="req">*</span></span><input type="text" id="input-w-no" required></label>
      <div class="field wide">
        <span class="lbl" data-i18n="upload_signature">Signature (→ SharePoint)</span>
        <div class="field-hint" style="margin-bottom:8px;" data-i18n="signature_hint">PNG format with a transparent or white background. The width must be three times the height (recommended 300 × 100 px, maximum 1500 × 500 px).</div>
        <div id="w-signature-current" style="margin-bottom:6px;"></div>
        <div id="input-w-signature-wrap">
          <input type="file" id="input-w-signature" accept="image/png,.png" onchange="onWelderSignatureChange(event)">
        </div>
        <div id="w-signature-preview-wrap" style="display:none;margin-top:8px;padding:10px;background:#F8FAFC;border:1px solid var(--border);border-radius:4px;">
          <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
            <div style="background:#fff;border:1px dashed #CBD5E1;border-radius:4px;padding:6px;display:inline-flex;align-items:center;justify-content:center;min-width:140px;min-height:48px;">
              <img id="w-signature-preview-img" style="max-height:55px;max-width:180px;object-fit:contain;" alt="Signature preview">
            </div>
            <div style="display:flex;gap:8px;align-items:center;font-size:0.8rem;color:var(--text-muted);">
              <span data-i18n="signature_resolution">Resolution:</span>
              <span id="w-signature-res-text" class="col-mono" style="font-weight:600;color:var(--text);">—</span>
            </div>
            <button type="button" class="btn-link" onclick="removeWelderSignature()" style="color:var(--danger);" data-i18n="remove_signature">Remove signature</button>
          </div>
        </div>
      </div>
      <div class="field wide" id="w-cert-section" style="display:none;">
        <div id="w-cert-rows"></div>
        <button type="button" class="inline-add-toggle" onclick="addWelderCertRow()" data-i18n="add_another_certificate">+ Add another certificate</button>
      </div>
      <button type="button" class="inline-add-toggle" id="w-cert-add-btn" onclick="showWelderCertSection()" style="text-align:left;grid-column:1/-1;" data-i18n="add_certificate">+ Add certificate</button>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-welder')" data-i18n="cancel">Cancel</button><button type="button" id="welder-submit-btn" class="btn btn-primary" onclick="submitWelderModal(event)" data-i18n="save_welder">Save welder</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-weld"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-weld')">&times;</button><h2 id="modal-weld-title" data-i18n="new_weld">New weld</h2>
    <form id="weld-form"><div class="form-grid">
      <label class="field"><span class="lbl" data-i18n="weld_no">Weld number <span class="req">*</span></span><input type="text" id="input-weld-no" required></label>
      <label class="field"><span class="lbl" data-i18n="date_of_welding">Date of welding</span><input type="date" id="input-weld-date"></label>
      <div class="field wide"><span class="lbl" data-i18n="between_joined_materials">Between (joined materials)</span><div class="checklist" id="input-weld-materials"></div>
        <button type="button" class="inline-add-toggle" onclick="openMaterialModal(null,true)" data-i18n="add_new_item">+ Add new item</button>
        <div class="field-hint" data-i18n="select_joined_materials_hint">Select the materials this seam joins.</div></div>
      <div class="field"><span class="lbl" data-i18n="weld_type">Type</span><select id="input-weld-type" onchange="onWeldTypeChange()"><option value="">—</option><option value="O">O — Orbital</option><option value="H">H — Hand / semi-auto</option><option value="M">M — Manual</option></select></div>
      <div class="field"><span class="lbl" data-i18n="procedure">Procedure</span><input type="text" id="input-weld-proc" readonly></div>
      <label class="field"><span class="lbl" data-i18n="visual_result">Visual result</span><select id="input-weld-visual"><option>OK</option><option>Not OK</option><option>n/a</option></select></label>
      <label class="field"><span class="lbl" data-i18n="endoscopy_result">Endoscopy result</span><select id="input-weld-endoscopy"><option>OK</option><option>Not OK</option><option>n/a</option></select></label>
      <div class="field"><span class="lbl" data-i18n="endoscopy_video">Endoscopy video (→ SharePoint)</span><div id="weld-video-current"></div><input type="file" id="input-weld-photo" accept="video/*"></div>
      <div class="field"><span class="lbl" data-i18n="endoscopy_image">Endoscopy image (→ SharePoint)</span><div id="weld-image-current"></div><input type="file" id="input-weld-endoscopy-img" accept="image/*"></div>
      <label class="field wide"><span class="lbl" data-i18n="remarks">Remarks</span><textarea id="input-weld-remarks" placeholder="Shown when the Remarks cell is clicked" data-i18n-placeholder="remarks_placeholder"></textarea></label>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-weld')" data-i18n="cancel">Cancel</button><button type="submit" class="btn btn-primary" data-i18n="save_weld">Save weld</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-material"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-material')">&times;</button><h2 id="modal-material-title" data-i18n="new_material">New material</h2>
    <form id="material-form"><div class="form-grid">
      <label class="field"><span class="lbl" data-i18n="position">Position</span><input type="text" id="input-mat-position" disabled></label>
      <div class="field"><span class="lbl" data-i18n="category">Category <span class="req">*</span></span><select id="input-mat-piece" onchange="onCategoryChange()"></select><input type="text" id="input-mat-piece-new" class="select-other-text" style="display:none" placeholder="Type category…" data-i18n-placeholder="type_category"></div>
      <div class="field wide"><span class="lbl" data-i18n="item_description">Item description</span><select id="input-mat-desc" onchange="onItemDescChange()"></select><input type="text" id="input-mat-desc-new" class="select-other-text" style="display:none" placeholder="Type description…" data-i18n-placeholder="type_description"></div>
      <div id="dn-fields-container"><div class="field" id="dn1-field"><span class="lbl" id="dn1-label">DN</span><select id="input-mat-dimension" onchange="onDnChange()"></select><input type="text" id="input-mat-dimension-new" class="select-other-text" style="display:none" placeholder="Type DN…" data-i18n-placeholder="type_dn"></div></div>
      <div class="field"><span class="lbl" data-i18n="din_en_number">DIN EN Number <span class="req">*</span></span><select id="input-mat-dien" onchange="onDienChange()"></select><input type="text" id="input-mat-dien-new" class="select-other-text" style="display:none" placeholder="Type DIN EN…" data-i18n-placeholder="type_din_en"></div>
      <div class="field"><span class="lbl" data-i18n="material_code">Material code <span class="req">*</span></span><select id="input-mat-code" onchange="onMatCodeChange()"></select><input type="text" id="input-mat-code-new" class="select-other-text" style="display:none" placeholder="Type material code…" data-i18n-placeholder="type_material_code"></div>
      <div class="field" id="diameter-field"><span class="lbl" data-i18n="outer_diameter">Outer diameter <span class="req">*</span></span><select id="input-mat-diameter" onchange="onDiameterChange()"></select><input type="text" id="input-mat-diameter-new" class="select-other-text" style="display:none" placeholder="Type diameter…" data-i18n-placeholder="type_diameter"></div>
      <div class="field" id="thickness-field"><span class="lbl" data-i18n="thickness">Thickness <span class="req">*</span></span><select id="input-mat-thickness" onchange="toggleSelectOther('input-mat-thickness','input-mat-thickness-new')"></select><input type="text" id="input-mat-thickness-new" class="select-other-text" style="display:none" placeholder="Type thickness…" data-i18n-placeholder="type_thickness"></div>
      <div class="field"><span class="lbl" data-i18n="surface">Surface</span><select id="input-mat-surface" onchange="toggleSelectOther('input-mat-surface','input-mat-surface-new')"></select><input type="text" id="input-mat-surface-new" class="select-other-text" style="display:none" placeholder="Type surface…" data-i18n-placeholder="type_surface"></div>
      <div class="field wide"><div class="check-row">
        <label><input type="checkbox" id="input-mat-start" onchange="onStartEndChange()"> <span data-i18n="start_of_plumbing">Start of plumbing</span></label>
        <label><input type="checkbox" id="input-mat-end" onchange="onStartEndChange()"> <span data-i18n="end_of_plumbing">End of plumbing</span></label>
      </div></div>
      <div class="field wide"><span class="lbl" data-i18n="connections">Connections (other materials this joins to)</span>
        <div id="conn-rows"></div>
        <button type="button" class="inline-add-toggle" onclick="addConnRow()" data-i18n="add_connection">+ Add connection</button>
        <div class="field-hint" id="conn-hint"></div>
      </div>
      <div class="modal-err" id="material-err"></div>
      <div class="modal-note" data-i18n="connections_from_weld_note">You can also add or edit connections from the weld list.</div>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-material')" data-i18n="cancel">Cancel</button><button type="submit" id="material-submit-btn" class="btn btn-primary" data-i18n="save_material">Save material</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-renew"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-renew')">&times;</button><h2 data-i18n="renew_cert_title">Renew certificate</h2>
    <p id="renew-text"></p>
    <div class="field" style="margin-bottom:12px;"><span class="lbl" data-i18n="wps_no">WPS No. <span class="req">*</span></span>
      <select id="renew-wps-sel" onchange="onRenewWpsChange()"></select>
      <input type="text" id="renew-wps-new" class="select-other-text" style="display:none;margin-top:4px;" placeholder="e.g. SP2/VP14" data-i18n-placeholder="wps_no_placeholder" oninput="onRenewWpsNewInput()">
    </div>
    <div class="field" style="margin-bottom:12px;"><span class="lbl" data-i18n="qualified_processes">Qualified processes <span class="req">*</span></span>
      <div id="renew-procs-wrap"><input type="text" id="renew-procs" placeholder="e.g. 141 / 142"></div>
    </div>
    <label class="field" style="margin-bottom:12px;"><span class="lbl" data-i18n="new_valid_until">New valid until <span class="req">*</span></span><input type="date" id="renew-valid" required></label>
    <label class="field" style="margin-bottom:12px;"><span class="lbl" data-i18n="next_renewal_due">Next renewal due <span class="req">*</span></span><input type="date" id="renew-renewal" required></label>
    <label class="field"><span class="lbl" data-i18n="renewal_attachment">Renewal attachment (→ SharePoint) <span class="req">*</span></span><input type="file" id="renew-file" accept="application/pdf"></label>
    <div class="field-hint" data-i18n="renew_cert_hint">The uploaded PDF is stored in SharePoint; all fields are required.</div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-renew')" data-i18n="cancel">Cancel</button><button id="renew-confirm-btn" class="btn btn-primary" onclick="confirmRenew()" data-i18n="confirm_renewal">Confirm renewal</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-people"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-people')">&times;</button><h2 id="people-title" data-i18n="assigned">Assigned</h2>
    <div id="people-body"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-people')" data-i18n="close">Close</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-remarks"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-remarks')">&times;</button><h2 data-i18n="remarks">Remarks</h2>
    <p id="remarks-body"></p>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-remarks')" data-i18n="close">Close</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-image"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-image')">&times;</button><h2 id="image-title" data-i18n="preview">Preview</h2>
    <div class="img-placeholder" id="image-placeholder"></div><div class="field-hint" id="image-link"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-image')" data-i18n="close">Close</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-archive"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-archive')">&times;</button><h2 id="modal-archive-title" data-i18n="archive_title">Archive?</h2>
    <p id="archive-confirm-text"></p>
    <div class="modal-actions"><button class="btn btn-ghost" id="archive-cancel-btn" onclick="closeModal('modal-archive')" data-i18n="cancel">Cancel</button><button class="btn btn-primary" id="archive-confirm-btn" onclick="confirmArchive()" data-i18n="archive">Archive</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-welding"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-welding')">&times;</button><h2 data-i18n="welding_completion_title">Welding completion</h2>
    <p class="field-hint" style="margin-bottom:16px;" data-i18n="welding_completion_hint">After the welder document is downloaded, welding is carried out on site. Record the start and completion dates below.</p>
    <div class="form-grid">
      <label class="field"><span class="lbl" data-i18n="welding_start_date">Welding start date</span><input type="date" id="input-wd-start"></label>
      <label class="field"><span class="lbl" data-i18n="welding_completion_date">Welding completion date</span><input type="date" id="input-wd-end"></label>
      <label class="field wide"><span class="lbl" data-i18n="remarks">Remarks</span><textarea id="input-wd-remarks" placeholder="Notes about the welding work…" data-i18n-placeholder="notes_about_welding_work"></textarea></label>
      <div class="modal-note" data-i18n="welding_completion_note">Confirming saves the dates and updates the pipeline status.</div>
    </div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-welding')" data-i18n="cancel">Cancel</button><button class="btn btn-success" onclick="confirmWeldingUpdate()" data-i18n="save_welding_details">Save welding details</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-waz-add"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-waz-add')">&times;</button><h2 id="modal-waz-title" data-i18n="add_waz_doc">Add WAZ document</h2>
    <div class="form-grid">
      <div class="field"><span class="lbl" data-i18n="waz_no">WAZ No.</span><select id="input-waz-no" onchange="onWazNoChange()"></select></div>
      <div class="field"><span class="lbl" data-i18n="cert_no">Certificate No.</span><input type="text" id="input-waz-cert-edit" placeholder="Type certificate No.…" data-i18n-placeholder="type_cert_no"></div>
      <div class="field"><span class="lbl" data-i18n="heat_melt_no">Heat / melt No.</span><input type="text" id="input-waz-heat-edit" placeholder="Type heat/melt No.…" data-i18n-placeholder="type_heat_no"></div>
      <div class="modal-note" id="waz-shared-warning" style="display:none;color:var(--copper);grid-column:1/-1;" data-i18n="waz_shared_warning">⚠ Any changes here will apply to every combination of heat number and certificate number under this project.</div>
      <div class="field wide"><span class="lbl"><span data-i18n="waz_doc_sp">WAZ document (→ SharePoint)</span> *</span>
        <div id="waz-current-doc"></div>
        <input type="file" id="input-waz-file" accept="application/pdf">
      </div>
      <div class="modal-err" id="waz-err"></div>
    </div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-waz-add')" data-i18n="cancel">Cancel</button><button id="waz-submit-btn" class="btn btn-primary" onclick="confirmAddWaz()" data-i18n="save_waz">Save WAZ</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-mat-props"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-mat-props')">&times;</button><h2 id="modal-mat-props-title" data-i18n="edit_material">Edit material</h2>
    <form id="mat-props-form"><div class="form-grid">
      <div class="field"><span class="lbl" data-i18n="category">Category</span><select id="mp-piece" onchange="onMpCategoryChange()"></select></div>
      <div class="field wide"><span class="lbl" data-i18n="item_description">Item description</span><select id="mp-desc" onchange="onMpDescChange()"></select><input type="text" id="mp-desc-new" class="select-other-text" style="display:none" placeholder="Type description…" data-i18n-placeholder="type_description"></div>
      <div id="mp-dn-container"><div class="field" id="mp-dn1-field"><span class="lbl" id="mp-dn1-label">DN</span><select id="mp-dimension" onchange="toggleSelectOther('mp-dimension','mp-dimension-new')"></select><input type="text" id="mp-dimension-new" class="select-other-text" style="display:none" placeholder="Type DN…" data-i18n-placeholder="type_dn"></div></div>
      <div class="field"><span class="lbl" data-i18n="din_en_number">DIN EN Number</span><select id="mp-dien" onchange="toggleSelectOther('mp-dien','mp-dien-new')"></select><input type="text" id="mp-dien-new" class="select-other-text" style="display:none" placeholder="Type DIN EN…" data-i18n-placeholder="type_din_en"></div>
      <div class="field"><span class="lbl" data-i18n="material_code">Material code</span><select id="mp-code" onchange="toggleSelectOther('mp-code','mp-code-new')"></select><input type="text" id="mp-code-new" class="select-other-text" style="display:none" placeholder="Type code…" data-i18n-placeholder="type_code"></div>
      <div class="field" id="mp-diameter-field"><span class="lbl" data-i18n="outer_diameter">Outer diameter</span><select id="mp-diameter" onchange="toggleSelectOther('mp-diameter','mp-diameter-new')"></select><input type="text" id="mp-diameter-new" class="select-other-text" style="display:none" placeholder="Type diameter…" data-i18n-placeholder="type_diameter"></div>
      <div class="field" id="mp-thickness-field"><span class="lbl" data-i18n="thickness">Thickness</span><select id="mp-thickness" onchange="toggleSelectOther('mp-thickness','mp-thickness-new')"></select><input type="text" id="mp-thickness-new" class="select-other-text" style="display:none" placeholder="Type thickness…" data-i18n-placeholder="type_thickness"></div>
      <div class="field"><span class="lbl" data-i18n="surface">Surface</span><select id="mp-surface" onchange="toggleSelectOther('mp-surface','mp-surface-new')"></select><input type="text" id="mp-surface-new" class="select-other-text" style="display:none" placeholder="Type surface…" data-i18n-placeholder="type_surface"></div>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-mat-props')" data-i18n="cancel">Cancel</button><button type="submit" class="btn btn-primary" data-i18n="save">Save</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-apply-all"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-apply-all')">&times;</button><h2 data-i18n="update_global_material">Update global material</h2>
    <p data-i18n="global_mat_update_warning">This material is used across <strong>all projects</strong>. Changing it here will update it everywhere.</p>
    <p><strong id="modal-apply-all-piece"></strong></p>
    <p data-i18n="confirm_proceed">Are you sure you want to proceed?</p>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="cancelGlobalEdit()" data-i18n="cancel">Cancel</button><button class="btn btn-primary" onclick="confirmGlobalEdit()" data-i18n="update_everywhere">Update everywhere</button></div>
  </div></div>`;
  if(typeof translatePage==='function') translatePage();
  attachFormHandlers();
}

/* generic modal open/close */
function openModal(id){ document.getElementById(id).classList.add('open'); document.body.style.overflow='hidden'; }
function closeModal(id){ document.getElementById(id).classList.remove('open'); document.body.style.overflow=document.querySelector('.modal-overlay.open')?'hidden':''; }
function modalHasData(overlay){
  /* Check if any form inside the modal has user-entered data */
  const form=overlay.querySelector('form');
  if(!form) return false;
  const inputs=form.querySelectorAll('input:not([type=hidden]):not([disabled]),textarea,select');
  for(const el of inputs){
    if(el.type==='file' && el.files&&el.files.length) return true;
    if(el.type==='checkbox' || el.type==='radio') continue;
    if(el.tagName==='SELECT' && el.selectedIndex>0) return true;
    if((el.type==='text'||el.type==='date'||el.type==='number'||el.tagName==='TEXTAREA') && el.value.trim()) return true;
  }
  return false;
}
function confirmModalClose(overlay){
  if(modalHasData(overlay)){
    if(!confirm('Discard current entries?')) return false;
  }
  overlay.classList.remove('open');
  document.body.style.overflow=document.querySelector('.modal-overlay.open')?'hidden':'';
  return true;
}
function wireModalDismiss(){
  document.querySelectorAll('.modal-overlay').forEach(ov=>ov.addEventListener('mousedown',e=>{
    if(e.target===ov) confirmModalClose(ov);
  }));
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      const openModals=[...document.querySelectorAll('.modal-overlay.open')];
      if(openModals.length){
        const top=openModals[openModals.length-1];
        confirmModalClose(top);
      }
    }
  });
}

function showImageRaw(title,url,extra){
  document.getElementById('image-title').textContent = title || t('preview', 'Preview');
  const ph = document.getElementById('image-placeholder');
  const linkDiv = document.getElementById('image-link');

  if(!url){
    ph.innerHTML = `<span class="muted">${t('no_file_uploaded', 'No file uploaded yet')}</span>`;
    linkDiv.innerHTML = '';
    openModal('modal-image');
    return;
  }

  // Display the actual uploaded image directly in the preview box (with cache busting)
  const previewSrc = url.includes('?') ? url : `${url}?_t=${Date.now()}`;
  ph.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;gap:10px;">
    <img src="${escapeHtml(previewSrc)}" style="max-width:100%;max-height:220px;object-fit:contain;background:#fff;padding:8px 14px;border-radius:6px;border:1px solid #CBD5E1;box-shadow:0 1px 3px rgba(0,0,0,0.06);" alt="Uploaded image" onerror="this.style.display='none';this.nextElementSibling.style.display='block';">
    <div style="display:none;color:var(--text-muted);font-size:0.82rem;text-align:center;">${t('preview_sharepoint', 'Preview (stored in SharePoint)')}</div>
  </div>`;

  let linkHtml = '';
  if(extra) linkHtml += `<div style="margin-bottom:6px;font-size:0.82rem;font-weight:500;color:var(--text-muted);text-align:center;">${escapeHtml(extra)}</div>`;
  linkHtml += `<div style="text-align:center;"><a href="${escapeHtml(previewSrc)}" target="_blank" rel="noopener" class="cell-link" style="font-size:0.78rem;">${t('open_in_sharepoint', 'Open in SharePoint')} ↗</a></div>`;
  linkDiv.innerHTML = linkHtml;
  openModal('modal-image');
}
function renderPeoplePopup(title, ids, pipeStatus){
  document.getElementById('people-title').textContent=title;
  document.getElementById('people-body').innerHTML=ids.map(id=>{ const p=getPerson(id); const cls=personNameClass(id,pipeStatus); return `<div class="profile-row"><a class="person-name ${cls}" href="welder-profile.html?id=${id}">${escapeHtml(p.name)}</a><span class="col-mono">No. ${escapeHtml(p.no)}</span></div>`; }).join('');
  openModal('modal-people');
}

/* ================================================================ FORM HANDLERS (attached after modals mount) ================================================================ */
let editingClientId=null, editingProjectId=null, editingPipelineId=null, editingWelderId=null, editingWeldId=null, editingMaterialId=null, renewingCertId=null, deleteContext=null;
let welderReturnToWeld=false, materialReturnToWeld=false;
/* Pre-fill values from previous material (used during cascading for new materials) */
let _prefillDn='', _prefillCode='', _prefillAllDns=[];

function attachFormHandlers(){
  /* Materials page simple edit form */
  const mpForm=document.getElementById('mat-props-form');
  if(mpForm) mpForm.addEventListener('submit', saveMaterialProps);
  document.getElementById('client-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const submitBtn=e.target.querySelector('[type="submit"]');
    if(submitBtn && submitBtn.disabled) return;
    setButtonLoading(submitBtn, true, t('saving', 'Saving…'));
    const data={ name:val('input-name'), street:val('input-street'), zipCode:val('input-zip'), location:val('input-place'), remarks:val('input-remarks') };
    if(editingClientId!==null) data.id=editingClientId;
    try {
      const saved = await apiPost('/clients', data);
      if(editingClientId!==null){ const idx=DB.clients.findIndex(c=>c.id===editingClientId); if(idx>=0) DB.clients[idx]=saved; }
      else DB.clients.push(saved);
      saveDB(); invalidateCache('counts'); closeModal('modal-client'); rerenderPage();
    } catch(e){ console.error('Save client failed:', e);
      if(editingClientId!==null) Object.assign(getClient(editingClientId),data); else DB.clients.push({id:nextId('client'),...data});
      saveDB(); invalidateCache('counts'); closeModal('modal-client'); rerenderPage();
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });
  document.getElementById('project-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const submitBtn=e.target.querySelector('[type="submit"]');
    if(submitBtn && submitBtn.disabled) return;
    /* Validate SharePoint folder */
    const spDiv=document.getElementById('input-project-sp-folder');
    const hasFolder=spDiv.querySelector('a[href]');
    if(!hasFolder && editingProjectId===null){
      spDiv.style.border='2px solid var(--danger)'; spDiv.style.borderRadius='4px'; spDiv.style.padding='4px';
      let errMsg=spDiv.querySelector('.sp-err'); if(!errMsg){ errMsg=document.createElement('div'); errMsg.className='sp-err'; errMsg.style.cssText='color:var(--danger);font-size:0.78rem;margin-top:4px;'; spDiv.appendChild(errMsg); }
      errMsg.textContent='Please select a SharePoint folder.';
      return;
    } else { spDiv.style.border=''; spDiv.style.padding=''; const errMsg=spDiv.querySelector('.sp-err'); if(errMsg) errMsg.remove(); }
    setButtonLoading(submitBtn, true, t('saving', 'Saving…'));
    const location=readSelectOther('input-project-location','input-project-location-new');
    const existingP = editingProjectId!==null?getProject(editingProjectId):null;
    const currentStatus = existingP ? computeProjectStatus(existingP) : 'not-started';
    const data={ clientId:Number(val('input-project-client')), title:val('input-project-title'), location, order:val('input-project-order')||'', istProjectNo:val('input-project-istno'), description:val('input-project-description'), status:currentStatus };
    if(editingProjectId!==null) data.id=editingProjectId;
    if(_pendingFolder){
      data.sharepointDriveId=_pendingFolder.sharepointDriveId;
      data.sharepointFolderId=_pendingFolder.sharepointFolderId;
      data.sharepointFolderUrl=_pendingFolder.sharepointFolderUrl;
    }
    try {
      const apiData={...data, orderNo:data.order};
      const saved = await apiPost('/projects', apiData);
      saved.order=saved.orderNo;
      if(editingProjectId!==null){ const idx=DB.projects.findIndex(p=>p.id===editingProjectId); if(idx>=0) DB.projects[idx]=saved; }
      else DB.projects.push(saved);
      _pendingFolder=null;
      saveDB(); invalidateCache('counts'); closeModal('modal-project'); rerenderPage();
    } catch(e){ console.error('Save project failed:', e);
      if(editingProjectId!==null) Object.assign(getProject(editingProjectId),data); else DB.projects.push({id:nextId('project'),...data});
      saveDB(); invalidateCache('counts'); closeModal('modal-project'); rerenderPage();
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });
  document.getElementById('pipeline-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const submitBtn=e.target.querySelector('[type="submit"]');
    if(submitBtn && submitBtn.disabled) return;
    setButtonLoading(submitBtn, true, t('saving', 'Saving…'));
    const statusVal = Number(val('input-pl-status')) || 0;
    const projectId=Number(val('input-pl-project')), no=val('input-pl-no');
    const data={ no, projectId, plant:val('input-pl-plant'), status: statusVal };
    if(editingPipelineId!==null) data.id=editingPipelineId;
    try {
      const saved = await apiPost('/pipelines', data);
      if(editingPipelineId!==null){ const idx=DB.pipelines.findIndex(p=>p.id===editingPipelineId); if(idx>=0) DB.pipelines[idx]=saved; }
      else DB.pipelines.push(saved);
      saveDB(); invalidateCache('counts'); closeModal('modal-pipeline'); rerenderPage();
    } catch(e){ console.error('Save pipeline failed:', e);
      const fallback={ no, projectId, drawingNo:'', plant:val('input-pl-plant'), welderIds:[], inspectorIds:[], procNo:'', procName:'', status: statusVal };
      if(editingPipelineId!==null) Object.assign(getPipeline(editingPipelineId),fallback); else DB.pipelines.push({id:nextId('pipeline'),...fallback});
      saveDB(); invalidateCache('counts'); closeModal('modal-pipeline'); rerenderPage();
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });
  const welderForm = document.getElementById('welder-form');
  if(welderForm) welderForm.addEventListener('submit', submitWelderModal);
  document.getElementById('export-final-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    if(!_exportingPipelineId) return;
    const includeWelder = document.getElementById('input-exp-welder-sign')?.checked ?? true;
    const includeInspector = document.getElementById('input-exp-inspector-sign')?.checked ?? true;
    const pipeId = _exportingPipelineId;
    closeModal('modal-export-final');
    await exportFinalDoc(pipeId, includeWelder, includeInspector);
  });
  document.getElementById('weld-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const submitBtn=e.target.querySelector('[type="submit"]');
    if(submitBtn.disabled) return;
    submitBtn.disabled=true;
    setButtonLoading(submitBtn, true, t('saving', 'Saving…'));
    const proc=val('input-weld-proc');
    const existingWeld=editingWeldId!==null?getWeld(editingWeldId):null;
    const welderIdVal=existingWeld?existingWeld.welderId:null;
    const inspectorIdVal=existingWeld?existingWeld.inspectorId:null;
    const welderName=existingWeld?existingWeld.welder:'';
    const inspectorName=existingWeld?existingWeld.inspector:'';
    const data={ pipelineId:PAGE.pipelineId, weldNo:val('input-weld-no'), materialIds:getChecked('input-weld-materials'), type:val('input-weld-type'), procedure:proc, welderId:welderIdVal, inspectorId:inspectorIdVal, welder:welderName, inspector:inspectorName, date:val('input-weld-date')||'', visual:val('input-weld-visual'), endoscopy:val('input-weld-endoscopy'), remarks:val('input-weld-remarks') };
    try {
      const selMats=data.materialIds.map(id=>getMaterial(id)).filter(Boolean);
      const bA=selMats[0]?posLetter(selMats[0].position):'';
      const bB=selMats[1]?posLetter(selMats[1].position):'';
      const apiData={pipelineId:data.pipelineId, weldNo:data.weldNo, betweenA:bA, betweenB:bB, type:data.type, procedure:data.procedure, welderId:welderIdVal, inspectorId:inspectorIdVal, welder:welderName, inspector:inspectorName, date:data.date, remarks:data.remarks};
      if(existingWeld && existingWeld.weldingWire) apiData.weldingWire=existingWeld.weldingWire;
      if(editingWeldId!==null) apiData.id=editingWeldId;
      const savedWeld=await apiPost('/welds', apiData);
      /* Upload endo video/image to SharePoint */
      const videoFile=document.getElementById('input-weld-photo').files[0];
      const imageFile=document.getElementById('input-weld-endoscopy-img').files[0];
      if(videoFile||imageFile){
        setButtonLoading(submitBtn, true, 'Uploading to SharePoint…');
        const fd=new FormData();
        if(videoFile) fd.append('video', videoFile);
        if(imageFile) fd.append('image', imageFile);
        const uploadResp=await fetch(`${API_BASE}/welds/${savedWeld.id}/upload-files`,{method:'POST',body:fd});
        if(!uploadResp.ok) console.error('Weld file upload failed:', uploadResp.statusText);
      }
      /* Reload welds from server */
      const freshWelds=await apiGet('/welds?pipelineId='+PAGE.pipelineId);
      DB.welds=normalizeWelds(freshWelds);
      rebuildRelationships();
      closeModal('modal-weld'); rerenderPage();
    } catch(ex){ alert('Error saving weld: '+ex.message); }
    finally { setButtonLoading(submitBtn, false); }
  });
  document.getElementById('material-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const submitBtn=document.getElementById('material-submit-btn');
    if(submitBtn.disabled) return;
    submitBtn.disabled=true;
    const start=document.getElementById('input-mat-start').checked, end=document.getElementById('input-mat-end').checked;
    const conns=[...document.querySelectorAll('#conn-rows select')].map(s=>Number(s.value)).filter(Boolean);
    const uniqueConns=[...new Set(conns)];
    const otherExists = pipelineMaterials(PAGE.pipelineId).some(m=>m.id!==editingMaterialId);
    const err=document.getElementById('material-err');
    err.classList.remove('show');
    /* check for duplicate start */
    const existingStart=pipelineMaterials(PAGE.pipelineId).find(m=>m.startOfPlumbing&&m.id!==editingMaterialId);
    if(start && existingStart){
      err.textContent=`There is already a "Start of plumbing" (${posLetter(existingStart.position)} · ${existingStart.piece}). Only one start is allowed.`;
      err.classList.add('show'); submitBtn.disabled=false; return;
    }
    /* validate required fields */
    const piece=readSelectOther('input-mat-piece','input-mat-piece-new');
    const itemDesc=readSelectOther('input-mat-desc','input-mat-desc-new');
    const isWire=(piece||'').toLowerCase()==='welding wire';
    const dimension=readSelectOther('input-mat-dimension','input-mat-dimension-new');
    const dnCount=requiredDns(piece);
    /* read all extra DN values dynamically */
    const extraDns=[];
    for(let i=2;i<=dnCount;i++){
      const sel=document.getElementById(`input-mat-dimension${i}`);
      const txt=document.getElementById(`input-mat-dimension${i}-new`);
      if(sel&&txt) extraDns.push(readSelectOther(`input-mat-dimension${i}`,`input-mat-dimension${i}-new`));
      else extraDns.push('');
    }
    const dienNo=readSelectOther('input-mat-dien','input-mat-dien-new');
    const matCode=readSelectOther('input-mat-code','input-mat-code-new');
    const diameter=hasDiameter(piece)?readSelectOther('input-mat-diameter','input-mat-diameter-new'):'';
    const thickness=hasThickness(piece)?readSelectOther('input-mat-thickness','input-mat-thickness-new'):'';
    const surface=readSelectOther('input-mat-surface','input-mat-surface-new');
    if(!piece){ err.textContent=t('category_required','Category is required.'); err.classList.add('show'); submitBtn.disabled=false; return; }
    if(!isWire && dnCount>0){
      if(!dimension){ err.textContent=t('dn_required','DN is required.'); err.classList.add('show'); submitBtn.disabled=false; return; }
      for(let i=0;i<extraDns.length;i++){
        if(!extraDns[i]){ err.textContent=t('dn_x_required','DN '+Math.toString(i+2)+' is required.'); err.classList.add('show'); submitBtn.disabled=false; return; }
      }
      if(!dienNo){ err.textContent=t('din_en_required','DIN EN Number is required.'); err.classList.add('show'); submitBtn.disabled=false; return; }
    }
    if(hasThickness(piece) && !isWire && !thickness){ err.textContent=t('thickness_required','Thickness is required.'); err.classList.add('show'); submitBtn.disabled=false; return; }
    if(!matCode){ err.textContent=t('material_code_required','Material code is required.'); err.classList.add('show'); submitBtn.disabled=false; return; }
    if(hasDiameter(piece) && !diameter){ err.textContent=t('diameter_required','Outer diameter is required.'); err.classList.add('show'); submitBtn.disabled=false; return; }
    setButtonLoading(submitBtn, true, t('saving', 'Saving…'));
    /* store up to 6 DNs as dimension, dimension2..dimension6 */
    const existingMat=editingMaterialId!==null?getMaterial(editingMaterialId):null;
    const posVal=val('input-mat-position'); const posNum=Number(posVal)||(posVal&&posVal.charCodeAt(0)>=65&&posVal.charCodeAt(0)<=90?posVal.charCodeAt(0)-64:pipelineMaterials(PAGE.pipelineId).length+1);
    const data={ pipelineId:PAGE.pipelineId, position:posNum,
      piece, dimension, materialCode:matCode, itemDescription:itemDesc||piece,
      diameter, thickness, dienNo, surface,
      certificate:existingMat?existingMat.certificate:'', heatNo:existingMat?existingMat.heatNo:'',
      wazNo:existingMat?existingMat.wazNo:'', wazPdfUrl:existingMat?existingMat.wazPdfUrl:'',
      connections:uniqueConns, startOfPlumbing:start, endOfPlumbing:end };
    for(let i=0;i<extraDns.length;i++) data[`dimension${i+2}`]=extraDns[i]||'';
    /* clear unused dimension fields */
    for(let i=extraDns.length+2;i<=6;i++) data[`dimension${i}`]='';
    try {
      const posLtr=val('input-mat-position')||posLetter(data.position||1);
      const connPositions=(data.connections||[]).map(cid=>{
        const cm=getMaterial(cid); return cm?posLetter(cm.position):null;
      }).filter(Boolean);

      // Step 1: Create/find global material
      const gmData={category:data.piece, itemDescription:data.itemDescription, materialCode:data.materialCode, dn1:data.dimension, diameter:data.diameter, thickness:data.thickness, dienNo:data.dienNo, surface:data.surface||''};
      for(let i=2;i<=6;i++) if(data[`dimension${i}`]) gmData[`dn${i}`]=data[`dimension${i}`];
      const gmResult=await apiPost('/global-materials', gmData);

      // Step 2: Create/find project material
      const pmData={projectId:PAGE.projectId, globalMaterialId:gmResult.id, certificate:data.certificate||'', heatNo:data.heatNo||'', surface:data.surface||'', wazNo:data.wazNo||''};
      const pmResult=await apiPost('/project-materials', pmData);

      // Step 3: Create/edit pipeline material
      const plmData={pipelineId:data.pipelineId, projectMaterialId:pmResult.id, position:posLtr, startOfPlumbing:data.startOfPlumbing, endOfPlumbing:data.endOfPlumbing, connections:connPositions};
      if(editingMaterialId!==null) plmData.id=editingMaterialId;
      if(plmData.id){ await apiPost('/pipeline-materials/'+plmData.id, plmData); }
      else { await apiPost('/pipeline-materials', plmData); }

      /* Reload from server so DB.materials has real IDs and projectMaterials has newly created items */
      const freshPipeData = await apiGet('/pipeline-detail/'+PAGE.pipelineId);
      DB.materials=normalizeMaterials(freshPipeData.materials||[]);
      DB.welds=normalizeWelds(freshPipeData.welds||[]);
      if(freshPipeData.projectMaterials && Array.isArray(freshPipeData.projectMaterials)) DB.projectMaterials=freshPipeData.projectMaterials;
      rebuildRelationships();
      saveDB();
      closeModal('modal-material');
      if(materialReturnToWeld){ materialReturnToWeld=false; if(document.getElementById('modal-weld').classList.contains('open')) buildWeldMaterialChecklist(getChecked('input-weld-materials')); }
      rerenderPage();
    } catch(e){
      console.error('Save material API error:', e);
      alert('Error saving material: ' + e.message);
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });
}
function val(id){ return (document.getElementById(id).value||'').trim(); }

/* ================================================================ MODAL OPENERS ================================================================ */
function openClientModal(id=null){
  editingClientId=id; document.getElementById('client-form').reset();
  if(id!==null){ const c=getClient(id); document.getElementById('modal-client-title').textContent=t('edit_client','Edit client'); setV('input-name',c.name); setV('input-street',c.street); setV('input-zip',c.zipCode); setV('input-place',c.location); setV('input-remarks',c.remarks); }
  else document.getElementById('modal-client-title').textContent=t('new_client','New client');
  openModal('modal-client'); document.getElementById('input-name').focus();
}
function clientLocations(clientId){
  const cli=getClient(clientId);
  const locs=[];
  if(cli && cli.location) locs.push(cli.location);
  clientProjects(clientId).forEach(p=>{ if(p.location && !locs.includes(p.location)) locs.push(p.location); });
  return locs.sort();
}
function formatSpPath(url){
  if(!url) return '';
  try {
    const u = new URL(url);
    let path = decodeURIComponent(u.pathname);
    if(path.startsWith('/sites/')) path = path.substring(7);
    else if(path.startsWith('/')) path = path.substring(1);
    return '.../' + path;
  } catch(e){
    return '.../' + url;
  }
}
function renderSpFolderHtml(folderUrl){
  if(!folderUrl){
    return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;"><span class="muted" style="font-size:0.85rem;">${t('no_folder_selected','— No folder selected —')}</span><button type="button" class="btn btn-ghost btn-sm" onclick="pickProjectFolder()">${t('select_folder','Select')}</button></div>`;
  }
  const displayPath = formatSpPath(folderUrl);
  return `<div class="sp-folder-row">
    <a href="${escapeHtml(folderUrl)}" target="_blank" rel="noopener" class="sp-folder-path" title="${escapeHtml(folderUrl)}">
      <bdi>${escapeHtml(displayPath)}</bdi>
    </a>
    <button type="button" class="btn btn-ghost btn-sm" onclick="pickProjectFolder()">${t('change','Change')}</button>
  </div>`;
}
function openProjectModal(id=null){
  editingProjectId=id; document.getElementById('project-form').reset(); _pendingFolder=null;
  const cliSel=document.getElementById('input-project-client');
  const cliReadonly=document.getElementById('input-project-client-readonly');
  cliSel.innerHTML=clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if(id!==null){ const p=getProject(id); document.getElementById('modal-project-title').textContent=t('edit_project','Edit project');
    setV('input-project-client',String(p.clientId)); setV('input-project-title',p.title); setV('input-project-order',p.order||''); setV('input-project-istno',p.istProjectNo||''); setV('input-project-description',p.description);
    buildSelectOther('input-project-location','input-project-location-new',clientLocations(p.clientId),p.location);
    /* Show current SharePoint folder */
    const spDiv=document.getElementById('input-project-sp-folder');
    if(spDiv) spDiv.innerHTML = renderSpFolderHtml(p.sharepointFolderUrl || '');
    cliSel.style.display='none';
    const cli=getClient(p.clientId);
    if(cliReadonly){ cliReadonly.value=cli?cli.name:''; cliReadonly.style.display=''; }
  } else { document.getElementById('modal-project-title').textContent=t('new_project','New project');
    /* Reset SP folder for new project */
    const spDiv=document.getElementById('input-project-sp-folder');
    if(spDiv) spDiv.innerHTML = renderSpFolderHtml(_pendingFolder ? _pendingFolder.sharepointFolderUrl : '');
    const preClient=projectFilters.clientId?String(projectFilters.clientId):(PAGE.clientId?String(PAGE.clientId):'');
    if(preClient){
      setV('input-project-client',preClient);
      cliSel.style.display='none';
      const cli=getClient(Number(preClient));
      if(cliReadonly){ cliReadonly.value=cli?cli.name:''; cliReadonly.style.display=''; }
    } else { cliSel.style.display=''; if(cliReadonly) cliReadonly.style.display='none'; }
    const cid=Number(preClient); const locs=cid?clientLocations(cid):uniqueLocations();
    const prevLoc=cid?clientProjects(cid).map(p=>p.location).filter(Boolean).pop():'';
    buildSelectOther('input-project-location','input-project-location-new',locs,prevLoc||''); }
  openModal('modal-project'); document.getElementById('input-project-title').focus();
}
function onPipelineProjectChange(){ const pr=getProject(Number(val('input-pl-project'))); setV('input-pl-order',pr&&pr.order?pr.order:''); }
function openPipelineModal(id=null){
  editingPipelineId=id; document.getElementById('pipeline-form').reset();
  const projSel=document.getElementById('input-pl-project');
  projSel.innerHTML=projects().map(p=>`<option value="${p.id}">${escapeHtml(p.title)} — ${escapeHtml(getClientName(p.clientId))}</option>`).join('');
  const statusSel=document.getElementById('input-pl-status');
  if(statusSel){
    statusSel.innerHTML=_RAW_PIPE_STATUS.map((s, idx)=>`<option value="${idx}">${typeof t==='function'?t(`status_${idx}`, s):s}</option>`).join('');
  }
  if(id!==null){ const pl=getPipeline(id); document.getElementById('modal-pipeline-title').textContent=t('edit_pipeline','Edit pipeline');
    setV('input-pl-no',pl.no); setV('input-pl-project',String(pl.projectId)); setV('input-pl-plant',pl.plant);
    setV('input-pl-status', String(pl.status !== undefined && pl.status !== null ? pl.status : 0));
    projSel.disabled=true; projSel.style.display='none';
    const pr=getProject(pl.projectId);
    let readOnly=document.getElementById('input-pl-project-readonly');
    if(!readOnly){ readOnly=document.createElement('input'); readOnly.type='text'; readOnly.id='input-pl-project-readonly'; readOnly.disabled=true; projSel.parentElement.appendChild(readOnly); }
    readOnly.value=pr?`${pr.title} — ${getClientName(pr.clientId)}`:'';
    readOnly.style.display='';
  } else { document.getElementById('modal-pipeline-title').textContent=t('new_pipeline','New pipeline'); setV('input-pl-status','0');
    /* Pre-select and lock the project if we're on a project page or pipeline page */
    let lockedProjectId=null;
    if(PAGE.projectId) lockedProjectId=PAGE.projectId;
    else if(PAGE.pipelineId){ const curPl=getPipeline(PAGE.pipelineId); if(curPl) lockedProjectId=curPl.projectId; }
    else if(typeof pipeFilters!=='undefined' && pipeFilters.projectId) lockedProjectId=Number(pipeFilters.projectId);
    if(lockedProjectId){
      setV('input-pl-project',String(lockedProjectId));
      projSel.style.display='none';
      const pr=getProject(lockedProjectId);
      let readOnly=document.getElementById('input-pl-project-readonly');
      if(!readOnly){ readOnly=document.createElement('input'); readOnly.type='text'; readOnly.id='input-pl-project-readonly'; readOnly.disabled=true; projSel.parentElement.appendChild(readOnly); }
      readOnly.value=pr?`${pr.title} — ${getClientName(pr.clientId)}`:'';
      readOnly.style.display='';
    } else {
      projSel.style.display=''; projSel.disabled=false;
      const readOnly=document.getElementById('input-pl-project-readonly');
      if(readOnly) readOnly.style.display='none';
    }
  }
  onPipelineProjectChange(); openModal('modal-pipeline'); document.getElementById('input-pl-no').focus();
}
let _welderSignatureFile = null;
let _welderSignatureRemoved = false;

/* Signature spec — must stay in sync with SIG_* in app/routes/welders.py.
   The PDF prints the signature into a fixed 3:1 cell, so off-ratio images are
   rejected here (and again server-side) rather than being squashed. */
const SIG_SPEC = { aspect:3, tol:0.10, minW:300, minH:100, maxW:1500, maxH:500 };

function validateSignatureImage(w, h){
  const S = SIG_SPEC;
  if(!w || !h) return t('sig_err_unreadable','This file could not be read as an image.');
  if(w < S.minW || h < S.minH)
    return t('sig_err_small','Image is below the minimum size')
      + ` (${w} × ${h} px). ` + t('sig_err_min','The minimum is')
      + ` ${S.minW} × ${S.minH} px.`;
  if(w > S.maxW || h > S.maxH)
    return t('sig_err_large','Image exceeds the maximum size')
      + ` (${w} × ${h} px). ` + t('sig_err_max','The maximum is')
      + ` ${S.maxW} × ${S.maxH} px.`;
  const ratio = w / h, lo = S.aspect*(1-S.tol), hi = S.aspect*(1+S.tol);
  if(ratio < lo || ratio > hi)
    return t('sig_err_ratio','Incorrect proportions')
      + ` (${w} × ${h} px). `
      + t('sig_err_ratio_hint','The width must be three times the height: for this height the width should be')
      + ` ${Math.round(h*S.aspect)} px (${Math.round(h*lo)}–${Math.round(h*hi)} px `
      + t('sig_err_accepted','accepted') + `).`;
  return null;
}

function onWelderSignatureChange(e){
  const file = e.target.files[0];
  if(!file) return;
  const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
  if(!isPng){
    alert(t('sig_err_png','Signature must be a PNG file.'));
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const err = validateSignatureImage(img.naturalWidth, img.naturalHeight);
      if(err){
        alert(err);
        e.target.value = '';
        _welderSignatureFile = null;
        return;
      }
      _welderSignatureFile = file;
      _welderSignatureRemoved = false;
      document.getElementById('w-signature-preview-img').src = ev.target.result;
      document.getElementById('w-signature-res-text').textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
      document.getElementById('w-signature-preview-wrap').style.display = 'block';
      const wrap = document.getElementById('input-w-signature-wrap');
      if(wrap) wrap.style.display = 'none';
    };
    img.onerror = () => {
      alert(t('sig_err_unreadable','Could not read the image dimensions.'));
      e.target.value = '';
      _welderSignatureFile = null;
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function removeWelderSignature(){
  _welderSignatureFile = null;
  _welderSignatureRemoved = true;
  const inp = document.getElementById('input-w-signature');
  if(inp) inp.value = '';
  document.getElementById('w-signature-preview-wrap').style.display = 'none';
  document.getElementById('w-signature-current').innerHTML = '';
  const wrap = document.getElementById('input-w-signature-wrap');
  if(wrap) wrap.style.display = '';
}

function getDistinctWpsNos(){
  const list = DB.wpsProcesses || [];
  const set = new Set();
  const res = [];
  list.forEach(item => {
    const w = (item.wpsNo || '').trim();
    if(w && !set.has(w.toUpperCase())){
      set.add(w.toUpperCase());
      res.push(w);
    }
  });
  return res.sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
}

function getProcessesForWps(wpsNo){
  if(!wpsNo) return [];
  const list = DB.wpsProcesses || [];
  const clean = wpsNo.trim().toLowerCase();
  const matches = list.filter(item => (item.wpsNo || '').trim().toLowerCase() === clean);
  const procs = [];
  const set = new Set();
  matches.forEach(m => {
    const p = (m.process || '').trim();
    if(p && !set.has(p)){
      set.add(p);
      procs.push(p);
    }
    if(p && p.includes('/')){
      const parts = p.split('/').map(x => x.trim()).filter(Boolean);
      parts.forEach(part => {
        if(!set.has(part)){
          set.add(part);
          procs.push(part);
        }
      });
    }
  });
  return procs;
}

async function submitWelderModal(e){
  if(e) e.preventDefault();
  const submitBtn = document.getElementById('welder-submit-btn') || document.querySelector('#modal-welder [type="submit"]') || document.querySelector('#modal-welder .btn-primary');
  if(submitBtn && submitBtn.disabled) return;
  const name = val('input-w-name');
  const no = val('input-w-no');
  if(!name){
    alert(t('welder_name_required','Welder name is required.'));
    document.getElementById('input-w-name').focus();
    return;
  }
  if(!no){
    alert(t('welder_no_required','Welder number is required.'));
    document.getElementById('input-w-no').focus();
    return;
  }
  const certs = getWelderCertRows();
  if(certs._validationError){
    alert(certs._validationError);
    return;
  }
  if(editingWelderId === null && !certs.length){
    alert(t('at_least_one_cert_required','At least one certificate is required.'));
    return;
  }
  setButtonLoading(submitBtn, true, t('saving', 'Saving…'));
  const data = { name, no };
  try {
    const welderPayload = editingWelderId !== null ? {id: editingWelderId, ...data} : data;
    if(_welderSignatureRemoved) welderPayload.signatureUrl = '';
    const savedWelder = await apiPost('/welders', welderPayload);
    const personId = savedWelder.id;
    const uploadTasks = [];

    if(_welderSignatureFile){
      const sigData = new FormData();
      sigData.append('file', _welderSignatureFile);
      uploadTasks.push(
        fetch(`/api/welders/${personId}/upload-signature`, { method: 'POST', body: sigData })
          .then(async resp => {
            if(!resp.ok){
              const errData = await resp.json().catch(()=>({}));
              console.warn('Signature upload error:', errData.error || resp.statusText);
            }
          })
      );
    }

    const rows = [...document.querySelectorAll('#w-cert-rows .w-cert-row')];
    for(let i = 0; i < certs.length; i++){
      const c = certs[i];
      const certPayload = {certNo: c.certNo, process: c.process, standard: c.standard, validUntil: c.validUntil, renewalDue: c.renewalDue};
      const savedCert = await apiPost(`/welders/${personId}/certificates`, certPayload);
      const row = rows[i];
      if(row){
        const fileInput = row.querySelector('input[type="file"]');
        if(fileInput && fileInput.files && fileInput.files[0]){
          const formData = new FormData();
          formData.append('file', fileInput.files[0]);
          uploadTasks.push(
            fetch(`/api/welders/certificates/${savedCert.id}/upload`, {method: 'POST', body: formData})
          );
        }
      }
    }

    if(uploadTasks.length){
      setButtonLoading(submitBtn, true, t('uploading_sp', 'Uploading to SharePoint…'));
      await Promise.all(uploadTasks);
    }

    await loadWeldersFromApi();
    closeModal('modal-welder');
    if(welderReturnToWeld){
      welderReturnToWeld = false;
      if(document.getElementById('modal-weld').classList.contains('open')){
        buildPersonChecklist('input-weld-welders', getChecked('input-weld-welders'));
        buildPersonChecklist('input-weld-inspectors', getChecked('input-weld-inspectors'));
      }
      if(document.getElementById('modal-pipeline').classList.contains('open')){
        buildPersonChecklist('input-pl-welders', getChecked('input-pl-welders'));
        buildPersonChecklist('input-pl-inspectors', getChecked('input-pl-inspectors'));
      }
    }
    rerenderPage();
  } catch(ex){
    console.error('Error saving welder:', ex);
    alert('Error saving welder: ' + ex.message);
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

async function openWelderModal(id=null, returnToWeld=false){
  if(!DB.wpsProcesses || !DB.wpsProcesses.length){
    DB.wpsProcesses = [...DEFAULT_WPS_PROCESSES];
  }
  loadWpsProcessesFromApi();
  welderReturnToWeld=!!returnToWeld; editingWelderId=(typeof id==='number')?id:null; document.getElementById('welder-form').reset();
  _welderSignatureFile = null;
  _welderSignatureRemoved = false;
  const sigInp = document.getElementById('input-w-signature');
  if(sigInp) sigInp.value = '';
  const sigWrap = document.getElementById('input-w-signature-wrap');
  if(sigWrap) sigWrap.style.display = '';
  const prevWrap = document.getElementById('w-signature-preview-wrap');
  if(prevWrap) prevWrap.style.display = 'none';
  const curDiv = document.getElementById('w-signature-current');
  if(curDiv) curDiv.innerHTML = '';

  /* reset cert section */
  document.getElementById('w-cert-section').style.display='none';
  document.getElementById('w-cert-add-btn').style.display='';
  document.getElementById('w-cert-rows').innerHTML='';
  if(editingWelderId!==null){
    const p=getPerson(editingWelderId);
    document.getElementById('modal-welder-title').textContent=t('edit_welder','Edit welder');
    setV('input-w-name',p.name);
    setV('input-w-no',p.no);
    if(p && p.signatureUrl){
      if(sigWrap) sigWrap.style.display = 'none';
      const sigImgUrl = p.signatureUrl.includes('?') ? p.signatureUrl : `${p.signatureUrl}?_v=${Date.now()}`;
      curDiv.innerHTML = `<div style="display:flex;align-items:center;gap:12px;padding:8px 12px;background:#F8FAFC;border:1px solid var(--border);border-radius:4px;">
        <img src="${escapeHtml(sigImgUrl)}" style="max-height:42px;max-width:140px;object-fit:contain;background:#fff;padding:2px 6px;border-radius:3px;border:1px solid #E2E8F0;" alt="Signature">
        <a class="doc-chip doc-iso" href="javascript:void(0)" onclick="showImageRaw('${escapeHtml(p.name)} - Signatur','${escapeHtml(p.signatureUrl)}','Welder No. ${escapeHtml(p.no)}')">${t('signature_preview','View')}</a>
        <button type="button" class="btn-link" onclick="removeWelderSignature()" style="color:var(--danger);" data-i18n="remove_signature">Remove signature</button>
      </div>`;
    }
  }
  else { document.getElementById('modal-welder-title').textContent=t('new_welder','New welder'); /* auto-show 1 required cert row */ showWelderCertSection(); }
  openModal('modal-welder'); document.getElementById('input-w-name').focus();
}
let _wCertIdx=0;
function showWelderCertSection(){
  document.getElementById('w-cert-section').style.display='';
  document.getElementById('w-cert-add-btn').style.display='none';
  addWelderCertRow();
}
function addWelderCertRow(){
  _wCertIdx++;
  const wpsOpts = getDistinctWpsNos();
  const wpsOptionsHtml = wpsOpts.map(w => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`).join('');
  const html=`<div class="w-cert-row" style="border:1px solid var(--border);border-radius:4px;padding:12px;margin-bottom:10px;background:#F9FAFB;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;">
      <div class="field">
        <span class="lbl">${t('wps_no','WPS No.')} <span class="req">*</span></span>
        <select id="wc-wps-${_wCertIdx}" onchange="onWpsSelectChange('${_wCertIdx}')">
          <option value="">—</option>
          ${wpsOptionsHtml}
          <option value="__other__">${t('new_wps_no','+ New WPS No. (type it)…')}</option>
        </select>
        <input type="text" id="wc-wps-new-${_wCertIdx}" class="select-other-text" style="display:none;margin-top:4px;" placeholder="${t('wps_no_placeholder','e.g. SP2/VP14')}" oninput="onWpsNewInput('${_wCertIdx}')">
      </div>
      <div class="field"><span class="lbl">${t('th_standard','Standard')} <span class="req">*</span></span><select id="wc-std-${_wCertIdx}" onchange="toggleSelectOther('wc-std-${_wCertIdx}','wc-std-new-${_wCertIdx}')"><option value="">—</option><option value="EN ISO 9606-1">EN ISO 9606-1</option><option value="EN ISO 14732">EN ISO 14732</option><option value="__other__">+ Other (type it)…</option></select><input type="text" id="wc-std-new-${_wCertIdx}" class="select-other-text" style="display:none" placeholder="Type standard…"></div>
      <div class="field">
        <span class="lbl">${t('qualified_processes','Qualified processes')} <span class="req">*</span></span>
        <div id="wc-procwrap-${_wCertIdx}">
          <input type="text" id="wc-procs-${_wCertIdx}" placeholder="e.g. 141 / 142">
        </div>
      </div>
      <label class="field"><span class="lbl">${t('th_valid_until','Valid until')} <span class="req">*</span></span><input type="date" id="wc-valid-${_wCertIdx}"></label>
      <label class="field"><span class="lbl">${t('th_renewal_due','Renewal due')} <span class="req">*</span></span><input type="date" id="wc-renewal-${_wCertIdx}"></label>
      <label class="field"><span class="lbl">${t('cert_pdf_sp','Certificate PDF (→ SharePoint)')} <span class="req">*</span></span><input type="file" id="wc-file-${_wCertIdx}" accept="application/pdf"></label>
      <div class="field" style="display:flex;align-items:flex-end;"><button type="button" class="conn-remove" onclick="this.closest('.w-cert-row').remove()" title="Remove">✕</button></div>
    </div>
  </div>`;
  document.getElementById('w-cert-rows').insertAdjacentHTML('beforeend',html);
}

function onWpsSelectChange(idx){
  const sel = document.getElementById(`wc-wps-${idx}`);
  const inpNew = document.getElementById(`wc-wps-new-${idx}`);
  if(!sel) return;
  const isOther = sel.value === '__other__';
  if(inpNew){
    inpNew.style.display = isOther ? '' : 'none';
    if(isOther) inpNew.focus();
  }
  const wpsVal = isOther ? (inpNew ? inpNew.value.trim() : '') : sel.value;
  updateProcFieldForWps(idx, wpsVal);
}

function onWpsNewInput(idx){
  const inpNew = document.getElementById(`wc-wps-new-${idx}`);
  const wpsVal = inpNew ? inpNew.value.trim() : '';
  updateProcFieldForWps(idx, wpsVal);
}

function updateProcFieldForWps(idx, wpsVal){
  const wrap = document.getElementById(`wc-procwrap-${idx}`);
  if(!wrap) return;
  const procs = getProcessesForWps(wpsVal);
  if(procs.length > 1){
    wrap.innerHTML = `<select id="wc-proc-sel-${idx}" onchange="toggleSelectOther('wc-proc-sel-${idx}','wc-procs-${idx}')">
      ${procs.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}
      <option value="__other__">${t('other_custom','+ Other (type it)…')}</option>
    </select>
    <input type="text" id="wc-procs-${idx}" class="select-other-text" style="display:none;margin-top:4px;" placeholder="e.g. 141 / 142">`;
  } else if(procs.length === 1){
    wrap.innerHTML = `<input type="text" id="wc-procs-${idx}" value="${escapeHtml(procs[0])}" placeholder="e.g. 141 / 142">`;
  } else {
    wrap.innerHTML = `<input type="text" id="wc-procs-${idx}" value="" placeholder="e.g. 141 / 142">`;
  }
}

function getWelderCertRows(){
  const rows=document.querySelectorAll('#w-cert-rows .w-cert-row');
  const certs=[];
  let validationError='';
  rows.forEach((row,idx)=>{
    const wpsSel = row.querySelector('select[id^="wc-wps-"]');
    const wpsNew = row.querySelector('input[id^="wc-wps-new-"]');
    let certNo = '';
    if(wpsSel && wpsNew && wpsSel.offsetParent !== null){
      certNo = readSelectOther(wpsSel.id, wpsNew.id);
    } else if(wpsSel){
      certNo = wpsSel.value ? wpsSel.value.trim() : '';
    } else if(wpsNew){
      certNo = wpsNew.value ? wpsNew.value.trim() : '';
    } else {
      certNo = (row.querySelector('[id^="wc-certno-"]')||{}).value?.trim()||'';
    }

    const stdSel=row.querySelector('select[id^="wc-std-"]');
    const stdNew=row.querySelector('input[id^="wc-std-new-"]');
    let std = '';
    if(stdSel && stdNew && stdSel.offsetParent !== null){
      std = readSelectOther(stdSel.id, stdNew.id);
    } else if(stdSel){
      std = stdSel.value ? stdSel.value.trim() : '';
    } else if(stdNew){
      std = stdNew.value ? stdNew.value.trim() : '';
    }

    const procSel = row.querySelector('select[id^="wc-proc-sel-"]');
    const procInp = row.querySelector('input[id^="wc-procs-"]');
    let procs = '';
    if(procSel && procInp && procSel.offsetParent !== null){
      procs = readSelectOther(procSel.id, procInp.id);
    } else if(procInp){
      procs = procInp.value ? procInp.value.trim() : '';
    } else if(procSel){
      procs = procSel.value ? procSel.value.trim() : '';
    }

    const valid=(row.querySelector('[id^="wc-valid-"]')||{}).value||'';
    const renewal=(row.querySelector('[id^="wc-renewal-"]')||{}).value||'';
    const fileInput=row.querySelector('[id^="wc-file-"]');
    const fileName=fileInput&&fileInput.files&&fileInput.files[0]?fileInput.files[0].name:'';

    const hasAny = certNo || std || procs || valid || renewal || fileName;
    if(!hasAny) return;

    /* validate required fields for non-empty cert row */
    if(!certNo) validationError=t('wps_no_required','WPS number is required.');
    else if(!std) validationError='Standard is required.';
    else if(!procs) validationError='Qualified processes is required.';
    else if(!valid) validationError='Valid until date is required.';

    certs.push({certNo, process: procs, standard: std, procs, validUntil: valid, renewalDue: renewal, fileName});
  });
  certs._validationError=validationError;
  return certs;
}
function toggleInlineAdd(kind){ document.getElementById(`inline-add-${kind}`).classList.toggle('open'); }
function addPersonInline(kind){
  const name=val(`new-${kind}-name`), no=val(`new-${kind}-no`);
  if(!name){ document.getElementById(`new-${kind}-name`).focus(); return; }
  const person={id:nextId('person'), name, no:no||'—', procs:''}; DB.people.push(person); saveDB();
  const w=getChecked('input-pl-welders'), i=getChecked('input-pl-inspectors'); if(kind==='welder') w.push(person.id); else i.push(person.id);
  buildPersonChecklist('input-pl-welders',w); buildPersonChecklist('input-pl-inspectors',i);
  setV(`new-${kind}-name`,''); setV(`new-${kind}-no`,''); document.getElementById(`inline-add-${kind}`).classList.remove('open');
}

/* weld modal */
function buildWeldMaterialChecklist(selectedIds){
  const mats=pipelineMaterials(PAGE.pipelineId);
  document.getElementById('input-weld-materials').innerHTML = mats.length? mats.map(m=>`<label class="check-item"><input type="checkbox" value="${m.id}" ${selectedIds.includes(m.id)?'checked':''}> ${posLetter(m.position)} · ${escapeHtml(m.piece)} · ${escapeHtml(m.itemDescription)}</label>`).join('') : '<div class="muted" style="padding:6px 0;">'+t('no_materials_yet_add_first','No materials yet — add one first.')+'</div>';
}
function openWeldModal(id=null){
  editingWeldId=id; document.getElementById('weld-form').reset();
  const sel=id!==null?getWeld(id):null;
  buildWeldMaterialChecklist(sel?sel.materialIds:[]);
  if(sel){ document.getElementById('modal-weld-title').textContent=t('edit_weld','Edit weld');
    setV('input-weld-no',sel.weldNo); setV('input-weld-date',sel.date||TODAY_ISO); setV('input-weld-type',sel.type); setV('input-weld-visual',sel.visual||'OK'); setV('input-weld-endoscopy',sel.endoscopy||'n/a'); setV('input-weld-remarks',sel.remarks||'');
    setV('input-weld-proc',sel.procedure||'');
    document.getElementById('weld-video-current').innerHTML=sel.endoscopyVideoUrl?`<a href="${escapeHtml(sel.endoscopyVideoUrl)}" target="_blank" class="doc-chip doc-iso">${t('view_video','View video')}</a>`:'';
    document.getElementById('weld-image-current').innerHTML=sel.endoscopyImageUrl?`<a href="${escapeHtml(sel.endoscopyImageUrl)}" target="_blank" class="doc-chip doc-iso">${t('view_image','View image')}</a>`:'';
  } else { document.getElementById('modal-weld-title').textContent=t('new_weld','New weld'); setV('input-weld-date',TODAY_ISO); setV('input-weld-type',''); setV('input-weld-proc','');
    document.getElementById('weld-video-current').innerHTML='';
    document.getElementById('weld-image-current').innerHTML='';
  }
  openModal('modal-weld'); document.getElementById('input-weld-no').focus();
}
function onWeldTypeChange(){
  const type=val('input-weld-type');
  const procEl=document.getElementById('input-weld-proc');
  if(type==='O') procEl.value='147';
  else if(type==='H') procEl.value='141';
  else if(type==='M') procEl.value='142';
  else procEl.value='';
}

/* material modal + connections — hierarchical filtering from DB.materials (sidebar data)
   Category → Description → DN / DIEN / Code → Diameter → Thickness
   Dropdown options come from unique values already saved in materials(). */
/* Map a raw category string to its canonical PIECE_OPTIONS casing */
function canonPiece(s){ if(!s) return ''; const low=s.toLowerCase(); const match=PIECE_OPTIONS.find(p=>p.toLowerCase()===low); return match||s; }
function matSource(){
  /* build from pipeline materials + global materials catalog */
  const fromDb=(DB.materials||[]).map(m=>({
    piece:canonPiece(m.piece||m.category),
    description:m.itemDescription||m.description||'',
    code:m.materialCode||m.code||'',
    dimension:m.dimension||m.dn1||'',
    dimension2:m.dimension2||m.dn2||'',
    dimension3:m.dimension3||m.dn3||'',
    dien:m.dienNo||m.dien||'',
    diameter:m.diameter||'',
    thickness:m.thickness||''
  }));
  const fromGlobal=(DB.globalMaterials||[]).map(g=>({
    piece:canonPiece(g.category||g.piece),
    description:g.itemDescription||g.description||'',
    code:g.materialCode||g.code||'',
    dimension:g.dn1||g.dimension||'',
    dimension2:g.dn2||g.dimension2||'',
    dimension3:g.dn3||g.dimension3||'',
    dien:g.dienNo||g.dien||'',
    diameter:g.diameter||'',
    thickness:g.thickness||''
  }));
  const combined=[...fromDb,...fromGlobal];
  /* deduplicate */
  const seen=new Set(); const unique=[];
  combined.forEach(i=>{
    const key=[i.piece,i.description,i.code,i.dimension,i.dimension2||'',i.dimension3||'',i.dien,i.diameter,i.thickness].join('|||').toLowerCase();
    if(!seen.has(key) && (i.piece || i.description || i.code)){
      seen.add(key);
      unique.push(i);
    }
  });
  return unique;
}
function matCatalogFiltered(){
  let items=matSource();
  const piece=readSelectOther('input-mat-piece','input-mat-piece-new');
  if(piece) items=items.filter(i=>i.piece.toLowerCase()===piece.toLowerCase());
  const desc=document.getElementById('input-mat-desc').value;
  if(desc && desc!=='__other__') items=items.filter(i=>i.description===desc);
  return items;
}
function onCategoryChange(){
  const piece=document.getElementById('input-mat-piece').value;
  toggleWireFields(piece);
  toggleDnFields(piece);
  toggleDiameterThicknessFields(piece);
  updateConnHint();
  const filtered=piece?matSource().filter(i=>i.piece.toLowerCase()===piece.toLowerCase()):matSource();
  const descs=[...new Set(filtered.map(i=>i.description).filter(Boolean))];
  buildSelectOther('input-mat-desc','input-mat-desc-new',descs,'');
  cascadeFromDesc();
}
function onCategoryTyped(){
  const piece=document.getElementById('input-mat-piece-new').value.trim();
  toggleWireFields(piece);
  toggleDnFields(piece);
  toggleDiameterThicknessFields(piece);
}
function toggleDnFields(piece){
  const dnCount=requiredDns(piece);
  const container=document.getElementById('dn-fields-container');
  /* Always keep the first DN field (dn1-field) and add/remove extras */
  const dn1=document.getElementById('dn1-field');
  const dn1Label=document.getElementById('dn1-label');
  if(dnCount<=0){ container.style.display='none'; return; }
  container.style.display='';
  dn1.style.display='';
  dn1Label.textContent=dnCount>1?'DN 1':'DN';
  /* Remove extra DN fields beyond what's needed */
  container.querySelectorAll('.dn-extra-field').forEach(el=>el.remove());
  /* Add extra DN fields (2..dnCount) */
  for(let i=2;i<=dnCount;i++){
    const div=document.createElement('div');
    div.className='field dn-extra-field';
    div.id=`dn${i}-field`;
    div.innerHTML=`<span class="lbl">DN ${i}</span><select id="input-mat-dimension${i}" onchange="toggleSelectOther('input-mat-dimension${i}','input-mat-dimension${i}-new')"></select><input type="text" id="input-mat-dimension${i}-new" class="select-other-text" style="display:none" placeholder="Type DN ${i}…">`;
    container.appendChild(div);
    buildSelectOther(`input-mat-dimension${i}`,`input-mat-dimension${i}-new`,DIMENSION_OPTIONS,'',true);
  }
}
function toggleDiameterThicknessFields(piece){
  const diaField=document.getElementById('diameter-field');
  const thkField=document.getElementById('thickness-field');
  if(diaField) diaField.style.display=hasDiameter(piece)?'':'none';
  if(thkField) thkField.style.display=hasThickness(piece)?'':'none';
}
function toggleWireFields(piece){
  const isWire=(piece||'').toLowerCase()==='welding wire';
  const container=document.getElementById('dn-fields-container');
  if(container) container.style.display=isWire?'none':'';
  document.getElementById('input-mat-dien').closest('.field').style.display=isWire?'none':'';
  toggleDiameterThicknessFields(piece);
  /* hide connections and start/end for welding wire */
  const connField=document.getElementById('conn-rows')?.closest('.field');
  const startEndField=document.getElementById('input-mat-start')?.closest('.field');
  if(connField) connField.style.display=isWire?'none':'';
  if(startEndField) startEndField.style.display=isWire?'none':'';
  if(isWire){ document.getElementById('conn-rows').innerHTML=''; document.getElementById('input-mat-start').checked=false; document.getElementById('input-mat-end').checked=false; }
  if(!isWire) toggleDnFields(piece);
}
function onItemDescChange(){
  toggleSelectOther('input-mat-desc','input-mat-desc-new');
  const desc=readSelectOther('input-mat-desc','input-mat-desc-new');
  if(desc && desc!=='__other__'){
    const hit=matSource().find(i=>i.description===desc);
    if(hit){
      const curPiece = readSelectOther('input-mat-piece','input-mat-piece-new');
      if(!curPiece){
        buildSelectSimple('input-mat-piece',PIECE_OPTIONS,hit.piece);
        toggleDnFields(hit.piece);
        toggleDiameterThicknessFields(hit.piece);
      }
    }
  }
  updateConnHint();
  cascadeFromDesc();
}
function cascadeFromDesc(){
  const items=matCatalogFiltered();
  const dns=[...new Set(items.map(i=>i.dimension).filter(Boolean))];
  const diens=[...new Set(items.map(i=>i.dien).filter(Boolean))];
  const codes=[...new Set(items.map(i=>i.code).filter(Boolean))];
  /* Prefill (last DN of previous material) always takes priority */
  const dnDefault=(_prefillDn&&editingMaterialId===null)?_prefillDn:(dns.length===1?dns[0]:'');
  buildSelectOther('input-mat-dimension','input-mat-dimension-new',DIMENSION_OPTIONS,dnDefault,true);
  /* populate extra DN fields with DIMENSION_OPTIONS (user picks) */
  const piece=readSelectOther('input-mat-piece','input-mat-piece-new');
  const dnCount=requiredDns(piece);
  for(let i=2;i<=dnCount;i++){
    const sel=document.getElementById(`input-mat-dimension${i}`);
    if(sel) buildSelectOther(`input-mat-dimension${i}`,`input-mat-dimension${i}-new`,DIMENSION_OPTIONS,'',true);
  }
  buildSelectOther('input-mat-dien','input-mat-dien-new',diens,diens.length===1?diens[0]:'');
  /* For material code: always include prefill in options so it can be selected */
  const codeOpts=_prefillCode&&editingMaterialId===null&&!codes.includes(_prefillCode)?[...codes,_prefillCode]:codes;
  const codeDefault=(_prefillCode&&editingMaterialId===null)?_prefillCode:(codes.length===1?codes[0]:'');
  buildSelectOther('input-mat-code','input-mat-code-new',codeOpts,codeDefault);
  cascadeFromDnDienCode();
}
function onDnChange(){ toggleSelectOther('input-mat-dimension','input-mat-dimension-new'); cascadeFromDnDienCode(); }
function onDienChange(){ toggleSelectOther('input-mat-dien','input-mat-dien-new'); cascadeFromDnDienCode(); }
function onMatCodeChange(){ toggleSelectOther('input-mat-code','input-mat-code-new'); cascadeFromDnDienCode(); }
function cascadeFromDnDienCode(){
  const dn=readSelectOther('input-mat-dimension','input-mat-dimension-new');
  /* Diameter: filter from ALL materials (across all pipelines) that share the same DN */
  let allItems=matSource();
  if(dn) allItems=allItems.filter(i=>i.dimension===dn);
  const diameters=[...new Set(allItems.map(i=>i.diameter).filter(Boolean))];
  buildSelectOther('input-mat-diameter','input-mat-diameter-new',diameters,diameters.length===1?diameters[0]:'');
  cascadeFromDiameter();
}
function onDiameterChange(){ toggleSelectOther('input-mat-diameter','input-mat-diameter-new'); cascadeFromDiameter(); }
function cascadeFromDiameter(){
  const dn=readSelectOther('input-mat-dimension','input-mat-dimension-new');
  const diameter=readSelectOther('input-mat-diameter','input-mat-diameter-new');
  /* Thickness: filter from ALL materials that share the same DN + Diameter */
  let allItems=matSource();
  if(dn) allItems=allItems.filter(i=>i.dimension===dn);
  if(diameter) allItems=allItems.filter(i=>i.diameter===diameter);
  const thicknesses=[...new Set(allItems.map(i=>i.thickness).filter(Boolean))];
  buildSelectOther('input-mat-thickness','input-mat-thickness-new',thicknesses,thicknesses.length===1?thicknesses[0]:'');
}
function connectableMaterials(){ return pipelineMaterials(PAGE.pipelineId).filter(m=>m.id!==editingMaterialId && (m.piece||'').toLowerCase()!=='welding wire'); }
function connRowHtml(selectedId){
  const opts=connectableMaterials().map(m=>`<option value="${m.id}" ${m.id===selectedId?'selected':''}>${posLetter(m.position)} · ${escapeHtml(m.piece)} · ${escapeHtml(m.itemDescription)}</option>`).join('');
  return `<div class="conn-row"><select><option value="">${t('select_material','Select material…')}</option>${opts}</select><button type="button" class="conn-remove" onclick="this.parentElement.remove(); updateConnHint();">✕</button></div>`;
}
function addConnRow(selectedId){ document.getElementById('conn-rows').insertAdjacentHTML('beforeend', connRowHtml(selectedId||0)); updateConnHint(); }
function renderConnRows(preset){
  const wrap=document.getElementById('conn-rows'); wrap.innerHTML='';
  const validIds = new Set(connectableMaterials().map(m=>m.id));
  const list = (preset || []).filter(cid => validIds.has(cid));
  list.forEach(cid=>addConnRow(cid));
  updateConnHint();
}
function updateConnHint(){
  const start=document.getElementById('input-mat-start').checked, end=document.getElementById('input-mat-end').checked;
  const otherExists=connectableMaterials().length>0;
  const piece=readSelectOther('input-mat-piece','input-mat-piece-new');
  const required=requiredWelds(piece);
  let adjusted=otherExists?required:0;
  if(otherExists && required>1){
    if(start) adjusted=Math.max(1,adjusted-1);
    if(end) adjusted=Math.max(1,adjusted-1);
  }
  const hint=document.getElementById('conn-hint');
  if(!otherExists) hint.textContent='This is the first material in the pipeline \u2014 no connections available yet.';
  else if(!piece) hint.textContent='Select a category to see connection info.';
  else hint.textContent=`Connections that ${piece} can have: ${adjusted}`;
}
function onStartEndChange(){
  const piece=readSelectOther('input-mat-piece','input-mat-piece-new');
  const required=requiredWelds(piece);
  if(required>1){
    const start=document.getElementById('input-mat-start').checked;
    const end=document.getElementById('input-mat-end').checked;
    let adjusted=required;
    if(start) adjusted=Math.max(1,adjusted-1);
    if(end) adjusted=Math.max(1,adjusted-1);
    const rows=[...document.querySelectorAll('#conn-rows .conn-row')];
    for(let i=rows.length-1;i>=adjusted;i--) rows[i].remove();
  }
  updateConnHint();
}
function openMaterialModal(id=null, returnToWeld=false){
  materialReturnToWeld=!!returnToWeld; editingMaterialId=(typeof id==='number')?id:null;
  document.getElementById('material-form').reset(); document.getElementById('material-err').classList.remove('show');
  const src=matSource();
  const allPieces=PIECE_OPTIONS.slice();
  const allDescs=[...new Set(src.map(i=>i.description).filter(Boolean))];
  const allDns=[...new Set(src.map(i=>i.dimension).filter(Boolean))];
  const allDiens=[...new Set(src.map(i=>i.dien).filter(Boolean))];
  const allCodes=[...new Set(src.map(i=>i.code).filter(Boolean))];
  const allDiameters=[...new Set(src.map(i=>i.diameter).filter(Boolean))];
  const allThicknesses=[...new Set(src.map(i=>i.thickness).filter(Boolean))];
  buildSelectSimple('input-mat-piece',allPieces,'');
  buildSelectOther('input-mat-desc','input-mat-desc-new',allDescs,'');
  buildSelectOther('input-mat-dimension','input-mat-dimension-new',DIMENSION_OPTIONS,'',true);
  buildSelectOther('input-mat-dien','input-mat-dien-new',allDiens,'');
  buildSelectOther('input-mat-code','input-mat-code-new',allCodes,'');
  buildSelectOther('input-mat-diameter','input-mat-diameter-new',allDiameters,'');
  buildSelectOther('input-mat-thickness','input-mat-thickness-new',allThicknesses,'');
  /* reset DN fields to just DN1 */
  document.getElementById('dn-fields-container').querySelectorAll('.dn-extra-field').forEach(el=>el.remove());
  document.getElementById('dn1-label').textContent='DN';
  document.getElementById('dn-fields-container').style.display='';
  document.getElementById('diameter-field').style.display='';
  document.getElementById('thickness-field').style.display='';
  if(editingMaterialId!==null){ const m=getMaterial(editingMaterialId); document.getElementById('modal-material-title').textContent=t('edit_material','Edit material');
    _prefillDn=''; _prefillCode=''; _prefillAllDns=[];
    setV('input-mat-position',posLetter(m.position));
    buildSelectSimple('input-mat-piece',allPieces,m.piece);
    toggleWireFields(m.piece);
    toggleDnFields(m.piece);
    toggleDiameterThicknessFields(m.piece);
    buildSelectOther('input-mat-desc','input-mat-desc-new',allDescs,m.itemDescription);
    buildSelectOther('input-mat-dimension','input-mat-dimension-new',DIMENSION_OPTIONS,m.dimension,true);
    /* populate extra DN fields with saved values */
    const dnCount=requiredDns(m.piece);
    for(let i=2;i<=dnCount;i++){
      const savedVal=m[`dimension${i}`]||'';
      const sel=document.getElementById(`input-mat-dimension${i}`);
      if(sel) buildSelectOther(`input-mat-dimension${i}`,`input-mat-dimension${i}-new`,DIMENSION_OPTIONS,savedVal,true);
    }
    buildSelectOther('input-mat-dien','input-mat-dien-new',allDiens,m.dienNo||'');
    buildSelectOther('input-mat-code','input-mat-code-new',allCodes,m.materialCode);
    buildSelectOther('input-mat-diameter','input-mat-diameter-new',allDiameters,m.diameter||'');
    buildSelectOther('input-mat-thickness','input-mat-thickness-new',allThicknesses,m.thickness||'');
    {const allSurfaces=[...new Set((DB.globalMaterials||[]).map(g=>g.surface).filter(Boolean))]; buildSelectOther('input-mat-surface','input-mat-surface-new',allSurfaces,m.surface||'');}
    document.getElementById('input-mat-start').checked=!!m.startOfPlumbing; document.getElementById('input-mat-end').checked=!!m.endOfPlumbing;
    renderConnRows(m.connections||[]);
  } else { document.getElementById('modal-material-title').textContent=t('new_material','New material'); setV('input-mat-position', posLetter(pipelineMaterials(PAGE.pipelineId).length+1));
    toggleWireFields('');
    const prevMats=pipelineMaterials(PAGE.pipelineId);
    /* Find last material with a DN value (skip welding wire etc.) */
    const lastWithDn=prevMats.slice().reverse().find(m=>m.dimension);
    const lastMat=prevMats.length?prevMats[prevMats.length-1]:null;
    /* Collect ALL DN values from the previous material */
    _prefillAllDns=[];
    if(lastWithDn){
      if(lastWithDn.dimension) _prefillAllDns.push(lastWithDn.dimension);
      for(let i=2;i<=6;i++){ if(lastWithDn[`dimension${i}`]) _prefillAllDns.push(lastWithDn[`dimension${i}`]); }
    }
    /* Use the LAST DN as the pre-selected default */
    _prefillDn=_prefillAllDns.length?_prefillAllDns[_prefillAllDns.length-1]:'';
    _prefillCode=lastWithDn?lastWithDn.materialCode:(lastMat?lastMat.materialCode:'');
    if(_prefillDn){
      buildSelectOther('input-mat-dimension','input-mat-dimension-new',DIMENSION_OPTIONS,_prefillDn,true);
    }
    if(_prefillCode){
      const codeOpts=allCodes.includes(_prefillCode)?allCodes:[...allCodes,_prefillCode];
      buildSelectOther('input-mat-code','input-mat-code-new',codeOpts,_prefillCode);
    }
    document.getElementById('input-mat-start').checked=prevMats.length===0; document.getElementById('input-mat-end').checked=false;
    /* populate surface dropdown for new material */
    {const allSurfaces=[...new Set((DB.globalMaterials||[]).map(g=>g.surface).filter(Boolean))]; buildSelectOther('input-mat-surface','input-mat-surface-new',allSurfaces,'');}
    if(_prefillDn) cascadeFromDnDienCode();
    /* pre-fill connection with the nearest material that has a missing connection */
    const autoConn=[];
    if(prevMats.length){
      const nonWire=prevMats.filter(m=>(m.piece||'').toLowerCase()!=='welding wire');
      const sorted=nonWire.slice().sort((a,b)=>b.position-a.position);
      const candidate=sorted.find(m=>{
        const needed=requiredWelds(m.piece);
        let adjusted=needed;
        if(m.startOfPlumbing) adjusted=Math.max(0,needed-1);
        if(m.endOfPlumbing) adjusted=Math.max(0,needed-1);
        return (m.connections||[]).length<adjusted;
      });
      if(candidate) autoConn.push(candidate.id);
    }
    renderConnRows(autoConn); }
  openModal('modal-material'); document.getElementById('input-mat-piece').focus();
}

function openRenewModal(certId){
  renewingCertId=certId; const c=DB.certificates.find(x=>x.id===certId), p=getPerson(c.personId);
  const certHtml=`<strong>${escapeHtml(c.certNo)}</strong>`;
  const nameHtml=escapeHtml(p?p.name:'');
  const procHtml=escapeHtml(c.process||'');
  const stdHtml=escapeHtml(c.standard||'');
  document.getElementById('renew-text').innerHTML=t('renew_cert_subtitle','Renew certificate {cert} for {name} (process {process}, {standard}).').replace('{cert}',certHtml).replace('{name}',nameHtml).replace('{process}',procHtml).replace('{standard}',stdHtml);
  
  // Populate renew WPS dropdown
  const wpsOpts = getDistinctWpsNos();
  const sel = document.getElementById('renew-wps-sel');
  const inpNew = document.getElementById('renew-wps-new');
  if(sel){
    const hasCurrent = wpsOpts.some(w => w.toLowerCase() === (c.certNo || '').toLowerCase());
    let optsHtml = '<option value="">—</option>' + wpsOpts.map(w => `<option value="${escapeHtml(w)}" ${w.toLowerCase() === (c.certNo||'').toLowerCase() ? 'selected' : ''}>${escapeHtml(w)}</option>`).join('');
    optsHtml += `<option value="__other__" ${!hasCurrent && c.certNo ? 'selected' : ''}>${t('new_wps_no','+ New WPS No. (type it)…')}</option>`;
    sel.innerHTML = optsHtml;
    if(!hasCurrent && c.certNo){
      if(inpNew){ inpNew.style.display = ''; inpNew.value = c.certNo; }
    } else {
      if(inpNew){ inpNew.style.display = 'none'; inpNew.value = ''; }
    }
  }

  updateRenewProcField(c.certNo, c.process);

  setV('renew-valid',c.validUntil||''); setV('renew-renewal',c.renewalDue||''); document.getElementById('renew-file').value='';
  openModal('modal-renew');
}

function onRenewWpsChange(){
  const sel = document.getElementById('renew-wps-sel');
  const inpNew = document.getElementById('renew-wps-new');
  if(!sel) return;
  const isOther = sel.value === '__other__';
  if(inpNew){
    inpNew.style.display = isOther ? '' : 'none';
    if(isOther) inpNew.focus();
  }
  const wpsVal = isOther ? (inpNew ? inpNew.value.trim() : '') : sel.value;
  updateRenewProcField(wpsVal);
}

function onRenewWpsNewInput(){
  const inpNew = document.getElementById('renew-wps-new');
  const wpsVal = inpNew ? inpNew.value.trim() : '';
  updateRenewProcField(wpsVal);
}

function updateRenewProcField(wpsVal, prefillProc){
  const wrap = document.getElementById('renew-procs-wrap');
  if(!wrap) return;
  const procs = getProcessesForWps(wpsVal);
  if(procs.length > 1){
    const currentVal = prefillProc || procs[0];
    const isOther = !procs.includes(currentVal) && !!currentVal;
    wrap.innerHTML = `<select id="renew-proc-sel" onchange="toggleSelectOther('renew-proc-sel','renew-procs')">
      ${procs.map(p => `<option value="${escapeHtml(p)}" ${p === currentVal ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
      <option value="__other__" ${isOther ? 'selected' : ''}>${t('other_custom','+ Other (type it)…')}</option>
    </select>
    <input type="text" id="renew-procs" class="select-other-text" style="${isOther ? '' : 'display:none;'}margin-top:4px;" value="${escapeHtml(currentVal||'')}" placeholder="e.g. 141 / 142">`;
  } else if(procs.length === 1){
    wrap.innerHTML = `<input type="text" id="renew-procs" value="${escapeHtml(prefillProc || procs[0])}" placeholder="e.g. 141 / 142">`;
  } else {
    wrap.innerHTML = `<input type="text" id="renew-procs" value="${escapeHtml(prefillProc || '')}" placeholder="e.g. 141 / 142">`;
  }
}

async function confirmRenew(){
  const oldCert=DB.certificates.find(x=>x.id===renewingCertId);
  if(!oldCert) return;
  const wpsSel = document.getElementById('renew-wps-sel');
  const wpsNew = document.getElementById('renew-wps-new');
  let cn = '';
  if(wpsSel && wpsNew){
    cn = readSelectOther('renew-wps-sel', 'renew-wps-new');
  } else {
    cn = val('renew-certno');
  }

  const procSel = document.getElementById('renew-proc-sel');
  const procInp = document.getElementById('renew-procs');
  let procVal = '';
  if(procSel && procInp && procSel.offsetParent !== null){
    procVal = readSelectOther('renew-proc-sel', 'renew-procs');
  } else if(procInp){
    procVal = procInp.value.trim();
  } else if(procSel){
    procVal = procSel.value.trim();
  }
  if(!procVal) procVal = oldCert.process;

  const vu=val('renew-valid');
  const rd=val('renew-renewal');
  const f=document.getElementById('renew-file').files[0];
  /* Validate all fields */
  if(!cn){ alert(t('wps_no_required','WPS number is required.')); return; }
  if(!procVal){ alert('Qualified processes is required.'); return; }
  if(!vu){ alert('Valid until date is required.'); return; }
  if(!rd){ alert('Renewal due date is required.'); return; }
  if(!f){ alert('Renewal attachment PDF is required.'); return; }
  const submitBtn=document.getElementById('renew-confirm-btn');
  setButtonLoading(submitBtn, true, t('saving', 'Saving…'));
  try {
    /* Archive old certificate */
    await apiPost(`/welders/certificates/${oldCert.id}`, {archived:true});
    /* Create new certificate */
    const newCert=await apiPost(`/welders/${oldCert.personId}/certificates`, {certNo:cn, process:procVal, standard:oldCert.standard, validUntil:vu, renewalDue:rd});
    /* Upload PDF */
    const formData=new FormData();
    formData.append('file', f);
    await fetch(`${API_BASE}/welders/certificates/${newCert.id}/upload`,{method:'POST',body:formData});
    await loadWeldersFromApi();
    closeModal('modal-renew'); rerenderPage();
  } catch(ex){ alert('Error renewing: '+ex.message); }
  finally { setButtonLoading(submitBtn, false); }
}

/* ================================================================ ARCHIVE (soft delete) ================================================================ */
function openArchiveModal(type,id){
  deleteContext={type,id}; let label,nounKey,nounDefault,warn='';
  if(type==='client'){ const c=getClient(id); label=c.name; nounKey='client'; nounDefault='client'; const n=clientProjects(id).length; if(n) warn=` ${t('client_has_projects_warn','This client has {n} project(s).').replace('{n}',n)}`; }
  else if(type==='project'){ const p=getProject(id); label=p.title; nounKey='project'; nounDefault='project'; const n=projectPipelines(id).length; if(n) warn=` ${t('project_has_pipelines_warn','This project has {n} pipeline(s).').replace('{n}',n)}`; }
  else if(type==='welder'){ const p=getPerson(id); label=p.name; nounKey='welder'; nounDefault='welder'; }
  else if(type==='pipeline'){ label=getPipeline(id).no; nounKey='pipeline'; nounDefault='pipeline'; }
  else if(type==='weld'){ label=getWeld(id).weldNo; nounKey='weld'; nounDefault='weld'; }
  else if(type==='material'){ const m=getMaterial(id); label=`${posLetter(m.position)} · ${m.piece}`; nounKey='material'; nounDefault='material'; }
  const nounText = t(nounKey, nounDefault);
  document.getElementById('modal-archive-title').textContent=`${t('archive','Archive')} ${nounText}?`;
  document.getElementById('archive-confirm-text').textContent=`${t('archive_confirm_text','Archive "{label}"? It will be hidden from the lists.').replace('{label}',label)}${warn}`;
  document.getElementById('archive-confirm-btn').textContent=`${t('archive','Archive')} ${nounText}`;
  openModal('modal-archive'); document.getElementById('archive-cancel-btn').focus();
}
async function confirmArchive(){
  const btn=document.getElementById('archive-confirm-btn');
  setButtonLoading(btn, true, t('archiving', 'Archiving…'));
  const {type,id}=deleteContext;
  const map={client:'clients',project:'projects',pipeline:'pipelines',welder:'people',weld:'welds',material:'materials'};
  const apiMap={client:'/clients',project:'/projects',pipeline:'/pipelines',weld:'/welds',material:'/pipeline-materials'};
  const rec = DB[map[type]].find(x=>x.id===id); if(rec) rec.archived=true;
  if(type==='client'){
    const clientProjIds = DB.projects.filter(p=>p.clientId===id).map(p=>p.id);
    DB.projects.filter(p=>p.clientId===id).forEach(p=>p.archived=true);
    DB.pipelines.filter(pl=>clientProjIds.includes(pl.projectId)).forEach(pl=>pl.archived=true);
  }
  if(type==='project'){
    DB.pipelines.filter(pl=>pl.projectId===id).forEach(pl=>pl.archived=true);
  }
  try {
    if(apiMap[type]){ await apiPost(apiMap[type]+(type==='material'?'/'+id:''), type==='material'?{archived:true}:{id, archived:true}); }
  } catch(e){ console.error('Archive API error:', e); }

  if(type==='material' || type==='weld'){
    const pipeId = rec ? rec.pipelineId : PAGE.pipelineId;
    if(pipeId){
      try {
        const data = await apiGet('/pipeline-detail/' + pipeId);
        DB.materials = normalizeMaterials(data.materials || []);
        DB.welds = normalizeWelds(data.welds || []);
        if(data.projectMaterials && Array.isArray(data.projectMaterials)) DB.projectMaterials = data.projectMaterials;
        rebuildRelationships();
      } catch(err){
        console.error('Failed to reload pipeline after archive:', err);
      }
    }
  }

  setButtonLoading(btn, false);
  saveDB(); closeModal('modal-archive');
  if(type==='welder') { location.href='welders.html'; return; }
  rerenderPage();
}
/* ---- welding-details update step (status 3 → 4) ---- */
let weldingUpdateId=null;
function openWeldingUpdate(id){
  weldingUpdateId=id;
  ['input-wd-start','input-wd-end','input-wd-remarks'].forEach(f=>{ const el=document.getElementById(f); if(el) el.value=''; });
  openModal('modal-welding');
}
async function confirmWeldingUpdate(){
  const btn=document.querySelector('#modal-welding .btn-success');
  setButtonLoading(btn, true, t('saving', 'Saving…'));
  const wStart=val('input-wd-start'); const wEnd=val('input-wd-end'); const wRem=val('input-wd-remarks');
  const pl=getPipeline(weldingUpdateId); if(!pl){ setButtonLoading(btn, false); return; }
  pl.weldingStart=wStart; pl.weldingEnd=wEnd; pl.weldingRemarks=wRem; pl.status=4;
  saveDB();
  try {
    await apiPost('/pipelines', {id:weldingUpdateId, status:4, weldingStart:wStart, weldingEnd:wEnd, weldingRemarks:wRem});
  } catch(e){ console.error('Welding update API error:', e); }
  finally { setButtonLoading(btn, false); }
  closeModal('modal-welding'); rerenderPage();
}

/* helper */
function setV(id,v){ const el=document.getElementById(id); if(el) el.value=v; }

/* ================================================================ PAGE CONTEXT + RE-RENDER ================================================================ */
const PAGE = { name:null, pipelineId:null, materialId:null, welderId:null, projectId:null };
function qp(name){ return new URLSearchParams(location.search).get(name); }
function rerenderPage(){
  if(PAGE.name==='clients') renderClientsPage();
  else if(PAGE.name==='client-detail') renderClientDetail();
  else if(PAGE.name==='projects') renderProjectsPage();
  else if(PAGE.name==='pipelines') renderPipelinesPage();
  else if(PAGE.name==='pipeline-detail'){ renderPipelineDetail(); }
  else if(PAGE.name==='material-detail') renderMaterialDetail();
  else if(PAGE.name==='welders') renderWeldersPage();
  else if(PAGE.name==='welder-profile') renderWelderProfile();
  else if(PAGE.name==='home') renderHomePage();
  else if(PAGE.name==='waz') renderWazPage();
  else if(PAGE.name==='materials') renderMaterialsPage();
  else if(PAGE.name==='material-usage') renderMaterialUsagePage();
  else if(PAGE.name==='project-detail') renderProjectDetail();
  else if(PAGE.name==='archive') renderArchivePage();
  // counts in the sidebar may change
  const navCounts={ clients:clients().length, projects:projects().length, pipelines:pipelines().length, welders:people().length, materials:materials().length, waz:uniqueWaz().length };
  Object.keys(navCounts).forEach(k=>{ const href=k==='clients'?'index.html':k+'.html'; const el=document.querySelector(`.nav-tab[href="${href}"] .nav-count`); if(el) el.textContent=navCounts[k]; });
}

/* ================================================================ CLIENTS PAGE ================================================================ */
let clientFilterId='';
async function initClientsPage(){ PAGE.name='clients'; initDB(); renderChrome('clients',t('clients','Clients')); mountModals(); wireModalDismiss();
  try {
    const data = await apiGet('/page/clients');
    DB.clients = data.clients || [];
    DB.pipelines = data.pipelines || [];
    DB.projects = normalizeProjects(data.projects || []);
  } catch(e){
    console.error('API error:', e);
    try { DB.clients = await apiGet('/clients'); } catch(e2){}
  }
  buildClientFilter(); renderClientsPage();
}
function buildClientFilter(){
  const sel=document.getElementById('client-filter-select');
  sel.innerHTML='<option value="">'+t('all_clients','All clients')+'</option>'+clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  sel.value=clientFilterId;
}
function onClientFilterChange(){ clientFilterId=document.getElementById('client-filter-select').value; renderClientsPage(); }
function clearClientFilter(){ clientFilterId=''; buildClientFilter(); renderClientsPage(); }
function renderClientsPage(){
  const activePipes = pipelines().filter(p=>p.status>=1 && p.status<5).length, donePipes = pipelines().filter(p=>p.status===5).length;
  document.getElementById('clients-stats').innerHTML=tile(clients().length,t('total_clients','Clients'),'')+tile(projects().length,t('total_projects','Projects'),'t-copper')+tile(pipelines().length,t('total_pipelines','Pipelines'),'t-neutral')+tile(activePipes,t('active_pipelines','Active pipelines'),'t-copper')+tile(donePipes,t('completed_pipelines','Completed pipelines'),'t-success');
  const tbody=document.getElementById('clients-tbody');
  const filtered=clientFilterId?clients().filter(c=>c.id===Number(clientFilterId)):clients();
  tbody.innerHTML = filtered.length? filtered.map(c=>`<tr class="clickable-row" onclick="rowToClientDetail(event,${c.id})">
    <td class="col-name">${escapeHtml(c.name)}</td>
    <td class="col-address">${escapeHtml(c.name)}<br>${escapeHtml(c.street)}<br>${escapeHtml(c.zipCode)} ${escapeHtml(c.location)}</td>
    <td class="col-remarks">${escapeHtml(c.remarks)||'<span class="muted">—</span>'}</td>
    <td class="col-actions"><a class="btn-link" href="client-detail.html?id=${c.id}">${t('view_projects','View projects')}</a><button class="btn-link" onclick="openClientModal(${c.id})" data-i18n="edit">${t('edit','Edit')}</button>${archiveBtn('client',c.id)}</td>
  </tr>`).join('') : `<tr class="empty-row"><td colspan="4">${clients().length===0?t('no_clients_yet','No clients yet.'):t('no_clients_match_filter','No clients match your filter.')}</td></tr>`;
}

/* ================================================================ ARCHIVE PAGE ================================================================ */
function archivedClients(){ return DB.clients.filter(c=>c.archived); }
function archivedProjects(){ return DB.projects.filter(p=>p.archived); }
function archivedPipelines(){ return DB.pipelines.filter(p=>p.archived); }
function archivedMaterials(){ return DB.materials.filter(m=>m.archived); }
function archivedWelds(){ return DB.welds.filter(w=>w.archived); }
function allProjectsForClient(cid){ return DB.projects.filter(p=>p.clientId===cid); }
let archiveFilterText='';
let archiveTab='clients';
async function initArchivePage(){
  PAGE.name='archive'; initDB();
  try {
    const data = await apiGet('/page/archive');
    DB.clients = data.clients || [];
    DB.projects = normalizeProjects(data.projects || []);
    DB.pipelines = data.pipelines || [];
    DB.materials = normalizeMaterials(data.materials || []);
    DB.welds = normalizeWelds(data.welds || []);
    rebuildRelationships();
  } catch(e){ console.error('API error:', e); }
  renderChrome('clients',`<a href="index.html">${t('clients','Clients')}</a> / ${t('archive','Archive')}`);
  mountModals(); wireModalDismiss();
  const tabParam=qp('tab'); if(tabParam) archiveTab=tabParam;
  renderArchivePage();
}
function switchArchiveTab(tab){
  archiveTab=tab; renderArchivePage();
}
function onArchiveFilterInput(v){ archiveFilterText=v; renderArchivePage(); }
function renderArchivePage(){
  const aC=archivedClients().length, aP=archivedProjects().length, aPl=archivedPipelines().length, aM=archivedMaterials().length, aW=archivedWelds().length;
  document.getElementById('archive-stats').innerHTML=tile(aC,t('total_clients','Clients'),'t-neutral')+tile(aP,t('total_projects','Projects'),'t-neutral')+tile(aPl,t('total_pipelines','Pipelines'),'t-neutral')+tile(aM,t('total_materials','Materials'),'t-neutral')+tile(aW,t('total_welds','Welds'),'t-neutral');
  ['clients','projects','pipelines','materials','welds'].forEach(t=>{
    const el=document.getElementById('arc-tab-'+t);
    if(el) el.classList.toggle('active',archiveTab===t);
  });
  document.getElementById('archive-expanded').innerHTML='';
  const content=document.getElementById('archive-tab-content');
  if(archiveTab==='clients') renderArchiveClients(content);
  else if(archiveTab==='projects') renderArchiveProjects(content);
  else if(archiveTab==='pipelines') renderArchivePipelines(content);
  else if(archiveTab==='materials') renderArchiveMaterials(content);
  else if(archiveTab==='welds') renderArchiveWelds(content);
}
const RESTORE_ICON='<svg viewBox="0 0 24 24" width="13" height="13" fill="none"><path d="M3 12a9 9 0 1 1 2.64 6.36" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3 18v-6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function renderArchiveClients(el){
  const items=archivedClients();
  el.innerHTML=`<div class="table-card"><table><thead><tr><th>${t('th_client_name','Client name')}</th><th>${t('th_address','Address')}</th><th>${t('th_projects','Projects')}</th><th>${t('th_remarks','Remarks')}</th><th></th></tr></thead><tbody>${items.length?items.map(c=>{
    const prjs=allProjectsForClient(c.id);
    return `<tr><td class="col-name">${escapeHtml(c.name)}</td><td>${escapeHtml(c.street)}<br>${escapeHtml(c.zipCode)} ${escapeHtml(c.location)}</td><td>${prjs.length} ${t('project_count_label','project')}${prjs.length!==1?'s':''}</td><td class="col-remarks">${escapeHtml(c.remarks)||'<span class="muted">\u2014</span>'}</td><td class="col-actions"><button class="btn-link" onclick="viewArchivedClient(${c.id})">${t('view','View')}</button><button class="btn-restore" onclick="restoreClient(${c.id})">${RESTORE_ICON} ${t('restore','Restore')}</button></td></tr>`;
  }).join(''):'<tr class="empty-row"><td colspan="5">'+t('no_archived_clients','No archived clients.')+'</td></tr>'}</tbody></table></div>`;
}
function renderArchiveProjects(el){
  const items=archivedProjects();
  el.innerHTML=`<div class="table-card"><table class="table-wide"><thead><tr><th>${t('th_ist_project_no','IST No.')}</th><th>${t('th_project_title','Project title')}</th><th>${t('th_client','Client')}</th><th>${t('th_location','Location')}</th><th>${t('th_status','Status')}</th><th></th></tr></thead><tbody>${items.length?items.map(p=>{
    const cli=getClient(p.clientId);
    return `<tr><td class="col-mono">${escapeHtml(p.istProjectNo)||'<span class="muted">\u2014</span>'}</td><td class="col-name">${escapeHtml(p.title)}</td><td>${cli?escapeHtml(cli.name):'\u2014'}</td><td>${escapeHtml(p.location)||'\u2014'}</td><td><span class="status-badge status-${p.status}" style="cursor:default;">${STATUS_LABELS[p.status]||p.status}</span></td><td class="col-actions"><button class="btn-restore" onclick="restoreProject(${p.id})">${RESTORE_ICON} ${t('restore','Restore')}</button></td></tr>`;
  }).join(''):'<tr class="empty-row"><td colspan="6">'+t('no_archived_projects','No archived projects.')+'</td></tr>'}</tbody></table></div>`;
}
function renderArchiveMaterials(el){
  const items=archivedMaterials();
  el.innerHTML=`<div class="table-card"><table class="table-wide"><thead><tr><th>${t('th_category','Category')}</th><th>${t('th_item_description','Item description')}</th><th>${t('th_dn','DN')}</th><th>${t('th_material','Material')}</th><th>${t('th_pipeline_no','Pipeline No.')}</th><th></th></tr></thead><tbody>${items.length?items.map(m=>{
    const pl=getPipeline(m.pipelineId);
    let dnDisplay=escapeHtml(m.dimension);
    for(let i=2;i<=6;i++){ if(m[`dimension${i}`]) dnDisplay+=' / '+escapeHtml(m[`dimension${i}`]); }
    return `<tr><td>${escapeHtml(m.piece)}</td><td>${escapeHtml(m.itemDescription)}</td><td class="col-mono">${dnDisplay}</td><td class="col-mono">${escapeHtml(m.materialCode)}</td><td>${pl?escapeHtml(pl.no):'\u2014'}</td><td class="col-actions"><button class="btn-restore" onclick="restoreMaterial(${m.id})">${RESTORE_ICON} ${t('restore','Restore')}</button></td></tr>`;
  }).join(''):'<tr class="empty-row"><td colspan="6">'+t('no_archived_materials','No archived materials.')+'</td></tr>'}</tbody></table></div>`;
}
function renderArchivePipelines(el){
  const items=archivedPipelines();
  el.innerHTML=`<div class="table-card"><table class="table-wide"><thead><tr><th>${t('th_pipeline_no','Pipeline No.')}</th><th>${t('th_project','Project')}</th><th>${t('th_client','Client')}</th><th>${t('th_plant','Plant')}</th><th>${t('th_status','Status')}</th><th></th></tr></thead><tbody>${items.length?items.map(pl=>{
    const pr=getProject(pl.projectId);
    const cli=pr?getClient(pr.clientId):null;
    return `<tr><td class="col-mono">${escapeHtml(pl.no)}</td><td>${pr?escapeHtml(pr.title):'\u2014'}</td><td>${cli?escapeHtml(cli.name):'\u2014'}</td><td class="col-mono">${escapeHtml(pl.plant)||'\u2014'}</td><td>${statusPill(pl.status)}</td><td class="col-actions"><button class="btn-restore" onclick="restorePipeline(${pl.id})">${RESTORE_ICON} ${t('restore','Restore')}</button></td></tr>`;
  }).join(''):'<tr class="empty-row"><td colspan="6">'+t('no_archived_pipelines','No archived pipelines.')+'</td></tr>'}</tbody></table></div>`;
}
function renderArchiveWelds(el){
  const items=archivedWelds();
  el.innerHTML=`<div class="table-card"><table class="table-wide"><thead><tr><th>${t('th_weld_no','Weld No.')}</th><th>${t('th_between','Between')}</th><th>${t('th_proc','Procedure')}</th><th>${t('th_pipeline_no','Pipeline No.')}</th><th>${t('th_date','Date')}</th><th></th></tr></thead><tbody>${items.length?items.map(w=>{
    const pl=getPipeline(w.pipelineId);
    const between=w.materialIds.map(id=>{const m=getMaterial(id); return m?m.piece+' ('+posLetter(m.position)+')':'?';}).join(' \u2194 ');
    return `<tr><td class="col-mono">${escapeHtml(w.weldNo)}</td><td>${escapeHtml(between)}</td><td class="col-mono">${escapeHtml(w.procedure)||'\u2014'}</td><td>${pl?escapeHtml(pl.no):'\u2014'}</td><td class="col-mono">${w.date?formatDate(w.date):'\u2014'}</td><td class="col-actions"><button class="btn-restore" onclick="restoreWeld(${w.id})">${RESTORE_ICON} ${t('restore','Restore')}</button></td></tr>`;
  }).join(''):'<tr class="empty-row"><td colspan="6">'+t('no_archived_welds','No archived welds.')+'</td></tr>'}</tbody></table></div>`;
}
let viewingArchivedClientId=null;
function viewArchivedClient(id){
  viewingArchivedClientId=id;
  const c=DB.clients.find(x=>x.id===id); if(!c) return;
  const prjs=allProjectsForClient(id);
  const container=document.getElementById('archive-expanded');
  container.innerHTML=`<div class="archive-detail-panel">
    <div class="archive-detail-head">
      <div><h2>${escapeHtml(c.name)}</h2><div class="page-subtitle">${escapeHtml(c.street)}, ${escapeHtml(c.zipCode)} ${escapeHtml(c.location)}</div></div>
      <button class="btn-restore" onclick="restoreClient(${c.id})">${RESTORE_ICON} ${t('restore_client','Restore client')}</button>
    </div>
    ${c.remarks?`<div class="archive-detail-remarks">${escapeHtml(c.remarks)}</div>`:''}
    <div class="detail-toolbar"><h2>${t('projects','Projects')} (${prjs.length})</h2></div>
    <div class="table-card"><table class="table-wide"><thead><tr><th>${t('th_ist_project_no','IST Project No.')}</th><th>${t('th_project_title','Project title')}</th><th>${t('th_location','Location')}</th><th>${t('th_status','Status')}</th><th></th></tr></thead><tbody>${prjs.length? prjs.map(p=>`<tr>
        <td class="col-mono">${escapeHtml(p.istProjectNo)||'<span class="muted">\u2014</span>'}</td>
        <td class="col-name">${escapeHtml(p.title)}</td>
        <td>${escapeHtml(p.location)||'<span class="muted">\u2014</span>'}</td>
        <td><span class="status-badge status-${p.status}" style="cursor:default;">${STATUS_LABELS[p.status]||p.status}</span></td>
        <td class="col-actions">${p.archived?`<button class="btn-restore" onclick="restoreProject(${p.id})" style="font-size:0.75rem;padding:3px 10px;">${t('restore','Restore')}</button>`:''}</td>
      </tr>`).join(''):`<tr class="empty-row"><td colspan="5">${t('no_projects_yet','No projects yet.')}</td></tr>`}</tbody></table></div>
  </div>`;
  container.scrollIntoView({behavior:'smooth',block:'start'});
}
async function restoreClient(id){
  const c=DB.clients.find(x=>x.id===id); if(c) c.archived=false;
  const clientProjIds = DB.projects.filter(p=>p.clientId===id).map(p=>p.id);
  DB.projects.filter(p=>p.clientId===id).forEach(p=>p.archived=false);
  DB.pipelines.filter(pl=>clientProjIds.includes(pl.projectId)).forEach(pl=>pl.archived=false);
  try { await apiPost('/clients', {id, archived:false}); } catch(e){ console.error('Restore API error:', e); }
  saveDB(); renderArchivePage();
}
async function restoreProject(id){
  const p=DB.projects.find(x=>x.id===id); if(p) p.archived=false;
  DB.pipelines.filter(pl=>pl.projectId===id).forEach(pl=>pl.archived=false);
  try { await apiPost('/projects', {id, archived:false}); } catch(e){ console.error('Restore API error:', e); }
  saveDB(); renderArchivePage();
}
async function restoreMaterial(id){
  const m=DB.materials.find(x=>x.id===id); if(m) m.archived=false;
  try { await apiPost('/pipeline-materials/'+id, {archived:false}); } catch(e){ console.error('Restore API error:', e); }
  saveDB(); renderArchivePage();
}
async function restorePipeline(id){
  const p=DB.pipelines.find(x=>x.id===id); if(p) p.archived=false;
  try { await apiPost('/pipelines', {id, archived:false}); } catch(e){ console.error('Restore API error:', e); }
  saveDB(); renderArchivePage();
}
async function restoreWeld(id){
  const w=DB.welds.find(x=>x.id===id); if(w) w.archived=false;
  try { await apiPost('/welds', {id, archived:false}); } catch(e){ console.error('Restore API error:', e); }
  saveDB(); renderArchivePage();
}

/* ================================================================ CLIENT DETAIL PAGE ================================================================ */
async function initClientDetailPage(){
  PAGE.name='client-detail'; initDB();
  const id=Number(qp('id'));
  PAGE.clientId=id;
  try {
    const data = await apiGet('/page/client-detail/'+id);
    DB.clients=data.clients||(data.client?[data.client]:[]);
    DB.pipelines=data.pipelines||[];
    DB.projects=normalizeProjects(data.projects||[]);
  } catch(e){ console.error('API error:', e); }
  const cli=getClient(id);
  if(!cli){ renderChrome('clients',t('clients','Clients')); return; }
  projectFilters.clientId=String(id);
  renderChrome('clients',`<a href="index.html">${t('clients','Clients')}</a> / ${escapeHtml(cli.name)}`); mountModals(); wireModalDismiss();
  renderClientDetail();
}
function switchClient(id){ if(id&&Number(id)!==PAGE.clientId) location.href='client-detail.html?id='+id; }
function renderClientDetail(){
  const cli=getClient(PAGE.clientId); if(!cli) return;
  document.getElementById('client-context').innerHTML=`<a href="index.html">${t('clients','Clients')}</a><span class="sep">›</span><span>${escapeHtml(cli.name)}</span>`;
  document.getElementById('client-switch').innerHTML=clients().map(c=>`<option value="${c.id}" ${c.id===cli.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('');
  document.getElementById('client-subtitle').textContent='';
  const item=(k,v,mono)=>`<div class="info-item"><div class="k">${k}</div><div class="v ${mono?'mono':''}">${v}</div></div>`;
  document.getElementById('client-info').innerHTML=item(t('company','Company'),escapeHtml(cli.name))+item(t('th_address','Address'),`${escapeHtml(cli.street)}<br>${escapeHtml(cli.zipCode)} ${escapeHtml(cli.location)}`)+item(t('th_remarks','Remarks'),escapeHtml(cli.remarks)||'—');
  const prjs=clientProjects(cli.id);
  const by=s=>prjs.filter(p=>p.status===s).length;
  document.getElementById('client-detail-stats').innerHTML=tile(prjs.length,t('total_projects','Projects'),'')+tile(by('not-started'),t('status_not_started','Not started'),'t-neutral')+tile(by('ongoing'),t('status_ongoing','Ongoing'),'t-copper')+tile(by('completed'),t('status_completed','Completed'),'t-success');
  document.getElementById('client-edit-btn').onclick=()=>openClientModal(cli.id);
  const tbody=document.getElementById('client-projects-tbody');
  tbody.innerHTML=prjs.length? prjs.map(p=>`<tr>
    <td class="col-mono">${escapeHtml(p.istProjectNo)||'<span class="muted">—</span>'}</td>
    <td class="col-name"><a class="cell-link" href="project-detail.html?id=${p.id}">${escapeHtml(p.title)}</a></td>
    <td>${escapeHtml(p.location)||'<span class="muted">—</span>'}</td>
    <td class="col-mono">${escapeHtml(p.order)||'<span class="muted">—</span>'}</td>
    <td class="col-remarks">${escapeHtml(p.description)||'<span class="muted">—</span>'}</td>
    <td>${p.sharepointFolderUrl?`<a href="${escapeHtml(p.sharepointFolderUrl)}" target="_blank" class="link">${t('view_folder','View folder')}</a>`:`<button class="btn btn-ghost btn-sm" onclick="openFolderPicker(${p.id})">${t('select_folder','Select')}</button>`}</td>
    <td><span class="status-badge status-${p.status}" style="cursor:default;">${STATUS_LABELS[p.status]||p.status}</span></td>
    <td class="col-actions"><a class="btn-link" href="project-detail.html?id=${p.id}">${t('open','Open')}</a><button class="btn-link" onclick="openProjectModal(${p.id})">${t('edit','Edit')}</button>${archiveBtn('project',p.id)}</td>
  </tr>`).join('') : `<tr class="empty-row"><td colspan="8">${t('no_projects_client_yet','No projects for this client yet.')}</td></tr>`;
}

/* ================================================================ PROJECTS PAGE ================================================================ */
let projectFilters={location:'',clientId:'',status:''};
function updateProjectsCrumb(){
  let crumb=t('projects','Projects');
  if(projectFilters.clientId){
    const c=getClient(Number(projectFilters.clientId));
    if(c) crumb=`<a href="index.html">${t('clients','Clients')}</a> / ${escapeHtml(c.name)} / ${t('projects','Projects')}`;
  }
  return crumb;
}
async function initProjectsPage(){
  PAGE.name='projects'; initDB();
  const clientParam=qp('client');
  if(clientParam){
    projectFilters.clientId=clientParam;
    setSharedClientFilter(clientParam);
  } else {
    const saved=getSharedClientFilter();
    if(saved) projectFilters.clientId=saved;
  }
  PAGE.clientId = projectFilters.clientId ? Number(projectFilters.clientId) : null;
  renderChrome('projects',updateProjectsCrumb()); mountModals(); wireModalDismiss();
  buildProjectFilters(); renderProjectsPage();

  try {
    const data = await apiGet('/page/projects');
    DB.clients=data.clients||[];
    DB.pipelines=data.pipelines||[];
    DB.projects=normalizeProjects(data.projects||[]);
    renderChrome('projects',updateProjectsCrumb());
    buildProjectFilters(); renderProjectsPage();
  } catch(e){ console.error('API error:', e); }
}
function buildProjectFilters(){
  const locSel=document.getElementById('filter-location'), cliSel=document.getElementById('filter-client'), stSel=document.getElementById('filter-status');
  locSel.innerHTML='<option value="">All locations</option>'+uniqueLocations().map(l=>`<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
  cliSel.innerHTML='<option value="">All clients</option>'+clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  locSel.value=projectFilters.location; cliSel.value=projectFilters.clientId; stSel.value=projectFilters.status;
}
function onProjectFilterChange(){
  projectFilters.location=document.getElementById('filter-location').value;
  projectFilters.clientId=document.getElementById('filter-client').value;
  projectFilters.status=document.getElementById('filter-status').value;
  PAGE.clientId = projectFilters.clientId ? Number(projectFilters.clientId) : null;
  setSharedClientFilter(projectFilters.clientId);
  setSharedProjectFilter('');
  renderChrome('projects',updateProjectsCrumb());
  renderProjectsPage();
}
function clearProjectFilters(){
  projectFilters={location:'',clientId:'',status:''};
  PAGE.clientId = null;
  setSharedClientFilter('');
  setSharedProjectFilter('');
  renderChrome('projects',t('projects','Projects'));
  buildProjectFilters();
  renderProjectsPage();
}
function renderProjectsPage(){
  const by=s=>projects().filter(p=>p.status===s).length;
  document.getElementById('projects-stats').innerHTML=tile(projects().length,t('total_projects','Total projects'),'')+tile(by('not-started'),t('status_not_started','Not started'),'t-neutral')+tile(by('ongoing'),t('status_ongoing','Ongoing'),'t-copper')+tile(by('completed'),t('status_completed','Completed'),'t-success');
  const tbody=document.getElementById('projects-tbody');
  const filtered=projects().filter(p=>{ if(projectFilters.location&&p.location!==projectFilters.location) return false; if(projectFilters.clientId&&p.clientId!==Number(projectFilters.clientId)) return false; if(projectFilters.status&&p.status!==projectFilters.status) return false; return true; });
  tbody.innerHTML=filtered.length? filtered.map(p=>`<tr>
    <td class="col-mono">${escapeHtml(p.istProjectNo)||'<span class="muted">—</span>'}</td>
    <td class="col-name"><a class="cell-link" href="project-detail.html?id=${p.id}">${escapeHtml(p.title)}</a></td>
    <td>${escapeHtml(p.location)||'<span class="muted">—</span>'}</td>
    <td><a class="cell-link" href="projects.html?client=${p.clientId}">${escapeHtml(getClientName(p.clientId))}</a></td>
    <td class="col-mono">${escapeHtml(p.order)||'<span class="muted">—</span>'}</td>
    <td class="col-remarks">${escapeHtml(p.description)||'<span class="muted">—</span>'}</td>
    <td>${p.sharepointFolderUrl?`<a href="${escapeHtml(p.sharepointFolderUrl)}" target="_blank" class="link">${t('view_folder','View folder')}</a>`:`<button class="btn btn-ghost btn-sm" onclick="openFolderPicker(${p.id})">${t('select_folder','Select')}</button>`}</td>
    <td><span class="status-badge status-${p.status}" style="cursor:default;">${STATUS_LABELS[p.status]||p.status}</span></td>
    <td class="col-actions"><a class="btn-link" href="project-detail.html?id=${p.id}">${t('open','Open')}</a><button class="btn-link" onclick="openProjectModal(${p.id})">${t('edit','Edit')}</button>${archiveBtn('project',p.id)}</td>
  </tr>`).join('') : `<tr class="empty-row"><td colspan="8">${projects().length===0?t('no_projects_yet','No projects yet.'):t('no_projects_match_filters','No projects match your filters.')}</td></tr>`;
}

/* ================================================================ PIPELINES PAGE ================================================================ */
let pipeFilter=null;
let pipeFilters={clientId:'',projectId:'',welderId:'',inspectorId:'',status:'',procedure:'',plant:'',search:''};
function updatePipelinesCrumb(){
  let crumb=t('pipelines','Pipelines');
  if(pipeFilters.projectId){
    const p=getProject(Number(pipeFilters.projectId));
    if(p) crumb=`<a href="projects.html">${t('projects','Projects')}</a> / ${escapeHtml(p.title)} / ${t('pipelines','Pipelines')}`;
  } else if(pipeFilters.clientId){
    const c=getClient(Number(pipeFilters.clientId));
    if(c) crumb=`<a href="index.html">${t('clients','Clients')}</a> / ${escapeHtml(c.name)} / ${t('pipelines','Pipelines')}`;
  }
  return crumb;
}
async function initPipelinesPage(){
  PAGE.name='pipelines'; initDB();
  const projectParam=qp('project'), clientParam=qp('client');
  if(projectParam){
    pipeFilters.projectId=projectParam;
    setSharedProjectFilter(projectParam);
    const p=getProject(Number(projectParam));
    if(p){
      pipeFilters.clientId=String(p.clientId);
      setSharedClientFilter(String(p.clientId));
    }
  } else {
    const savedProject=getSharedProjectFilter();
    if(savedProject) pipeFilters.projectId=savedProject;
  }
  if(clientParam){
    pipeFilters.clientId=clientParam;
    setSharedClientFilter(clientParam);
  } else if(!pipeFilters.clientId){
    const savedClient=getSharedClientFilter();
    if(savedClient) pipeFilters.clientId=savedClient;
  }
  PAGE.clientId = pipeFilters.clientId ? Number(pipeFilters.clientId) : null;
  PAGE.projectId = pipeFilters.projectId ? Number(pipeFilters.projectId) : null;
  pipeFilter=null;
  renderChrome('pipelines',updatePipelinesCrumb()); mountModals(); wireModalDismiss(); buildPipeFilters(); renderPipelinesPage();

  try {
    const data = await apiGet('/page/pipelines');
    DB.clients=data.clients||[]; DB.projects=normalizeProjects(data.projects||[]); DB.pipelines=data.pipelines||[];
    renderChrome('pipelines',updatePipelinesCrumb());
    buildPipeFilters(); renderPipelinesPage();
  } catch(e){ console.error('API error:', e); }
}
function buildPipeFilters(){
  const cli=document.getElementById('pf-client'); if(!cli) return;
  cli.innerHTML='<option value="">'+t('all_clients','All clients')+'</option>'+clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  const prjSel=document.getElementById('pf-project');
  if(prjSel){
    const prjList=pipeFilters.clientId?projects().filter(p=>p.clientId===Number(pipeFilters.clientId)):projects();
    prjSel.innerHTML='<option value="">'+t('all_projects','All projects')+'</option>'+prjList.map(p=>`<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');
    prjSel.value=pipeFilters.projectId;
  }
  document.getElementById('pf-status').innerHTML='<option value="">'+t('all_statuses','All statuses')+'</option>'+PIPE_STATUS.map((s,i)=>`<option value="${i}">${escapeHtml(s)}</option>`).join('');
  const plants=[...new Set(pipelines().map(p=>p.plant).filter(Boolean))].sort();
  document.getElementById('pf-plant').innerHTML='<option value="">All plants</option>'+plants.map(p=>`<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  document.getElementById('pf-client').value=pipeFilters.clientId;
  document.getElementById('pf-status').value=pipeFilters.status; document.getElementById('pf-plant').value=pipeFilters.plant;
  const s=document.getElementById('pf-search'); if(s) s.value=pipeFilters.search;
}
function onPipeFilterChange(){
  const newClient=document.getElementById('pf-client').value;
  const clientChanged=newClient!==pipeFilters.clientId;
  pipeFilters.clientId=newClient;
  pipeFilters.status=document.getElementById('pf-status').value;
  pipeFilters.plant=document.getElementById('pf-plant').value;
  const prjSel=document.getElementById('pf-project');
  if(clientChanged && prjSel){ pipeFilters.projectId=''; /* rebuild project list for new client */
    const prjList=pipeFilters.clientId?projects().filter(p=>p.clientId===Number(pipeFilters.clientId)):projects();
    prjSel.innerHTML='<option value="">'+t('all_projects','All projects')+'</option>'+prjList.map(p=>`<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');
  } else if(prjSel){ pipeFilters.projectId=prjSel.value; }
  PAGE.clientId = pipeFilters.clientId ? Number(pipeFilters.clientId) : null;
  PAGE.projectId = pipeFilters.projectId ? Number(pipeFilters.projectId) : null;
  setSharedClientFilter(pipeFilters.clientId);
  setSharedProjectFilter(pipeFilters.projectId);
  pipeFilter=null;
  renderChrome('pipelines',updatePipelinesCrumb());
  renderPipelinesPage();
}
function onPipeSearchInput(v){ pipeFilters.search=v; renderPipelinesPage(); }
function clearPipeFilters(){
  pipeFilters={clientId:'',projectId:'',welderId:'',inspectorId:'',status:'',procedure:'',plant:'',search:''};
  pipeFilter=null;
  PAGE.clientId = null;
  PAGE.projectId = null;
  setSharedClientFilter('');
  setSharedProjectFilter('');
  renderChrome('pipelines',t('pipelines','Pipelines'));
  buildPipeFilters();
  renderPipelinesPage();
}
function renderPipelinesPage(){
  const by=s=>pipelines().filter(p=>p.status===s).length;
  const expiring=certificates().filter(c=>certStatus(c)==='expiring').length;
  document.getElementById('pipelines-stats').innerHTML=tile(pipelines().length,t('total_pipelines','Total pipelines'),'')+tile(by(0),t('status_not_started','Not started'),'t-neutral')+tile(by(1)+by(2)+by(3)+by(4),t('in_progress','In progress'),'t-copper')+tile(by(5),t('status_completed','Completed'),'t-success')+tile(expiring,t('certs_expiring_30d','Certs expiring ≤30d'),'t-danger');
  const bar=document.getElementById('pipeline-filter-bar');
  bar.innerHTML='';
  const list=pipelines().filter(pl=>{
    // toolbar filters
    if(pipeFilters.projectId && pl.projectId!==Number(pipeFilters.projectId)) return false;
    if(pipeFilters.clientId){ const pr=getProject(pl.projectId); if(!(pr&&pr.clientId===Number(pipeFilters.clientId))) return false; }
    if(pipeFilters.welderId && !(pl.welderIds||[]).includes(Number(pipeFilters.welderId))) return false;
    if(pipeFilters.inspectorId && !(pl.inspectorIds||[]).includes(Number(pipeFilters.inspectorId))) return false;
    if(pipeFilters.status!=='' && pl.status!==Number(pipeFilters.status)) return false;
    if(pipeFilters.procedure && pl.procNo!==pipeFilters.procedure) return false;
    if(pipeFilters.plant && pl.plant!==pipeFilters.plant) return false;
    if(pipeFilters.search && !String(pl.no).toLowerCase().includes(pipeFilters.search.toLowerCase())) return false;
    return true;
  });
  const tbody=document.getElementById('pipelines-tbody');
  tbody.innerHTML=list.length? list.map(pl=>{
    const pr=getProject(pl.projectId), cli=pr?getClient(pr.clientId):null;
    const projLabel=pr?`${escapeHtml(pr.title)}${pr.order?' - '+escapeHtml(pr.order):''}`:'—';
    return `<tr class="clickable-row" onclick="rowToDetail(event,${pl.id})">
      <td><a class="pipe-no" href="pipeline-detail.html?id=${pl.id}">${escapeHtml(pl.no)}</a></td>
      <td>${pr?`<a class="cell-link" href="pipelines.html?project=${pr.id}">${projLabel}</a>`:'<span class="muted">—</span>'}</td>
      <td>${cli?`<a class="cell-link" href="projects.html?client=${cli.id}">${escapeHtml(cli.name)}</a>`:'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml(pl.plant)||'<span class="muted">—</span>'}</td>
      <td>${statusPill(pl.status)}</td>
      <td>${docCell(pl)}</td>
      <td class="col-actions"><a class="btn-link" href="pipeline-detail.html?id=${pl.id}" data-i18n="details">${t('details','Details')}</a><button class="btn-link" onclick="openPipelineModal(${pl.id})" data-i18n="edit">${t('edit','Edit')}</button>${archiveBtn('pipeline',pl.id)}</td>
    </tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="7">${pipelines().length===0?t('no_pipelines_yet','No pipelines yet.'):t('no_pipelines_match_filter','No pipelines match this filter.')}</td></tr>`;
}
function rowToDetail(event,id){ if(event.target.closest('a,button,.cell-link,.person-name,.plus-badge,.doc-chip,.pipe-no')) return; location.href='pipeline-detail.html?id='+id; }
function rowToClientDetail(event,id){ if(event.target.closest('a,button,.cell-link,.btn-link,.btn-archive')) return; location.href='client-detail.html?id='+id; }
function showPipelinePeople(plId,kind){ const pl=getPipeline(plId); const ids=kind==='welder'?pl.welderIds:pl.inspectorIds; renderPeoplePopup((kind==='welder'?t('welders_on','Welders on '):t('inspectors_on','Inspectors on '))+pl.no, ids, pl.status); }
function showWeldPeople(weldId,kind){ const w=getWeld(weldId); const pl=getPipeline(w.pipelineId); const ids=kind==='welder'?w.welderIds:w.inspectorIds; renderPeoplePopup((kind==='welder'?t('welders_on','Welders on '):t('inspectors_on','Inspectors on '))+w.weldNo, ids, pl.status); }

/* ================================================================ PIPELINE DETAIL PAGE ================================================================ */
let detailView='materials';
async function initPipelineDetailPage(){
  PAGE.name='pipeline-detail'; initDB();
  PAGE.pipelineId=Number(qp('id'));
  try {
    // Single API call — server JOINs everything in fewer DB round-trips
    const data = await apiGet('/pipeline-detail/'+PAGE.pipelineId);
    DB.clients=data.client?[data.client]:[];
    DB.projects=normalizeProjects(data.project?[data.project]:[]);
    DB.pipelines=data.pipelines||[];
    DB.materials=normalizeMaterials(data.materials||[]);
    DB.welds=normalizeWelds(data.welds||[]);
    DB.projectMaterials=data.projectMaterials||[];
    DB.globalMaterials=data.globalMaterials||[];
    if(data.welders && data.welders.length){
      DB.people=data.welders;
      DB.certificates=[];
      data.welders.forEach(w=>{
        (w.certificates||[]).forEach(c=>{
          DB.certificates.push({id:c.id, personId:w.id, certNo:c.certNo, process:c.process, standard:c.standard, validUntil:c.validUntil, renewalDue:c.renewalDue, certPdfUrl:c.certPdfUrl});
        });
      });
    }
    rebuildRelationships();
  } catch(e){ console.error('API error:', e); }
  const tab=qp('tab'); if(tab==='weldlist'||tab==='materials') detailView=tab; else detailView='materials';
  const pl=getPipeline(PAGE.pipelineId);
  if(!pl){ renderChrome('pipelines','Pipelines'); return; }
  const pr=getProject(pl.projectId);
  PAGE.projectId=pl.projectId;
  if(pr) PAGE.clientId=pr.clientId;
  renumberWelds(PAGE.pipelineId); saveDB();
  renderChrome('pipelines',`<a href="pipelines.html">${t('pipelines','Pipelines')}</a> / ${escapeHtml(pl.no)}`); mountModals(); wireModalDismiss();
  renderPipelineDetail();
  const seam=qp('seam'); if(seam){ const w=getWeld(Number(seam)); if(w&&w.pipelineId===PAGE.pipelineId) showSeamDetail(w.id); }

  // Background: load welders & global materials for modals if not already cached
  if(!DB.people || !DB.people.length){
    loadWeldersFromApi().catch(()=>{});
  }
  if(!DB.globalMaterials || !DB.globalMaterials.length){
    apiGet('/global-materials').then(gms=>{ DB.globalMaterials = gms || []; }).catch(()=>{});
  }
}
function switchPipeline(id){ if(id&&Number(id)!==PAGE.pipelineId) location.href='pipeline-detail.html?id='+id; }
function renderPipelineDetail(){
  const pl=getPipeline(PAGE.pipelineId); if(!pl) return;
  const pr=getProject(pl.projectId), cli=pr?getClient(pr.clientId):null;
  document.getElementById('detail-context').innerHTML=`${cli?`<a href="projects.html?client=${cli.id}">${escapeHtml(cli.name)}</a>`:''}<span class="sep">›</span>${pr?`<a href="project-detail.html?id=${pr.id}">${escapeHtml(pr.title)}</a>`:''}<span class="sep">›</span><span>${escapeHtml(pl.no)}</span>`;
  // pipeline switcher: sibling pipelines within the same project
  const siblings=pr?projectPipelines(pr.id):[pl];
  document.getElementById('pipeline-switch').innerHTML=siblings.map(s=>`<option value="${s.id}" ${s.id===pl.id?'selected':''}>${escapeHtml(s.no)}</option>`).join('');
  document.getElementById('detail-subtitle').textContent=`${pr?pr.title:'—'}${pr&&pr.order?` · ${t('order_number','Order')} `+pr.order:''}${siblings.length>1?` · ${siblings.length} ${t('pipelines_in_project','pipelines in this project')}`:''}`;
  const item=(k,v,mono)=>`<div class="info-item"><div class="k">${k}</div><div class="v ${mono?'mono':''}">${v}</div></div>`;
  let infoHtml=item(t('client','Client'),cli?escapeHtml(cli.name):'—')+item(t('order_number','Order number'),pr&&pr.order?escapeHtml(pr.order):'—',true)+item(t('plant','Plant'),escapeHtml(pl.plant)||'—',true)+item(t('status','Status'),statusPill(pl.status));
  if(pl.status>=4){
    if(pl.weldingStart) infoHtml+=item(t('welding_start_date','Welding start'),formatDate(pl.weldingStart),true);
    if(pl.weldingEnd) infoHtml+=item(t('welding_completion_date','Welding completion'),formatDate(pl.weldingEnd),true);
  }
  document.getElementById('detail-info').innerHTML=infoHtml;
  renderWorkflowBar(pl); renderMaterialsList(); renderWeldList(); renderMarkDoneBars(pl); showDetailView(detailView);
}
function renderWorkflowBar(pl){
  const steps=[t('material_list','Material list'),t('weld_list','Weld list'),t('welder_doc','Welder doc'),t('welding_details','Welding details'),t('export','Export')];
  let html='<div class="workflow-bar">';
  steps.forEach((s,i)=>{ const stage=i+1; const cls=pl.status>=stage?'done':(pl.status===i?'current':''); const mark=pl.status>=stage?'✓':stage;
    html+=`<div class="workflow-step ${cls}"><span class="step-dot">${mark}</span>${s}</div>`;
    if(i<steps.length-1) html+='<span class="workflow-arrow">→</span>'; });
  // contextual next action for pipeline-level stages
  let action='';
  const isExporting = _exportingFinalPipelines.has(pl.id);
  if(pl.status===2) action=`<button class="btn btn-primary btn-sm" onclick="downloadBuilderDoc(${pl.id})">${t('download_builder_doc','Download welder document')}</button>`;
  else if(pl.status===3) action=`<button class="btn btn-primary btn-sm" onclick="openWeldingUpdate(${pl.id})">${t('update_welding_details','Update welding details')}</button>`;
  else if(pl.status===4){
    if(isExporting){
      action=`<button class="btn btn-success btn-sm is-loading" disabled style="display:inline-flex;align-items:center;gap:6px;cursor:wait;"><span class="doc-spinner"></span> <span>${t('exporting','Exporting PDF…')}</span></button>`;
    } else {
      action=`<button class="btn btn-success btn-sm" onclick="openExportFinalModal(${pl.id})">${t('export_final_doc','Export final document')}</button>`;
    }
  }
  else if(pl.status===5) action=`<span class="done-chip"><svg viewBox="0 0 24 24" fill="none"><path d="m5 13 4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg> ${t('exported_complete','Exported · complete')}</span>`;
  html+=`<span style="flex:1"></span>${action}</div>`;
  document.getElementById('detail-workflow').innerHTML=html;
}
function renderMarkDoneBars(pl){
  const doneChip=text=>`<span class="done-chip"><svg viewBox="0 0 24 24" fill="none"><path d="m5 13 4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg> ${text}</span>`;
  // material list mark-done
  const mm=document.getElementById('materials-markdone');
  if(pl.status===0){
    const mats=pipelineMaterials(pl.id);
    const hasStart=mats.some(m=>m.startOfPlumbing);
    if(!mats.length){
      mm.innerHTML=`<div class="mark-done-bar"><div class="md-text">Add materials to the pipeline first before marking as done.</div><button class="btn btn-success" disabled>${t('mark_mat_done','Mark material list as done')}</button></div>`;
    } else if(!hasStart){
      mm.innerHTML=`<div class="mark-done-bar"><div class="md-text">Cannot mark as done — missing <strong>start of plumbing</strong>. Assign start of plumbing to a material first.</div><button class="btn btn-success" disabled>${t('mark_mat_done','Mark material list as done')}</button></div>`;
    } else {
      mm.innerHTML=`<div class="mark-done-bar"><div class="md-text">Finished building the master parts list? <strong>Mark it as done</strong> to move this pipeline to weld list creation.</div><button class="btn btn-success" onclick="markMaterialDone(${pl.id})">${t('mark_mat_done','Mark material list as done')}</button></div>`;
    }
  } else mm.innerHTML=`<div class="mark-done-bar"><div class="md-text">${doneChip(t('mat_list_marked_done','Material list marked as done'))}</div></div>`;
  // weld list mark-done (enabled only once material list is done)
  const wm=document.getElementById('weldlist-markdone');
  if(pl.status===0) wm.innerHTML=`<div class="mark-done-bar"><div class="md-text">Complete and mark the <strong>material list</strong> as done first — then you can finalise the weld list.</div><button class="btn btn-success" disabled>${t('mark_weld_done','Mark weld list as done')}</button></div>`;
  else if(pl.status===1) wm.innerHTML=`<div class="mark-done-bar"><div class="md-text">All seams recorded? <strong>Mark the weld list as done</strong> to make the welder document available.</div><button class="btn btn-success" onclick="markWeldlistDone(${pl.id})">${t('mark_weld_done','Mark weld list as done')}</button></div>`;
  else wm.innerHTML=`<div class="mark-done-bar"><div class="md-text">${doneChip(t('weld_list_marked_done','Weld list marked as done'))}</div></div>`;
}
function showDetailView(view){
  detailView=view;
  document.getElementById('detail-materials').style.display=view==='materials'?'block':'none';
  document.getElementById('detail-weldlist').style.display=view==='weldlist'?'block':'none';
  document.getElementById('detail-combined').style.display=view==='combined'?'block':'none';
  document.getElementById('detail-seam').style.display=view==='seam'?'block':'none';
  document.getElementById('subtab-materials').classList.toggle('active',view==='materials');
  document.getElementById('subtab-weldlist').classList.toggle('active',view==='weldlist'||view==='seam');
  document.getElementById('subtab-combined').classList.toggle('active',view==='combined');
  if(view==='combined') renderCombinedView();
}
function materialConnError(m, allMats){
  if(!m) return false;
  const conns=(m.connections||[]).length;
  const piece=(m.piece||m.category||'').toLowerCase();
  if(piece==='welding wire' || piece==='blind flange') return false;
  const isFirst=allMats.length<=1;
  if(isFirst) return false;
  const required=requiredWelds(piece);
  if(required<=0) return false;
  /* start/end pieces need one less connection, but only if they have more than 1 weld */
  let adjusted=required;
  if(m.startOfPlumbing && required>1) adjusted=Math.max(1,required-1);
  if(m.endOfPlumbing && required>1) adjusted=Math.max(1,required-1);
  if(m.startOfPlumbing && m.endOfPlumbing) adjusted=0;
  return conns<adjusted || conns>required;
}
/* Categories that must have matching DN on all connections (single-DN pieces) */
const SINGLE_DN_PIECES = ["pipe","flange","blind flange","elbow","equipment"];
function materialDnMismatch(m){
  if(!m.dimension || !m.connections || !m.connections.length) return false;
  const myPiece=(m.piece||m.category||'').toLowerCase();
  if(!SINGLE_DN_PIECES.includes(myPiece)) return false;
  return m.connections.some(cid=>{
    const c=getMaterial(cid); if(!c || !c.dimension) return false;
    const cPiece=(c.piece||c.category||'').toLowerCase();
    if(!SINGLE_DN_PIECES.includes(cPiece)) return false;
    return m.dimension!==c.dimension;
  });
}
function renderMaterialsList(){
  const tbody=document.getElementById('materials-tbody'); const allRows=pipelineMaterials(PAGE.pipelineId);
  const isWire=m=>(m.piece||m.category||'').toLowerCase()==='welding wire';
  const rows=allRows.filter(m=>!isWire(m));
  const wireRows=allRows.filter(m=>isWire(m));
  /* find the max number of DN fields used by any material */
  let maxDn=1;
  rows.forEach(m=>{ for(let i=2;i<=6;i++){ if(m[`dimension${i}`]) maxDn=Math.max(maxDn,i); } });
  tbody.innerHTML=rows.length? rows.map(m=>{
    const flags=[m.startOfPlumbing?'start':'',m.endOfPlumbing?'end':''].filter(Boolean).join(' · ');
    const hasErr=materialConnError(m, rows);
    const dnWarn=materialDnMismatch(m);
    const connCount=(m.connections||[]).length;
    const piece=m.piece||m.category||'';
    const maxWelds=requiredWelds(piece);
    let adjusted=maxWelds;
    if(m.startOfPlumbing && maxWelds>1) adjusted=Math.max(1,adjusted-1);
    if(m.endOfPlumbing && maxWelds>1) adjusted=Math.max(1,adjusted-1);
    if(m.startOfPlumbing && m.endOfPlumbing) adjusted=0;
    const canDrag=maxWelds<3;
    let extraDnCells='';
    for(let i=2;i<=maxDn;i++){
      extraDnCells+=`<td class="col-mono">${m[`dimension${i}`]?escapeHtml(m[`dimension${i}`]):'<span class="muted">—</span>'}</td>`;
    }
    return `<tr${hasErr?' class="row-error"':''} data-mat-id="${m.id}" ${canDrag?'draggable="true" ondragstart="onMatDragStart(event,'+m.id+')"':''} ondragover="onMatDragOver(event)" ondrop="onMatDrop(event,${m.id})">
      <td class="col-mono">${canDrag?'<span class="drag-handle" title="Drag to reorder">⠿</span> ':''}${posLetter(m.position)}${flags?`<span class="person-sub">${flags}</span>`:''}</td>
      <td>${escapeHtml(piece)}</td>
      <td><a class="cell-link" href="material-detail.html?id=${m.id}">${escapeHtml(m.itemDescription)}</a></td>
      <td class="col-mono${dnWarn?' dn-warn':''}">${escapeHtml(m.dimension)}</td>${extraDnCells}
      <td class="col-mono">${m.diameter?fmtDia(m.diameter):'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml(m.thickness)||'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml(m.dienNo)||'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml(m.surface)||'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml(m.materialCode)}</td><td>${escapeHtml(m.certificate)}</td>
      <td class="col-mono">${escapeHtml(m.heatNo)}</td>
      <td>${m.wazNo?`<button class="doc-chip doc-weld" onclick="showWaz(${m.id})" title="View WAZ PDF">${escapeHtml(m.wazNo)}</button><button class="btn-link btn-edit-inline" onclick="openEditWazModal(${m.id})" title="Edit WAZ">✎</button>`:`<button class="btn btn-primary btn-sm" onclick="openAddWazModal(${m.id})">+</button>`}</td>
      <td><a class="img-btn" href="material-detail.html?id=${m.id}">${t('welds','Welds')}</a></td>
      <td class="col-actions"><button class="btn-link" onclick="openMaterialModal(${m.id})">${t('edit','Edit')}</button>${archiveBtn('material',m.id)}</td>
    </tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="${14+(maxDn-1)}">${t('no_materials_yet','No project materials yet. Click "+ Add material" to add one.')}</td></tr>`;
  /* update table header to include DN columns dynamically */
  const thead=tbody.closest('table').querySelector('thead tr');
  if(thead){
    let dnHeader=maxDn>1?'<th>DN 1</th>':'<th>DN</th>';
    for(let i=2;i<=maxDn;i++) dnHeader+=`<th>DN ${i}</th>`;
    thead.innerHTML=`<th>${t('th_pos','Pos.')}</th><th>${t('th_category','Category')}</th><th>${t('th_item_description','Item description')}</th>${dnHeader}<th>${t('th_diameter','Diameter')}</th><th>${t('th_thickness','Thickness')}</th><th>${t('th_din_en_no','DIN EN No.')}</th><th>${t('th_surface','Surface')}</th><th>${t('th_material','Material')}</th><th>${t('th_certificate','Certificate')}</th><th>${t('th_heat_no','Heat No.')}</th><th>${t('th_waz_no','WAZ No.')}</th><th>${t('th_welds','Welds')}</th><th></th>`;
  }
  // Welding Wire table
  const wireSection=document.getElementById('welding-wire-section');
  if(wireSection){
    wireSection.innerHTML=wireRows.length?`<h3 style="margin-top:24px;">${t('th_welding_wire','Welding Wire')}</h3><div class="table-card"><table class="table-wide"><thead><tr><th>${t('th_pos','Pos.')}</th><th>${t('th_item_description','Item description')}</th><th>${t('th_material','Material')}</th><th>${t('th_diameter','Diameter')}</th><th>${t('th_surface','Surface')}</th><th>${t('th_certificate','Certificate')}</th><th>${t('th_heat_no','Heat No.')}</th><th>${t('th_waz_no','WAZ No.')}</th><th></th></tr></thead><tbody>${wireRows.map(m=>`<tr>
      <td class="col-mono">${posLetter(m.position)}</td>
      <td>${escapeHtml(m.itemDescription)}</td>
      <td class="col-mono">${escapeHtml(m.materialCode)}</td>
      <td class="col-mono">${m.diameter?fmtDia(m.diameter):'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml(m.surface)||'<span class="muted">—</span>'}</td>
      <td>${escapeHtml(m.certificate)}</td>
      <td class="col-mono">${escapeHtml(m.heatNo)}</td>
      <td>${m.wazNo?`<button class="doc-chip doc-weld" onclick="showWaz(${m.id})" title="View WAZ PDF">${escapeHtml(m.wazNo)}</button><button class="btn-link btn-edit-inline" onclick="openEditWazModal(${m.id})" title="Edit WAZ">✎</button>`:`<button class="btn btn-primary btn-sm" onclick="openAddWazModal(${m.id})">+</button>`}</td>
      <td class="col-actions"><button class="btn-link" onclick="openMaterialModal(${m.id})">${t('edit','Edit')}</button>${archiveBtn('material',m.id)}</td>
    </tr>`).join('')}</tbody></table></div>`:'';
  }
}
/* ---- Drag & Drop for material reordering ---- */
let _dragMatId=null;
function onMatDragStart(e,matId){
  _dragMatId=matId;
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain',String(matId));
  e.currentTarget.style.opacity='0.5';
  setTimeout(()=>{ if(e.currentTarget) e.currentTarget.style.opacity=''; },300);
}
function onMatDragOver(e){ e.preventDefault(); e.dataTransfer.dropEffect='move'; }
async function onMatDrop(e,targetMatId){
  e.preventDefault();
  if(!_dragMatId || _dragMatId===targetMatId) return;
  const dragged=getMaterial(_dragMatId);
  const target=getMaterial(targetMatId);
  if(!dragged || !target || dragged.pipelineId!==target.pipelineId) return;
  const pipeId=dragged.pipelineId;
  const mats=pipelineMaterials(pipeId).filter(m=>(m.piece||'').toLowerCase()!=='welding wire');
  /* Remember dragged material's old neighbors before removing connections */
  const oldConns=(dragged.connections||[]).slice();
  const oldPos=dragged.position;
  const sortedBefore=mats.slice().sort((a,b)=>a.position-b.position);
  const oldIdx=sortedBefore.findIndex(m=>m.id===dragged.id);
  const oldPrev=oldIdx>0?sortedBefore[oldIdx-1]:null;
  const oldNext=oldIdx<sortedBefore.length-1?sortedBefore[oldIdx+1]:null;
  /* Remove all connections and welds from the dragged material */
  oldConns.forEach(cid=>{
    const c=getMaterial(cid);
    if(c) c.connections=(c.connections||[]).filter(id=>id!==dragged.id);
    const wIdx=DB.welds.findIndex(w=>w.pipelineId===pipeId && w.materialIds.includes(dragged.id) && w.materialIds.includes(cid));
    if(wIdx!==-1) DB.welds.splice(wIdx,1);
  });
  dragged.connections=[];
  /* Reconnect old neighbors to each other (fill the gap left by dragged) */
  if(oldPrev && oldNext && oldConns.includes(oldPrev.id) && oldConns.includes(oldNext.id)){
    if(!(oldPrev.connections||[]).includes(oldNext.id)){
      oldPrev.connections=oldPrev.connections||[]; oldPrev.connections.push(oldNext.id);
      oldNext.connections=oldNext.connections||[]; oldNext.connections.push(oldPrev.id);
      ensureWeldForPair(pipeId,oldPrev.id,oldNext.id);
    }
  }
  /* Reorder: move dragged to target's position */
  const newPos=target.position;
  if(oldPos<newPos){
    mats.filter(m=>m.position>oldPos&&m.position<=newPos).forEach(m=>m.position--);
  } else {
    mats.filter(m=>m.position>=newPos&&m.position<oldPos).forEach(m=>m.position++);
  }
  dragged.position=newPos;
  /* Handle start of plumbing (end stays where it was manually set) */
  const sorted=mats.slice().sort((a,b)=>a.position-b.position);
  const idx=sorted.findIndex(m=>m.id===dragged.id);
  const hadStart=sorted.some(m=>m.startOfPlumbing);
  /* Clear start from dragged (it will be reassigned if needed) */
  dragged.startOfPlumbing=false;
  /* Keep end as-is — do not clear or reassign */
  /* If dropped at first position AND there was already a start, take over start */
  if(idx===0 && hadStart){
    mats.forEach(m=>m.startOfPlumbing=false);
    dragged.startOfPlumbing=true;
  }
  /* Ensure there's always a start (first item) if one existed before */
  if(hadStart && !sorted.some(m=>m.startOfPlumbing)){ sorted[0].startOfPlumbing=true; }
  /* Find new neighbors */
  const prev=idx>0?sorted[idx-1]:null;
  const next=idx<sorted.length-1?sorted[idx+1]:null;
  const maxWelds=requiredWelds(dragged.piece);
  /* Skip connections for pieces with 0 welds */
  if(maxWelds>0){
    /* Determine which sides to connect based on start/end and max welds */
    const connectPrev=prev && !dragged.startOfPlumbing;
    const connectNext=next && !dragged.endOfPlumbing && (maxWelds>1 || !connectPrev);
    /* Break prev-next connection if we're inserting between them */
    if(connectPrev && next && (prev.connections||[]).includes(next.id)){
      prev.connections=prev.connections.filter(id=>id!==next.id);
      next.connections=(next.connections||[]).filter(id=>id!==prev.id);
      const wIdx=DB.welds.findIndex(w=>w.pipelineId===pipeId&&w.materialIds.includes(prev.id)&&w.materialIds.includes(next.id));
      if(wIdx!==-1) DB.welds.splice(wIdx,1);
    }
    /* Connect to previous neighbor */
    if(connectPrev){
      dragged.connections.push(prev.id);
      prev.connections=prev.connections||[];
      if(!prev.connections.includes(dragged.id)) prev.connections.push(dragged.id);
      ensureWeldForPair(pipeId,dragged.id,prev.id);
    }
    /* Connect to next neighbor */
    if(connectNext){
      dragged.connections.push(next.id);
      next.connections=next.connections||[];
      if(!next.connections.includes(dragged.id)) next.connections.push(dragged.id);
      ensureWeldForPair(pipeId,dragged.id,next.id);
    }
  }
  renumberWelds(pipeId);
  saveDB();
  _dragMatId=null;
  rerenderPage();
  /* Sync reorder to backend and reload */
  try {
    const allMats=pipelineMaterials(pipeId);
    const payload={ pipelineId:pipeId, materials:allMats.map(m=>({
      id:m.id, position:posLetter(m.position),
      connections:(m.connections||[]).map(cid=>{ const c=getMaterial(cid); return c?posLetter(c.position):null; }).filter(Boolean),
      startOfPlumbing:!!m.startOfPlumbing, endOfPlumbing:!!m.endOfPlumbing
    }))};
    await apiPost('/pipeline-materials/reorder', payload);
    /* Reload fresh data */
    const [freshMats, freshWelds] = await Promise.all([
      apiGet('/pipeline-materials?pipelineId='+PAGE.pipelineId),
      apiGet('/welds?pipelineId='+PAGE.pipelineId)
    ]);
    DB.materials=normalizeMaterials(freshMats);
    DB.welds=normalizeWelds(freshWelds);
    rebuildRelationships();
    rerenderPage();
  } catch(e){ console.error('Reorder API error:', e); }
}
/* Show welds for a material — if 1 weld, open edit directly; if multiple, open first seam detail */


function betweenCell(materialIds, useDesc){
  const parts=materialIds.map(mid=>{ const m=getMaterial(mid); if(!m) return '<span class="muted">?</span>'; const label=useDesc?m.itemDescription:m.piece; return `<a class="cell-link" title="${escapeHtml(m.itemDescription)}" href="material-detail.html?id=${m.id}">${escapeHtml(label)} (${posLetter(m.position)})</a>`; });
  return `<div class="between-cell">${parts.join('<span class="between-arrow">→</span>')}</div>`;
}
function renderWeldList(){
  const tbody=document.getElementById('weldlist-tbody'); const pl=getPipeline(PAGE.pipelineId); const rows=pipelineWelds(PAGE.pipelineId);
  tbody.innerHTML=rows.length? rows.map(w=>{
    const photo=w.endoscopyVideoUrl?`<a class="img-btn" href="${escapeHtml(w.endoscopyVideoUrl)}" target="_blank">${t('view','View')}</a>`:'<span class="img-btn empty">—</span>';
    const endo=w.endoscopyImageUrl?`<a class="img-btn" href="${escapeHtml(w.endoscopyImageUrl)}" target="_blank">${t('view','View')}</a>`:'<span class="img-btn empty">—</span>';
    const rem=w.remarks?`<button class="remarks-btn" onclick="showRemarks(${w.id})">${t('view','View')}</button>`:'<span class="remarks-btn none">—</span>';
    return `<tr>
      <td><button class="pipe-no" onclick="showSeamDetail(${w.id})">${escapeHtml(w.weldNo)}</button></td>
      <td>${betweenCell(w.materialIds)}</td>
      <td><span class="type-tag">${escapeHtml(w.type)||'—'}</span></td>
      <td class="col-mono">${escapeHtml(w.procedure)||'—'}</td>
      <td>${weldWireDropdown(w)}</td>
      <td>${weldPersonCell(w,pl,'welder')}</td>
      <td>${weldPersonCell(w,pl,'inspector')}</td>
      <td class="col-mono">${w.date?formatDate(w.date):'—'}</td>
      <td>${photo}</td><td>${endo}</td><td>${rem}</td>
      <td class="col-actions"><button class="btn-link" onclick="showSeamDetail(${w.id})">${t('seam','Seam')}</button><button class="btn-link" onclick="openWeldModal(${w.id})">${t('edit','Edit')}</button>${archiveBtn('weld',w.id)}</td>
    </tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="12">'+t('no_welds_yet','No welds yet — add materials with connections (welds are created automatically) or use \"+ Add weld\".')+'</td></tr>';
}
function showRemarks(weldId){ document.getElementById('remarks-body').textContent=getWeld(weldId).remarks||'—'; openModal('modal-remarks'); }
function weldWireDropdown(w){
  const isWire=m=>(m.piece||m.category||'').toLowerCase().includes('welding') || (m.piece||m.category||'').toLowerCase().includes('wire');
  const wires=pipelineMaterials(PAGE.pipelineId).filter(isWire);
  let selected=w.weldingWireId?getMaterial(w.weldingWireId):null;
  if(!selected && w.weldingWire){
    selected=wires.find(wr=>wr.itemDescription===w.weldingWire || String(wr.id)===String(w.weldingWire)) || null;
    if(selected) w.weldingWireId=selected.id;
  }
  const id=`iwd-${w.id}`;
  if(!wires.length){
    return `<div class="ipd-wrap" id="${id}"><button type="button" class="ipd-btn" onclick="toggleIpd('${id}')" style="color:var(--text-muted);">${t('no_wire_added','No wire added')}</button><div class="ipd-panel"><div class="muted" style="padding:8px;">Add a Welding Wire material first.</div></div></div>`;
  }
  const currentWireId=selected?selected.id:null;
  const opts=wires.map(wr=>`<label class="ipd-item"><input type="radio" name="${id}" value="${wr.id}" ${currentWireId===wr.id?'checked':''} onchange="updateWeldWire(${w.id},${wr.id},'${id}')">${escapeHtml(wr.itemDescription)}${wr.diameter?' ('+escapeHtml(fmtDia(wr.diameter))+')':''}</label>`).join('');
  const noneOpt=`<label class="ipd-item"><input type="radio" name="${id}" value="" ${!currentWireId?'checked':''} onchange="updateWeldWire(${w.id},null,'${id}')">${t('none_opt','— None —')}</label>`;
  if(selected){
    return `<div class="ipd-wrap" id="${id}">${escapeHtml(selected.itemDescription)}<button class="btn-link btn-edit-inline" onclick="event.stopPropagation();toggleIpd('${id}')" title="Change">✎</button><div class="ipd-panel">${noneOpt}${opts}</div></div>`;
  }
  return `<div class="ipd-wrap" id="${id}"><button type="button" class="ipd-btn" onclick="toggleIpd('${id}')">${t('select_opt','Select…')}</button><div class="ipd-panel">${noneOpt}${opts}</div></div>`;
}
async function updateWeldWire(weldId, wireId, wrapperId){
  const w=getWeld(weldId); if(!w) return;
  w.weldingWireId=wireId;
  const wireMat=wireId?getMaterial(wireId):null;
  w.weldingWire=wireMat?wireMat.itemDescription:'';
  try {
    await apiPost('/welds', {
      id: w.id,
      pipelineId: w.pipelineId,
      weldingWire: w.weldingWire
    });
  } catch(e){
    console.error('Failed to update welding wire on weld:', e);
  }
  renderWeldList();
}

/* ================================================================ COMBINED VIEW ================================================================ */
function renderCombinedView(){
  const container=document.getElementById('combined-content');
  const mats=pipelineMaterials(PAGE.pipelineId);
  const wlds=pipelineWelds(PAGE.pipelineId);
  if(!mats.length){ container.innerHTML='<div class="archive-empty-page">'+t('no_materials_yet_add_first','No materials yet — add one first.')+'</div>'; return; }
  const startMat=mats.find(m=>m.startOfPlumbing)||mats[0];
  const branches=[];
  const visited=new Set();
  function walkLine(startId){
    const line=[];
    let current=getMaterial(startId);
    while(current && !visited.has(current.id)){
      visited.add(current.id);
      line.push({type:'material', data:current});
      const conns=(current.connections||[]).map(getMaterial).filter(c=>c&&!visited.has(c.id));
      conns.sort((a,b)=>(a.endOfPlumbing?1:0)-(b.endOfPlumbing?1:0));
      if(conns.length===0) break;
      const next=conns[0];
      /* find weld between current and next */
      const w=wlds.find(wl=>wl.materialIds.includes(current.id)&&wl.materialIds.includes(next.id));
      if(w) line.push({type:'weld', data:w});
      /* queue remaining connections as branches */
      for(let i=1;i<conns.length;i++){
        branches.push({fromMat:current, branchStartId:conns[i].id});
      }
      current=next;
    }
    return line;
  }
  const mainLine=walkLine(startMat.id);
  const branchLines=[];
  while(branches.length){
    const b=branches.shift();
    if(visited.has(b.branchStartId)) continue;
    /* find weld between junction and branch start */
    const junctionWeld=wlds.find(wl=>wl.materialIds.includes(b.fromMat.id)&&wl.materialIds.includes(b.branchStartId));
    const bLine=walkLine(b.branchStartId);
    if(bLine.length) branchLines.push({from:b.fromMat, junctionWeld, line:bLine});
  }
  /* render as table — no branch separators, badge on junction pieces */
  /* track which materials have branches */
  const branchMap={}; /* matId -> [branch index ids] */
  branchLines.forEach((bl,idx)=>{
    if(!branchMap[bl.from.id]) branchMap[bl.from.id]=[];
    branchMap[bl.from.id].push(idx);
  });
  /* Walk any additional segments/unvisited chains */
  const extraLines=[];
  mats.forEach(m=>{
    if(!visited.has(m.id) && (m.piece||'').toLowerCase()!=='welding wire'){
      const eLine=walkLine(m.id);
      if(eLine.length) extraLines.push(eLine);
    }
  });

  let allRows=[];
  mainLine.forEach(item=>allRows.push(item));
  branchLines.forEach(bl=>{
    if(bl.junctionWeld) allRows.push({type:'weld', data:bl.junctionWeld});
    bl.line.forEach(item=>allRows.push(item));
  });
  extraLines.forEach(el=>{
    el.forEach(item=>allRows.push(item));
  });

  /* assign row ids for scroll targets — use the junction weld id */
  let branchWeldIds={}; /* branchIdx -> junction weld id */
  branchLines.forEach((bl,idx)=>{
    if(bl.junctionWeld) branchWeldIds[idx]=bl.junctionWeld.id;
  });

  /* track which material ids belong to branches and their junction label */
  const branchMatIds=new Set();
  const branchMatLabel={}; /* matId -> {fromId, fromPos, weldId} */
  const junctionWeldLabel={}; /* weldId -> {fromPos} — badge for the weld row */
  branchLines.forEach(bl=>{
    const firstMat=bl.line.find(item=>item.type==='material');
    if(firstMat){
      branchMatLabel[firstMat.data.id]={fromId:bl.from.id, fromPos:posLetter(bl.from.position), weldId:bl.junctionWeld?bl.junctionWeld.id:null};
    }
    if(bl.junctionWeld){
      junctionWeldLabel[bl.junctionWeld.id]={fromPos:posLetter(bl.from.position)};
    }
    bl.line.forEach(item=>{ if(item.type==='material') branchMatIds.add(item.data.id); });
  });

  let html=`<div class="table-card"><table class="table-xwide"><thead><tr><th>${t('th_type','Type')}</th><th>${t('th_pos_weld','Pos./Weld')}</th><th>${t('th_item_description','Item description')}</th><th>${t('th_dn','DN')}</th><th>Ø</th><th>${t('th_thk','Thk.')}</th><th>${t('th_ho','H/O')}</th><th>${t('th_wire','Wire')}</th><th>${t('th_welder','Welder')}</th><th>${t('th_inspector','Inspector')}</th></tr></thead><tbody>`;
  allRows.forEach(row=>{
    if(row.type==='material'){
      const m=row.data;
      const dnWarn=materialDnMismatch(m);
      const flags=[m.startOfPlumbing?'start':'',m.endOfPlumbing?'end':''].filter(Boolean).join(', ');
      const isBranch=branchMatIds.has(m.id);
      let badge='';
      if(branchMap[m.id]){
        const bIdxs=branchMap[m.id];
        badge=bIdxs.map(idx=>{
          const weldId=branchWeldIds[idx];
          const targetMat=branchLines[idx]?.line.find(item=>item.type==='material');
          const targetLabel=targetMat?posLetter(targetMat.data.position):'';
          const jWeld=branchLines[idx]?.junctionWeld;
          const weldLabel=jWeld?jWeld.weldNo:'';
          return weldId?`<button class="cv-branch-badge" onclick="jumpToBranch(${weldId})" title="Jump to branch weld">${targetLabel} · W${weldLabel}</button>`:'';
        }).join('');
      }
      let dnDisplay=escapeHtml(m.dimension||'');
      for(let i=2;i<=6;i++){ if(m[`dimension${i}`]) dnDisplay+=' / '+escapeHtml(m[`dimension${i}`]); }
      html+=`<tr class="cv-mat-row" id="cv-row-${m.id}"><td>${t('material','Material')}${badge}</td><td class="col-mono"><strong>${posLetter(m.position)}</strong>${flags?' <span class="cv-table-flag">('+flags+')</span>':''}</td><td>${escapeHtml(m.itemDescription)}</td><td class="col-mono${dnWarn?' dn-warn':''}">${dnDisplay}</td><td class="col-mono">${m.diameter?fmtDia(m.diameter):''}</td><td class="col-mono">${escapeHtml(m.thickness)||''}</td><td></td><td></td><td></td><td></td></tr>`;
    } else if(row.type==='weld'){
      const w=row.data;
      const wire=w.weldingWireId?getMaterial(w.weldingWireId):null;
      const wireLabel=wire?posLetter(wire.position):'—';
      const typeLabel=w.type==='O'?t('orbital','Orbital'):w.type==='H'?t('hand','Hand'):w.type==='M'?t('manual','Manual'):'—';
      const welderNames=(w.welderIds||[]).map(id=>{const p=getPerson(id);return p?escapeHtml(p.name):'';}).filter(Boolean).join(', ');
      const inspNames=(w.inspectorIds||[]).map(id=>{const p=getPerson(id);return p?escapeHtml(p.name):'';}).filter(Boolean).join(', ');
      const jBadge=junctionWeldLabel[w.id]?`<span class="cv-branch-badge" style="cursor:default;">→ ${junctionWeldLabel[w.id].fromPos}</span>`:'';
      html+=`<tr class="cv-weld-row" id="cv-weld-${w.id}"><td>${t('weld','Weld')}${jBadge}</td><td class="col-mono">${escapeHtml(w.weldNo)}</td><td></td><td></td><td></td><td></td><td>${typeLabel}</td><td class="col-mono">${wireLabel}</td><td>${welderNames||'—'}</td><td>${inspNames||'—'}</td></tr>`;
    }
  });
  html+=`</tbody></table></div>`;
  container.innerHTML=html;
}
function jumpToBranch(weldId){
  const el=document.getElementById('cv-weld-'+weldId);
  if(!el) return;
  el.scrollIntoView({behavior:'smooth',block:'center'});
  /* single blink */
  el.querySelectorAll('td').forEach(td=>td.style.background='rgba(168,93,44,0.4)');
  setTimeout(()=>el.querySelectorAll('td').forEach(td=>td.style.background=''),800);
}
function weldPersonCell(w, pl, role){
  const idVal=role==='welder'?(w.welderId||0):(w.inspectorId||0);
  const id=`ipd-${w.id}-${role}`;
  const ppl=people();
  let items=ppl.map(p=>{
    const certs = personCerts(p.id);
    const rank = personCertRank(p.id);
    let badge = '';
    if(certs.length === 0){
      badge = ` <span class="cpill cpill-expired" style="font-size:0.7rem;padding:1px 5px;">⚠️ ${t('no_cert_on_file','No cert')}</span>`;
    } else if(rank === 'expired'){
      badge = ` <span class="cpill cpill-expired" style="font-size:0.7rem;padding:1px 5px;">⚠️ ${t('cert_expired','Expired')}</span>`;
    } else if(rank === 'expiring'){
      badge = ` <span class="cpill cpill-expiring" style="font-size:0.7rem;padding:1px 5px;">⏳ ${t('cert_expiring','Expiring')}</span>`;
    }
    return `<label class="ipd-item"><input type="radio" name="${id}-radio" value="${p.id}" ${p.id===idVal?'checked':''} onchange="onInlinePersonChange(${w.id},'${role}','${id}')">${escapeHtml(p.name)} · No. ${escapeHtml(p.no)}${badge}</label>`;
  }).join('');
  items=`<label class="ipd-item"><input type="radio" name="${id}-radio" value="" ${!idVal?'checked':''} onchange="onInlinePersonChange(${w.id},'${role}','${id}')"><span class="muted">— None —</span></label>`+items;
  if(!idVal){
    const nameFallback = role==='welder' ? w.welder : w.inspector;
    if(nameFallback){
      return `<div class="ipd-wrap" id="${id}"><span>${escapeHtml(nameFallback)}</span><button class="btn-link btn-edit-inline" onclick="event.stopPropagation();toggleIpd('${id}')" title="Change">✎</button><div class="ipd-panel">${items}</div></div>`;
    }
    return `<div class="ipd-wrap" id="${id}"><button type="button" class="ipd-btn" onclick="toggleIpd('${id}')">${t('select_opt','Select…')}</button><div class="ipd-panel">${items}</div></div>`;
  }
  const person=ppl.find(p=>p.id===idVal);
  let statusIcon = '';
  if(person){
    const certs = personCerts(person.id);
    const rank = personCertRank(person.id);
    if(certs.length === 0 || rank === 'expired'){
      statusIcon = ` <span title="${t('cert_expired','Expired certificate')}" style="color:var(--danger,#e53e3e);cursor:help;font-weight:bold;margin-left:4px;">⚠️</span>`;
    } else if(rank === 'expiring'){
      statusIcon = ` <span title="${t('cert_expiring','Certificate expiring soon')}" style="color:var(--copper,#d97706);cursor:help;margin-left:4px;">⏳</span>`;
    }
  }
  const nameFallback = role==='welder' ? w.welder : w.inspector;
  const displayText = person ? `${escapeHtml(person.name)} · No. ${escapeHtml(person.no)}${statusIcon}` : (nameFallback ? escapeHtml(nameFallback) : '—');
  return `<div class="ipd-wrap" id="${id}"><span>${displayText}</span><button class="btn-link btn-edit-inline" onclick="event.stopPropagation();toggleIpd('${id}')" title="Change">✎</button><div class="ipd-panel">${items}</div></div>`;
}
function toggleIpd(id){
  const el=document.getElementById(id); if(!el) return;
  const wasOpen=el.classList.contains('open');
  document.querySelectorAll('.ipd-wrap.open').forEach(e=>e.classList.remove('open'));
  if(!wasOpen){
    el.classList.add('open');
    const panel=el.querySelector('.ipd-panel');
    if(panel){
      const rect=el.getBoundingClientRect();
      const panelH=Math.min(panel.scrollHeight,240);
      if(rect.bottom+panelH+8>window.innerHeight){
        panel.style.top=(rect.top-panelH-4)+'px';
      } else {
        panel.style.top=(rect.bottom+4)+'px';
      }
      panel.style.left=rect.left+'px';
    }
  }
}
document.addEventListener('click',e=>{ if(!e.target.closest('.ipd-wrap')){ const wasOpen=document.querySelectorAll('.ipd-wrap.open').length>0; document.querySelectorAll('.ipd-wrap.open').forEach(el=>el.classList.remove('open')); if(wasOpen) renderWeldList(); } });
function onInlinePersonChange(weldId, role, wrapperId){
  const wrap=document.getElementById(wrapperId); if(!wrap) return;
  const w=getWeld(weldId); if(!w) return;
  const selected=wrap.querySelector('input[type=radio]:checked');
  const idVal=selected?Number(selected.value)||0:0;
  const person=idVal?getPerson(idVal):null;
  if(role==='welder'){ w.welderId=idVal||null; w.welder=person?person.name:''; }
  else { w.inspectorId=idVal||null; w.inspector=person?person.name:''; }
  apiPost('/welds', {id:w.id, pipelineId:w.pipelineId, welderId:w.welderId, inspectorId:w.inspectorId, welder:w.welder, inspector:w.inspector}).catch(e=>console.error(e));
  wrap.classList.remove('open');
  renderWeldList();
}
function showWaz(matId){
  const m=getMaterial(matId);
  if(!m) return;
  const targetUrl = m.wazPackageUrl || (m.wazPdfUrl ? `${API_BASE}/pipeline-materials/${matId}/waz-package` : '');
  if(targetUrl){
    window.open(targetUrl, '_blank', 'noopener');
  } else {
    alert(t('no_file_uploaded', 'No file uploaded yet'));
  }
}
function toggleWazMore(btn, containerId, count){
  const container = document.getElementById(containerId);
  if(!container) return;
  const isHidden = container.style.display === 'none' || !container.style.display;
  if(isHidden){
    container.style.display = 'inline-flex';
    btn.textContent = '−';
    btn.title = t('show_less', 'Show less');
  } else {
    container.style.display = 'none';
    btn.textContent = `+${count}`;
    btn.title = `${t('show_more', 'Show')} ${count} ${t('more', 'more')}`;
  }
}
let wazMaterialId=null;
function nextWazNo(pipelineId){
  const existing=pipelineMaterials(pipelineId).map(m=>m.wazNo).filter(Boolean);
  const nums=existing.map(w=>{ const n=w.match(/(\d+)$/); return n?Number(n[1]):0; });
  const next=nums.length?Math.max(...nums)+1:1;
  return 'Z'+String(next).padStart(3,'0');
}
function openAddWazModal(matId){
  wazMaterialId=matId; const m=getMaterial(matId);
  const existingWaz=[...new Set(pipelineMaterials(m.pipelineId).map(x=>x.wazNo).filter(Boolean))].sort();
  const newWaz=nextWazNo(m.pipelineId);
  const wazSel=document.getElementById('input-waz-no');
  let wazOpts=`<option value="${escapeHtml(newWaz)}" selected>${escapeHtml(newWaz)} (new)</option>`;
  existingWaz.forEach(w=>{ wazOpts+=`<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`; });
  wazSel.innerHTML=wazOpts;

  // Pre-fill cert + heat directly from this material
  const certInput=document.getElementById('input-waz-cert-edit');
  if(certInput) certInput.value=m.certificate||'';
  const heatInput=document.getElementById('input-waz-heat-edit');
  if(heatInput) heatInput.value=m.heatNo||'';

  const fileEl=document.getElementById('input-waz-file'); if(fileEl) fileEl.value='';
  wazDocRemoved=false;
  _wazProjectPdfUrl='';
  document.getElementById('waz-current-doc').innerHTML='';
  document.getElementById('waz-err').classList.remove('show');
  document.getElementById('modal-waz-title').textContent=t('add_waz_doc','Add WAZ document');
  document.getElementById('waz-shared-warning').style.display='none';
  toggleWazFileVisibility();
  openModal('modal-waz-add');
}
let wazDocRemoved=false;
let _wazProjectPdfUrl='';
function toggleWazFileVisibility(){
  const wazNo=val('input-waz-no');
  const m=getMaterial(wazMaterialId);
  const existingWithDoc=m?pipelineMaterials(m.pipelineId).find(x=>x.wazNo===wazNo && x.wazPdfUrl):null;
  const fileEl=document.getElementById('input-waz-file');
  const docDiv=document.getElementById('waz-current-doc');
  if(existingWithDoc && !wazDocRemoved){
    fileEl.style.display='none';
    docDiv.innerHTML=`<div class="waz-doc-current"><a class="doc-chip doc-iso" href="${escapeHtml(existingWithDoc.wazPdfUrl)}" target="_blank" rel="noopener">${escapeHtml(existingWithDoc.wazPdfUrl.split('/').pop())}</a><button type="button" class="btn-link waz-doc-remove" onclick="removeWazCurrentDoc()">Remove</button></div>`;
  } else if(_wazProjectPdfUrl && !wazDocRemoved){
    fileEl.style.display='none';
    docDiv.innerHTML=`<div class="waz-doc-current"><a class="doc-chip doc-iso" href="${escapeHtml(_wazProjectPdfUrl)}" target="_blank" rel="noopener">${escapeHtml(_wazProjectPdfUrl.split('/').pop())}</a> <span class="muted">(from project)</span><button type="button" class="btn-link waz-doc-remove" onclick="removeWazCurrentDoc()">Remove</button></div>`;
  } else if(!wazDocRemoved){
    fileEl.style.display='';
    docDiv.innerHTML='';
  } else {
    fileEl.style.display='';
  }
}
function removeWazCurrentDoc(){
  document.getElementById('waz-current-doc').innerHTML='<span class="muted">Document removed \u2014 upload a new one.</span>';
  wazDocRemoved=true;
  _wazProjectPdfUrl='';
  document.getElementById('input-waz-file').style.display='';
}
function onWazHeatChange(){
  toggleSelectOther('input-waz-heat','input-waz-heat-new');
  const heatNo=readSelectOther('input-waz-heat','input-waz-heat-new');
  _wazProjectPdfUrl='';
  const wazSel=document.getElementById('input-waz-no');
  const newOpt=[...wazSel.options].find(o=>o.text.includes('(new'));
  if(!heatNo){ if(newOpt) wazSel.value=newOpt.value; wazDocRemoved=false; toggleWazFileVisibility(); return; }
  const m=getMaterial(wazMaterialId); if(!m) return;
  const pl=getPipeline(m.pipelineId); if(!pl) return;
  const pr=getProject(pl.projectId);
  /* 1. Same pipeline, same heat → reuse same WAZ number */
  const pipeMatch=pipelineMaterials(m.pipelineId).find(x=>x.id!==m.id && x.heatNo===heatNo && x.wazNo);
  if(pipeMatch){
    if([...wazSel.options].some(o=>o.value===pipeMatch.wazNo)) wazSel.value=pipeMatch.wazNo;
    if(pipeMatch.certificate){
      const projMats=pr?projects().filter(p=>p.clientId===pr.clientId).flatMap(p=>projectPipelines(p.id)).flatMap(pl2=>pipelineMaterials(pl2.id)):[];
      const certs=[...new Set(projMats.map(x=>x.certificate).filter(Boolean))].sort();
      buildSelectOther('input-waz-cert','input-waz-cert-new',certs,pipeMatch.certificate);
    }
    wazDocRemoved=false;
    toggleWazFileVisibility();
    return;
  }
  /* 2. Same project (other pipelines), same heat → new WAZ number, reuse PDF */
  if(newOpt) wazSel.value=newOpt.value;
  if(pr){
    const siblings=projectPipelines(pr.id);
    for(const sib of siblings){
      if(sib.id===m.pipelineId) continue;
      const projMatch=pipelineMaterials(sib.id).find(x=>x.heatNo===heatNo && x.wazNo && x.wazPdfUrl);
      if(projMatch){
        _wazProjectPdfUrl=projMatch.wazPdfUrl;
        if(projMatch.certificate){
          const projMats=projects().filter(p=>p.clientId===pr.clientId).flatMap(p=>projectPipelines(p.id)).flatMap(pl2=>pipelineMaterials(pl2.id));
          const certs=[...new Set(projMats.map(x=>x.certificate).filter(Boolean))].sort();
          buildSelectOther('input-waz-cert','input-waz-cert-new',certs,projMatch.certificate);
        }
        wazDocRemoved=false;
        toggleWazFileVisibility();
        return;
      }
    }
  }
  /* 3. No match — new WAZ, upload required */
  wazDocRemoved=false;
  toggleWazFileVisibility();
}
function onWazNoChange(){
  const wazNo=val('input-waz-no');
  const m=getMaterial(wazMaterialId); if(!m) return;
  wazDocRemoved=false;
  const existingMat=pipelineMaterials(m.pipelineId).find(x=>x.wazNo===wazNo);
  const certEdit=document.getElementById('input-waz-cert-edit');
  const heatEdit=document.getElementById('input-waz-heat-edit');
  if(existingMat){
    if(certEdit) certEdit.value=existingMat.certificate || '';
    if(heatEdit) heatEdit.value=existingMat.heatNo || '';
  } else {
    if(certEdit) certEdit.value=m.certificate || '';
    if(heatEdit) heatEdit.value=m.heatNo || '';
  }
  toggleWazFileVisibility();
  document.getElementById('waz-err').classList.remove('show');
}
function openEditWazModal(matId){
  wazMaterialId=matId; const m=getMaterial(matId);
  if(!m) return;
  const existingWaz=[...new Set(pipelineMaterials(m.pipelineId).map(x=>x.wazNo).filter(Boolean))].sort();
  const newWaz=nextWazNo(m.pipelineId);
  const wazSel=document.getElementById('input-waz-no');
  wazSel.innerHTML=`<option value="${escapeHtml(newWaz)}">${escapeHtml(newWaz)} (new)</option>`+existingWaz.map(w=>`<option value="${escapeHtml(w)}" ${w===m.wazNo?'selected':''}>${escapeHtml(w)}</option>`).join('');

  const certEdit=document.getElementById('input-waz-cert-edit');
  if(certEdit) certEdit.value=m.certificate||'';
  const heatEdit=document.getElementById('input-waz-heat-edit');
  if(heatEdit) heatEdit.value=m.heatNo||'';

  const fileEl=document.getElementById('input-waz-file'); if(fileEl) fileEl.value='';
  wazDocRemoved=false;
  document.getElementById('waz-err').classList.remove('show');
  document.getElementById('modal-waz-title').textContent=t('edit_waz_doc','Edit WAZ document');
  document.getElementById('waz-shared-warning').style.display='block';
  toggleWazFileVisibility();
  openModal('modal-waz-add');
}
function confirmAddWaz(){
  let m=getMaterial(wazMaterialId);
  if(!m && PAGE.pipelineId){
    const pmats=pipelineMaterials(PAGE.pipelineId);
    m=pmats.find(x=>x.id===wazMaterialId) || pmats[pmats.length-1];
  }
  if(!m) return;
  const submitBtn=document.getElementById('waz-submit-btn');
  if(submitBtn && submitBtn.disabled) return;

  const certEditEl=document.getElementById('input-waz-cert-edit');
  const heatEditEl=document.getElementById('input-waz-heat-edit');
  const certificate=(certEditEl?certEditEl.value.trim():'') || m.certificate || '';
  const heatNo=(heatEditEl?heatEditEl.value.trim():'') || m.heatNo || '';

  const wazNo=val('input-waz-no');
  const fileInput=document.getElementById('input-waz-file');
  const file=fileInput ? (fileInput.files[0]||null) : null;
  const errEl=document.getElementById('waz-err');

  const existingWithDoc = pipelineMaterials(m.pipelineId).find(x => x.wazNo === wazNo && x.wazPdfUrl);
  const hasExistingDoc = (existingWithDoc && !wazDocRemoved) || (_wazProjectPdfUrl && !wazDocRemoved) || (m.wazPdfUrl && !wazDocRemoved && m.wazNo === wazNo);

  if(!certificate){ errEl.textContent=t('cert_required','Certificate number is required.'); errEl.classList.add('show'); return; }
  if(!heatNo){ errEl.textContent=t('heat_required','Heat number is required.'); errEl.classList.add('show'); return; }
  if(!file && !hasExistingDoc){ errEl.textContent=t('waz_file_required','WAZ PDF document is required.'); errEl.classList.add('show'); return; }
  errEl.classList.remove('show');
  setButtonLoading(submitBtn, true, t('saving', 'Saving…'));

  (async ()=>{
    try {
      const payload={certificate, heatNo};
      if(wazNo) payload.wazNo=wazNo;
      if(_wazProjectPdfUrl && !wazDocRemoved && !file) payload.wazPdfUrl=_wazProjectPdfUrl;

      await apiPost('/pipeline-materials/'+m.id, payload);

      if(file){
        const formData=new FormData();
        formData.append('file', file);
        const uploadResp=await fetch(`${API_BASE}/pipeline-materials/${m.id}/upload-waz`, {method:'POST', body:formData});
        if(!uploadResp.ok){
          const errData=await uploadResp.json().catch(()=>({}));
          throw new Error(errData.error || uploadResp.statusText);
        }
      }

      const [freshMats, freshWelds] = await Promise.all([
        apiGet('/pipeline-materials?pipelineId='+PAGE.pipelineId),
        apiGet('/welds?pipelineId='+PAGE.pipelineId)
      ]);
      DB.materials=normalizeMaterials(freshMats);
      DB.welds=normalizeWelds(freshWelds);
      rebuildRelationships();
      closeModal('modal-waz-add');
      rerenderPage();
    } catch(ex){
      console.error('Error saving WAZ:', ex);
      errEl.textContent='Error saving: '+ex.message;
      errEl.classList.add('show');
    } finally { setButtonLoading(submitBtn, false); }
  })();
}
function showSeamDetail(weldId){
  const w=getWeld(weldId), pl=getPipeline(w.pipelineId);
  const seamIndex=pipelineWelds(w.pipelineId).findIndex(x=>x.id===weldId)+1;
  const mats=w.materialIds.map(getMaterial).filter(Boolean);
  const typeName=w.type==='O'?'Orbital weld':w.type==='M'?'Manual weld':w.type==='H'?'Hand / semi-auto weld':'—';
  const firstW=getPerson(w.welderIds[0]);
  const welderLabel=firstW?`${escapeHtml(firstW.name)} · No. ${escapeHtml(firstW.no)}${w.welderIds.length>1?` (+${w.welderIds.length-1})`:''}`:'—';
  const insLabel=w.inspectorIds.length?w.inspectorIds.map(id=>escapeHtml(getPerson(id).name)).join(', '):'—';
  const tag=v=>v==='OK'?'<span class="ok-tag">OK</span>':`<span class="na-tag">${escapeHtml(v||'—')}</span>`;
  let schematic=''; mats.forEach((m,idx)=>{ schematic+=`<div class="pos-box"><div class="pos-label">${posLetter(m.position)}</div><div class="pos-desc">${escapeHtml(m.itemDescription)}</div></div>`; if(idx<mats.length-1) schematic+=`<div class="naht-marker"><div class="naht-label">${escapeHtml(w.weldNo)}</div><div class="naht-bar"></div></div>`; });
  const sideLabels=['SIDE A','PAGE B','PART C','PART D','PART E','PART F'];
  let cards=''; mats.forEach((m,idx)=>{ const inSeams=welds().filter(x=>x.pipelineId===w.pipelineId&&x.materialIds.includes(m.id)).map(x=>x.weldNo).join(', ');
    let seamDn=escapeHtml(m.dimension); for(let i=2;i<=6;i++){ if(m[`dimension${i}`]) seamDn+=' / '+escapeHtml(m[`dimension${i}`]); }
    cards+=`<div class="jm-card"><div class="jm-card-head"><span class="jm-item-tag">${t('item','Item')} ${idx+1}</span><span class="jm-waz">WAZ ${escapeHtml(m.wazNo)}</span><span style="flex:1"></span><span class="jm-waz">${sideLabels[idx]||''}</span></div>
      <div class="jm-card-body"><div class="jm-title"><a class="cell-link" href="material-detail.html?id=${m.id}">${escapeHtml(m.itemDescription)}</a></div>
        <div class="jm-row"><span class="k">DN</span><span class="v">${seamDn}</span></div>
        <div class="jm-row"><span class="k">${t('th_diameter','Diameter')}</span><span class="v">${m.diameter?fmtDia(m.diameter):'—'}</span></div>
        <div class="jm-row"><span class="k">${t('th_thickness','Thickness')}</span><span class="v">${escapeHtml(m.thickness)||'—'}</span></div>
        <div class="jm-row"><span class="k">${t('th_material','Material')}</span><span class="v">${escapeHtml(m.materialCode)}</span></div>
        <div class="jm-row"><span class="k">${t('th_certificate','Certificate')}</span><span class="v">${escapeHtml(m.certificate)}</span></div>
        <div class="jm-row"><span class="k">${t('heat_melt_no','Heat / melt No.')}</span><span class="v">${escapeHtml(m.heatNo)}</span></div>
        <div class="jm-row"><span class="k">${t('in_the_seams','In the seam(s)')}</span><span class="v">${escapeHtml(inSeams)}</span></div>
        <div class="jm-row"><span class="k">${t('waz_document','WAZ document')}</span><span class="v"><button class="doc-chip doc-weld" onclick="showWaz(${m.id})">${escapeHtml(m.wazNo)} PDF</button></span></div></div></div>`; });
  const wallThickness=mats.map(m=>parseFloat(m.thickness)||0).sort((a,b)=>b-a)[0];
  const wallThkLabel=wallThickness?`${t('wall_thickness','Wall thickness')} ${wallThickness} mm`:`${t('wall_thickness','Wall thickness')} —`;
  document.getElementById('seam-content').innerHTML=`
    <div class="seam-card"><div class="seam-card-head">${t('seam','Seam')} ${seamIndex} · ${t('joining_of','joining of')} ${mats.length} ${mats.length!==1?t('materials_word','materials'):t('material_word','material')}</div>
      <div class="seam-schematic">${schematic}</div>
      <div class="seam-drawing-line">${t('drawing','Drawing')} <strong>${escapeHtml(pl.no)}</strong> · ${wallThkLabel} · ${escapeHtml(w.type)||'—'} · ${typeName} · ${t('procedure','Procedure')} ${escapeHtml(w.procedure)||'—'}</div>
      <div class="seam-metrics">
        <div class="seam-metric"><div class="k">${t('welder_no','Welder No.')}</div><div class="v">${welderLabel}</div></div>
        <div class="seam-metric"><div class="k">${t('inspector','Inspector')}</div><div class="v">${insLabel}</div></div>
        <div class="seam-metric"><div class="k">${t('th_date','Date')}</div><div class="v">${w.date?formatDate(w.date):'—'}</div></div>
        <div class="seam-metric"><div class="k">${t('visual_result','Visually')}</div><div class="v">${tag(w.visual)}</div></div>
        <div class="seam-metric"><div class="k">${t('endoscopy','Endoscopy')}</div><div class="v">${tag(w.endoscopy)}</div></div>
        <div class="seam-metric"><div class="k">${t('ferrite_test','Ferrite test')} (&lt;3.0%)</div><div class="v">${escapeHtml(w.ferrite)||'—'}</div></div>
        <div class="seam-metric"><div class="k">${t('note_image_no','Note / image No.')}</div><div class="v">${escapeHtml(w.noteImageNo)||'—'}</div></div>
        <div class="seam-metric"><div class="k">${t('edit','Edit')}</div><div class="v"><button class="btn-link" onclick="openWeldModal(${w.id})">${t('edit_weld','Edit weld')}</button></div></div>
      </div></div>
    <div class="jm-head">${t('joined_materials','Joined materials')} (${mats.length})</div><div class="jm-grid">${cards}</div>`;
  showDetailView('seam');
}

/* ================================================================ MATERIAL DETAIL PAGE ================================================================ */
async function initMaterialDetailPage(){
  PAGE.name='material-detail'; initDB();
  PAGE.materialId=Number(qp('id'));
  try {
    const data = await apiGet('/pipeline-materials/'+PAGE.materialId+'?includeContext=true');
    DB.clients=data.client?[data.client]:[];
    DB.projects=normalizeProjects(data.project?[data.project]:[]);
    DB.pipelines=data.pipelines||[];
    DB.materials=normalizeMaterials(data.materials||[]);
    DB.welds=normalizeWelds(data.welds||[]);
    DB.projectMaterials=data.projectMaterials||[];
    rebuildRelationships();
  } catch(e){ console.error('API error:', e); }
  PAGE.materialId=Number(qp('id')); const m=getMaterial(PAGE.materialId);
  if(!m){ renderChrome('pipelines',t('pipelines','Pipelines')); return; }
  PAGE.pipelineId=m.pipelineId;
  const pl=getPipeline(m.pipelineId);
  PAGE.projectId=pl.projectId;
  const pr=getProject(pl.projectId); if(pr) PAGE.clientId=pr.clientId;
  renderChrome('pipelines',`<a href="pipelines.html">${t('pipelines','Pipelines')}</a> / <a href="pipeline-detail.html?id=${pl.id}">${escapeHtml(pl.no)}</a> / ${posLetter(m.position)}`); mountModals(); wireModalDismiss(); renderMaterialDetail();
}
function renderMaterialDetail(){
  const m=getMaterial(PAGE.materialId); if(!m) return;
  const pl=getPipeline(m.pipelineId), pr=pl?getProject(pl.projectId):null, cli=pr?getClient(pr.clientId):null;
  document.getElementById('material-context').innerHTML=`${cli?`<a href="projects.html?client=${cli.id}">${escapeHtml(cli.name)}</a>`:''}<span class="sep">›</span>${pr?`<a href="project-detail.html?id=${pr.id}">${escapeHtml(pr.title)}</a>`:''}<span class="sep">›</span><a href="pipeline-detail.html?id=${pl.id}">${escapeHtml(pl.no)}</a><span class="sep">›</span><span>${posLetter(m.position)}</span>`;
  document.getElementById('material-title').textContent=m.itemDescription;
  let dnDisplay=m.dimension||'';
  for(let i=2;i<=6;i++){ if(m[`dimension${i}`]) dnDisplay+=' / '+m[`dimension${i}`]; }
  document.getElementById('material-subtitle').textContent=`${posLetter(m.position)} · ${m.piece} · ${dnDisplay}`;
  const item=(k,v,mono)=>`<div class="info-item"><div class="k">${k}</div><div class="v ${mono?'mono':''}">${v}</div></div>`;
  const flags=[m.startOfPlumbing?'Start of plumbing':'',m.endOfPlumbing?'End of plumbing':''].filter(Boolean).join(' · ')||'—';
  let dnInfoHtml=item('DN',escapeHtml(m.dimension),true);
  for(let i=2;i<=6;i++){ if(m[`dimension${i}`]) dnInfoHtml+=item(`DN ${i}`,escapeHtml(m[`dimension${i}`]),true); }
  document.getElementById('material-info').innerHTML=item('Category',escapeHtml(m.piece))+dnInfoHtml+item('Outer diameter',m.diameter?fmtDia(m.diameter):'—',true)+item('Thickness',escapeHtml(m.thickness)||'—',true)+item('Material code',escapeHtml(m.materialCode),true)+item('Certificate',escapeHtml(m.certificate))+item('Heat / melt No.',escapeHtml(m.heatNo),true)+item('WAZ No.',m.wazNo?`<button class="doc-chip doc-weld" onclick="showWaz(${m.id})">${escapeHtml(m.wazNo)} PDF</button>`:'—')+item('Plumbing',flags);
  const conns=(m.connections||[]).map(cid=>getMaterial(cid)).filter(Boolean);
  document.getElementById('material-connections').innerHTML=conns.length? conns.map(c=>`<a class="chip-link" href="material-detail.html?id=${c.id}">Pos ${c.position} · ${escapeHtml(c.piece)} · ${escapeHtml(c.itemDescription)}</a>`).join('') : '<span class="muted">No connections recorded.</span>';
  const mw=materialWelds(m.id); const tbody=document.getElementById('material-welds-tbody');
  tbody.innerHTML=mw.length? mw.map(w=>{
    const photo=w.endoscopyVideoUrl?`<a class="img-btn" href="${escapeHtml(w.endoscopyVideoUrl)}" target="_blank">${t('view','View')}</a>`:'<span class="img-btn empty">\u2014</span>';
    const endo=w.endoscopyImageUrl?`<a class="img-btn" href="${escapeHtml(w.endoscopyImageUrl)}" target="_blank">${t('view','View')}</a>`:'<span class="img-btn empty">\u2014</span>';
    const rem=w.remarks?`<button class="remarks-btn" onclick="showRemarks(${w.id})">${t('view','View')}</button>`:'<span class="remarks-btn none">\u2014</span>';
    const wire=w.weldingWireId?getMaterial(w.weldingWireId):null;
    const wireLabel=wire?escapeHtml(wire.itemDescription):'\u2014';
    return `<tr>
    <td><button class="pipe-no" onclick="location.href='pipeline-detail.html?id=${pl.id}&seam=${w.id}'">${escapeHtml(w.weldNo)}</button></td>
    <td>${betweenCell(w.materialIds, true)}</td>
    <td><span class="type-tag">${escapeHtml(w.type)||'\u2014'}</span></td>
    <td class="col-mono">${escapeHtml(w.procedure)||'\u2014'}</td>
    <td>${weldWireDropdown(w)}</td>
    <td>${weldPersonCell(w,pl,'welder')}</td>
    <td>${weldPersonCell(w,pl,'inspector')}</td>
    <td class="col-mono">${w.date?formatDate(w.date):'\u2014'}</td>
    <td>${photo}</td><td>${endo}</td><td>${rem}</td>
    <td class="col-actions"><a class="btn-link" href="pipeline-detail.html?id=${pl.id}&seam=${w.id}">${t('seam','Seam')}</a><button class="btn-link" onclick="openWeldModal(${w.id})">${t('edit','Edit')}</button>${archiveBtn('weld',w.id)}</td>
  </tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="12">'+t('no_welds_reference_material','No welds reference this material yet.')+'</td></tr>';
  document.getElementById('material-edit-btn').onclick=()=>openMaterialModal(m.id);
}

/* ================================================================ MATERIAL USAGE PAGE ================================================================ */
async function initMaterialUsagePage(){
  PAGE.name='material-usage'; initDB();
  try {
    const data = await apiGet('/page/material-usage' + (window.location.search || ''));
    DB.clients=data.clients||[];
    DB.projects=normalizeProjects(data.projects||[]);
    DB.pipelines=data.pipelines||[];
    DB.materials=normalizeMaterials(data.materials||[]);
  } catch(e){ console.error('API error:', e); }
  renderChrome('materials',`<a href="materials.html">${t('materials','Materials')}</a> / ${t('usage','Usage')}`); mountModals(); wireModalDismiss();
  renderMaterialUsagePage();
}
function getMaterialUsageParams(){
  return { piece:qp('piece')||'', desc:qp('desc')||'', dn:qp('dn')||'', dien:qp('dien')||'', dia:qp('dia')||'', thk:qp('thk')||'', code:qp('code')||'' };
}
let muWazFilters = { wazNo:'', cert:'', heatNo:'', pipeline:'', project:'' };
let muUsageFilters = { pipeline:'', project:'', client:'', pos:'', wazNo:'', cert:'', heatNo:'' };

function setMuWazFilter(key, val){
  muWazFilters[key] = val;
  document.querySelectorAll('.col-filter.open').forEach(el=>el.classList.remove('open'));
  renderMaterialUsagePage();
}

function setMuUsageFilter(key, val){
  muUsageFilters[key] = val;
  document.querySelectorAll('.col-filter.open').forEach(el=>el.classList.remove('open'));
  renderMaterialUsagePage();
}

function muWazColFilter(label, filterKey, options, curVal){
  const isActive = !!curVal;
  const badge = isActive ? '1' : '';
  let optsHtml = `<button class="cf-clear" onclick="setMuWazFilter('${filterKey}','')">${t('clear_filter','Clear filter')}</button>`;
  optsHtml += options.map(o => `<div class="cf-opt ${curVal===o?'selected':''}" onclick="setMuWazFilter('${filterKey}','${escapeHtml(o).replace(/'/g,"\\'")}');">${escapeHtml(o)}</div>`).join('');
  return `<th class="col-filter ${isActive?'active':''}" onclick="toggleColFilter(this,event)"><span class="col-filter-btn">${label}${badge?' <span style=\"display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:var(--copper);color:#fff;font-size:0.6rem;font-weight:700;\">'+badge+'</span>':''}</span><div class="col-filter-panel">${optsHtml}</div></th>`;
}

function muUsageColFilter(label, filterKey, options, curVal){
  const isActive = !!curVal;
  const badge = isActive ? '1' : '';
  let optsHtml = `<button class="cf-clear" onclick="setMuUsageFilter('${filterKey}','')">${t('clear_filter','Clear filter')}</button>`;
  optsHtml += options.map(o => `<div class="cf-opt ${curVal===o?'selected':''}" onclick="setMuUsageFilter('${filterKey}','${escapeHtml(o).replace(/'/g,"\\'")}');">${escapeHtml(o)}</div>`).join('');
  return `<th class="col-filter ${isActive?'active':''}" onclick="toggleColFilter(this,event)"><span class="col-filter-btn">${label}${badge?' <span style=\"display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:var(--copper);color:#fff;font-size:0.6rem;font-weight:700;\">'+badge+'</span>':''}</span><div class="col-filter-panel">${optsHtml}</div></th>`;
}

function renderMaterialUsagePage(){
  const p=getMaterialUsageParams();
  /* find all materials matching this combination */
  const matching=materials().filter(m=>{
    if(p.piece && m.piece!==p.piece) return false;
    if(p.desc && m.itemDescription!==p.desc) return false;
    if(p.dn && m.dimension!==p.dn) return false;
    if(p.dien && (m.dienNo||'')!==p.dien) return false;
    if(p.dia && (m.diameter||'')!==p.dia) return false;
    if(p.thk && (m.thickness||'')!==p.thk) return false;
    if(p.code && m.materialCode!==p.code) return false;
    return true;
  });
  /* context bar */
  document.getElementById('mu-context').innerHTML=`<a href="materials.html">Materials</a><span class="sep">›</span><span>${escapeHtml(p.desc||p.piece)}</span>`;
  /* title */
  document.getElementById('mu-title').textContent=p.desc||p.piece;
  let subtitleParts=[p.piece];
  if(p.dn) subtitleParts.push(p.dn);
  if(p.code) subtitleParts.push(p.code);
  document.getElementById('mu-subtitle').textContent=subtitleParts.join(' · ');
  /* info panel */
  const item=(k,v,mono)=>`<div class="info-item"><div class="k">${k}</div><div class="v ${mono?'mono':''}">${v}</div></div>`;
  let infoHtml=item('Category',escapeHtml(p.piece));
  infoHtml+=item('DN',escapeHtml(p.dn)||'—',true);
  if(p.dia) infoHtml+=item('Outer diameter',fmtDia(p.dia),true);
  if(p.thk) infoHtml+=item('Thickness',escapeHtml(p.thk),true);
  if(p.dien) infoHtml+=item('DIN EN No.',escapeHtml(p.dien),true);
  infoHtml+=item('Material code',escapeHtml(p.code)||'—',true);
  document.getElementById('mu-info').innerHTML=infoHtml;
  /* stats */
  const uniquePipelines=[...new Set(matching.map(m=>m.pipelineId))];
  const uniqueProjects=[...new Set(uniquePipelines.map(pid=>{const pl=getPipeline(pid);return pl?pl.projectId:0;}).filter(Boolean))];
  const uniqueClients=[...new Set(uniqueProjects.map(prid=>{const pr=getProject(prid);return pr?pr.clientId:0;}).filter(Boolean))];
  const uniqueWazNos=[...new Set(matching.map(m=>m.wazNo).filter(Boolean))];
  document.getElementById('mu-stats').innerHTML=tile(matching.length,t('total_used','Total used'),'')+tile(uniquePipelines.length,t('total_pipelines','Pipelines'),'t-neutral')+tile(uniqueProjects.length,t('total_projects','Projects'),'t-copper')+tile(uniqueClients.length,t('total_clients','Clients'),'t-neutral')+tile(uniqueWazNos.length,t('total_waz','WAZ documents'),'t-success');

  /* WAZ documents table */
  const wazGroups={};
  matching.filter(m=>m.wazNo).forEach(m=>{
    if(!wazGroups[m.wazNo]){
      wazGroups[m.wazNo]={ wazNo:m.wazNo, certs:new Set(), heats:new Set(), pipelineIds:new Set(), projectIds:new Set(), matId:m.id };
    }
    const wg=wazGroups[m.wazNo];
    if(m.certificate) wg.certs.add(m.certificate);
    if(m.heatNo) wg.heats.add(m.heatNo);
    if(m.pipelineId){
      wg.pipelineIds.add(m.pipelineId);
      const pl=getPipeline(m.pipelineId);
      if(pl&&pl.projectId) wg.projectIds.add(pl.projectId);
    }
  });
  const allWazKeys=Object.keys(wazGroups).sort((a, b) => {
    const numA = (a.match(/(\d+)/) || [])[1];
    const numB = (b.match(/(\d+)/) || [])[1];
    if(numA && numB && Number(numA) !== Number(numB)) {
      return Number(numB) - Number(numA);
    }
    const idA = wazGroups[a].matId || 0;
    const idB = wazGroups[b].matId || 0;
    if(idB !== idA) return idB - idA;
    return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
  });

  /* filter WAZ documents */
  const filteredWazKeys = allWazKeys.filter(k => {
    const wg = wazGroups[k];
    const pls = [...wg.pipelineIds].map(getPipeline).filter(Boolean);
    const prs = [...wg.projectIds].map(getProject).filter(Boolean);
    if(muWazFilters.wazNo && wg.wazNo !== muWazFilters.wazNo) return false;
    if(muWazFilters.cert && !wg.certs.has(muWazFilters.cert)) return false;
    if(muWazFilters.heatNo && !wg.heats.has(muWazFilters.heatNo)) return false;
    if(muWazFilters.pipeline && !pls.some(p => p.no === muWazFilters.pipeline)) return false;
    if(muWazFilters.project && !prs.some(p => p.title === muWazFilters.project)) return false;
    return true;
  });

  const wazThead=document.getElementById('mu-waz-thead');
  if(wazThead){
    const optWaz = allWazKeys;
    const optCert = [...new Set(allWazKeys.flatMap(k => [...wazGroups[k].certs]))].sort();
    const optHeat = [...new Set(allWazKeys.flatMap(k => [...wazGroups[k].heats]))].sort();
    const optPipe = [...new Set(allWazKeys.flatMap(k => [...wazGroups[k].pipelineIds].map(id => (getPipeline(id)||{}).no).filter(Boolean)))].sort();
    const optProj = [...new Set(allWazKeys.flatMap(k => [...wazGroups[k].projectIds].map(id => (getProject(id)||{}).title).filter(Boolean)))].sort();

    let hdr = muWazColFilter(t('th_waz_no','WAZ No.'), 'wazNo', optWaz, muWazFilters.wazNo);
    hdr += muWazColFilter(t('th_certificate','Certificate'), 'cert', optCert, muWazFilters.cert);
    hdr += muWazColFilter(t('th_heat_no','Heat / Melt No.'), 'heatNo', optHeat, muWazFilters.heatNo);
    hdr += muWazColFilter(t('th_pipeline_no','Pipeline'), 'pipeline', optPipe, muWazFilters.pipeline);
    hdr += muWazColFilter(t('th_project','Project'), 'project', optProj, muWazFilters.project);
    hdr += `<th>${t('th_pdf','PDF')}</th>`;
    wazThead.innerHTML = hdr;
  }

  const wazTbody=document.getElementById('mu-waz-tbody');
  if(wazTbody){
    wazTbody.innerHTML=filteredWazKeys.length ? filteredWazKeys.map(k=>{
      const wg=wazGroups[k];
      const pls=[...wg.pipelineIds].map(getPipeline).filter(Boolean);
      const prs=[...wg.projectIds].map(getProject).filter(Boolean);
      return `<tr>
        <td><button class="doc-chip doc-weld" onclick="showWaz(${wg.matId})" title="${t('view_document','View WAZ PDF')}">${escapeHtml(wg.wazNo)}</button></td>
        <td>${escapeHtml([...wg.certs].join(', '))||'<span class="muted">—</span>'}</td>
        <td class="col-mono">${escapeHtml([...wg.heats].join(', '))||'<span class="muted">—</span>'}</td>
        <td>${pls.map(p=>`<a class="cell-link" href="pipeline-detail.html?id=${p.id}">${escapeHtml(p.no)}</a>`).join(', ')||'<span class="muted">—</span>'}</td>
        <td>${prs.map(p=>`<a class="cell-link" href="project-detail.html?id=${p.id}">${escapeHtml(p.title)}</a>`).join(', ')||'<span class="muted">—</span>'}</td>
        <td><button class="doc-chip doc-iso" onclick="showWaz(${wg.matId})">PDF</button></td>
      </tr>`;
    }).join('') : `<tr class="empty-row"><td colspan="6">${t('no_waz_documents_for_material','No WAZ documents match these filters.')}</td></tr>`;
  }

  /* filter usage table */
  const filteredUsage = matching.filter(m => {
    const pl = getPipeline(m.pipelineId);
    const pr = pl ? getProject(pl.projectId) : null;
    const cli = pr ? getClient(pr.clientId) : null;
    if(muUsageFilters.pipeline && (!pl || pl.no !== muUsageFilters.pipeline)) return false;
    if(muUsageFilters.project && (!pr || pr.title !== muUsageFilters.project)) return false;
    if(muUsageFilters.client && (!cli || cli.name !== muUsageFilters.client)) return false;
    if(muUsageFilters.pos && posLetter(m.position) !== muUsageFilters.pos) return false;
    if(muUsageFilters.wazNo && m.wazNo !== muUsageFilters.wazNo) return false;
    if(muUsageFilters.cert && m.certificate !== muUsageFilters.cert) return false;
    if(muUsageFilters.heatNo && m.heatNo !== muUsageFilters.heatNo) return false;
    return true;
  });

  const usageThead=document.getElementById('mu-usage-thead');
  if(usageThead){
    const optPipe = [...new Set(matching.map(m => (getPipeline(m.pipelineId)||{}).no).filter(Boolean))].sort();
    const optProj = [...new Set(matching.map(m => { const pl=getPipeline(m.pipelineId); return pl?(getProject(pl.projectId)||{}).title:''; }).filter(Boolean))].sort();
    const optClient = [...new Set(matching.map(m => { const pl=getPipeline(m.pipelineId); const pr=pl?getProject(pl.projectId):null; return pr?(getClient(pr.clientId)||{}).name:''; }).filter(Boolean))].sort();
    const optPos = [...new Set(matching.map(m => posLetter(m.position)).filter(Boolean))].sort();
    const optWaz = [...new Set(matching.map(m => m.wazNo).filter(Boolean))].sort();
    const optCert = [...new Set(matching.map(m => m.certificate).filter(Boolean))].sort();
    const optHeat = [...new Set(matching.map(m => m.heatNo).filter(Boolean))].sort();

    let hdr = muUsageColFilter(t('th_pipeline_no','Pipeline No.'), 'pipeline', optPipe, muUsageFilters.pipeline);
    hdr += muUsageColFilter(t('th_project','Project'), 'project', optProj, muUsageFilters.project);
    hdr += muUsageColFilter(t('th_client','Client'), 'client', optClient, muUsageFilters.client);
    hdr += muUsageColFilter(t('th_pos','Pos.'), 'pos', optPos, muUsageFilters.pos);
    hdr += muUsageColFilter(t('th_waz_no','WAZ No.'), 'wazNo', optWaz, muUsageFilters.wazNo);
    hdr += muUsageColFilter(t('th_certificate','Certificate'), 'cert', optCert, muUsageFilters.cert);
    hdr += muUsageColFilter(t('th_heat_no','Heat / Melt No.'), 'heatNo', optHeat, muUsageFilters.heatNo);
    hdr += `<th></th>`;
    usageThead.innerHTML = hdr;
  }

  /* usage table */
  const tbody=document.getElementById('mu-usage-tbody');
  tbody.innerHTML=filteredUsage.length? filteredUsage.map(m=>{
    const pl=getPipeline(m.pipelineId);
    const pr=pl?getProject(pl.projectId):null;
    const cli=pr?getClient(pr.clientId):null;
    return `<tr>
      <td><a class="cell-link" href="pipeline-detail.html?id=${m.pipelineId}">${pl?escapeHtml(pl.no):'—'}</a></td>
      <td>${pr?`<a class="cell-link" href="project-detail.html?id=${pr.id}">${escapeHtml(pr.title)}</a>`:'—'}</td>
      <td>${cli?`<a class="cell-link" href="client-detail.html?id=${cli.id}">${escapeHtml(cli.name)}</a>`:'—'}</td>
      <td class="col-mono">${posLetter(m.position)}</td>
      <td>${m.wazNo?`<button class="doc-chip doc-weld" onclick="showWaz(${m.id})" title="View WAZ PDF">${escapeHtml(m.wazNo)}</button>`:'<span class="muted">—</span>'}</td>
      <td>${escapeHtml(m.certificate)||'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml(m.heatNo)||'<span class="muted">—</span>'}</td>
      <td class="col-actions"><a class="btn-link" href="material-detail.html?id=${m.id}">Detail</a></td>
    </tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="8">'+t('no_materials_match_filters','No materials match these filters.')+'</td></tr>';
}
function openMuEdit(){
  const p=getMaterialUsageParams();
  const matching=materials().filter(m=>{
    if(p.piece && m.piece!==p.piece) return false;
    if(p.desc && m.itemDescription!==p.desc) return false;
    if(p.dn && m.dimension!==p.dn) return false;
    if(p.dien && (m.dienNo||'')!==p.dien) return false;
    if(p.dia && (m.diameter||'')!==p.dia) return false;
    if(p.thk && (m.thickness||'')!==p.thk) return false;
    if(p.code && m.materialCode!==p.code) return false;
    return true;
  });
  if(matching.length) openMaterialsPageEdit(matching[0].id);
}

/* ================================================================ WELDERS PAGE ================================================================ */
let welderFilters={welder:'',process:'',status:''};
let welderTab='active';
async function loadWpsProcessesFromApi(){
  try {
    const list = await apiGet('/wps-processes');
    if(list && list.length) DB.wpsProcesses = list;
  } catch(e){
    console.error('Failed to load WPS processes:', e);
  }
}

async function loadWeldersFromApi(){
  try {
    const [welders, wpsList] = await Promise.all([
      apiGet('/welders'),
      apiGet('/wps-processes').catch(()=>[])
    ]);
    if(wpsList && wpsList.length) DB.wpsProcesses = wpsList;
    DB.people=welders.map(w=>({id:w.id, name:w.name, no:w.no, signatureUrl:w.signatureUrl||'', procs:w.procs, archived:w.archived}));
    DB.certificates=[];
    welders.forEach(w=>{
      (w.certificates||[]).forEach(c=>{
        DB.certificates.push({id:c.id, personId:w.id, certNo:c.certNo, process:c.process, standard:c.standard, validUntil:c.validUntil, renewalDue:c.renewalDue, pdfUrl:c.pdfUrl, archived:c.archived});
      });
    });
  } catch(e){ console.error('Failed to load welders:', e); }
}
async function initWeldersPage(){ PAGE.name='welders'; initDB(); await loadWeldersFromApi(); renderChrome('welders',t('welders','Welders')); mountModals(); wireModalDismiss(); renderWeldersPage(); }
function buildWelderFilters(){ /* filters are in column headers */ }
function setWelderFilter(key,val){
  welderFilters[key]=val;
  document.querySelectorAll('.col-filter.open').forEach(el=>el.classList.remove('open'));
  renderWeldersPage();
}
function onWelderFilterChange(){ renderWeldersPage(); }
function clearWelderFilters(){ welderFilters={welder:'',process:'',status:''}; renderWeldersPage(); }
function welderColFilter(label,filterKey,options,curVal){
  const isActive=!!curVal;
  const badge=isActive?'1':'';
  let optsHtml=`<button class="cf-clear" onclick="setWelderFilter('${filterKey}','')">${t('clear_filter','Clear filter')}</button>`;
  optsHtml+=options.map(o=>{
    const v=typeof o==='object'?o.value:o;
    const l=typeof o==='object'?o.label:o;
    return `<div class="cf-opt ${curVal===v?'selected':''}" onclick="setWelderFilter('${filterKey}','${escapeHtml(v).replace(/'/g,"\\'")}')">${escapeHtml(l)}</div>`;
  }).join('');
  return `<th class="col-filter ${isActive?'active':''}" onclick="toggleColFilter(this,event)"><span class="col-filter-btn">${label}${badge?' <span style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:var(--copper);color:#fff;font-size:0.6rem;font-weight:700;">'+badge+'</span>':''}</span><div class="col-filter-panel">${optsHtml}</div></th>`;
}
function certRow(cert, includeWelder){
  const p=getPerson(cert.personId);
  const wc=includeWelder?`<td class="col-mono">${escapeHtml(p.no)}</td><td class="col-name"><a class="cell-link" href="welder-profile.html?id=${p.id}">${escapeHtml(p.name)}</a></td>`:'';
  const signHtml = p && p.signatureUrl
    ? `<a class="doc-chip doc-iso" href="javascript:void(0)" onclick="showImageRaw('${escapeHtml(p.name)} - Signatur','${escapeHtml(p.signatureUrl)}','Welder No. ${escapeHtml(p.no)}')">${t('sign','Sign')}</a>`
    : '<span class="muted">—</span>';
  return `<tr>${wc}
    <td class="col-mono">${escapeHtml(cert.certNo)}</td><td class="col-mono">${escapeHtml(cert.process)}</td><td>${escapeHtml(cert.standard)}</td>
    <td><div class="valid-cell"><span>${cert.validUntil?formatDate(cert.validUntil):'—'}</span>${cert.validUntil?certStatusPill(cert):''}</div></td>
    <td>${cert.renewalDue?formatDate(cert.renewalDue):'—'}</td>
    <td>${cert.pdfUrl?`<a class="doc-chip doc-iso" href="${escapeHtml(cert.pdfUrl)}" target="_blank" rel="noopener">PDF</a>`:'<span class="muted">—</span>'}</td>
    <td>${signHtml}</td>
    <td class="col-actions"><button class="btn btn-ghost btn-sm" onclick="openRenewModal(${cert.id})">${t('renew','Renew')}</button></td></tr>`;
}
function archivedCertRow(cert){
  const p=getPerson(cert.personId);
  const signHtml = p && p.signatureUrl
    ? `<a class="doc-chip doc-iso" href="javascript:void(0)" onclick="showImageRaw('${escapeHtml(p?p.name:'')} - Signatur','${escapeHtml(p.signatureUrl)}','Welder No. ${escapeHtml(p?p.no:'')}')">${t('sign','Sign')}</a>`
    : '<span class="muted">—</span>';
  return `<tr>
    <td class="col-mono">${escapeHtml(p?p.no:'')}</td>
    <td class="col-name"><a class="cell-link" href="welder-profile.html?id=${p?p.id:''}">${escapeHtml(p?p.name:'')}</a></td>
    <td class="col-mono">${escapeHtml(cert.certNo)}</td>
    <td class="col-mono">${escapeHtml(cert.process)}</td>
    <td>${escapeHtml(cert.standard)}</td>
    <td>${formatDate(cert.validUntil)}</td>
    <td>${cert.pdfUrl?`<a class="doc-chip doc-iso" href="${escapeHtml(cert.pdfUrl)}" target="_blank" rel="noopener">PDF</a>`:'<span class="muted">—</span>'}</td>
    <td>${signHtml}</td>
  </tr>`;
}
function switchWelderTab(tab){
  welderTab=tab;
  document.getElementById('wtab-active').classList.toggle('active',tab==='active');
  document.getElementById('wtab-archived').classList.toggle('active',tab==='archived');
  document.getElementById('welders-active-section').style.display=tab==='active'?'':'none';
  document.getElementById('welders-archived-section').style.display=tab==='archived'?'':'none';
  if(tab==='archived') renderArchivedCerts();
}
function renderWeldersPage(){
  const archivedCerts=DB.certificates.filter(c=>c.archived);
  const expiring=certificates().filter(c=>certStatus(c)==='expiring').length, expired=certificates().filter(c=>certStatus(c)==='expired').length;
  document.getElementById('welders-stats').innerHTML=tile(people().length,t('total_welders','Welders / personnel'),'')+tile(certificates().length,t('active_certs','Active certs'),'t-neutral')+tile(expiring,t('expiring_30d','Expiring ≤30 days'),'t-copper')+tile(expired,t('expired','Expired'),'t-danger')+tile(archivedCerts.length,t('archived','Archived'),'t-neutral');
  let rows=certificates().slice().sort((a,b)=>{ const pa=getPerson(a.personId), pb=getPerson(b.personId); return String(pa.no).localeCompare(String(pb.no),undefined,{numeric:true})||a.certNo.localeCompare(b.certNo); });
  if(welderFilters.welder) rows=rows.filter(c=>c.personId===Number(welderFilters.welder));
  if(welderFilters.process) rows=rows.filter(c=>c.process===welderFilters.process);
  if(welderFilters.status) rows=rows.filter(c=>certStatus(c)===welderFilters.status);
  /* build column filter thead */
  const thead=document.getElementById('welders-thead');
  if(thead){
    const welderOpts=people().map(p=>({value:String(p.id),label:p.name+' · '+p.no}));
    const procOpts=[...new Set(certificates().map(c=>c.process).filter(Boolean))].sort();
    const statusOpts=[{value:'valid',label:t('cert_valid','Valid')},{value:'expiring',label:t('expiring_30d','Expiring')},{value:'expired',label:t('expired','Expired')}];
    let hdr=`<th>${t('th_no','No.')}</th>`;
    hdr+=welderColFilter(t('th_welder_name','Welder name'),'welder',welderOpts,welderFilters.welder);
    hdr+=`<th>${t('th_cert_no','Certificate No.')}</th>`;
    hdr+=welderColFilter(t('th_process','Process'),'process',procOpts,welderFilters.process);
    hdr+=`<th>${t('th_standard','Standard')}</th>`;
    hdr+=welderColFilter(t('th_valid_until','Valid until'),'status',statusOpts,welderFilters.status);
    hdr+=`<th>${t('th_renewal_due','Renewal due')}</th><th>${t('th_pdf','PDF')}</th><th>${t('th_signature','Sign')}</th><th></th>`;
    thead.innerHTML=hdr;
  }
  const tbody=document.getElementById('welders-tbody');
  tbody.innerHTML=rows.length? rows.map(c=>certRow(c,true)).join('') : `<tr class="empty-row"><td colspan="9">${certificates().length===0?t('no_certs_yet','No certificates yet.'):t('no_certs_match','No certificates match your filters.')}</td></tr>`;
  if(welderTab==='archived') renderArchivedCerts();
}
let archivedCertFilters={welder:'',process:''};
function setArchivedCertFilter(key,val){
  archivedCertFilters[key]=val;
  document.querySelectorAll('.col-filter.open').forEach(el=>el.classList.remove('open'));
  renderArchivedCerts();
}
function archivedColFilter(label,filterKey,options,curVal){
  const isActive=!!curVal;
  const badge=isActive?'1':'';
  let optsHtml=`<button class="cf-clear" onclick="setArchivedCertFilter('${filterKey}','')">${t('clear_filter','Clear filter')}</button>`;
  optsHtml+=options.map(o=>{
    const v=typeof o==='object'?o.value:o;
    const l=typeof o==='object'?o.label:o;
    return `<div class="cf-opt ${curVal===v?'selected':''}" onclick="setArchivedCertFilter('${filterKey}','${escapeHtml(v).replace(/'/g,"\\'")}')">${escapeHtml(l)}</div>`;
  }).join('');
  return `<th class="col-filter ${isActive?'active':''}" onclick="toggleColFilter(this,event)"><span class="col-filter-btn">${label}${badge?' <span style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:var(--copper);color:#fff;font-size:0.6rem;font-weight:700;">'+badge+'</span>':''}</span><div class="col-filter-panel">${optsHtml}</div></th>`;
}
function renderArchivedCerts(){
  let archived=DB.certificates.filter(c=>c.archived).sort((a,b)=>{ const pa=getPerson(a.personId), pb=getPerson(b.personId); return String(pa.no).localeCompare(String(pb.no),undefined,{numeric:true})||a.certNo.localeCompare(b.certNo); });
  if(archivedCertFilters.welder) archived=archived.filter(c=>c.personId===Number(archivedCertFilters.welder));
  if(archivedCertFilters.process) archived=archived.filter(c=>c.process===archivedCertFilters.process);
  /* build thead with column filters */
  const thead=document.getElementById('welders-archived-thead');
  if(thead){
    const allArchived=DB.certificates.filter(c=>c.archived);
    const welderOpts=[...new Map(allArchived.map(c=>{const p=getPerson(c.personId);return [String(c.personId),{value:String(c.personId),label:p.name+' · '+p.no}];})).values()];
    const procOpts=[...new Set(allArchived.map(c=>c.process).filter(Boolean))].sort();
    let hdr=`<th>${t('th_no','No.')}</th>`;
    hdr+=archivedColFilter(t('th_welder_name','Welder name'),'welder',welderOpts,archivedCertFilters.welder);
    hdr+=`<th>${t('th_cert_no','Certificate No.')}</th>`;
    hdr+=archivedColFilter(t('th_process','Process'),'process',procOpts,archivedCertFilters.process);
    hdr+=`<th>${t('th_standard','Standard')}</th><th>${t('th_valid_until','Valid until')}</th><th>${t('th_pdf','PDF')}</th><th>${t('th_signature','Sign')}</th>`;
    thead.innerHTML=hdr;
  }
  const tbody=document.getElementById('welders-archived-tbody');
  tbody.innerHTML=archived.length? archived.map(c=>archivedCertRow(c)).join('') : `<tr class="empty-row"><td colspan="7">${t('no_certs_archived','No archived certificates.')}</td></tr>`;
}
function restoreCert(id){
  /* no-op */
}

/* ================================================================ WELDER PROFILE PAGE ================================================================ */
async function initWelderProfilePage(){
  PAGE.name='welder-profile'; initDB(); PAGE.welderId=Number(qp('id'));
  await loadWeldersFromApi();
  const p=getPerson(PAGE.welderId);
  if(!p){ renderChrome('welders',t('welders','Welders')); return; }
  renderChrome('welders',`<a href="welders.html">${t('welders','Welders')}</a> / ${escapeHtml(p.name)}`); mountModals(); wireModalDismiss(); renderWelderProfile();
}
function renderWelderProfile(){
  const p=getPerson(PAGE.welderId); if(!p) return;
  document.getElementById('profile-avatar').textContent=initials(p.name);
  document.getElementById('profile-name').textContent=p.name;
  document.getElementById('profile-sub').textContent=`No. ${p.no} · Qualified: ${p.procs||'—'}`;
  const sigBox=document.getElementById('profile-signature-box');
  if(sigBox){
    if(p.signatureUrl){
      const sigImgUrl = p.signatureUrl.includes('?') ? p.signatureUrl : `${p.signatureUrl}?_v=${Date.now()}`;
      sigBox.innerHTML=`<div style="display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--border);border-radius:6px;padding:4px 10px;box-shadow:var(--shadow-sm);">
        <img src="${escapeHtml(sigImgUrl)}" style="max-height:42px;max-width:130px;object-fit:contain;background:#fff;padding:2px 4px;border-radius:3px;" alt="Signature">
        <a class="doc-chip doc-iso" href="javascript:void(0)" onclick="showImageRaw('${escapeHtml(p.name)} - Signatur','${escapeHtml(p.signatureUrl)}','Welder No. ${escapeHtml(p.no)}')">${t('sign','Sign')}</a>
      </div>`;
    } else {
      sigBox.innerHTML='';
    }
  }
  const certs=personCerts(p.id);
  const archivedCerts=DB.certificates.filter(c=>c.personId===p.id && c.archived);
  const expiring=certs.filter(c=>certStatus(c)==='expiring').length;
  const asWelder=pipelines().filter(pl=>(pl.welderIds||[]).includes(p.id)&&pl.status<3).length;
  const asInspector=pipelines().filter(pl=>(pl.inspectorIds||[]).includes(p.id)&&pl.status<3).length;
  const activeProjects=new Set(pipelines().filter(pl=>((pl.welderIds||[]).includes(p.id)||(pl.inspectorIds||[]).includes(p.id))&&pl.status<3).map(pl=>pl.projectId));
  document.getElementById('profile-stats').innerHTML=tile(certs.length,t('total_certs','Certificates'),'')+tile(expiring,t('expiring_1_month','Expiring ≤1 month'),'t-copper')+tile(asWelder,t('active_pipelines_welder','Active pipelines (welder)'),'t-neutral')+tile(asInspector,t('active_pipelines_inspector','Active pipelines (inspector)'),'t-neutral')+tile(archivedCerts.length,t('archived','Archived'),'t-neutral')+tile(activeProjects.size,t('active_projects','Active projects'),'t-success');
  const tbody=document.getElementById('profile-certs-tbody');
  tbody.innerHTML=certs.length? certs.map(c=>certRow(c,false)).join('') : `<tr class="empty-row"><td colspan="7">${t('no_certs_file','No certificates on file.')}</td></tr>`;
  const arcSec=document.getElementById('profile-archived-section');
  const arcTbody=document.getElementById('profile-archived-certs-tbody');
  if(arcSec && arcTbody){
    if(archivedCerts.length){
      arcSec.style.display='';
      arcTbody.innerHTML=archivedCerts.map(c=>`<tr>
        <td class="col-mono">${escapeHtml(c.certNo)}</td><td class="col-mono">${escapeHtml(c.process)}</td><td>${escapeHtml(c.standard)}</td>
        <td>${c.validUntil?formatDate(c.validUntil):'—'}</td>
        <td>${c.renewalDue?formatDate(c.renewalDue):'—'}</td>
        <td>${c.pdfUrl?`<a class="doc-chip doc-iso" href="${escapeHtml(c.pdfUrl)}" target="_blank" rel="noopener">PDF</a>`:'<span class="muted">—</span>'}</td>
      </tr>`).join('');
    } else {
      arcSec.style.display='none';
    }
  }
  document.getElementById('profile-edit-btn').onclick=()=>openWelderModal(p.id);
}

/* ================================================================ SHARED: pipelines table for dashboards ================================================================ */
function homePipelineTable(list, emptyMsg){
  const rows=list.map(pl=>{
    const pr=getProject(pl.projectId), cli=pr?getClient(pr.clientId):null;
    return `<tr>
      <td><a class="pipe-no" href="pipeline-detail.html?id=${pl.id}">${escapeHtml(pl.no)}</a></td>
      <td>${pr?`<a class="cell-link" href="project-detail.html?id=${pr.id}">${escapeHtml(pr.title)}</a>`:'<span class="muted">—</span>'}</td>
      <td>${cli?escapeHtml(cli.name):'<span class="muted">—</span>'}</td>
      <td>${statusPill(pl.status)}</td>
      <td>${docCell(pl)}</td>
      <td class="col-actions"><a class="btn-link" href="pipeline-detail.html?id=${pl.id}">${t('open','Open')}</a>${archiveBtn('pipeline',pl.id)}</td>
    </tr>`;
  }).join('');
  return `<div class="table-card"><table class="table-wide"><thead><tr><th>${t('th_pipeline_no','Pipeline No.')}</th><th>${t('th_project','Project')}</th><th>${t('th_client','Client')}</th><th>${t('th_status','Status')}</th><th>${t('th_documents','Documents')}</th><th></th></tr></thead><tbody>${list.length?rows:`<tr class="empty-row"><td colspan="6">${escapeHtml(emptyMsg)}</td></tr>`}</tbody></table></div>`;
}
function homeCertTable(list){
  const sorted=list.slice().sort((a,b)=>daysUntil(a.validUntil)-daysUntil(b.validUntil));
  const rows=sorted.length? sorted.map(c=>certRow(c,true)).join('') : `<tr class="empty-row"><td colspan="9">${t('no_expiring_certs_30d','No certificates expiring in the next 30 days.')}</td></tr>`;
  return `<div class="table-card"><table class="table-wide"><thead><tr><th>${t('th_no','No.')}</th><th>${t('th_welder','Welder')}</th><th>${t('th_cert_no','Certificate No.')}</th><th>${t('th_process','Process')}</th><th>${t('th_standard','Standard')}</th><th>${t('th_valid_until','Valid until')}</th><th>${t('th_renewal_due','Renewal due')}</th><th>${t('th_pdf','PDF')}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* ================================================================ HOME (office + vendor dashboards) ================================================================ */
let homeTab=null;
async function initHomePage(){ PAGE.name='home'; initDB();
  try {
    const data = await apiGet('/page/home');
    DB.clients=data.clients||[];
    DB.projects=normalizeProjects(data.projects||[]);
    DB.pipelines=data.pipelines||[];
    DB.materials=normalizeMaterials(data.materials||[]);
    DB.welds=normalizeWelds(data.welds||[]);
    DB.people=data.people||[];
    DB.certificates=data.certificates||[];
    rebuildRelationships();
  } catch(e){ console.error('API error:', e); }
  renderChrome('home',getRole()==='vendor'?(t('home','Home')+' / '+t('my_work','My work')):(t('home','Home')+' / '+t('office_dashboard','Office dashboard'))); mountModals(); wireModalDismiss(); renderHomePage();
}
function officeTabs(){
  const byStatus=s=>pipelines().filter(p=>p.status===s);
  const mkTab=(key,label,list,desc,alert)=>({key,label,count:list.length,desc,alert,render:()=>homePipelineTable(list,t('home_empty_caught_up','Nothing here — all caught up.'))});
  const expiry=certsExpiringWithin(30);
  return [
    mkTab('material',t('home_tab_pending_mat','Pending material list'),byStatus(0),t('tab_mat_desc','Pipelines created but whose master parts list has not been finalised yet.')),
    mkTab('weldlist',t('home_tab_pending_weld','Pending weld list'),byStatus(1),t('tab_weld_desc','Material list done — the weld seam list still needs to be completed and marked done.')),
    mkTab('builder',t('home_tab_pending_doc','Pending welder document'),byStatus(2),t('tab_builder_desc','Weld list done — the welder document is ready to be generated, downloaded and printed.')),
    mkTab('welding',t('home_tab_pending_update','Pending welding update'),byStatus(3),t('tab_welding_desc','Welder document downloaded — as-built welding details still need to be entered and verified.')),
    mkTab('export',t('home_tab_pending_export','Pending export'),byStatus(4),t('tab_export_desc','Welding details recorded and verified — the final document can now be exported.')),
    mkTab('wazcert',t('tab_wazcert','Pending WAZ certificates'),pipelinesPendingWaz(),t('tab_wazcert_desc','Pipelines with at least one material whose WAZ (material acceptance) certificate is still missing.'),true),
    mkTab('certs',t('tab_certs','Pending welder certificates'),pipelinesPendingCert(),t('tab_certs_desc','Active pipelines whose assigned welders have an expired or missing certificate.'),true),
    mkTab('assign',t('tab_assign','Pending welder/inspector assignment'),pipelinesUnassignedAny(),t('tab_assign_desc','Pipelines still missing a welder and/or an inspector.'),true),
    {key:'expiry',label:t('tab_expiry','Certificate expiry ≤30d'),count:expiry.length,alert:true,desc:t('tab_expiry_desc','Welder certificates expiring within the next 30 days — plan renewals ahead of time.'),render:()=>homeCertTable(expiry)}
  ];
}
function vendorTabs(){
  const uid=getCurrentUserId();
  const mkTab=(key,label,list,desc)=>({key,label,count:list.length,desc,render:()=>homePipelineTable(list,t('home_empty_none','None right now.'))});
  return [
    mkTab('assigned',t('tab_assigned_vendor','Assigned pipelines'),pipelinesForUser(uid),t('tab_assigned_vendor_desc','Pipelines where you are assigned as a welder or inspector.')),
    mkTab('uw',t('tab_uw_vendor','Unassigned welder'),pipelinesUnassignedWelder(),t('tab_uw_vendor_desc','Pipelines that still need a welder assigned — available to pick up.')),
    mkTab('ui',t('tab_ui_vendor','Unassigned inspector'),pipelinesUnassignedInspector(),t('tab_ui_vendor_desc','Pipelines that still need an inspector assigned.'))
  ];
}
function setHomeTab(k){ homeTab=k; renderHomePage(); }
function renderHomePage(){
  const role=getRole();
  const tabs=role==='vendor'?vendorTabs():officeTabs();
  if(!homeTab||!tabs.find(t=>t.key===homeTab)) homeTab=tabs[0].key;
  document.getElementById('home-title').textContent=role==='vendor'?t('my_work','My work'):t('office_dashboard','Office dashboard');
  document.getElementById('home-subtitle').textContent=role==='vendor'?`${t('signed_in_as','Signed in as')} ${escapeHtml((getPerson(getCurrentUserId())||{}).name||'')} · ${t('vendor','Vendor')}`:t('workload_subtitle','Pipelines grouped by what needs to happen next — the count on each tab is the workload.');
  document.getElementById('home-tabs').innerHTML=tabs.map(t=>`<button class="home-tab ${t.key===homeTab?'active':''} ${t.alert&&t.count?'alert':''}" onclick="setHomeTab('${t.key}')">${escapeHtml(t.label)} <span class="tab-count">${t.count}</span></button>`).join('');
  const active=tabs.find(t=>t.key===homeTab);
  document.getElementById('home-desc').textContent=active.desc||'';
  document.getElementById('home-content').innerHTML=active.render();
}

/* ================================================================ WAZ DOCUMENTS PAGE ================================================================ */
let wazFilters={clientId:'',projectId:''};
async function initWazPage(){ PAGE.name='waz'; initDB();
  try {
    const bulk = await apiBulk(['clients','projects','pipelines','pipelineMaterials']);
    DB.clients=bulk.clients||[]; DB.projects=normalizeProjects(bulk.projects||[]); DB.pipelines=bulk.pipelines||[]; DB.materials=normalizeMaterials(bulk.pipelineMaterials||[]);
  } catch(e){ console.error('API error:', e); }
  renderChrome('waz',t('waz_documents','WAZ Documents')); mountModals(); wireModalDismiss(); buildWazFilters(); renderWazPage();
}
function buildWazFilters(){
  const cliSel=document.getElementById('waz-filter-client'), prSel=document.getElementById('waz-filter-project');
  cliSel.innerHTML='<option value="">'+t('all_clients','All clients')+'</option>'+clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  prSel.innerHTML='<option value="">'+t('all_projects','All projects')+'</option>'+projects().map(p=>`<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');
  cliSel.value=wazFilters.clientId; prSel.value=wazFilters.projectId;
}
function onWazFilterChange(){ wazFilters.clientId=document.getElementById('waz-filter-client').value; wazFilters.projectId=document.getElementById('waz-filter-project').value; renderWazPage(); }
function clearWazFilters(){ wazFilters={clientId:'',projectId:''}; buildWazFilters(); renderWazPage(); }
function wazMaterialsFiltered(){
  return materials().filter(m=>m.wazNo).filter(m=>{ const pl=getPipeline(m.pipelineId); if(!pl) return false; const pr=getProject(pl.projectId); if(!pr) return false;
    if(wazFilters.projectId && pr.id!==Number(wazFilters.projectId)) return false;
    if(wazFilters.clientId && pr.clientId!==Number(wazFilters.clientId)) return false; return true; });
}
function renderWazPage(){
  const mats=wazMaterialsFiltered();
  const groups={}; mats.forEach(m=>{ (groups[m.wazNo]=groups[m.wazNo]||[]).push(m); });
  const keys=Object.keys(groups).sort((a, b) => {
    const numA = (a.match(/(\d+)/) || [])[1];
    const numB = (b.match(/(\d+)/) || [])[1];
    if(numA && numB && Number(numA) !== Number(numB)) {
      return Number(numB) - Number(numA);
    }
    const idA = Math.max(...groups[a].map(m => m.id || 0));
    const idB = Math.max(...groups[b].map(m => m.id || 0));
    if(idB !== idA) return idB - idA;
    return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
  });
  document.getElementById('waz-stats').innerHTML=tile(keys.length,t('total_waz','WAZ documents'),'')+tile(mats.length,t('materials_covered','Materials covered'),'t-neutral')+tile(new Set(mats.map(m=>{const pl=getPipeline(m.pipelineId);return pl?pl.projectId:0;})).size,t('total_projects','Projects'),'t-copper');
  const tbody=document.getElementById('waz-tbody');
  tbody.innerHTML=keys.length? keys.map(waz=>{
    const list=groups[waz], first=list[0];
    const pls=[...new Set(list.map(m=>m.pipelineId))].map(getPipeline).filter(Boolean);
    const prs=[...new Set(pls.map(p=>p.projectId))].map(getProject).filter(Boolean);
    const matList=list.map(m=>`<div><a class="cell-link" href="material-detail.html?id=${m.id}">${posLetter(m.position)} · ${escapeHtml(m.piece)}</a></div>`).join('');
    return `<tr>
      <td><button class="doc-chip doc-weld" onclick="showWaz(${first.id})" title="${t('view_document','View WAZ PDF')}">${escapeHtml(waz)}</button></td>
      <td>${matList}</td>
      <td>${escapeHtml([...new Set(list.map(m=>m.certificate).filter(Boolean))].join(', '))||'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml([...new Set(list.map(m=>m.heatNo).filter(Boolean))].join(', '))||'<span class="muted">—</span>'}</td>
      <td>${prs.map(p=>`<a class="cell-link" href="project-detail.html?id=${p.id}">${escapeHtml(p.title)}</a>`).join('<br>')}</td>
      <td><a class="doc-chip doc-iso" href="${escapeHtml(first.wazPdfUrl)}" target="_blank" rel="noopener">PDF</a></td>
    </tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="6">${t('no_waz_match','No WAZ documents match these filters.')}</td></tr>`;
}

/* ================================================================ MATERIALS PAGE (all pipelines) ================================================================ */
let matFilters={clientId:'',projectId:'',piece:'',dn:'',dien:'',diameter:'',thickness:'',code:'',waz:''};
function updateMaterialsCrumb(){
  return t('materials','Materials');
}
async function initMaterialsPage(){
  PAGE.name='materials'; initDB();
  const clientParam=qp('client'), projectParam=qp('project');
  if(clientParam) matFilters.clientId=clientParam;
  if(projectParam) matFilters.projectId=projectParam;
  PAGE.clientId = null;
  PAGE.projectId = null;
  renderChrome('materials',t('materials','Materials')); mountModals(); wireModalDismiss(); buildMatClientProjectFilters(); renderMaterialsPage();

  try {
    const data = await apiGet('/page/materials');
    DB.clients=data.clients||[];
    DB.projects=normalizeProjects(data.projects||[]);
    DB.pipelines=data.pipelines||[];
    DB.materials=normalizeMaterials(data.materials||[]);
    DB.globalMaterialCount=DB.materials.length;
    renderChrome('materials',t('materials','Materials'));
    buildMatClientProjectFilters();
    renderMaterialsPage();
  } catch(e){ console.error('API error:', e); }
}
function buildMatClientProjectFilters(){
  const cliSel=document.getElementById('mat-filter-client'), prSel=document.getElementById('mat-filter-project');
  if(cliSel) cliSel.innerHTML='<option value="">'+t('all_clients','All clients')+'</option>'+clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if(prSel){
    const prjList=matFilters.clientId?projects().filter(p=>p.clientId===Number(matFilters.clientId)):projects();
    prSel.innerHTML='<option value="">'+t('all_projects','All projects')+'</option>'+prjList.map(p=>`<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');
  }
  if(cliSel) cliSel.value=matFilters.clientId;
  if(prSel) prSel.value=matFilters.projectId;
}
/* Column-header filter: build a <th> with clickable dropdown */
function colFilterTh(label,filterKey,options,curVal){
  const isActive=!!curVal;
  const activeClass=isActive?'active':'';
  const badge=isActive?'1':'';
  let optsHtml=`<button class="cf-clear" onclick="setMatFilter('${filterKey}','')">Clear filter</button>`;
  optsHtml+=options.map(o=>`<div class="cf-opt ${curVal===o?'selected':''}" onclick="setMatFilter('${filterKey}','${escapeHtml(o).replace(/'/g,"\\'")}');">${escapeHtml(o)}</div>`).join('');
  return `<th class="col-filter ${activeClass}" onclick="toggleColFilter(this,event)"><span class="col-filter-btn">${label}${badge?' <span style=\"display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:var(--copper);color:#fff;font-size:0.6rem;font-weight:700;\">'+badge+'</span>':''}</span><div class="col-filter-panel">${optsHtml}</div></th>`;
}
function toggleColFilter(th,e){
  if(e.target.closest('.col-filter-panel')) return; /* don't toggle if clicking inside panel */
  const wasOpen=th.classList.contains('open');
  document.querySelectorAll('.col-filter.open').forEach(el=>el.classList.remove('open'));
  if(!wasOpen){
    th.classList.add('open');
    /* position the panel below the header using fixed positioning */
    const panel=th.querySelector('.col-filter-panel');
    if(panel){
      const rect=th.getBoundingClientRect();
      panel.style.top=(rect.bottom+4)+'px';
      panel.style.left=rect.left+'px';
    }
  }
}
function setMatFilter(key,val){
  matFilters[key]=val;
  document.querySelectorAll('.col-filter.open').forEach(el=>el.classList.remove('open'));
  renderMaterialsPage();
}
document.addEventListener('click',e=>{ if(!e.target.closest('.col-filter')) document.querySelectorAll('.col-filter.open').forEach(el=>el.classList.remove('open')); });
function onMaterialsFilterChange(){
  const el=id=>document.getElementById(id);
  const cliEl=el('mat-filter-client');
  const prjEl=el('mat-filter-project');
  if(cliEl){
    const clientChanged=cliEl.value!==matFilters.clientId;
    matFilters.clientId=cliEl.value;
    if(clientChanged){
      matFilters.projectId='';
    }
  }
  if(prjEl){
    matFilters.projectId=prjEl.value;
  }
  buildMatClientProjectFilters();
  renderChrome('materials',t('materials','Materials'));
  renderMaterialsPage();
}
function clearMaterialsFilters(){
  matFilters={clientId:'',projectId:'',piece:'',dn:'',dien:'',diameter:'',thickness:'',code:'',waz:''};
  PAGE.clientId = null;
  PAGE.projectId = null;
  renderChrome('materials',t('materials','Materials'));
  buildMatClientProjectFilters();
  renderMaterialsPage();
}
function matSpecKey(m){
  let k = `${m.piece||''}|${m.itemDescription||m.piece||''}|${m.dimension||''}|${m.dienNo||''}|${m.diameter||''}|${m.thickness||''}|${m.surface||''}|${m.materialCode||''}`;
  for(let i=2; i<=6; i++){
    k += `|${m['dimension'+i]||m['dn'+i]||''}`;
  }
  return k;
}
function renderMaterialsPage(){
  // 1. Filter raw materials by Client and Project filters (from top filter-bar)
  const scopedMats = materials().filter(m => {
    const pl = getPipeline(m.pipelineId);
    if(matFilters.projectId && (!pl || pl.projectId !== Number(matFilters.projectId))) return false;
    if(matFilters.clientId){
      if(!pl) return false;
      const pr = getProject(pl.projectId);
      if(!pr || pr.clientId !== Number(matFilters.clientId)) return false;
    }
    return true;
  });

  // 2. Group materials by unique specification
  const groupMap = new Map();
  scopedMats.forEach(m => {
    const k = matSpecKey(m);
    if(!groupMap.has(k)){
      groupMap.set(k, {
        id: m.id,
        piece: m.piece,
        itemDescription: m.itemDescription || m.piece,
        dimension: m.dimension,
        dimension2: m.dimension2||m.dn2||'',
        dimension3: m.dimension3||m.dn3||'',
        dimension4: m.dimension4||m.dn4||'',
        dimension5: m.dimension5||m.dn5||'',
        dimension6: m.dimension6||m.dn6||'',
        dienNo: m.dienNo||'',
        diameter: m.diameter||'',
        thickness: m.thickness||'',
        surface: m.surface||'',
        materialCode: m.materialCode||'',
        allIds: [m.id],
        wazEntries: [],
        totalCount: 0
      });
    }
    const g = groupMap.get(k);
    g.totalCount++;
    if(m.id && !g.allIds.includes(m.id)) g.allIds.push(m.id);
    if(m.wazNo && !g.wazEntries.some(w => w.wazNo === m.wazNo)){
      g.wazEntries.push({ wazNo: m.wazNo, matId: m.id, wazPdfUrl: m.wazPdfUrl || m.wazPackageUrl || '' });
    }
  });

  const allGroups = Array.from(groupMap.values());
  // Sort WAZ entries for each material group so latest uploaded / highest WAZ number comes first
  allGroups.forEach(g => {
    g.wazEntries.sort((a, b) => {
      const numA = (a.wazNo.match(/(\d+)/) || [])[1];
      const numB = (b.wazNo.match(/(\d+)/) || [])[1];
      if(numA && numB && Number(numA) !== Number(numB)) {
        return Number(numB) - Number(numA);
      }
      if((b.matId || 0) !== (a.matId || 0)) {
        return (b.matId || 0) - (a.matId || 0);
      }
      return b.wazNo.localeCompare(a.wazNo, undefined, { numeric: true, sensitivity: 'base' });
    });
  });

  // 3. Apply column-level filters (Category, DN, DIN EN, Diameter, Thickness, Code, WAZ)
  const filteredGroups = allGroups.filter(g => {
    if(matFilters.piece && g.piece !== matFilters.piece) return false;
    if(matFilters.dn && g.dimension !== matFilters.dn) return false;
    if(matFilters.dien && (g.dienNo||'') !== matFilters.dien) return false;
    if(matFilters.diameter && (g.diameter||'') !== matFilters.diameter) return false;
    if(matFilters.thickness && (g.thickness||'') !== matFilters.thickness) return false;
    if(matFilters.code && g.materialCode !== matFilters.code) return false;
    if(matFilters.waz && !g.wazEntries.some(w => w.wazNo === matFilters.waz)) return false;
    return true;
  });

  // 4. Stats
  const totalUsages = filteredGroups.reduce((acc, g) => acc + g.totalCount, 0);
  const totalWazSet = new Set();
  filteredGroups.forEach(g => g.wazEntries.forEach(w => totalWazSet.add(w.wazNo)));
  document.getElementById('materials-stats').innerHTML =
    tile(filteredGroups.length, t('unique_materials', 'Unique materials'), '') +
    tile(totalUsages, t('total_used', 'Total used'), 't-neutral') +
    tile(totalWazSet.size, t('total_waz', 'WAZ documents'), 't-success');

  // 5. Max DN for multi-DN pieces
  let maxDn = 1;
  filteredGroups.forEach(g => { for(let i=2; i<=6; i++){ if(g[`dimension${i}`]) maxDn = Math.max(maxDn, i); } });

  // 6. Render table rows
  const tbody = document.getElementById('materials-page-tbody');
  tbody.innerHTML = filteredGroups.length ? filteredGroups.map((g, idx) => {
    let extraDnCells = '';
    for(let i=2; i<=maxDn; i++) extraDnCells += `<td class="col-mono">${g[`dimension${i}`] ? escapeHtml(g[`dimension${i}`]) : '<span class="muted">—</span>'}</td>`;

    let wazChips = '<span class="muted">—</span>';
    if(g.wazEntries.length){
      const maxVisible = 3;
      const visibleWaz = g.wazEntries.slice(0, maxVisible);
      const hiddenWaz = g.wazEntries.slice(maxVisible);
      const visibleHtml = visibleWaz.map(w => `<button class="doc-chip doc-weld" onclick="showWaz(${w.matId})" title="${t('view_document','View WAZ PDF')}">${escapeHtml(w.wazNo)}</button>`).join('');
      let hiddenHtml = '';
      if(hiddenWaz.length){
        const hiddenChips = hiddenWaz.map(w => `<button class="doc-chip doc-weld" onclick="showWaz(${w.matId})" title="${t('view_document','View WAZ PDF')}">${escapeHtml(w.wazNo)}</button>`).join('');
        hiddenHtml = `<span class="waz-extra-chips" id="waz-extra-${idx}" style="display:none;">${hiddenChips}</span>` +
          `<button type="button" class="doc-chip doc-more" onclick="toggleWazMore(this, 'waz-extra-${idx}', ${hiddenWaz.length})" title="${t('show_more', 'Show')} ${hiddenWaz.length} ${t('more', 'more')}">+${hiddenWaz.length}</button>`;
      }
      wazChips = `<div class="waz-chip-group">${visibleHtml}${hiddenHtml}</div>`;
    }

    return `<tr>
      <td>${escapeHtml(g.piece)}</td>
      <td class="td-mat-desc"><a class="cell-link text-truncate-desc" href="material-usage.html?piece=${encodeURIComponent(g.piece)}&desc=${encodeURIComponent(g.itemDescription)}&dn=${encodeURIComponent(g.dimension)}&dien=${encodeURIComponent(g.dienNo||'')}&dia=${encodeURIComponent(g.diameter||'')}&thk=${encodeURIComponent(g.thickness||'')}&code=${encodeURIComponent(g.materialCode)}" title="${escapeHtml(g.itemDescription)}">${escapeHtml(g.itemDescription)}</a></td>
      <td class="col-mono">${escapeHtml(g.dimension)}</td>${extraDnCells}
      <td class="col-mono">${escapeHtml(g.dienNo||'')}</td>
      <td class="col-mono">${g.diameter ? fmtDia(g.diameter) : ''}</td>
      <td class="col-mono">${escapeHtml(g.thickness||'')}</td>
      <td class="col-mono">${escapeHtml(g.surface||'')}</td>
      <td class="col-mono">${escapeHtml(g.materialCode)}</td>
      <td class="td-waz-cell">${wazChips}</td>
      <td class="col-actions"><button class="btn-link" onclick="openMaterialsPageEdit(${g.id})">${t('edit','Edit')}</button></td>
    </tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="${10+(maxDn-1)}">${t('no_materials_match','No materials match these filters.')}</td></tr>`;

  // 7. Update column filter headers
  const allPieces = [...new Set(allGroups.map(g => g.piece).filter(Boolean))].sort();
  const allDnOpts = [...new Set(allGroups.map(g => g.dimension).filter(Boolean))].sort();
  const allDienOpts = [...new Set(allGroups.map(g => g.dienNo).filter(Boolean))].sort();
  const allDiaOpts = [...new Set(allGroups.map(g => g.diameter).filter(Boolean))].sort();
  const allThkOpts = [...new Set(allGroups.map(g => g.thickness).filter(Boolean))].sort();
  const allCodeOpts = [...new Set(allGroups.map(g => g.materialCode).filter(Boolean))].sort();
  const allWazOpts = [...new Set(allGroups.flatMap(g => g.wazEntries.map(w => w.wazNo)).filter(Boolean))].sort();

  const thead = document.getElementById('mat-thead');
  if(thead){
    let hdr = colFilterTh(t('th_category','Category'), 'piece', allPieces, matFilters.piece);
    hdr += `<th>${t('th_item_description','Item description')}</th>`;
    hdr += colFilterTh(maxDn>1?'DN 1':'DN', 'dn', allDnOpts, matFilters.dn);
    for(let i=2; i<=maxDn; i++) hdr += `<th>DN ${i}</th>`;
    hdr += colFilterTh(t('th_din_en_no','DIN EN No.'), 'dien', allDienOpts, matFilters.dien);
    hdr += colFilterTh(t('th_diameter','Diameter'), 'diameter', allDiaOpts, matFilters.diameter);
    hdr += colFilterTh(t('th_thickness','Thickness'), 'thickness', allThkOpts, matFilters.thickness);
    hdr += `<th>${t('th_surface','Surface')}</th>`;
    hdr += colFilterTh(t('th_material','Material'), 'code', allCodeOpts, matFilters.code);
    hdr += colFilterTh(t('th_waz_no','WAZ No.'), 'waz', allWazOpts, matFilters.waz);
    hdr += `<th></th>`;
    thead.innerHTML = hdr;
  }
}
/* Edit from materials page — separate simple modal (no connections/position) */
let _materialsPageEditId=null;
let _mpOriginal=null; /* snapshot of original values before edit */
function openMaterialsPageEdit(id){
  _materialsPageEditId=id;
  const m=getMaterial(id);
  /* Save original values to find matching materials later */
  _mpOriginal={piece:m.piece, itemDescription:m.itemDescription, dimension:m.dimension,
    dienNo:m.dienNo||'', materialCode:m.materialCode, diameter:m.diameter||'', thickness:m.thickness||'', surface:m.surface||''};
  for(let i=2;i<=6;i++) _mpOriginal[`dimension${i}`]=m[`dimension${i}`]||'';
  const src=matSource();
  const allPieces=PIECE_OPTIONS.slice();
  const allDescs=[...new Set(src.map(i=>i.description).filter(Boolean))];
  const allDns=[...new Set(src.map(i=>i.dimension).filter(Boolean))];
  const allDiens=[...new Set(src.map(i=>i.dien).filter(Boolean))];
  const allCodes=[...new Set(src.map(i=>i.code).filter(Boolean))];
  const allDiameters=[...new Set(src.map(i=>i.diameter).filter(Boolean))];
  const allThicknesses=[...new Set(src.map(i=>i.thickness).filter(Boolean))];
  /* populate dropdowns */
  document.getElementById('mp-piece').innerHTML=allPieces.map(p=>`<option value="${escapeHtml(p)}" ${p===m.piece?'selected':''}>${escapeHtml(p)}</option>`).join('');
  buildSelectOther('mp-desc','mp-desc-new',allDescs,m.itemDescription);
  buildSelectOther('mp-dimension','mp-dimension-new',DIMENSION_OPTIONS,m.dimension,true);
  buildSelectOther('mp-dien','mp-dien-new',allDiens,m.dienNo||'');
  buildSelectOther('mp-code','mp-code-new',allCodes,m.materialCode);
  buildSelectOther('mp-diameter','mp-diameter-new',allDiameters,m.diameter||'');
  buildSelectOther('mp-thickness','mp-thickness-new',allThicknesses,m.thickness||'');
  const allSurfaces=[...new Set(materials().map(x=>x.surface).filter(Boolean))];
  buildSelectOther('mp-surface','mp-surface-new',allSurfaces,m.surface||'');
  /* show/hide diameter/thickness based on category */
  document.getElementById('mp-diameter-field').style.display=hasDiameter(m.piece)?'':'none';
  document.getElementById('mp-thickness-field').style.display=hasThickness(m.piece)?'':'none';
  /* DN fields */
  const dnCount=requiredDns(m.piece);
  const container=document.getElementById('mp-dn-container');
  container.querySelectorAll('.dn-extra-field').forEach(el=>el.remove());
  container.style.display=dnCount>0?'':'none';
  document.getElementById('mp-dn1-label').textContent=dnCount>1?'DN 1':'DN';
  for(let i=2;i<=dnCount;i++){
    const div=document.createElement('div');
    div.className='field dn-extra-field';
    div.innerHTML=`<span class="lbl">DN ${i}</span><select id="mp-dimension${i}" onchange="toggleSelectOther('mp-dimension${i}','mp-dimension${i}-new')"></select><input type="text" id="mp-dimension${i}-new" class="select-other-text" style="display:none" placeholder="Type DN ${i}…">`;
    container.appendChild(div);
    buildSelectOther(`mp-dimension${i}`,`mp-dimension${i}-new`,DIMENSION_OPTIONS,m[`dimension${i}`]||'',true);
  }
  openModal('modal-mat-props');
}
function onMpCategoryChange(){
  const piece=document.getElementById('mp-piece').value;
  document.getElementById('mp-diameter-field').style.display=hasDiameter(piece)?'':'none';
  document.getElementById('mp-thickness-field').style.display=hasThickness(piece)?'':'none';
  const dnCount=requiredDns(piece);
  const container=document.getElementById('mp-dn-container');
  container.querySelectorAll('.dn-extra-field').forEach(el=>el.remove());
  container.style.display=dnCount>0?'':'none';
  document.getElementById('mp-dn1-label').textContent=dnCount>1?'DN 1':'DN';
  for(let i=2;i<=dnCount;i++){
    const div=document.createElement('div');
    div.className='field dn-extra-field';
    div.innerHTML=`<span class="lbl">DN ${i}</span><select id="mp-dimension${i}" onchange="toggleSelectOther('mp-dimension${i}','mp-dimension${i}-new')"></select><input type="text" id="mp-dimension${i}-new" class="select-other-text" style="display:none" placeholder="Type DN ${i}…">`;
    container.appendChild(div);
    buildSelectOther(`mp-dimension${i}`,`mp-dimension${i}-new`,DIMENSION_OPTIONS,'',true);
  }
}
function onMpDescChange(){ toggleSelectOther('mp-desc','mp-desc-new'); }
function saveMaterialProps(e){
  e.preventDefault();
  const m=getMaterial(_materialsPageEditId); if(!m) return;
  m.piece=document.getElementById('mp-piece').value;
  m.itemDescription=readSelectOther('mp-desc','mp-desc-new')||m.piece;
  m.dimension=readSelectOther('mp-dimension','mp-dimension-new');
  const dnCount=requiredDns(m.piece);
  for(let i=2;i<=dnCount;i++){
    const sel=document.getElementById(`mp-dimension${i}`);
    const txt=document.getElementById(`mp-dimension${i}-new`);
    if(sel&&txt) m[`dimension${i}`]=readSelectOther(`mp-dimension${i}`,`mp-dimension${i}-new`);
  }
  for(let i=dnCount+1;i<=6;i++) m[`dimension${i}`]='';
  m.dienNo=readSelectOther('mp-dien','mp-dien-new');
  m.materialCode=readSelectOther('mp-code','mp-code-new');
  m.diameter=hasDiameter(m.piece)?readSelectOther('mp-diameter','mp-diameter-new'):'';
  m.thickness=hasThickness(m.piece)?readSelectOther('mp-thickness','mp-thickness-new'):'';
  m.surface=readSelectOther('mp-surface','mp-surface-new');
  closeModal('modal-mat-props');
  /* Show warning before saving global material */
  document.getElementById('modal-apply-all-piece').textContent=`${m.piece} · ${m.itemDescription} · ${m.dimension}`;
  openModal('modal-apply-all');
}
let _pendingGlobalEdit=null;
function confirmGlobalEdit(){
  const m=getMaterial(_materialsPageEditId); if(!m) return;
  saveDB();
  /* Sync edit to global materials API */
  try {
    apiPost('/global-materials/'+m.id, {category:m.piece, itemDescription:m.itemDescription, dn1:m.dimension,
      dn2:m.dimension2||'', dn3:m.dimension3||'', dn4:m.dimension4||'', dn5:m.dimension5||'', dn6:m.dimension6||'',
      dienNo:m.dienNo, materialCode:m.materialCode, diameter:m.diameter, thickness:m.thickness, surface:m.surface||''});
  } catch(e){ console.error('Edit global material API error:', e); }
  closeModal('modal-apply-all'); _materialsPageEditId=null; _mpOriginal=null; rerenderPage();
}
function cancelGlobalEdit(){
  /* Revert local changes */
  const m=getMaterial(_materialsPageEditId);
  if(m && _mpOriginal){
    m.piece=_mpOriginal.piece; m.itemDescription=_mpOriginal.itemDescription;
    m.dimension=_mpOriginal.dimension; m.dienNo=_mpOriginal.dienNo;
    m.materialCode=_mpOriginal.materialCode; m.diameter=_mpOriginal.diameter;
    m.thickness=_mpOriginal.thickness; m.surface=_mpOriginal.surface||'';
    for(let i=2;i<=6;i++) m[`dimension${i}`]=_mpOriginal[`dimension${i}`]||'';
  }
  closeModal('modal-apply-all'); _materialsPageEditId=null; _mpOriginal=null; rerenderPage();
}

/* ================================================================ PROJECT DETAIL PAGE ================================================================ */
let _projMatEditId=null;
async function initProjectDetailPage(){
  PAGE.name='project-detail'; initDB(); PAGE.projectId=Number(qp('id'));
  try {
    const data = await apiGet('/page/project-detail/'+PAGE.projectId);
    DB.clients=data.client?[data.client]:[];
    DB.pipelines=data.pipelines||[];
    DB.projects=normalizeProjects(data.projects||(data.project?[data.project]:[]));
    DB.globalMaterials=data.globalMaterials||[];
    DB.projectMaterials=data.projectMaterials||[];
  } catch(e){ console.error('API error:', e); }
  const pr=getProject(PAGE.projectId);
  if(!pr){ renderChrome('pipelines',t('projects','Projects')); return; }
  PAGE.clientId=pr.clientId;
  renderChrome('pipelines',`<a href="projects.html">${t('projects','Projects')}</a> / ${escapeHtml(pr.title)}`); mountModals(); wireModalDismiss(); renderProjectDetail();
}
function switchProject(id){ if(id&&Number(id)!==PAGE.projectId) location.href='project-detail.html?id='+id; }
function renderProjectDetail(){
  const pr=getProject(PAGE.projectId); if(!pr) return; const cli=getClient(pr.clientId);
  pr.status=computeProjectStatus(pr);
  document.getElementById('project-context').innerHTML=`${cli?`<a href="projects.html?client=${cli.id}">${escapeHtml(cli.name)}</a>`:''}<span class="sep">›</span><span>${escapeHtml(pr.title)}</span>`;
  const siblings=cli?clientProjects(cli.id):[pr];
  document.getElementById('project-switch').innerHTML=siblings.map(s=>`<option value="${s.id}" ${s.id===pr.id?'selected':''}>${escapeHtml(s.title)}</option>`).join('');
  document.getElementById('project-subtitle').textContent=`${cli?cli.name:'—'}${pr.location?' · '+pr.location:''}${siblings.length>1?` · ${siblings.length} ${t('projects_for_client','projects for this client')}`:''}`;
  const item=(k,v,mono)=>`<div class="info-item"><div class="k">${k}</div><div class="v ${mono?'mono':''}">${v}</div></div>`;
  document.getElementById('project-info').innerHTML=item(t('client','Client'),cli?escapeHtml(cli.name):'—')+item(t('location','Location'),escapeHtml(pr.location)||'—')+item(t('order_number','Order number'),pr.order?escapeHtml(pr.order):'—',true)+item(t('th_ist_project_no','IST Project No.'),escapeHtml(pr.istProjectNo)||'—',true)+item(t('status','Status'),`<span class="status-badge status-${pr.status}">${STATUS_LABELS[pr.status]||pr.status}</span>`)+item(t('description','Description'),escapeHtml(pr.description)||'—')+(pr.sharepointFolderUrl?item(t('sharepoint_folder','SharePoint folder'),`<a href="${escapeHtml(pr.sharepointFolderUrl)}" target="_blank" class="link">${t('view_folder','View folder')}</a>`):'');
  const pls=projectPipelines(pr.id); const by=s=>pls.filter(p=>p.status===s).length;
  document.getElementById('project-stats').innerHTML=tile(pls.length,t('total_pipelines','Pipelines'),'')+tile(pls.filter(p=>p.status<5).length,t('in_progress','In progress'),'t-copper')+tile(by(5),t('exported','Exported'),'t-success');
  document.getElementById('project-toolbar').innerHTML=`<h2>${t('pipelines','Pipelines')}</h2><div style="display:flex;gap:8px;"><a class="btn btn-ghost btn-sm" href="archive.html?tab=pipelines"><svg viewBox="0 0 24 24" width="14" height="14" fill="none"><rect x="3" y="4" width="18" height="4" rx="1" stroke="currentColor" stroke-width="1.8"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M10 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> ${t('archive','Archive')}</a><button class="btn btn-primary btn-sm" onclick="openPipelineModal()">${t('new_pipeline','+ New pipeline')}</button></div>`;
  document.getElementById('project-pipelines').innerHTML=homePipelineTable(pls,t('no_pipelines_in_project','No pipelines in this project yet.'));
  renderProjectMaterialsTable();
}

/* --- Project view tab switching --- */
function showProjectView(tab){
  document.querySelectorAll('.subtab').forEach(b=>b.classList.remove('active'));
  document.getElementById('subtab-'+tab).classList.add('active');
  document.getElementById('project-pipelines-view').style.display=tab==='pipelines'?'':'none';
  document.getElementById('project-materials-view').style.display=tab==='proj-materials'?'':'none';
}

/* --- Project Materials table --- */
let pmFilters={piece:'',dn:'',dien:'',diameter:'',thickness:'',code:''};
function setPmFilter(key,val){
  pmFilters[key]=val;
  document.querySelectorAll('.col-filter.open').forEach(el=>el.classList.remove('open'));
  renderProjectMaterialsTable();
}
function clearPmFilters(){ pmFilters={piece:'',dn:'',dien:'',diameter:'',thickness:'',code:''}; renderProjectMaterialsTable(); }
function renderProjectMaterialsTable(){
  const tbody=document.getElementById('proj-materials-tbody');
  if(!tbody) return;
  const allMats=DB.projectMaterials||[];
  /* Apply filters */
  const mats=allMats.filter(pm=>{
    const gm=(DB.globalMaterials||[]).find(g=>g.id===pm.globalMaterialId)||{};
    if(pmFilters.piece && gm.category!==pmFilters.piece) return false;
    if(pmFilters.dn && gm.dn1!==pmFilters.dn) return false;
    if(pmFilters.dien && (gm.dienNo||'')!==pmFilters.dien) return false;
    if(pmFilters.diameter && (gm.diameter||'')!==pmFilters.diameter) return false;
    if(pmFilters.thickness && (gm.thickness||'')!==pmFilters.thickness) return false;
    if(pmFilters.code && (gm.materialCode||'')!==pmFilters.code) return false;
    return true;
  });
  /* Find max DN count across all project materials */
  let maxDn=1;
  const allGmsForDn=allMats.map(pm=>(DB.globalMaterials||[]).find(g=>g.id===pm.globalMaterialId)||{});
  allGmsForDn.forEach(g=>{ for(let i=2;i<=6;i++){ if(g[`dn${i}`]) maxDn=Math.max(maxDn,i); } });

  const colCount=12+maxDn; /* #, category, desc, dn1..maxDn, diameter, thickness, dien, surface, material, cert, heat, waz, edit */
  if(!mats.length){ tbody.innerHTML=`<tr><td colspan="${colCount}" class="empty">${allMats.length?t('no_materials_match_filters','No materials match these filters.'):t('no_materials_yet','No project materials yet. Click "+ Add material" to add one.')}</td></tr>`; }
  else {
    tbody.innerHTML=mats.map((pm,i)=>{
    const gm=(DB.globalMaterials||[]).find(g=>g.id===pm.globalMaterialId)||{};
    let extraDnCells='';
    for(let d=2;d<=maxDn;d++) extraDnCells+=`<td class="col-mono">${gm[`dn${d}`]?escapeHtml(gm[`dn${d}`]):'<span class="muted">—</span>'}</td>`;
    return `<tr>
      <td>${i+1}</td>
      <td>${escapeHtml(gm.category||'')}</td>
      <td>${escapeHtml(gm.itemDescription||'')}</td>
      <td class="col-mono">${escapeHtml(gm.dn1||'')}</td>${extraDnCells}
      <td class="col-mono">${escapeHtml(gm.diameter||'')}</td>
      <td class="col-mono">${escapeHtml(gm.thickness||'')}</td>
      <td class="col-mono">${escapeHtml(gm.dienNo||'')}</td>
      <td class="col-mono">${escapeHtml(gm.surface||'')}</td>
      <td class="col-mono">${escapeHtml(gm.materialCode||'')}</td>
      <td class="col-mono">${escapeHtml(pm.certificate||'')}</td>
      <td class="col-mono">${escapeHtml(pm.heatNo||'')}</td>
      <td>${pm.wazPdfUrl?'<a href="'+escapeHtml(pm.wazPdfUrl)+'" target="_blank" class="link">'+t('view','View')+'</a>':'<span class="muted">—</span>'}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="openProjectMaterialModal(${pm.id})">${t('edit','Edit')}</button></td>
    </tr>`;
  }).join('');
  }
  /* Build column filter headers */
  const thead=document.getElementById('proj-mat-thead');
  if(thead){
    const allGms=allMats.map(pm=>(DB.globalMaterials||[]).find(g=>g.id===pm.globalMaterialId)||{});
    const opts=key=>[...new Set(allGms.map(g=>g[key]).filter(Boolean))].sort();
    const pmfTh=(label,key,options)=>colFilterTh(label,key,options,pmFilters[key]).replace(/setMatFilter/g,'setPmFilter');
    let hdr='<th>#</th>';
    hdr+=pmfTh(t('th_category','Category'),'piece',opts('category'));
    hdr+=`<th>${t('th_item_description','Item description')}</th>`;
    hdr+=pmfTh(maxDn>1?'DN 1':'DN','dn',opts('dn1'));
    for(let d=2;d<=maxDn;d++) hdr+=`<th>DN ${d}</th>`;
    hdr+=pmfTh(t('th_diameter','Diameter'),'diameter',opts('diameter'));
    hdr+=pmfTh(t('th_thickness','Thickness'),'thickness',opts('thickness'));
    hdr+=pmfTh(t('th_din_en_no','DIN EN No.'),'dien',opts('dienNo'));
    hdr+=`<th>${t('th_surface','Surface')}</th>`;
    hdr+=pmfTh(t('th_material','Material'),'code',opts('materialCode'));
    hdr+=`<th>${t('th_certificate','Certificate')}</th><th>${t('th_heat_no','Heat No.')}</th><th>${t('th_mat_cert','Mat. Cert.')}</th><th></th>`;
    thead.innerHTML=hdr;
  }
}

/* --- Project Material Modal --- */
function openProjectMaterialModal(editId){
  _projMatEditId=editId||null;
  const existing=_projMatEditId?DB.projectMaterials.find(m=>m.id===_projMatEditId):null;
  const gm=existing?(DB.globalMaterials||[]).find(g=>g.id===existing.globalMaterialId):null;
  const title=existing?t('edit_project_material','Edit project material'):t('add_project_material','Add project material');

  /* Build the modal HTML with all fields */
  const allGm=DB.globalMaterials||[];
  const allPieces=[...new Set(allGm.map(g=>g.category).filter(Boolean))];
  const allDescs=[...new Set(allGm.map(g=>g.itemDescription).filter(Boolean))];
  const allDiens=[...new Set(allGm.map(g=>g.dienNo).filter(Boolean))];
  const allCodes=[...new Set(allGm.map(g=>g.materialCode).filter(Boolean))];
  const allDiameters=[...new Set(allGm.map(g=>g.diameter).filter(Boolean))];
  const allThicknesses=[...new Set(allGm.map(g=>g.thickness).filter(Boolean))];

  let modal=document.getElementById('modal-proj-material');
  if(!modal){
    const overlay=document.createElement('div');
    overlay.className='modal-overlay';
    overlay.id='modal-proj-material';
    overlay.innerHTML=`<div class="modal modal-wide">
      <button class="modal-close" onclick="closeModal('modal-proj-material')">&times;</button>
      <h2 id="modal-proj-material-title">${title}</h2>
      <form id="proj-material-form"><div class="form-grid">
        <div class="field"><span class="lbl">${t('category','Category')} <span class="req">*</span></span><select id="pm-category" onchange="onPmCategoryChange()"></select><input type="text" id="pm-category-new" class="select-other-text" style="display:none" placeholder="${t('type_category','Type category…')}"></div>
        <div class="field wide"><span class="lbl">${t('item_description','Item description')}</span><select id="pm-desc" onchange="onPmDescChange()"></select><input type="text" id="pm-desc-new" class="select-other-text" style="display:none" placeholder="${t('type_description','Type description…')}"></div>
        <div id="pm-dn-container" style="display:contents"><div class="field" id="pm-dn1-field"><span class="lbl" id="pm-dn1-label">DN</span><select id="pm-dn1" onchange="onPmDnChange()"></select><input type="text" id="pm-dn1-new" class="select-other-text" style="display:none" placeholder="${t('type_dn','Type DN…')}"></div></div>
        <div class="field"><span class="lbl">${t('material_code','Material code')} <span class="req">*</span></span><select id="pm-code" onchange="onPmCodeChange()"></select><input type="text" id="pm-code-new" class="select-other-text" style="display:none" placeholder="${t('type_material_code','Type code…')}"></div>
        <div class="field"><span class="lbl">${t('din_en_number','DIN EN Number')} <span class="req">*</span></span><select id="pm-dien" onchange="onPmDienChange()"></select><input type="text" id="pm-dien-new" class="select-other-text" style="display:none" placeholder="${t('type_din_en','Type DIN EN…')}"></div>
        <div class="field" id="pm-diameter-field"><span class="lbl">${t('outer_diameter','Outer diameter')} <span class="req">*</span></span><select id="pm-diameter" onchange="onPmDiameterChange()"></select><input type="text" id="pm-diameter-new" class="select-other-text" style="display:none" placeholder="${t('type_diameter','Type diameter…')}"></div>
        <div class="field" id="pm-thickness-field"><span class="lbl">${t('th_thickness','Thickness')} <span class="req">*</span></span><select id="pm-thickness" onchange="toggleSelectOther('pm-thickness','pm-thickness-new')"></select><input type="text" id="pm-thickness-new" class="select-other-text" style="display:none" placeholder="${t('type_thickness','Type thickness…')}"></div>
        <div class="field"><span class="lbl">${t('surface','Surface')}</span><select id="pm-surface" onchange="toggleSelectOther('pm-surface','pm-surface-new')"></select><input type="text" id="pm-surface-new" class="select-other-text" style="display:none" placeholder="${t('type_surface','Type surface…')}"></div>
        <div class="field-separator wide"></div>
        <label class="field"><span class="lbl">${t('cert_no','Certificate number')} <span class="req">*</span></span><input type="text" id="pm-certificate" required placeholder="${t('cert_no_placeholder','e.g. 12345')}"></label>
        <label class="field"><span class="lbl">${t('heat_melt_no','Heat number')} <span class="req">*</span></span><input type="text" id="pm-heat" required placeholder="${t('heat_no_placeholder','e.g. H-98765')}"></label>
        <div class="field wide"><span class="lbl">${t('mat_cert_pdf','Material certificate (PDF)')}</span><div id="pm-waz-section"></div></div>
        <div class="modal-err" id="pm-err"></div>
      </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-proj-material')">${t('cancel','Cancel')}</button><button type="submit" class="btn btn-primary">${t('save','Save')}</button></div></form>
    </div>`;
    document.getElementById('modal-root').appendChild(overlay);
    document.getElementById('proj-material-form').addEventListener('submit', saveProjectMaterial);
  }
  document.getElementById('modal-proj-material-title').textContent=title;

  /* Populate dropdowns */
  buildSelectOther('pm-category','pm-category-new',[...new Set([...allPieces,...PIECE_OPTIONS])],gm?gm.category:'');
  buildSelectOther('pm-desc','pm-desc-new',allDescs,gm?gm.itemDescription:'');
  buildSelectOther('pm-dn1','pm-dn1-new',DIMENSION_OPTIONS,gm?gm.dn1:'',true);
  buildSelectOther('pm-dien','pm-dien-new',allDiens,gm?gm.dienNo:'');
  buildSelectOther('pm-code','pm-code-new',allCodes,gm?gm.materialCode:'');
  buildSelectOther('pm-diameter','pm-diameter-new',allDiameters,gm?gm.diameter:'');
  buildSelectOther('pm-thickness','pm-thickness-new',allThicknesses,gm?gm.thickness:'');

  /* Surface - stored on global material */
  if(gm&&gm.surface){
    const allSurfaces=[...new Set((DB.globalMaterials||[]).map(g=>g.surface).filter(Boolean))];
    buildSelectOther('pm-surface','pm-surface-new',allSurfaces,gm.surface);
  } else {
    const allSurfaces=[...new Set((DB.globalMaterials||[]).map(g=>g.surface).filter(Boolean))];
    buildSelectOther('pm-surface','pm-surface-new',allSurfaces,'');
  }

  /* DN fields */
  const cat=gm?gm.category:'';
  const dnCount=requiredDns(cat);
  const container=document.getElementById('pm-dn-container');
  container.querySelectorAll('.dn-extra-field').forEach(el=>el.remove());
  container.style.display=dnCount>0?'contents':'none';
  document.getElementById('pm-dn1-field').style.display=dnCount>0?'':'none';
  document.getElementById('pm-dn1-label').textContent=dnCount>1?'DN 1':'DN';
  for(let i=2;i<=dnCount;i++){
    const div=document.createElement('div');
    div.className='field dn-extra-field';
    div.innerHTML=`<span class="lbl">DN ${i}</span><select id="pm-dn${i}" onchange="toggleSelectOther('pm-dn${i}','pm-dn${i}-new')"></select><input type="text" id="pm-dn${i}-new" class="select-other-text" style="display:none" placeholder="${t('type_dn','Type DN…')}">`;
    container.appendChild(div);
    buildSelectOther(`pm-dn${i}`,`pm-dn${i}-new`,DIMENSION_OPTIONS,gm?gm[`dn${i}`]:'',true);
  }

  /* Show/hide diameter/thickness */
  document.getElementById('pm-diameter-field').style.display=hasDiameter(cat)?'':'none';
  document.getElementById('pm-thickness-field').style.display=hasThickness(cat)?'':'none';

  /* Certificate fields */
  setV('pm-certificate',existing?existing.certificate:'');
  setV('pm-heat',existing?existing.heatNo:'');
  /* WAZ document section */
  const wazSection=document.getElementById('pm-waz-section');
  if(existing&&existing.wazPdfUrl){
    wazSection.innerHTML=`<div style="display:flex;align-items:center;gap:12px;"><a href="${escapeHtml(existing.wazPdfUrl)}" target="_blank" class="btn btn-ghost btn-sm">${t('view_pdf','View PDF')}</a><button type="button" class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deletePmWaz(${existing.id})">${t('remove','Remove')}</button></div>`;
  } else {
    wazSection.innerHTML=`<input type="file" id="pm-waz-file" accept=".pdf,application/pdf">`;
  }
  document.getElementById('pm-err').textContent='';
  document.getElementById('pm-err').classList.remove('show');

  openModal('modal-proj-material');
}

async function deletePmWaz(pmId){
  if(!confirm(t('confirm_remove_mat_cert','Remove the material certificate? This will delete it from SharePoint.'))) return;
  try {
    await apiPost('/project-materials/'+pmId+'/delete-waz', {});
    /* Update local data */
    const pm=DB.projectMaterials.find(m=>m.id===pmId);
    if(pm) pm.wazPdfUrl='';
    /* Refresh the WAZ section in the modal */
    const wazSection=document.getElementById('pm-waz-section');
    wazSection.innerHTML=`<input type="file" id="pm-waz-file" accept=".pdf,application/pdf">`;
    renderProjectMaterialsTable();
  } catch(ex){
    alert(t('error_removing_waz','Error removing WAZ: ')+ex.message);
  }
}

function onPmCategoryChange(){
  const cat=readSelectOther('pm-category','pm-category-new');
  const dnCount=requiredDns(cat);
  const container=document.getElementById('pm-dn-container');
  container.querySelectorAll('.dn-extra-field').forEach(el=>el.remove());
  container.style.display=dnCount>0?'contents':'none';
  document.getElementById('pm-dn1-field').style.display=dnCount>0?'':'none';
  document.getElementById('pm-dn1-label').textContent=dnCount>1?'DN 1':'DN';
  for(let i=2;i<=dnCount;i++){
    const div=document.createElement('div');
    div.className='field dn-extra-field';
    div.innerHTML=`<span class="lbl">DN ${i}</span><select id="pm-dn${i}" onchange="toggleSelectOther('pm-dn${i}','pm-dn${i}-new')"></select><input type="text" id="pm-dn${i}-new" class="select-other-text" style="display:none" placeholder="${t('type_dn','Type DN…')}">`;
    container.appendChild(div);
    buildSelectOther(`pm-dn${i}`,`pm-dn${i}-new`,DIMENSION_OPTIONS,'',true);
  }
  document.getElementById('pm-diameter-field').style.display=hasDiameter(cat)?'':'none';
  document.getElementById('pm-thickness-field').style.display=hasThickness(cat)?'':'none';
  /* Cascade: filter description by category */
  pmCascadeDesc();
}
function pmCascadeDesc(){
  const cat=readSelectOther('pm-category','pm-category-new');
  const allGm=DB.globalMaterials||[];
  const filtered=cat?allGm.filter(g=>g.category===cat):allGm;
  const descs=[...new Set(filtered.map(g=>g.itemDescription).filter(Boolean))];
  buildSelectOther('pm-desc','pm-desc-new',descs,'');
  pmCascadeFromDesc();
}
function onPmDescChange(){
  toggleSelectOther('pm-desc','pm-desc-new');
  pmCascadeFromDesc();
}
function pmCascadeFromDesc(){
  const cat=readSelectOther('pm-category','pm-category-new');
  const desc=readSelectOther('pm-desc','pm-desc-new');
  const allGm=DB.globalMaterials||[];
  let filtered=allGm;
  if(cat) filtered=filtered.filter(g=>g.category===cat);
  if(desc) filtered=filtered.filter(g=>g.itemDescription===desc);
  const diens=[...new Set(filtered.map(g=>g.dienNo).filter(Boolean))];
  const codes=[...new Set(filtered.map(g=>g.materialCode).filter(Boolean))];
  buildSelectOther('pm-dien','pm-dien-new',diens,diens.length===1?diens[0]:'');
  buildSelectOther('pm-code','pm-code-new',codes,codes.length===1?codes[0]:'');
  pmCascadeDiameter();
}
function onPmDienChange(){ toggleSelectOther('pm-dien','pm-dien-new'); }
function onPmCodeChange(){ toggleSelectOther('pm-code','pm-code-new'); }
function onPmDnChange(){ toggleSelectOther('pm-dn1','pm-dn1-new'); pmCascadeDiameter(); }
function pmCascadeDiameter(){
  const dn=readSelectOther('pm-dn1','pm-dn1-new');
  const allGm=DB.globalMaterials||[];
  let filtered=allGm;
  if(dn) filtered=filtered.filter(g=>g.dn1===dn);
  const diameters=[...new Set(filtered.map(g=>g.diameter).filter(Boolean))];
  buildSelectOther('pm-diameter','pm-diameter-new',diameters,diameters.length===1?diameters[0]:'');
  pmCascadeThickness();
}
function onPmDiameterChange(){ toggleSelectOther('pm-diameter','pm-diameter-new'); pmCascadeThickness(); }
function pmCascadeThickness(){
  const dn=readSelectOther('pm-dn1','pm-dn1-new');
  const diameter=readSelectOther('pm-diameter','pm-diameter-new');
  const allGm=DB.globalMaterials||[];
  let filtered=allGm;
  if(dn) filtered=filtered.filter(g=>g.dn1===dn);
  if(diameter) filtered=filtered.filter(g=>g.diameter===diameter);
  const thicknesses=[...new Set(filtered.map(g=>g.thickness).filter(Boolean))];
  buildSelectOther('pm-thickness','pm-thickness-new',thicknesses,thicknesses.length===1?thicknesses[0]:'');
}

async function saveProjectMaterial(e){
  e.preventDefault();
  const submitBtn=e.target.querySelector('[type="submit"]');
  if(submitBtn && submitBtn.disabled) return;
  const err=document.getElementById('pm-err');
  err.classList.remove('show');

  const category=readSelectOther('pm-category','pm-category-new');
  const itemDescription=readSelectOther('pm-desc','pm-desc-new')||category;
  const dn1=readSelectOther('pm-dn1','pm-dn1-new');
  const dnCount=requiredDns(category);
  const dns={dn1};
  for(let i=2;i<=dnCount;i++){
    const v=readSelectOther(`pm-dn${i}`,`pm-dn${i}-new`);
    if(v) dns[`dn${i}`]=v;
  }
  const dienNo=readSelectOther('pm-dien','pm-dien-new');
  const materialCode=readSelectOther('pm-code','pm-code-new');
  const diameter=readSelectOther('pm-diameter','pm-diameter-new');
  const thickness=readSelectOther('pm-thickness','pm-thickness-new');
  const surface=readSelectOther('pm-surface','pm-surface-new');
  const certificate=val('pm-certificate');
  const heatNo=val('pm-heat');
  const wazFileInput=document.getElementById('pm-waz-file');
  const wazFile=wazFileInput?wazFileInput.files[0]||null:null;

  /* Validation */
  if(!category){ err.textContent='Category is required.'; err.classList.add('show'); return; }
  if(!materialCode){ err.textContent='Material code is required.'; err.classList.add('show'); return; }
  if(!certificate){ err.textContent='Certificate number is required.'; err.classList.add('show'); return; }
  if(!heatNo){ err.textContent='Heat number is required.'; err.classList.add('show'); return; }

  setButtonLoading(submitBtn, true, t('saving', 'Saving…'));
  try {
    /* Step 1: Create or find the global material */
    const gmData={category, itemDescription, materialCode, dienNo, diameter, thickness, surface, ...dns};
    const gmResult=await apiPost('/global-materials', gmData);

    /* Step 2: Create or update project material */
    const pmData={
      projectId: PAGE.projectId,
      globalMaterialId: gmResult.id,
      certificate, heatNo
    };
    if(_projMatEditId) pmData.id=_projMatEditId;
    const pmResult=await apiPost('/project-materials', pmData);

    /* Step 3: Upload WAZ file if provided */
    if(wazFile){
      const formData=new FormData();
      formData.append('file', wazFile);
      const uploadResp=await fetch(`${API_BASE}/project-materials/${pmResult.id}/upload-waz`, {method:'POST', body:formData});
      const uploadResult=await uploadResp.json();
      if(uploadResult.wazPdfUrl) pmResult.wazPdfUrl=uploadResult.wazPdfUrl;
    }

    /* Update local data */
    if(_projMatEditId){
      const idx=DB.projectMaterials.findIndex(m=>m.id===_projMatEditId);
      if(idx>=0) DB.projectMaterials[idx]=pmResult;
    } else {
      DB.projectMaterials.push(pmResult);
    }
    /* Also update global materials list */
    const gmIdx=DB.globalMaterials.findIndex(g=>g.id===gmResult.id);
    if(gmIdx>=0) DB.globalMaterials[gmIdx]=gmResult;
    else DB.globalMaterials.push(gmResult);

    closeModal('modal-proj-material');
    _projMatEditId=null;
    renderProjectMaterialsTable();
  } catch(ex){
    err.textContent='Error saving: '+ex.message;
    err.classList.add('show');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

/* ================================================================ ADD MATERIAL CHOICE (Pipeline detail) ================================================================ */
function openAddMaterialChoice(){
  const projMats=DB.projectMaterials||[];
  if(!projMats.length){
    /* No project materials — go straight to new material form */
    openMaterialModal();
    return;
  }
  let modal=document.getElementById('modal-add-choice');
  if(!modal){
    const overlay=document.createElement('div');
    overlay.className='modal-overlay';
    overlay.id='modal-add-choice';
    overlay.innerHTML=`<div class="modal modal-small">
      <button class="modal-close" onclick="closeModal('modal-add-choice')">&times;</button>
      <h2>${t('add_material','Add material')}</h2>
      <p>${t('add_mat_choice_desc','Would you like to add an existing material from this project or create a new one?')}</p>
      <div class="modal-actions" style="flex-direction:column;gap:12px;">
        <button class="btn btn-primary" onclick="closeModal('modal-add-choice');openExistingMaterialModal()">${t('add_existing_material','Add existing material')}</button>
        <button class="btn btn-ghost" onclick="closeModal('modal-add-choice');openMaterialModal()">${t('add_new_material','Add new material')}</button>
      </div>
    </div>`;
    document.getElementById('modal-root').appendChild(overlay);
  }
  openModal('modal-add-choice');
}

/* --- Add existing material with cascading dropdowns --- */
async function openExistingMaterialModal(){
  if(PAGE.projectId){
    try {
      const pms = await apiGet('/project-materials?projectId='+PAGE.projectId);
      if(pms && Array.isArray(pms)) DB.projectMaterials = pms;
    } catch(e){ console.error('Failed to refresh projectMaterials:', e); }
  }
  const projMats=DB.projectMaterials||[];
  let modal=document.getElementById('modal-existing-material');
  if(!modal){
    const overlay=document.createElement('div');
    overlay.className='modal-overlay';
    overlay.id='modal-existing-material';
    overlay.innerHTML=`<div class="modal modal-wide">
      <button class="modal-close" onclick="closeModal('modal-existing-material')">&times;</button>
      <h2>${t('add_existing_material','Add existing material')}</h2>
      <form id="existing-material-form"><div class="form-grid">
        <div class="field"><span class="lbl">${t('category','Category')} <span class="req">*</span></span><select id="ex-category" onchange="onExCategoryChange()"><option value="">Select...</option></select></div>
        <div class="field wide"><span class="lbl">${t('item_description','Item description')}</span><select id="ex-desc" onchange="onExDescChange()"><option value="">Select...</option></select></div>
        <div id="ex-dn-container" style="display:contents"><div class="field" id="ex-dn1-field"><span class="lbl" id="ex-dn1-label">DN</span><select id="ex-dn1" onchange="onExDnChange()"><option value="">Select...</option></select></div></div>
        <div class="field"><span class="lbl">${t('material_code','Material code')}</span><select id="ex-code" onchange="onExFieldChange()"><option value="">Select...</option></select></div>
        <div class="field"><span class="lbl">${t('din_en_number','DIN EN Number')}</span><select id="ex-dien" onchange="onExFieldChange()"><option value="">Select...</option></select></div>
        <div class="field" id="ex-diameter-field"><span class="lbl">${t('outer_diameter','Diameter')}</span><select id="ex-diameter" onchange="onExDiameterChange()"><option value="">Select...</option></select></div>
        <div class="field" id="ex-thickness-field"><span class="lbl">${t('thickness','Thickness')}</span><select id="ex-thickness" onchange="onExFieldChange()"><option value="">Select...</option></select></div>
        <div class="field"><span class="lbl">${t('surface','Surface')}</span><select id="ex-surface" onchange="onExFieldChange()"><option value="">Select...</option></select></div>
        <div class="field"><span class="lbl">${t('th_certificate','Certificate')}</span><select id="ex-certificate" onchange="onExFieldChange()"><option value="">Select...</option></select></div>
        <div class="field"><span class="lbl">${t('heat_melt_no','Heat number')}</span><select id="ex-heat" onchange="onExHeatChange()"><option value="">Select...</option></select></div>
        <div class="field-separator wide"></div>
        <div class="field wide" id="ex-startend-field"><div class="check-row">
          <label><input type="checkbox" id="ex-start" onchange="onExStartEndChange()"> ${t('start_of_plumbing','Start of plumbing')}</label>
          <label><input type="checkbox" id="ex-end" onchange="onExStartEndChange()"> ${t('end_of_plumbing','End of plumbing')}</label>
        </div></div>
        <div class="field wide" id="ex-conn-field"><span class="lbl">${t('connections','Connections (other materials this joins to)')}</span>
          <div id="ex-conn-rows"></div>
          <button type="button" class="inline-add-toggle" onclick="addExConnRow()">${t('add_connection','+ Add connection')}</button>
        </div>
        <div class="modal-err" id="ex-err"></div>
      </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-existing-material')">${t('cancel','Cancel')}</button><button type="submit" class="btn btn-primary">${t('add_to_pipeline','Add to pipeline')}</button></div></form>
    </div>`;
    document.getElementById('modal-root').appendChild(overlay);
    document.getElementById('existing-material-form').addEventListener('submit', saveExistingMaterial);
  }
  /* Populate category dropdown */
  const categories=[...new Set(projMats.map(pm=>pm.category).filter(Boolean))].sort();
  document.getElementById('ex-category').innerHTML='<option value="">Select...</option>'+categories.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  _exResetFields();
  openModal('modal-existing-material');
}

function _exResetFields(){
  document.getElementById('ex-desc').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-dn1').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-dien').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-code').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-diameter').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-thickness').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-surface').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-certificate').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-heat').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-err').textContent='';
  document.getElementById('ex-err').classList.remove('show');
  /* Remove extra DN fields */
  document.getElementById('ex-dn-container').querySelectorAll('.dn-extra-field').forEach(el=>el.remove());
  /* Reset start/end and connections */
  const startEl=document.getElementById('ex-start'); if(startEl) startEl.checked=false;
  const endEl=document.getElementById('ex-end'); if(endEl) endEl.checked=false;
  const connRows=document.getElementById('ex-conn-rows'); if(connRows) connRows.innerHTML='';
  /* Auto-check start if pipeline is empty, otherwise auto-add connection to last non-wire material */
  const existingMats=(DB.materials||[]).filter(m=>!m.archived && (m.piece||m.category||'').toLowerCase()!=='welding wire');
  if(existingMats.length===0){
    if(startEl) startEl.checked=true;
  } else {
    /* Auto-add connection to the last non-wire material */
    const lastMat=existingMats[existingMats.length-1];
    const options=existingMats.map(m=>`<option value="${posLetter(m.position)}" ${m.id===lastMat.id?'selected':''}>${posLetter(m.position)} — ${escapeHtml(m.piece||m.category||'')} (${escapeHtml(m.itemDescription||'')})</option>`).join('');
    const row=document.createElement('div');
    row.style.cssText='display:flex;gap:8px;align-items:center;margin-bottom:6px;';
    row.innerHTML=`<select style="flex:1"><option value="">Select position...</option>${options}</select><button type="button" class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()" style="color:var(--danger)">✕</button>`;
    connRows.appendChild(row);
  }
}

function _exFilteredProjMats(){
  const projMats=DB.projectMaterials||[];
  const cat=document.getElementById('ex-category')?.value||'';
  const desc=document.getElementById('ex-desc')?.value||'';
  const dn=document.getElementById('ex-dn1')?.value||'';
  const dien=document.getElementById('ex-dien')?.value||'';
  const code=document.getElementById('ex-code')?.value||'';
  const dia=document.getElementById('ex-diameter')?.value||'';
  const thk=document.getElementById('ex-thickness')?.value||'';
  const surface=document.getElementById('ex-surface')?.value||'';
  const cert=document.getElementById('ex-certificate')?.value||'';
  const heat=document.getElementById('ex-heat')?.value||'';
  let filtered=projMats;
  if(cat) filtered=filtered.filter(pm=>pm.category===cat);
  if(desc) filtered=filtered.filter(pm=>pm.itemDescription===desc);
  if(dn) filtered=filtered.filter(pm=>pm.dn1===dn);
  const dnCount=requiredDns(cat);
  for(let i=2;i<=dnCount;i++){
    const extraVal=document.getElementById(`ex-dn${i}`)?.value;
    if(extraVal) filtered=filtered.filter(pm=>pm[`dn${i}`]===extraVal);
  }
  if(dien) filtered=filtered.filter(pm=>pm.dienNo===dien);
  if(code) filtered=filtered.filter(pm=>pm.materialCode===code);
  if(dia) filtered=filtered.filter(pm=>pm.diameter===dia);
  if(thk) filtered=filtered.filter(pm=>pm.thickness===thk);
  if(surface) filtered=filtered.filter(pm=>pm.surface===surface);
  if(cert) filtered=filtered.filter(pm=>pm.certificate===cert);
  if(heat) filtered=filtered.filter(pm=>pm.heatNo===heat);
  return filtered;
}

function onExCategoryChange(){
  const cat=document.getElementById('ex-category').value;
  /* Reset all downstream fields first */
  document.getElementById('ex-desc').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-dn1').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-dien').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-code').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-diameter').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-thickness').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-surface').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-certificate').innerHTML='<option value="">Select...</option>';
  document.getElementById('ex-heat').innerHTML='<option value="">Select...</option>';
  /* Show/hide DN fields based on category */
  const dnCount=requiredDns(cat);
  const container=document.getElementById('ex-dn-container');
  container.querySelectorAll('.dn-extra-field').forEach(el=>el.remove());
  container.style.display=dnCount>0?'contents':'none';
  document.getElementById('ex-dn1-field').style.display=dnCount>0?'':'none';
  document.getElementById('ex-dn1-label').textContent=dnCount>1?'DN 1':'DN';
  /* Add extra DN fields */
  for(let i=2;i<=dnCount;i++){
    const div=document.createElement('div');
    div.className='field dn-extra-field';
    div.innerHTML=`<span class="lbl">DN ${i}</span><select id="ex-dn${i}" onchange="onExFieldChange()"><option value="">Select...</option></select>`;
    container.appendChild(div);
  }
  /* Show/hide diameter/thickness */
  document.getElementById('ex-diameter-field').style.display=hasDiameter(cat)?'':'none';
  document.getElementById('ex-thickness-field').style.display=hasThickness(cat)?'':'none';
  /* Hide start/end and connections for welding wire */
  const isWire=(cat||'').toLowerCase()==='welding wire';
  const startEndField=document.getElementById('ex-startend-field');
  const connField=document.getElementById('ex-conn-field');
  if(startEndField) startEndField.style.display=isWire?'none':'';
  if(connField) connField.style.display=isWire?'none':'';
  if(isWire){
    const connRows=document.getElementById('ex-conn-rows');
    if(connRows) connRows.innerHTML='';
    const startEl=document.getElementById('ex-start'); if(startEl) startEl.checked=false;
    const endEl=document.getElementById('ex-end'); if(endEl) endEl.checked=false;
  }
  /* Cascade descriptions */
  const projMats=DB.projectMaterials||[];
  const filtered=cat?projMats.filter(pm=>pm.category===cat):projMats;
  const descs=[...new Set(filtered.map(pm=>pm.itemDescription).filter(Boolean))].sort();
  document.getElementById('ex-desc').innerHTML='<option value="">Select...</option>'+descs.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  if(descs.length===1) document.getElementById('ex-desc').value=descs[0];
  onExDescChange();
}

function onExDescChange(){
  const filtered=_exFilteredProjMats();
  /* DN options - preserve current values */
  const dns=[...new Set(filtered.map(pm=>pm.dn1).filter(Boolean))].sort();
  const curDn=document.getElementById('ex-dn1').value;
  document.getElementById('ex-dn1').innerHTML='<option value="">Select...</option>'+dns.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  if(dns.includes(curDn)) document.getElementById('ex-dn1').value=curDn;
  else if(dns.length===1) document.getElementById('ex-dn1').value=dns[0];
  /* Populate extra DN fields */
  const cat=document.getElementById('ex-category').value;
  const dnCount=requiredDns(cat);
  for(let i=2;i<=dnCount;i++){
    const sel=document.getElementById(`ex-dn${i}`);
    if(sel){
      const dnOpts=[...new Set(filtered.map(pm=>pm[`dn${i}`]).filter(Boolean))].sort();
      const curVal=sel.value;
      sel.innerHTML='<option value="">Select...</option>'+dnOpts.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
      if(dnOpts.includes(curVal)) sel.value=curVal;
      else if(dnOpts.length===1) sel.value=dnOpts[0];
    }
  }
  /* Populate heat numbers early so user can pick one to auto-fill */
  const heats=[...new Set(filtered.map(pm=>pm.heatNo).filter(Boolean))].sort();
  document.getElementById('ex-heat').innerHTML='<option value="">Select...</option>'+heats.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  if(heats.length===1){ document.getElementById('ex-heat').value=heats[0]; onExHeatChange(); }
  onExDnChange();
}

function onExDnChange(){
  const filtered=_exFilteredProjMats();
  const diens=[...new Set(filtered.map(pm=>pm.dienNo).filter(Boolean))].sort();
  const codes=[...new Set(filtered.map(pm=>pm.materialCode).filter(Boolean))].sort();
  const curDien=document.getElementById('ex-dien').value;
  const curCode=document.getElementById('ex-code').value;
  document.getElementById('ex-dien').innerHTML='<option value="">Select...</option>'+diens.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  document.getElementById('ex-code').innerHTML='<option value="">Select...</option>'+codes.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  if(diens.includes(curDien)) document.getElementById('ex-dien').value=curDien;
  else if(diens.length===1) document.getElementById('ex-dien').value=diens[0];
  if(codes.includes(curCode)) document.getElementById('ex-code').value=curCode;
  else if(codes.length===1) document.getElementById('ex-code').value=codes[0];
  onExFieldChange();
}

function onExDiameterChange(){ onExFieldChange(); }

function onExFieldChange(){
  const filtered=_exFilteredProjMats();
  /* Diameter */
  const dias=[...new Set(filtered.map(pm=>pm.diameter).filter(Boolean))].sort();
  const cat=document.getElementById('ex-category').value;
  const diaSel=document.getElementById('ex-diameter');
  const curDia=diaSel.value;
  diaSel.innerHTML='<option value="">Select...</option>'+dias.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  if(dias.includes(curDia)) diaSel.value=curDia;
  else if(dias.length===1) diaSel.value=dias[0];
  document.getElementById('ex-diameter-field').style.display=hasDiameter(cat)?'':'none';
  /* Thickness */
  const thks=[...new Set(filtered.map(pm=>pm.thickness).filter(Boolean))].sort();
  const thkSel=document.getElementById('ex-thickness');
  const curThk=thkSel.value;
  thkSel.innerHTML='<option value="">Select...</option>'+thks.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  if(thks.includes(curThk)) thkSel.value=curThk;
  else if(thks.length===1) thkSel.value=thks[0];
  document.getElementById('ex-thickness-field').style.display=hasThickness(cat)?'':'none';
  /* DIN EN */
  const diens=[...new Set(filtered.map(pm=>pm.dienNo).filter(Boolean))].sort();
  const dienSel=document.getElementById('ex-dien');
  const curDien=dienSel.value;
  dienSel.innerHTML='<option value="">Select...</option>'+diens.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  if(diens.includes(curDien)) dienSel.value=curDien;
  else if(diens.length===1) dienSel.value=diens[0];
  /* Surface */
  const surfaces=[...new Set(filtered.map(pm=>pm.surface).filter(Boolean))].sort();
  document.getElementById('ex-surface').innerHTML='<option value="">Select...</option>'+surfaces.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  if(surfaces.length===1) document.getElementById('ex-surface').value=surfaces[0];
  /* Certificate */
  const certs=[...new Set(filtered.map(pm=>pm.certificate).filter(Boolean))].sort();
  document.getElementById('ex-certificate').innerHTML='<option value="">Select...</option>'+certs.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  if(certs.length===1) document.getElementById('ex-certificate').value=certs[0];
  /* Heat */
  const heats=[...new Set(filtered.map(pm=>pm.heatNo).filter(Boolean))].sort();
  document.getElementById('ex-heat').innerHTML='<option value="">Select...</option>'+heats.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  if(heats.length===1) document.getElementById('ex-heat').value=heats[0];
}

function onExHeatChange(){
  const heat=document.getElementById('ex-heat').value;
  if(!heat) return;
  /* Find the exact project material matching category + description + this heat number */
  const cat=document.getElementById('ex-category').value;
  const desc=document.getElementById('ex-desc').value;
  const projMats=DB.projectMaterials||[];
  let filtered=projMats;
  if(cat) filtered=filtered.filter(pm=>pm.category===cat);
  if(desc) filtered=filtered.filter(pm=>pm.itemDescription===desc);
  const match=filtered.find(pm=>pm.heatNo===heat);
  if(match){
    /* Auto-fill all fields from this exact material */
    const dnCount=requiredDns(cat);
    document.getElementById('ex-dn1').value=match.dn1||'';
    for(let i=2;i<=dnCount;i++){
      const sel=document.getElementById(`ex-dn${i}`);
      if(sel) sel.value=match[`dn${i}`]||'';
    }
    document.getElementById('ex-dien').value=match.dienNo||'';
    document.getElementById('ex-code').value=match.materialCode||'';
    document.getElementById('ex-diameter').value=match.diameter||'';
    document.getElementById('ex-thickness').value=match.thickness||'';
    document.getElementById('ex-surface').value=match.surface||'';
    document.getElementById('ex-certificate').value=match.certificate||'';
  }
}

function onExStartEndChange(){
  /* If start is checked, ensure it's the only start */
  /* No special logic needed — backend handles it */
}

function addExConnRow(){
  const container=document.getElementById('ex-conn-rows');
  const existingMats=(DB.materials||[]).filter(m=>!m.archived && (m.piece||m.category||'').toLowerCase()!=='welding wire');
  if(!existingMats.length){ return; }
  const options=existingMats.map(m=>`<option value="${posLetter(m.position)}">${posLetter(m.position)} — ${escapeHtml(m.piece||m.category||'')} (${escapeHtml(m.itemDescription||'')})</option>`).join('');
  const row=document.createElement('div');
  row.style.cssText='display:flex;gap:8px;align-items:center;margin-bottom:6px;';
  row.innerHTML=`<select style="flex:1"><option value="">Select position...</option>${options}</select><button type="button" class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()" style="color:var(--danger)">✕</button>`;
  container.appendChild(row);
}

async function saveExistingMaterial(e){
  e.preventDefault();
  const submitBtn=e.target.querySelector('[type="submit"]');
  if(submitBtn && submitBtn.disabled) return;
  const err=document.getElementById('ex-err');
  err.classList.remove('show');
  const cat=document.getElementById('ex-category').value;
  if(!cat){ err.textContent='Category is required.'; err.classList.add('show'); return; }

  const matched=_exFilteredProjMats();
  if(!matched.length){ err.textContent='No matching material found. Please select values.'; err.classList.add('show'); return; }
  if(matched.length>1){ err.textContent='Multiple matches — please narrow your selection.'; err.classList.add('show'); return; }

  setButtonLoading(submitBtn, true, t('saving', 'Saving…'));
  const pmId=matched[0].id;
  const startOfPlumbing=document.getElementById('ex-start').checked;
  const endOfPlumbing=document.getElementById('ex-end').checked;

  /* Collect connections */
  const connSelects=document.querySelectorAll('#ex-conn-rows select');
  const connections=[...connSelects].map(s=>s.value).filter(Boolean);

  try {
    await apiPost('/pipeline-materials', {
      pipelineId: PAGE.pipelineId,
      projectMaterialId: pmId,
      startOfPlumbing,
      endOfPlumbing,
      connections: connections.length ? connections : undefined
    });
    const data = await apiGet('/pipeline-detail/'+PAGE.pipelineId);
    DB.materials=normalizeMaterials(data.materials||[]);
    DB.welds=normalizeWelds(data.welds||[]);
    if(data.projectMaterials && Array.isArray(data.projectMaterials)) DB.projectMaterials=data.projectMaterials;
    rebuildRelationships();
    saveDB();
    closeModal('modal-existing-material');
    rerenderPage();
  } catch(ex){
    err.textContent='Error: '+ex.message; err.classList.add('show');
  } finally { setButtonLoading(submitBtn, false); }
}

/* ================================================================ SHAREPOINT FOLDER PICKER ================================================================ */
let _pendingFolder=null;
async function pickProjectFolder(){
  const projId=editingProjectId!==null?editingProjectId:PAGE.projectId;
  await openFolderPicker(projId||null);
}

let _msalInstance=null;
async function _getMsalInstance(){
  if(_msalInstance) return _msalInstance;
  const cfg=await fetch('/api/sharepoint-config').then(r=>r.json());
  _msalInstance=new msal.PublicClientApplication({
    auth:{ clientId:cfg.clientId, authority:`https://login.microsoftonline.com/${cfg.tenantId}`, redirectUri:window.location.origin+'/' },
    cache:{ cacheLocation:'sessionStorage' }
  });
  await _msalInstance.initialize();
  return _msalInstance;
}
async function _getPickerToken(resource){
  const msalApp=await _getMsalInstance();
  const scope=resource.replace(/\/$/,'')+`/.default`;
  const accounts=msalApp.getAllAccounts();
  try {
    if(accounts.length){ const r=await msalApp.acquireTokenSilent({scopes:[scope],account:accounts[0]}); return r.accessToken; }
    const r=await msalApp.acquireTokenPopup({scopes:[scope]}); return r.accessToken;
  } catch(e){
    const r=await msalApp.acquireTokenPopup({scopes:[scope]}); return r.accessToken;
  }
}

async function openFolderPicker(projId){
  console.log('openFolderPicker called, projId:', projId);
  /* Open window immediately (must be synchronous with user click) */
  const win=window.open("","FolderPicker","width=1080,height=680");
  console.log('window.open result:', win);
  if(!win){ alert('Popup blocked. Please allow popups for this site.'); return; }
  win.document.title='Loading SharePoint...';

  const cfg=await fetch('/api/sharepoint-config').then(r=>r.json());
  if(!cfg.host){ win.close(); alert('SharePoint not configured.'); return; }
  const baseUrl=`https://${cfg.host}${cfg.sitePath}`;

  let token;
  try { token=await _getPickerToken('https://'+cfg.host); }
  catch(e){ win.close(); alert('Failed to get SharePoint token: '+e.message); return; }

  const channelId=crypto.randomUUID();
  const options={
    sdk:"8.0",
    entry:{ sharePoint:{ byPath:{ web:baseUrl } } },
    typesAndSources:{ mode:"folders" },
    selection:{ mode:"single" },
    authentication:{},
    messaging:{ origin:window.location.origin, channelId },
    commands:{ pick:{ action:"select" }, createFolder:{ enabled:true } }
  };

  const queryString=new URLSearchParams({ filePicker:JSON.stringify(options), locale:'en-us' });
  const url=baseUrl+`/_layouts/15/FilePicker.aspx?${queryString}`;
  const form=win.document.createElement("form");
  form.setAttribute("action",url);
  form.setAttribute("method","POST");
  const tokenInput=win.document.createElement("input");
  tokenInput.setAttribute("type","hidden");
  tokenInput.setAttribute("name","access_token");
  tokenInput.setAttribute("value",token);
  form.appendChild(tokenInput);
  win.document.body.append(form);
  form.submit();

  /* Listen for messages from picker */
  window.addEventListener("message",function pickerListener(event){
    if(event.source!==win) return;
    const message=event.data;
    if(message.type==="initialize" && message.channelId===channelId){
      const port=event.ports[0];
      port.addEventListener("message",async function(msg){
        const payload=msg.data;
        if(payload.type==="command"){
          port.postMessage({type:"acknowledge",id:payload.id});
          const cmd=payload.data;
          if(cmd.command==="authenticate"){
            try {
              const t=await _getPickerToken(cmd.resource);
              port.postMessage({type:"result",id:payload.id,data:{result:"token",token:t}});
            } catch(err){
              port.postMessage({type:"result",id:payload.id,data:{result:"error",error:{code:"unableToObtainToken",message:err.message}}});
            }
          } else if(cmd.command==="pick"){
            const item=cmd.items[0];
            const driveId=item.parentReference.driveId;
            const folderId=item.id;
            const endpoint=item["@sharePoint.endpoint"];
            /* Get folder web URL */
            const currentToken=await _getPickerToken('https://'+cfg.host);
            const folderInfo=await fetch(`${endpoint}/drives/${driveId}/items/${folderId}`,{headers:{Authorization:'Bearer '+currentToken}}).then(r=>r.json());
            const folderUrl=folderInfo.webUrl||'';
            if(projId){
              /* Existing project — save immediately */
              await apiPost('/projects',{id:projId, sharepointDriveId:driveId, sharepointFolderId:folderId, sharepointFolderUrl:folderUrl});
              const pr=getProject(projId);
              if(pr){ pr.sharepointDriveId=driveId; pr.sharepointFolderId=folderId; pr.sharepointFolderUrl=folderUrl; }
            } else {
              /* New project — store for form submit */
              _pendingFolder={sharepointDriveId:driveId, sharepointFolderId:folderId, sharepointFolderUrl:folderUrl};
            }
            /* Update the input field in the modal if open */
            const spDiv=document.getElementById('input-project-sp-folder');
            if(spDiv) spDiv.innerHTML = renderSpFolderHtml(folderUrl);
            port.postMessage({type:"result",id:payload.id,data:{result:"success"}});
            win.close();
            window.removeEventListener("message",pickerListener);
            rerenderPage();
          } else if(cmd.command==="close"){
            win.close();
            window.removeEventListener("message",pickerListener);
          } else {
            port.postMessage({type:"result",id:payload.id,data:{result:"error",error:{code:"unsupportedCommand",message:cmd.command}}});
          }
        }
      });
      port.start();
      port.postMessage({type:"activate"});
    }
  });
}

/* Ensure pages refreshed on browser back/forward navigation (bfcache) */
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    if (PAGE.name === 'pipelines' && typeof initPipelinesPage === 'function') initPipelinesPage();
    else if (PAGE.name === 'projects' && typeof initProjectsPage === 'function') initProjectsPage();
    else if (PAGE.name === 'pipeline-detail' && typeof initPipelineDetailPage === 'function') initPipelineDetailPage();
    else if (typeof rerenderPage === 'function') rerenderPage();
  }
});
