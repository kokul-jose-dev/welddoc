/* ================================================================
   WeldDoc shared application module (loaded by every page).
   Data lives in localStorage so edits persist across page
   navigations. "Reset demo data" (top-right) restores the seed.
   Names / line IDs / certs are realistic-format but fictional.
   ================================================================ */
const TODAY = new Date(2026, 6, 10);
const TODAY_ISO = "2026-07-10";
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const STORE_KEY = 'weldoc_db_v3';
const ROLE_KEY = 'weldoc_role';        // 'office' | 'vendor'
const CURRENT_USER_KEY = 'weldoc_user'; // logged-in person id (for the vendor role)

/* ---- API helpers ---- */
const API_BASE = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' ? 'http://127.0.0.1:5000/api' : window.location.origin + '/api';
async function apiGet(path){ const r=await fetch(API_BASE+path); if(!r.ok) throw new Error(r.statusText); return r.json(); }
async function apiPost(path, data){ const r=await fetch(API_BASE+path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)}); if(!r.ok) throw new Error(r.statusText); return r.json(); }
function normalizeProject(p){ p.order=p.orderNo||p.order||''; return p; }
function normalizeProjects(arr){ return arr.map(normalizeProject); }
function normalizeMaterial(m){
  if(m.category && !m.piece) m.piece=m.category;
  if(m.dn1 && !m.dimension) m.dimension=m.dn1;
  if(typeof m.position==='string'){ const code=m.position.charCodeAt(0); m.position=code>=65&&code<=90?code-64:1; }
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
  if(!w.welderIds) w.welderIds=[];
  if(!w.inspectorIds) w.inspectorIds=[];
  if(w.pipelineId===undefined && w.pipeline_id!==undefined) w.pipelineId=w.pipeline_id;
  if(w.weldNo===undefined && w.weld_no!==undefined) w.weldNo=w.weld_no;
  if(!w.visual) w.visual='n/a';
  if(!w.endoscopy) w.endoscopy='n/a';
  if(!w.ferrite) w.ferrite='n/a';
  if(!w.photoUrl) w.photoUrl='';
  if(!w.endoscopyUrl) w.endoscopyUrl='';
  if(!w.remarks) w.remarks='';
  if(!w.noteImageNo) w.noteImageNo='';
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
      if(!a.connections.includes(bId)) a.connections.push(bId);
      if(!b.connections.includes(aId)) b.connections.push(aId);
    }
  });
}

/* ---- catalogs for dropdown + free-text fields ---- */
const ITEM_CATALOG = [
  { description:"Pipe DIN 11866 series B", code:"1.4435", piece:"Pipe", dimension:"DN 40", dimension2:"", dimension3:"", dien:"DIN 11866", diameter:"41.0 mm", thickness:"2.0 mm" },
  { description:"Pipe DIN 11866 series B", code:"1.4435", piece:"Pipe", dimension:"DN 50", dimension2:"", dimension3:"", dien:"DIN 11866", diameter:"53.0 mm", thickness:"2.0 mm" },
  { description:"90° pipe bend acc. to DIN EN 11865 series B", code:"1.4435", piece:"Elbow", dimension:"DN 15", dimension2:"", dimension3:"", dien:"DIN 11865", diameter:"21.3 mm", thickness:"2.0 mm" },
  { description:"90° pipe bend acc. to DIN EN 11865 series B", code:"1.4435", piece:"Elbow", dimension:"DN 25", dimension2:"", dimension3:"", dien:"DIN 11865", diameter:"29.0 mm", thickness:"2.0 mm" },
  { description:"T-piece DIN 11866 series B", code:"1.4435", piece:"Tee", dimension:"DN 15", dimension2:"DN 15", dimension3:"", dien:"DIN 11866", diameter:"21.3 mm", thickness:"2.0 mm" },
  { description:"T-piece DIN 11866 series B", code:"1.4435", piece:"Tee", dimension:"DN 25", dimension2:"DN 25", dimension3:"", dien:"DIN 11866", diameter:"29.0 mm", thickness:"2.0 mm" },
  { description:"Tri-Clamp flange DIN 32676", code:"1.4435", piece:"Flange", dimension:"DN 15", dimension2:"", dimension3:"", dien:"DIN 32676", diameter:"21.3 mm", thickness:"2.0 mm" },
  { description:"Tri-Clamp flange DIN 32676", code:"1.4435", piece:"Flange", dimension:"DN 25", dimension2:"", dimension3:"", dien:"DIN 32676", diameter:"29.0 mm", thickness:"2.0 mm" },
  { description:"Concentric reducer DIN 11866", code:"1.4404", piece:"Reducer", dimension:"DN 25", dimension2:"DN 15", dimension3:"", dien:"DIN 11866", diameter:"29.0 / 21.3 mm", thickness:"2.0 mm" },
  { description:"Diaphragm valve, Tri-Clamp", code:"1.4435", piece:"Valve", dimension:"DN 15", dimension2:"", dimension3:"", dien:"DIN 32676", diameter:"21.3 mm", thickness:"2.0 mm" }
];
const PIECE_OPTIONS = ["Pipe","Flange","Blind Flange","Elbow","Reducer","Tee","Pipe extruded outlet","Pipe 2 extruded outlet","Equipment","3-Way Valve","4-Way Valve","6-Way Valve","Welding Wire"];
/* Required number of welds (connections) per category */
const PIECE_WELDS = {
  "pipe":2, "flange":1, "blind flange":0, "elbow":2, "reducer":2,
  "tee":3, "pipe extruded outlet":3, "pipe 2 extruded outlet":4,
  "equipment":2, "3-way valve":3, "4-way valve":4, "6-way valve":6,
  "ferrule":2, "welding wire":0, "valve":2
};
function requiredWelds(piece){ return PIECE_WELDS[(piece||'').toLowerCase()] ?? 2; }
/* Number of DN fields per category (matches ports that can differ in size) */
const PIECE_DNS = {
  "pipe":1, "flange":1, "blind flange":1, "elbow":1, "reducer":2,
  "tee":2, "pipe extruded outlet":2, "pipe 2 extruded outlet":3,
  "equipment":1, "3-way valve":3, "4-way valve":4, "6-way valve":6,
  "ferrule":1, "welding wire":0, "valve":1
};
function requiredDns(piece){ return PIECE_DNS[(piece||'').toLowerCase()] ?? 1; }
/* Whether category shows outer diameter field */
const PIECE_HAS_DIAMETER = {
  "pipe":true, "flange":true, "blind flange":false, "elbow":true, "reducer":true,
  "tee":true, "pipe extruded outlet":true, "pipe 2 extruded outlet":true,
  "equipment":false, "3-way valve":false, "4-way valve":false, "6-way valve":false,
  "ferrule":true, "welding wire":true, "valve":true
};
/* Whether category shows thickness field */
const PIECE_HAS_THICKNESS = {
  "pipe":true, "flange":true, "blind flange":false, "elbow":true, "reducer":true,
  "tee":true, "pipe extruded outlet":true, "pipe 2 extruded outlet":true,
  "equipment":false, "3-way valve":false, "4-way valve":false, "6-way valve":false,
  "ferrule":true, "welding wire":false, "valve":true
};
function hasDiameter(piece){ return PIECE_HAS_DIAMETER[(piece||'').toLowerCase()] !== false; }
function hasThickness(piece){ return PIECE_HAS_THICKNESS[(piece||'').toLowerCase()] !== false; }
const DIMENSION_OPTIONS = ["DN 8","DN 10","DN 15","DN 20","DN 25","DN 32","DN 40","DN 50","DN 65","DN 80","DN 100","DN 125","DN 150","DN 200","DN 250","DN 300","DN 350","DN 400","DN 450","DN 500","DN 550","DN 600","DN 700","DN 800","DN 900"];
const CERT_OPTIONS = ["EN 10204 3.1","EN 10204 3.2","EN 10204 2.2"];
const PROC_OPTIONS = ["141","147"];

/* ================================================================ DEFAULT (seed) DATA ================================================================ */
function seedData(){
  return {
    clients:[
      { id:1, name:"Helvetia Pharma AG", street:"Industriestrasse 12", zipCode:"4057", location:"Basel", remarks:"Preferred pharma client since 2021. Strict EN 10204 3.1 documentation required on all lines." },
      { id:2, name:"Basel BioTech Solutions AG", street:"Gewerbeweg 8", zipCode:"4132", location:"Muttenz", remarks:"New client — onboarding scheduled for Q3 2026." },
      { id:3, name:"Rheinfelden Life Sciences AG", street:"Bahnhofstrasse 24", zipCode:"4310", location:"Rheinfelden", remarks:"All deliverables must include German-language documentation." },
      { id:4, name:"Alpine Pharmaceuticals AG", street:"Musterstrasse 66", zipCode:"3000", location:"Bern", remarks:"Annual maintenance contract; low document volume." },
      { id:5, name:"Zürichsee Biologics AG", street:"Seestrasse 140", zipCode:"8002", location:"Zürich", remarks:"Multiple active pipelines across two plant sites." }
    ],
    projects:[
      { id:1, clientId:1, title:"Sterile Filling Line Expansion", location:"Basel, BS", order:9260007, istProjectNo:"HPH-001", description:"Piping upgrade for a new sterile filling suite in Building C.", status:"ongoing" },
      { id:2, clientId:2, title:"Utility Piping Retrofit", location:"Muttenz, BL", order:8840321, istProjectNo:"BBT-001", description:"Replacement of WFI and clean steam distribution piping.", status:"not-started" },
      { id:3, clientId:3, title:"Bioreactor Suite Piping", location:"Rheinfelden, AG", order:7710255, istProjectNo:"RLS-001", description:"New stainless piping for the upstream bioreactor train.", status:"ongoing" },
      { id:4, clientId:4, title:"Annual Maintenance Shutdown", location:"Schlieren, ZH", order:6620190, istProjectNo:"APH-001", description:"Scheduled inspection and weld repairs during the plant shutdown window.", status:"completed" },
      { id:5, clientId:5, title:"Plant 2 Clean-in-Place Piping", location:"Zürich, ZH", order:9260044, istProjectNo:"ZBG-001", description:"CIP/SIP piping installation for the Plant 2 expansion.", status:"not-started" },
      { id:6, clientId:5, title:"Purified Water Loop Renewal", location:"Wädenswil, ZH", order:9260051, istProjectNo:"ZBG-002", description:"Full renewal of the purified water distribution loop in Plant 1.", status:"completed" }
    ],
    people:[
      { id:1, name:"Beat Wenger", no:860, procs:"141 / 142" },
      { id:2, name:"Andreas Portmann", no:712, procs:"141 / 142" },
      { id:3, name:"Marco Studer", no:845, procs:"141" },
      { id:4, name:"Urs Baumann", no:731, procs:"142" },
      { id:5, name:"Nadia Furrer", no:503, procs:"142" }
    ],
    certificates:[
      { id:1, personId:1, certNo:"Q-PZ-26-0141", process:"141", standard:"EN ISO 9606-1", validUntil:"2026-11-30", renewalDue:"2026-11-16", pdfUrl:"https://istinox.sharepoint.com/…/certs/860-141.pdf" },
      { id:2, personId:1, certNo:"Q-PZ-26-0142", process:"142", standard:"EN ISO 14732", validUntil:"2026-07-25", renewalDue:"2026-07-11", pdfUrl:"https://istinox.sharepoint.com/…/certs/860-142.pdf" },
      { id:3, personId:2, certNo:"Q-PZ-27-0031", process:"141", standard:"EN ISO 9606-1", validUntil:"2027-03-15", renewalDue:"2027-03-01", pdfUrl:"https://istinox.sharepoint.com/…/certs/712-141.pdf" },
      { id:4, personId:2, certNo:"Q-PZ-26-0207", process:"142", standard:"EN ISO 14732", validUntil:"2026-08-05", renewalDue:"2026-07-22", pdfUrl:"https://istinox.sharepoint.com/…/certs/712-142.pdf" },
      { id:5, personId:3, certNo:"Q-PZ-26-0088", process:"141", standard:"EN ISO 9606-1", validUntil:"2026-05-20", renewalDue:"2026-05-06", pdfUrl:"https://istinox.sharepoint.com/…/certs/845-141.pdf" },
      { id:6, personId:4, certNo:"Q-PZ-27-0012", process:"142", standard:"EN ISO 14732", validUntil:"2027-01-10", renewalDue:"2026-12-27", pdfUrl:"https://istinox.sharepoint.com/…/certs/731-142.pdf" },
      { id:7, personId:5, certNo:"Q-PZ-26-0166", process:"142", standard:"EN ISO 14732", validUntil:"2026-07-18", renewalDue:"2026-07-04", pdfUrl:"https://istinox.sharepoint.com/…/certs/503-142.pdf" }
    ],
    pipelines:[
      { id:1, no:"15-SFL-LH088-AD403-100", projectId:1, drawingNo:"ISO-24-0403", plant:"WBD", welderIds:[1,3], inspectorIds:[2], procNo:"142", procName:"WIG orbital (TIG)", status:5, isoUploaded:true, docIso:"https://istinox.sharepoint.com/…/iso/15-SFL-LH088-AD403-100.pdf", docBuilder:"https://istinox.sharepoint.com/…/builder/15-SFL-LH088-AD403-100_builder.pdf", docFinal:"https://istinox.sharepoint.com/…/final/15-SFL-LH088-AD403-100_package.pdf" },
      { id:2, no:"15-SFL-LH088-MP413-303", projectId:1, drawingNo:"ISO-24-0413", plant:"WBD", welderIds:[1], inspectorIds:[2], procNo:"141/142", procName:"WIG mech. (manual + orbital)", status:2, isoUploaded:true, docIso:"https://istinox.sharepoint.com/…/iso/15-SFL-LH088-MP413-303.pdf", docBuilder:"", docFinal:"" },
      { id:3, no:"22-UPR-KA12-PR201-050", projectId:2, drawingNo:"ISO-24-0201", plant:"RCT", welderIds:[3], inspectorIds:[4], procNo:"141", procName:"WIG manual (TIG)", status:1, isoUploaded:true, docIso:"https://istinox.sharepoint.com/…/iso/22-UPR-KA12-PR201-050.pdf", docBuilder:"", docFinal:"" },
      { id:4, no:"30-BRS-BS03-AD110-010", projectId:3, drawingNo:"ISO-25-0110", plant:"BRS", welderIds:[], inspectorIds:[], procNo:"142", procName:"WIG orbital (TIG)", status:0, isoUploaded:false, docIso:"", docBuilder:"", docFinal:"" },
      { id:5, no:"30-BRS-BS03-AD110-020", projectId:3, drawingNo:"ISO-25-0111", plant:"BRS", welderIds:[5], inspectorIds:[4], procNo:"141/142", procName:"WIG mech.", status:3, isoUploaded:true, docIso:"https://istinox.sharepoint.com/…/iso/30-BRS-BS03-AD110-020.pdf", docBuilder:"https://istinox.sharepoint.com/…/builder/30-BRS-BS03-AD110-020_builder.pdf", docFinal:"" },
      { id:6, no:"41-AMS-SL04-RP330-005", projectId:4, drawingNo:"ISO-25-0330", plant:"AMS", welderIds:[1], inspectorIds:[4], procNo:"141", procName:"WIG manual (TIG)", status:4, isoUploaded:true, docIso:"https://istinox.sharepoint.com/…/iso/41-AMS-SL04-RP330-005.pdf", docBuilder:"https://istinox.sharepoint.com/…/builder/41-AMS-SL04-RP330-005_builder.pdf", docFinal:"" }
    ],
    materials:[
      { id:1, pipelineId:1, position:1, piece:"Pipe",  dimension:"DN 15", diameter:"21.3 mm", thickness:"2.0 mm", itemDescription:"Pipe DIN 11866 series B", materialCode:"1.4435", certificate:"EN 10204 3.1", heatNo:"307010", wazNo:"Z001", wazPdfUrl:"https://istinox.sharepoint.com/…/waz/Z001.pdf", connections:[2], startOfPlumbing:true, endOfPlumbing:false },
      { id:2, pipelineId:1, position:2, piece:"Elbow", dimension:"DN 15", diameter:"21.3 mm", thickness:"2.0 mm", itemDescription:"90° pipe bend acc. to DIN EN 11865 series B", materialCode:"1.4435", certificate:"EN 10204 3.1", heatNo:"145354 / 205008 / 816767", wazNo:"Z002", wazPdfUrl:"https://istinox.sharepoint.com/…/waz/Z002.pdf", connections:[1,3], startOfPlumbing:false, endOfPlumbing:false },
      { id:3, pipelineId:1, position:3, piece:"Pipe",  dimension:"DN 15", diameter:"21.3 mm", thickness:"2.0 mm", itemDescription:"Pipe DIN 11866 series B", materialCode:"1.4435", certificate:"EN 10204 3.1", heatNo:"307010", wazNo:"Z003", wazPdfUrl:"https://istinox.sharepoint.com/…/waz/Z003.pdf", connections:[2,4], startOfPlumbing:false, endOfPlumbing:false },
      { id:4, pipelineId:1, position:4, piece:"Tee",   dimension:"DN 15", diameter:"21.3 mm", thickness:"2.0 mm", itemDescription:"T-piece DIN 11866 series B", materialCode:"1.4435", certificate:"EN 10204 3.1", heatNo:"520019", wazNo:"Z004", wazPdfUrl:"https://istinox.sharepoint.com/…/waz/Z004.pdf", connections:[3,5], startOfPlumbing:false, endOfPlumbing:false },
      { id:5, pipelineId:1, position:5, piece:"Flange",dimension:"DN 15", diameter:"21.3 mm", thickness:"2.0 mm", itemDescription:"Tri-Clamp flange DIN 32676", materialCode:"1.4435", certificate:"EN 10204 3.1", heatNo:"770213", wazNo:"Z005", wazPdfUrl:"https://istinox.sharepoint.com/…/waz/Z005.pdf", connections:[4], startOfPlumbing:false, endOfPlumbing:true },
      { id:6, pipelineId:3, position:1, piece:"Pipe", dimension:"DN 25", diameter:"29.0 mm", thickness:"2.0 mm", itemDescription:"Pipe DIN 11866 series B", materialCode:"1.4404", certificate:"EN 10204 3.1", heatNo:"441122", wazNo:"Z001", wazPdfUrl:"https://istinox.sharepoint.com/…/waz/Z001.pdf", connections:[], startOfPlumbing:true, endOfPlumbing:true }
    ],
    welds:[
      { id:1, pipelineId:1, weldNo:"1", materialIds:[1,2], type:"O", procedure:"142", welderIds:[1], inspectorIds:[2], date:"2026-02-02", visual:"OK", endoscopy:"OK", ferrite:"n/a", photoUrl:"https://istinox.sharepoint.com/…/photos/naht1.jpg", endoscopyUrl:"https://istinox.sharepoint.com/…/endo/naht1.jpg", remarks:"Prefabrication weld, orbital. Manufacturer accepted 03.02.2026 (BW).", noteImageNo:"" },
      { id:2, pipelineId:1, weldNo:"2", materialIds:[2,3], type:"O", procedure:"142", welderIds:[1], inspectorIds:[2], date:"2026-02-03", visual:"OK", endoscopy:"OK", ferrite:"n/a", photoUrl:"https://istinox.sharepoint.com/…/photos/naht2.jpg", endoscopyUrl:"", remarks:"", noteImageNo:"EP-2026-014" },
      { id:3, pipelineId:1, weldNo:"3", materialIds:[3,4], type:"M", procedure:"141", welderIds:[3], inspectorIds:[4], date:"2026-02-04", visual:"OK", endoscopy:"n/a", ferrite:"1.2%", photoUrl:"", endoscopyUrl:"", remarks:"Manual root pass; ferrite within limit.", noteImageNo:"" },
      { id:4, pipelineId:1, weldNo:"4", materialIds:[4,5], type:"H", procedure:"141", welderIds:[1,3], inspectorIds:[2], date:"2026-02-05", visual:"OK", endoscopy:"OK", ferrite:"n/a", photoUrl:"https://istinox.sharepoint.com/…/photos/naht4.jpg", endoscopyUrl:"https://istinox.sharepoint.com/…/endo/naht4.jpg", remarks:"Branch connection at the T-piece.", noteImageNo:"" }
    ],
    counters:{ client:6, project:7, person:6, cert:8, pipeline:7, material:7, weld:5 }
  };
}

/* ================================================================ PERSISTENCE ================================================================ */
let DB = null;
function loadDB(){ return null; }
function saveDB(){ /* no-op: data is in Azure SQL now */ }
function initDB(){ DB = DB || { clients:[], projects:[], people:[], certificates:[], pipelines:[], materials:[], welds:[], counters:{ client:1, project:1, person:1, cert:1, pipeline:1, material:1, weld:1 } }; }
function resetDemo(){ location.reload(); }

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
function getClientName(id){ const c=getClient(id); return c?c.name:'Unknown client'; }
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
function posLetter(n){ return String.fromCharCode(64+Number(n)); }
function initials(name){ return name.split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase(); }
function fmtDia(v){ if(!v) return ''; const s=String(v).trim(); return 'Ø '+s+(s.toLowerCase().includes('mm')?'':' mm'); }
function formatDate(iso){ if(!iso) return '—'; const [y,m,d]=iso.split('-').map(Number); return `${d} ${MONTHS[m-1]} ${y}`; }
function daysUntil(iso){ const [y,m,d]=iso.split('-').map(Number); return Math.round((new Date(y,m-1,d)-TODAY)/86400000); }
function certStatus(cert){ if(!cert.validUntil) return 'valid'; const n=daysUntil(cert.validUntil); if(n<0) return 'expired'; if(n<=30) return 'expiring'; return 'valid'; }
function isoAddMonths(months){ const d=new Date(TODAY); d.setMonth(d.getMonth()+months); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function personCertRank(pid){ const s=personCerts(pid).map(certStatus); if(s.includes('valid')) return 'valid'; if(s.includes('expiring')) return 'expiring'; return 'expired'; }
function personNameClass(pid, pipeStatus){ if(pipeStatus===3) return ''; const r=personCertRank(pid); return r==='expired'?'expired':r==='expiring'?'warn':''; }
function tile(num,label,cls){ return `<div class="stat-tile ${cls||''}"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`; }
const ARCHIVE_SVG='<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="4" rx="1" stroke="currentColor" stroke-width="1.8"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M10 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
function archiveBtn(type,id){ return `<button class="btn-archive" onclick="openArchiveModal('${type}',${id})" title="Archive">${ARCHIVE_SVG}Archive</button>`; }
/* ---- pipeline lifecycle (6 states) ---- */
const PIPE_STATUS = [
  "New",                           // 0  → pending material list creation
  "Material list done",          // 1  → pending weld list creation
  "Weld list done",              // 2  → pending builder document (print / download)
  "Builder document downloaded", // 3  → pending welding detail update
  "Welding details updated",     // 4  → pending export of final document
  "Exported"                     // 5  → complete
];
/* office-staff "what's pending" labels, indexed by status */
const PENDING_LABEL = [
  "Pending material list creation",
  "Pending weld list creation",
  "Pending builder document",
  "Pending welding detail update",
  "Pending export of final document",
  "Completed"
];
const STATUS_LABELS = { 'not-started':'Not started','ongoing':'Ongoing','completed':'Completed' };
const STATUS_SEQUENCE = ['not-started','ongoing','completed'];
function statusPill(s){ return `<span class="pill pill-${s}"><span class="dot"></span>${PIPE_STATUS[s]}</span>`; }
function certStatusPill(cert){ const s=certStatus(cert); const label=s==='valid'?'Valid':s==='expiring'?'Expiring':'Expired'; return `<span class="cpill cpill-${s}">${label}</span>`; }

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
function docCell(pl){
  const slot=t=>`<span class="doc-slot" title="${t}">—</span>`;
  const iso = pl.isoUploaded&&pl.docIso
    ? `<a class="doc-chip doc-iso" href="${escapeHtml(pl.docIso)}" target="_blank" rel="noopener" title="Isometric drawing (SharePoint)">ISO</a>`
    : `<button class="btn btn-primary btn-sm" onclick="uploadIsoDoc(${pl.id})" title="Upload ISO document">+</button>`;
  let builder;
  if(pl.status===2) builder=`<button class="doc-chip doc-weld" onclick="downloadBuilderDoc(${pl.id})" title="Generate & download the builder document (advances the pipeline to 'Builder document downloaded')">Builder ⬇</button>`;
  else if(pl.status>=3) builder=`<a class="doc-chip doc-weld" href="${escapeHtml(pl.docBuilder)}" target="_blank" rel="noopener" title="Builder document (SharePoint)">Builder</a>`;
  else builder=slot('Builder document available once the weld list is done');
  const fin = pl.status>=5&&pl.docFinal
    ? `<a class="doc-chip doc-final" href="${escapeHtml(pl.docFinal)}" target="_blank" rel="noopener" title="Final documentation package (SharePoint)">Final</a>`
    : slot('Final document available after export');
  return `<div class="docs">${iso}${builder}${fin}</div>`;
}
/* Upload ISO document for a pipeline */
function uploadIsoDoc(plId){
  const input=document.createElement('input');
  input.type='file'; input.accept='application/pdf';
  input.onchange=()=>{
    const f=input.files[0]; if(!f) return;
    const pl=getPipeline(plId);
    pl.isoUploaded=true;
    pl.docIso=`https://istinox.sharepoint.com/…/iso/${f.name}`;
    saveDB(); rerenderPage();
  };
  input.click();
}

/* ================================================================ WORKFLOW STATE MACHINE ================================================================ */
function setPipelineStatus(id,status){ const pl=getPipeline(id); if(!pl) return; pl.status=status;
  pl.isoUploaded = pl.isoUploaded || status>=1;
  if(status>=1 && !pl.docIso) pl.docIso=`https://istinox.sharepoint.com/…/iso/${pl.no}.pdf`;
  if(status>=3 && !pl.docBuilder) pl.docBuilder=`https://istinox.sharepoint.com/…/builder/${pl.no}_builder.pdf`;
  if(status>=5 && !pl.docFinal) pl.docFinal=`https://istinox.sharepoint.com/…/final/${pl.no}_package.pdf`;
  saveDB();
  apiPost('/pipelines', {id, status}).catch(e=>console.error('Pipeline status update failed:', e));
}
function markMaterialDone(id){ const pl=getPipeline(id); if(pl&&pl.status===0){ setPipelineStatus(id,1); rerenderPage(); } }
function markWeldlistDone(id){ const pl=getPipeline(id); if(pl&&pl.status===1){ setPipelineStatus(id,2); rerenderPage(); } }
function downloadBuilderDoc(id){ const pl=getPipeline(id); if(!pl) return; if(pl.status===2) setPipelineStatus(id,3); window.open(API_BASE+'/pipelines/'+id+'/builder-doc','_blank','noopener'); rerenderPage(); }
function exportFinalDoc(id){ const pl=getPipeline(id); if(pl&&pl.status===4){ setPipelineStatus(id,5); rerenderPage(); } }

/* workflow / assignment queries used by the home dashboards */
function pipelineExpiredWelder(pl){ return (pl.welderIds||[]).some(wid=>personCerts(wid).length===0 || personCerts(wid).every(c=>certStatus(c)==='expired')); }
function pipelinesPendingCert(){ return pipelines().filter(pl=>pl.status<5 && (pl.welderIds||[]).length>0 && pipelineExpiredWelder(pl)); }
function pipelinesUnassignedWelder(){ return pipelines().filter(pl=>!(pl.welderIds||[]).length); }
function pipelinesUnassignedInspector(){ return pipelines().filter(pl=>!(pl.inspectorIds||[]).length); }
function pipelinesUnassignedAny(){ return pipelines().filter(pl=>!(pl.welderIds||[]).length || !(pl.inspectorIds||[]).length); }
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
function readSelectOther(selectId, textId){ const sel=document.getElementById(selectId); return sel.value==='__other__'?document.getElementById(textId).value.trim():sel.value; }

/* ---- checklist helper ---- */
function buildPersonChecklist(containerId, selectedIds){
  document.getElementById(containerId).innerHTML = people().map(p=>`<label class="check-item"><input type="checkbox" value="${p.id}" ${selectedIds.includes(p.id)?'checked':''}> ${escapeHtml(p.name)} · No. ${escapeHtml(p.no)}</label>`).join('');
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
function renderChrome(activeNav, breadcrumbHtml){
  const counts = { clients:clients().length, projects:projects().length, pipelines:pipelines().length, welders:people().length,
                   materials:materials().length, waz:uniqueWaz().length };
  const nav=(key,label,href,showCount)=>`<a class="nav-tab ${activeNav===key?'active':''}" href="${href}"><span class="nav-icon">${icon(key)}</span><span class="nav-label">${label}</span>${showCount?`<span class="nav-count">${counts[key]}</span>`:''}</a>`;
  const role=getRole();
  const roleName = role==='vendor' ? escapeHtml((getPerson(getCurrentUserId())||{}).name||'Vendor') : 'Office staff';
  document.getElementById('chrome').innerHTML = `
    <div class="accent-bar"></div>
    <header class="topbar">
      <a class="brand" href="home.html">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4H10V14C10 17.3137 12.6863 20 16 20H20" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="4" cy="4" r="1.7" fill="currentColor"/><circle cx="20" cy="20" r="1.7" fill="currentColor"/></svg>
        <span class="brand-text"><span class="brand-name">WELDDOC</span><span class="brand-tagline">Pharma Piping Documentation</span></span>
      </a>
      <div class="topbar-divider"></div>
      <div class="breadcrumb">${breadcrumbHtml||''}</div>

    </header>
    <nav class="sidebar">
      <div class="nav-section-label">Workspace</div>
      ${nav('home','Home','home.html',false)}
      ${nav('clients','Clients','index.html',true)}
      ${nav('projects','Projects','projects.html'+(PAGE.clientId?'?client='+PAGE.clientId:''),true)}
      ${nav('pipelines','Pipelines','pipelines.html'+(PAGE.projectId?'?project='+PAGE.projectId:(PAGE.clientId?'?client='+PAGE.clientId:'')),true)}
      <div class="nav-section-label">Documents</div>
      ${nav('materials','Materials','materials.html',true)}
      ${nav('welders','Welders','welders.html',true)}
      <div class="sidebar-role">
        <div class="role-line">Signed in as<br><strong>${roleName}</strong></div>
        <a href="role.html">Switch role</a>
      </div>
    </nav>`;
}

/* All modals live in one template, injected into #modal-root on every page. */
function mountModals(){
  document.getElementById('modal-root').innerHTML = `
  <div class="modal-overlay" id="modal-client"><div class="modal">
    <button class="modal-close" onclick="closeModal('modal-client')">&times;</button><h2 id="modal-client-title">New client</h2>
    <form id="client-form"><div class="form-grid">
      <label class="field wide"><span class="lbl">Client name <span class="req">*</span></span><input type="text" id="input-name" required></label>
      <label class="field wide"><span class="lbl">Street <span class="req">*</span></span><input type="text" id="input-street" required></label>
      <label class="field"><span class="lbl">Zip Code <span class="req">*</span></span><input type="text" id="input-zip" required></label>
      <label class="field"><span class="lbl">Location <span class="req">*</span></span><input type="text" id="input-place" required></label>
      <label class="field wide"><span class="lbl">Remarks</span><textarea id="input-remarks"></textarea></label>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-client')">Cancel</button><button type="submit" class="btn btn-primary">Save client</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-project"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-project')">&times;</button><h2 id="modal-project-title">New project</h2>
    <form id="project-form"><div class="form-grid">
      <label class="field"><span class="lbl">IST Project number</span><input type="text" id="input-project-istno" placeholder="e.g. 926xxxx"></label>
      <div class="field"><span class="lbl">Client <span class="req">*</span></span><select id="input-project-client" required></select><input type="text" id="input-project-client-readonly" disabled style="display:none"></div>
      <label class="field"><span class="lbl">Project title <span class="req">*</span></span><input type="text" id="input-project-title" required></label>
      <div class="field"><span class="lbl">Location</span><select id="input-project-location" onchange="toggleSelectOther('input-project-location','input-project-location-new')"></select><input type="text" id="input-project-location-new" class="select-other-text" style="display:none" placeholder="Type new location…"></div>
      <label class="field"><span class="lbl">Order number</span><input type="text" id="input-project-order"></label>
      <label class="field wide"><span class="lbl">Description</span><textarea id="input-project-description"></textarea></label>
      <label class="field"><span class="lbl">Status</span><select id="input-project-status"><option value="not-started">Not started</option><option value="ongoing">Ongoing</option><option value="completed">Completed</option></select></label>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-project')">Cancel</button><button type="submit" class="btn btn-primary">Save project</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-pipeline"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-pipeline')">&times;</button><h2 id="modal-pipeline-title">New pipeline</h2>
    <form id="pipeline-form"><div class="form-grid">
      <label class="field wide"><span class="lbl">Pipeline number <span class="req">*</span></span><input type="text" id="input-pl-no" required></label>
      <label class="field"><span class="lbl">Project <span class="req">*</span></span><select id="input-pl-project" onchange="onPipelineProjectChange()" required></select></label>
      <label class="field"><span class="lbl">Order number (from project)</span><input type="text" id="input-pl-order" disabled></label>
      <label class="field"><span class="lbl">Plant</span><input type="text" id="input-pl-plant"></label>
      <label class="field"><span class="lbl">Status</span><select id="input-pl-status"></select></label>
      <div class="modal-note">Order number is inherited from the project.</div>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-pipeline')">Cancel</button><button type="submit" class="btn btn-primary">Save pipeline</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-welder"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-welder')">&times;</button><h2 id="modal-welder-title">New welder</h2>
    <form id="welder-form"><div class="form-grid">
      <label class="field"><span class="lbl">Welder name <span class="req">*</span></span><input type="text" id="input-w-name" required></label>
      <label class="field"><span class="lbl">Welder number <span class="req">*</span></span><input type="text" id="input-w-no" required></label>
      <div class="field wide" id="w-cert-section" style="display:none;">
        <div id="w-cert-rows"></div>
        <button type="button" class="inline-add-toggle" onclick="addWelderCertRow()">+ Add another certificate</button>
      </div>
      <button type="button" class="inline-add-toggle" id="w-cert-add-btn" onclick="showWelderCertSection()" style="text-align:left;grid-column:1/-1;">+ Add certificate</button>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-welder')">Cancel</button><button type="submit" class="btn btn-primary">Save welder</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-weld"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-weld')">&times;</button><h2 id="modal-weld-title">New weld</h2>
    <form id="weld-form"><div class="form-grid">
      <label class="field"><span class="lbl">Weld number <span class="req">*</span></span><input type="text" id="input-weld-no" required></label>
      <label class="field"><span class="lbl">Date of welding</span><input type="date" id="input-weld-date"></label>
      <div class="field wide"><span class="lbl">Between (joined materials)</span><div class="checklist" id="input-weld-materials"></div>
        <button type="button" class="inline-add-toggle" onclick="openMaterialModal(null,true)">+ Add new item</button>
        <div class="field-hint">Select the materials this seam joins.</div></div>
      <div class="field"><span class="lbl">Type</span><select id="input-weld-type" onchange="onWeldTypeChange()"><option value="">—</option><option value="O">O — Orbital</option><option value="H">H — Hand / semi-auto</option><option value="M">M — Manual</option></select></div>
      <div class="field"><span class="lbl">Procedure</span><input type="text" id="input-weld-proc" readonly></div>
      <label class="field"><span class="lbl">Visual result</span><select id="input-weld-visual"><option>OK</option><option>Not OK</option><option>n/a</option></select></label>
      <label class="field"><span class="lbl">Endoscopy result</span><select id="input-weld-endoscopy"><option>OK</option><option>Not OK</option><option>n/a</option></select></label>
      <label class="field"><span class="lbl">Endoscopy video (→ SharePoint)</span><input type="file" id="input-weld-photo" accept="video/*"></label>
      <label class="field"><span class="lbl">Endoscopy image (→ SharePoint)</span><input type="file" id="input-weld-endoscopy-img" accept="image/*"></label>
      <label class="field wide"><span class="lbl">Remarks</span><textarea id="input-weld-remarks" placeholder="Shown when the Remarks cell is clicked"></textarea></label>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-weld')">Cancel</button><button type="submit" class="btn btn-primary">Save weld</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-material"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-material')">&times;</button><h2 id="modal-material-title">New material</h2>
    <form id="material-form"><div class="form-grid">
      <label class="field"><span class="lbl">Position</span><input type="text" id="input-mat-position" disabled></label>
      <div class="field"><span class="lbl">Category <span class="req">*</span></span><select id="input-mat-piece" onchange="onCategoryChange()"></select><input type="text" id="input-mat-piece-new" class="select-other-text" style="display:none" placeholder="Type category…"></div>
      <div class="field wide"><span class="lbl">Item description</span><select id="input-mat-desc" onchange="onItemDescChange()"></select><input type="text" id="input-mat-desc-new" class="select-other-text" style="display:none" placeholder="Type description…"></div>
      <div id="dn-fields-container"><div class="field" id="dn1-field"><span class="lbl" id="dn1-label">DN</span><select id="input-mat-dimension" onchange="onDnChange()"></select><input type="text" id="input-mat-dimension-new" class="select-other-text" style="display:none" placeholder="Type DN…"></div></div>
      <div class="field"><span class="lbl">DIN EN Number <span class="req">*</span></span><select id="input-mat-dien" onchange="onDienChange()"></select><input type="text" id="input-mat-dien-new" class="select-other-text" style="display:none" placeholder="Type DIN EN…"></div>
      <div class="field"><span class="lbl">Material code <span class="req">*</span></span><select id="input-mat-code" onchange="onMatCodeChange()"></select><input type="text" id="input-mat-code-new" class="select-other-text" style="display:none" placeholder="Type material code…"></div>
      <div class="field" id="diameter-field"><span class="lbl">Outer diameter <span class="req">*</span></span><select id="input-mat-diameter" onchange="onDiameterChange()"></select><input type="text" id="input-mat-diameter-new" class="select-other-text" style="display:none" placeholder="Type diameter…"></div>
      <div class="field" id="thickness-field"><span class="lbl">Thickness <span class="req">*</span></span><select id="input-mat-thickness" onchange="toggleSelectOther('input-mat-thickness','input-mat-thickness-new')"></select><input type="text" id="input-mat-thickness-new" class="select-other-text" style="display:none" placeholder="Type thickness…"></div>
      <label class="field"><span class="lbl">Surface</span><input type="text" id="input-mat-surface" placeholder="e.g. Ra 0.8 µm"></label>
      <div class="field wide"><div class="check-row">
        <label><input type="checkbox" id="input-mat-start" onchange="onStartEndChange()"> Start of plumbing</label>
        <label><input type="checkbox" id="input-mat-end" onchange="onStartEndChange()"> End of plumbing</label>
      </div></div>
      <div class="field wide"><span class="lbl">Connections (other materials this joins to)</span>
        <div id="conn-rows"></div>
        <button type="button" class="inline-add-toggle" onclick="addConnRow()">+ Add connection</button>
        <div class="field-hint" id="conn-hint"></div>
      </div>
      <div class="modal-err" id="material-err"></div>
      <div class="modal-note">You can also add or edit connections from the weld list.</div>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-material')">Cancel</button><button type="submit" class="btn btn-primary">Save material</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-renew"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-renew')">&times;</button><h2>Renew certificate</h2>
    <p id="renew-text"></p>
    <label class="field" style="margin-bottom:12px;"><span class="lbl">Certificate number <span class="req">*</span></span><input type="text" id="renew-certno" required></label>
    <label class="field" style="margin-bottom:12px;"><span class="lbl">New valid until <span class="req">*</span></span><input type="date" id="renew-valid" required></label>
    <label class="field" style="margin-bottom:12px;"><span class="lbl">Next renewal due <span class="req">*</span></span><input type="date" id="renew-renewal" required></label>
    <label class="field"><span class="lbl">Renewal attachment (→ SharePoint) <span class="req">*</span></span><input type="file" id="renew-file" accept="application/pdf"></label>
    <div class="field-hint">The uploaded PDF is stored in SharePoint; all fields are required.</div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-renew')">Cancel</button><button class="btn btn-primary" onclick="confirmRenew()">Confirm renewal</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-people"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-people')">&times;</button><h2 id="people-title">Assigned</h2>
    <div id="people-body"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-people')">Close</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-remarks"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-remarks')">&times;</button><h2>Remarks</h2>
    <p id="remarks-body"></p>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-remarks')">Close</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-image"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-image')">&times;</button><h2 id="image-title">Preview</h2>
    <div class="img-placeholder" id="image-placeholder"></div><div class="field-hint" id="image-link"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-image')">Close</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-archive"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-archive')">&times;</button><h2 id="modal-archive-title">Archive?</h2>
    <p id="archive-confirm-text"></p>
    <div class="modal-actions"><button class="btn btn-ghost" id="archive-cancel-btn" onclick="closeModal('modal-archive')">Cancel</button><button class="btn btn-primary" id="archive-confirm-btn" onclick="confirmArchive()">Archive</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-welding"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-welding')">&times;</button><h2>Update welding details</h2>
    <p class="field-hint" style="margin-bottom:16px;">After the builder document is downloaded, welding is carried out on site. Record the as-built details and confirm the verification documents below to complete this step.</p>
    <div class="form-grid">
      <label class="field"><span class="lbl">Welding start date</span><input type="date" id="input-wd-start"></label>
      <label class="field"><span class="lbl">Welding completion date</span><input type="date" id="input-wd-end"></label>
      <label class="field wide"><span class="lbl">Remarks</span><textarea id="input-wd-remarks" placeholder="Any notes on the as-built welding…"></textarea></label>
      <div class="modal-note">Confirming sets the pipeline status to <strong>Welding details updated</strong>, after which the final document can be exported.</div>
    </div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-welding')">Cancel</button><button class="btn btn-success" onclick="confirmWeldingUpdate()">Complete welding details</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-waz-add"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-waz-add')">&times;</button><h2 id="modal-waz-title">Add WAZ document</h2>
    <div class="form-grid">
      <div class="field"><span class="lbl">WAZ No.</span><select id="input-waz-no" onchange="onWazNoChange()"></select></div>
      <div class="field"><span class="lbl">Certificate No.</span><select id="input-waz-cert" onchange="toggleSelectOther('input-waz-cert','input-waz-cert-new')"></select><input type="text" id="input-waz-cert-new" class="select-other-text" style="display:none" placeholder="Type certificate No.…"><input type="text" id="input-waz-cert-edit" style="display:none"></div>
      <div class="field"><span class="lbl">Heat / melt No.</span><select id="input-waz-heat" onchange="onWazHeatChange()"></select><input type="text" id="input-waz-heat-new" class="select-other-text" style="display:none" placeholder="Type heat/melt No.…"><input type="text" id="input-waz-heat-edit" style="display:none"></div>
      <div class="modal-note" id="waz-shared-warning" style="display:none;color:var(--copper);grid-column:1/-1;">⚠ Any changes here will apply to every combination of heat number and certificate number under this project.</div>
      <div class="field wide"><span class="lbl">WAZ document (→ SharePoint)</span>
        <div id="waz-current-doc"></div>
        <input type="file" id="input-waz-file" accept="application/pdf">
      </div>
      <div class="modal-err" id="waz-err"></div>
    </div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal('modal-waz-add')">Cancel</button><button class="btn btn-primary" onclick="confirmAddWaz()">Save WAZ</button></div>
  </div></div>

  <div class="modal-overlay" id="modal-mat-props"><div class="modal modal-wide">
    <button class="modal-close" onclick="closeModal('modal-mat-props')">&times;</button><h2 id="modal-mat-props-title">Edit material</h2>
    <form id="mat-props-form"><div class="form-grid">
      <div class="field"><span class="lbl">Category</span><select id="mp-piece" onchange="onMpCategoryChange()"></select></div>
      <div class="field wide"><span class="lbl">Item description</span><select id="mp-desc" onchange="onMpDescChange()"></select><input type="text" id="mp-desc-new" class="select-other-text" style="display:none" placeholder="Type description…"></div>
      <div id="mp-dn-container"><div class="field" id="mp-dn1-field"><span class="lbl" id="mp-dn1-label">DN</span><select id="mp-dimension" onchange="toggleSelectOther('mp-dimension','mp-dimension-new')"></select><input type="text" id="mp-dimension-new" class="select-other-text" style="display:none" placeholder="Type DN…"></div></div>
      <div class="field"><span class="lbl">DIN EN Number</span><select id="mp-dien" onchange="toggleSelectOther('mp-dien','mp-dien-new')"></select><input type="text" id="mp-dien-new" class="select-other-text" style="display:none" placeholder="Type DIN EN…"></div>
      <div class="field"><span class="lbl">Material code</span><select id="mp-code" onchange="toggleSelectOther('mp-code','mp-code-new')"></select><input type="text" id="mp-code-new" class="select-other-text" style="display:none" placeholder="Type code…"></div>
      <div class="field" id="mp-diameter-field"><span class="lbl">Outer diameter</span><select id="mp-diameter" onchange="toggleSelectOther('mp-diameter','mp-diameter-new')"></select><input type="text" id="mp-diameter-new" class="select-other-text" style="display:none" placeholder="Type diameter…"></div>
      <div class="field" id="mp-thickness-field"><span class="lbl">Thickness</span><select id="mp-thickness" onchange="toggleSelectOther('mp-thickness','mp-thickness-new')"></select><input type="text" id="mp-thickness-new" class="select-other-text" style="display:none" placeholder="Type thickness…"></div>
      <label class="field"><span class="lbl">Surface</span><input type="text" id="mp-surface" placeholder="e.g. Ra 0.8 µm"></label>
    </div><div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal('modal-mat-props')">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div></form>
  </div></div>

  <div class="modal-overlay" id="modal-apply-all"><div class="modal modal-small">
    <button class="modal-close" onclick="closeModal('modal-apply-all')">&times;</button><h2>Apply changes</h2>
    <p>There are <strong id="modal-apply-all-count">0</strong> other material(s) with the same combination:<br><strong id="modal-apply-all-piece"></strong></p>
    <p>Would you like to update all of them, or only this one?</p>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="confirmApplyOne()">Only this one</button><button class="btn btn-primary" onclick="confirmApplyAll()">Update all matching</button></div>
  </div></div>`;
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

/* shared preview / remarks / people popups */
function showImage(title,url){ showImageRaw(title,url,''); }
function showImageRaw(title,url,extra){
  document.getElementById('image-title').textContent=title;
  document.getElementById('image-placeholder').textContent = url?'Preview (stored in SharePoint)':'No file uploaded yet';
  document.getElementById('image-link').innerHTML=(extra?escapeHtml(extra)+'<br>':'')+(url?`<span class="col-mono">${escapeHtml(url)}</span>`:'');
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
    const data={ name:val('input-name'), street:val('input-street'), zipCode:val('input-zip'), location:val('input-place'), remarks:val('input-remarks') };
    if(editingClientId!==null) data.id=editingClientId;
    try {
      const saved = await apiPost('/clients', data);
      if(editingClientId!==null){ const idx=DB.clients.findIndex(c=>c.id===editingClientId); if(idx>=0) DB.clients[idx]=saved; }
      else DB.clients.push(saved);
    } catch(e){ console.error('Save client failed:', e);
      if(editingClientId!==null) Object.assign(getClient(editingClientId),data); else DB.clients.push({id:nextId('client'),...data});
    }
    saveDB(); closeModal('modal-client'); rerenderPage();
  });
  document.getElementById('project-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const location=readSelectOther('input-project-location','input-project-location-new');
    const data={ clientId:Number(val('input-project-client')), title:val('input-project-title'), location, order:val('input-project-order')||'', istProjectNo:val('input-project-istno'), description:val('input-project-description'), status:val('input-project-status') };
    if(editingProjectId!==null) data.id=editingProjectId;
    try {
      const apiData={...data, orderNo:data.order};
      const saved = await apiPost('/projects', apiData);
      saved.order=saved.orderNo;
      if(editingProjectId!==null){ const idx=DB.projects.findIndex(p=>p.id===editingProjectId); if(idx>=0) DB.projects[idx]=saved; }
      else DB.projects.push(saved);
    } catch(e){ console.error('Save project failed:', e);
      if(editingProjectId!==null) Object.assign(getProject(editingProjectId),data); else DB.projects.push({id:nextId('project'),...data});
    }
    saveDB(); closeModal('modal-project'); rerenderPage();
  });
  document.getElementById('pipeline-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const projectId=Number(val('input-pl-project')), status=Number(val('input-pl-status')), no=val('input-pl-no');
    const data={ no, projectId, plant:val('input-pl-plant'), status };
    if(editingPipelineId!==null) data.id=editingPipelineId;
    try {
      const saved = await apiPost('/pipelines', data);
      if(editingPipelineId!==null){ const idx=DB.pipelines.findIndex(p=>p.id===editingPipelineId); if(idx>=0) DB.pipelines[idx]=saved; }
      else DB.pipelines.push(saved);
    } catch(e){ console.error('Save pipeline failed:', e);
      const fallback={ no, projectId, drawingNo:'', plant:val('input-pl-plant'), welderIds:[], inspectorIds:[], procNo:'', procName:'', status };
      if(editingPipelineId!==null) Object.assign(getPipeline(editingPipelineId),fallback); else DB.pipelines.push({id:nextId('pipeline'),...fallback});
    }
    saveDB(); closeModal('modal-pipeline'); rerenderPage();
  });
  document.getElementById('welder-form').addEventListener('submit',e=>{
    e.preventDefault();
    const data={ name:val('input-w-name'), no:val('input-w-no'), procs:'' };
    /* Require at least 1 certificate for new welders, and all fields filled */
    const certs=getWelderCertRows();
    if(certs._validationError){
      alert(certs._validationError);
      return;
    }
    if(editingWelderId===null && !certs.length){
      alert('At least one certificate is required.');
      return;
    }
    let personId;
    if(editingWelderId!==null){ Object.assign(getPerson(editingWelderId),data); personId=editingWelderId; }
    else { personId=nextId('person'); DB.people.push({id:personId,...data}); }
    /* Create certificates from the dynamic rows (for both new and edit) */
    if(certs.length){
      const allProcs=[];
      certs.forEach(c=>{
        const pdfUrl=c.fileName?`https://istinox.sharepoint.com/…/certs/${c.fileName}`:'';
        DB.certificates.push({ id:nextId('cert'), personId, certNo:c.certNo, process:c.process, standard:c.standard, validUntil:c.validUntil, renewalDue:c.renewalDue, pdfUrl });
        if(c.procs) allProcs.push(c.procs);
        else allProcs.push(c.process);
      });
      /* Update qualified processes on the person */
      const person=getPerson(personId);
      const existingProcs=person.procs?person.procs.split(/\s*\/\s*/):[];
      const merged=[...new Set([...existingProcs,...allProcs].filter(Boolean))];
      person.procs=merged.join(' / ');
    }
    saveDB(); closeModal('modal-welder');
    if(welderReturnToWeld){ welderReturnToWeld=false;
      if(document.getElementById('modal-weld').classList.contains('open')){ buildPersonChecklist('input-weld-welders',getChecked('input-weld-welders')); buildPersonChecklist('input-weld-inspectors',getChecked('input-weld-inspectors')); }
      if(document.getElementById('modal-pipeline').classList.contains('open')){ buildPersonChecklist('input-pl-welders',getChecked('input-pl-welders')); buildPersonChecklist('input-pl-inspectors',getChecked('input-pl-inspectors')); }
    }
    rerenderPage();
  });
  document.getElementById('weld-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const proc=val('input-weld-proc');
    const existingWeld=editingWeldId!==null?getWeld(editingWeldId):null;
    const data={ pipelineId:PAGE.pipelineId, weldNo:val('input-weld-no'), materialIds:getChecked('input-weld-materials'), type:val('input-weld-type'), procedure:proc, weldingWireId:existingWeld?existingWeld.weldingWireId:null, welderIds:existingWeld?existingWeld.welderIds:[], inspectorIds:existingWeld?existingWeld.inspectorIds:[], date:val('input-weld-date')||'', visual:val('input-weld-visual'), endoscopy:val('input-weld-endoscopy'), remarks:val('input-weld-remarks') };
    const photoName=(document.getElementById('input-weld-photo').files[0]||{}).name;
    const endoName=(document.getElementById('input-weld-endoscopy-img').files[0]||{}).name;
    if(editingWeldId!==null){ const w=getWeld(editingWeldId); data.ferrite=w.ferrite; data.noteImageNo=w.noteImageNo;
      data.photoUrl=photoName?`https://istinox.sharepoint.com/…/photos/${photoName}`:w.photoUrl; data.endoscopyUrl=endoName?`https://istinox.sharepoint.com/…/endo/${endoName}`:w.endoscopyUrl; Object.assign(w,data);
    } else { data.ferrite='n/a'; data.noteImageNo=''; data.photoUrl=photoName?`https://istinox.sharepoint.com/…/photos/${photoName}`:''; data.endoscopyUrl=endoName?`https://istinox.sharepoint.com/…/endo/${endoName}`:''; DB.welds.push({id:nextId('weld'),...data}); }
    saveDB(); closeModal('modal-weld'); rerenderPage();
    try {
      const selMats=data.materialIds.map(id=>getMaterial(id)).filter(Boolean);
      const bA=selMats[0]?posLetter(selMats[0].position):'';
      const bB=selMats[1]?posLetter(selMats[1].position):'';
      const apiData={pipelineId:data.pipelineId, weldNo:data.weldNo, betweenA:bA, betweenB:bB, type:data.type, procedure:data.procedure, weldingWire:'', welder:'', inspector:'', date:data.date, remarks:data.remarks};
      if(editingWeldId!==null) apiData.id=editingWeldId;
      await apiPost('/welds', apiData);
    } catch(e){ console.error('Save weld API error:', e); }
  });
  document.getElementById('material-form').addEventListener('submit',async e=>{
    e.preventDefault();
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
      err.classList.add('show'); return;
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
    const surface=val('input-mat-surface');
    if(!piece){ err.textContent='Category is required.'; err.classList.add('show'); return; }
    if(!isWire && dnCount>0){
      if(!dimension){ err.textContent='DN is required.'; err.classList.add('show'); return; }
      for(let i=0;i<extraDns.length;i++){
        if(!extraDns[i]){ err.textContent=`DN ${i+2} is required.`; err.classList.add('show'); return; }
      }
      if(!dienNo){ err.textContent='DIN EN Number is required.'; err.classList.add('show'); return; }
    }
    if(hasThickness(piece) && !isWire && !thickness){ err.textContent='Thickness is required.'; err.classList.add('show'); return; }
    if(!matCode){ err.textContent='Material code is required.'; err.classList.add('show'); return; }
    if(hasDiameter(piece) && !diameter){ err.textContent='Outer diameter is required.'; err.classList.add('show'); return; }
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
    let savedId;
    if(editingMaterialId!==null){ Object.assign(getMaterial(editingMaterialId),data); savedId=editingMaterialId; }
    else { savedId=nextId('material'); DB.materials.push({id:savedId,...data});
      /* auto-connect: if no connections given and not welding wire, find the nearest material that needs more connections */
      if(!uniqueConns.length && requiredWelds(data.piece)>0){
        const existing=pipelineMaterials(PAGE.pipelineId).filter(m=>m.id!==savedId && (m.piece||'').toLowerCase()!=='welding wire');
        if(existing.length){
          const sorted=existing.slice().sort((a,b)=>b.position-a.position);
          const candidate=sorted.find(m=>{
            const needed=requiredWelds(m.piece);
            const current=(m.connections||[]).length;
            return current<needed;
          });
          if(candidate){
            const saved=getMaterial(savedId);
            saved.connections=[candidate.id];
          }
        }
      }
    }
    try { syncMaterialConnections(savedId); } catch(syncErr){ console.error('syncMaterialConnections error:', syncErr); }
    saveDB(); closeModal('modal-material');
    if(materialReturnToWeld){ materialReturnToWeld=false; if(document.getElementById('modal-weld').classList.contains('open')) buildWeldMaterialChecklist(getChecked('input-weld-materials')); }
    rerenderPage();
    /* ---- Sync to API (backend handles connections + welds) ---- */
    try {
      const posLtr=val('input-mat-position')||posLetter(data.position||1);
      const connPositions=(getMaterial(savedId).connections||[]).map(cid=>{
        const cm=getMaterial(cid); return cm?posLetter(cm.position):null;
      }).filter(Boolean);
      const apiData={pipelineId:data.pipelineId, position:posLtr, category:data.piece, dn1:data.dimension, itemDescription:data.itemDescription, materialCode:data.materialCode, diameter:data.diameter, thickness:data.thickness, dienNo:data.dienNo, surface:data.surface, certificate:data.certificate, heatNo:data.heatNo, wazNo:data.wazNo, wazPdfUrl:data.wazPdfUrl, startOfPlumbing:data.startOfPlumbing, endOfPlumbing:data.endOfPlumbing, connections:connPositions};
      if(editingMaterialId!==null) apiData.id=editingMaterialId;
      await apiPost('/materials', apiData);
    } catch(e){ console.error('Save material API error:', e); }
  });
}
function val(id){ return (document.getElementById(id).value||'').trim(); }

/* ================================================================ MODAL OPENERS ================================================================ */
function openClientModal(id=null){
  editingClientId=id; document.getElementById('client-form').reset();
  if(id!==null){ const c=getClient(id); document.getElementById('modal-client-title').textContent='Edit client'; setV('input-name',c.name); setV('input-street',c.street); setV('input-zip',c.zipCode); setV('input-place',c.location); setV('input-remarks',c.remarks); }
  else document.getElementById('modal-client-title').textContent='New client';
  openModal('modal-client'); document.getElementById('input-name').focus();
}
function clientLocations(clientId){
  const cli=getClient(clientId);
  const locs=[];
  if(cli && cli.location) locs.push(cli.location);
  clientProjects(clientId).forEach(p=>{ if(p.location && !locs.includes(p.location)) locs.push(p.location); });
  return locs.sort();
}
function openProjectModal(id=null){
  editingProjectId=id; document.getElementById('project-form').reset();
  const cliSel=document.getElementById('input-project-client');
  const cliReadonly=document.getElementById('input-project-client-readonly');
  cliSel.innerHTML=clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if(id!==null){ const p=getProject(id); document.getElementById('modal-project-title').textContent='Edit project';
    setV('input-project-client',String(p.clientId)); setV('input-project-title',p.title); setV('input-project-order',p.order||''); setV('input-project-istno',p.istProjectNo||''); setV('input-project-description',p.description); setV('input-project-status',p.status);
    buildSelectOther('input-project-location','input-project-location-new',clientLocations(p.clientId),p.location);
    cliSel.style.display='none';
    const cli=getClient(p.clientId);
    if(cliReadonly){ cliReadonly.value=cli?cli.name:''; cliReadonly.style.display=''; }
  } else { document.getElementById('modal-project-title').textContent='New project'; setV('input-project-status','not-started');
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
  document.getElementById('input-pl-status').innerHTML=PIPE_STATUS.map((s,i)=>`<option value="${i}">${escapeHtml(s)}</option>`).join('');
  if(id!==null){ const pl=getPipeline(id); document.getElementById('modal-pipeline-title').textContent='Edit pipeline';
    setV('input-pl-no',pl.no); setV('input-pl-project',String(pl.projectId)); setV('input-pl-plant',pl.plant); setV('input-pl-status',String(pl.status));
    projSel.disabled=true; projSel.style.display='none';
    const pr=getProject(pl.projectId);
    let readOnly=document.getElementById('input-pl-project-readonly');
    if(!readOnly){ readOnly=document.createElement('input'); readOnly.type='text'; readOnly.id='input-pl-project-readonly'; readOnly.disabled=true; projSel.parentElement.appendChild(readOnly); }
    readOnly.value=pr?`${pr.title} — ${getClientName(pr.clientId)}`:'';
    readOnly.style.display='';
  } else { document.getElementById('modal-pipeline-title').textContent='New pipeline'; setV('input-pl-status','0');
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
function openWelderModal(id=null, returnToWeld=false){
  welderReturnToWeld=!!returnToWeld; editingWelderId=(typeof id==='number')?id:null; document.getElementById('welder-form').reset();
  /* reset cert section */
  document.getElementById('w-cert-section').style.display='none';
  document.getElementById('w-cert-add-btn').style.display='';
  document.getElementById('w-cert-rows').innerHTML='';
  if(editingWelderId!==null){ const p=getPerson(editingWelderId); document.getElementById('modal-welder-title').textContent='Edit welder'; setV('input-w-name',p.name); setV('input-w-no',p.no); }
  else { document.getElementById('modal-welder-title').textContent='New welder'; /* auto-show 1 required cert row */ showWelderCertSection(); }
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
  const html=`<div class="w-cert-row" style="border:1px solid var(--border);border-radius:4px;padding:12px;margin-bottom:10px;background:#F9FAFB;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;">
      <label class="field"><span class="lbl">Certificate number <span class="req">*</span></span><input type="text" id="wc-certno-${_wCertIdx}" placeholder="e.g. Q-PZ-26-0141"></label>
      <div class="field"><span class="lbl">Standard <span class="req">*</span></span><select id="wc-std-${_wCertIdx}" onchange="toggleSelectOther('wc-std-${_wCertIdx}','wc-std-new-${_wCertIdx}')"><option value="">—</option><option value="EN ISO 9606-1">EN ISO 9606-1</option><option value="EN ISO 14732">EN ISO 14732</option><option value="__other__">+ Other (type it)…</option></select><input type="text" id="wc-std-new-${_wCertIdx}" class="select-other-text" style="display:none" placeholder="Type standard…"></div>
      <label class="field"><span class="lbl">Qualified processes <span class="req">*</span></span><input type="text" id="wc-procs-${_wCertIdx}" placeholder="e.g. 141 / 142"></label>
      <label class="field"><span class="lbl">Valid until <span class="req">*</span></span><input type="date" id="wc-valid-${_wCertIdx}"></label>
      <label class="field"><span class="lbl">Renewal due <span class="req">*</span></span><input type="date" id="wc-renewal-${_wCertIdx}"></label>
      <label class="field"><span class="lbl">Certificate PDF (→ SharePoint) <span class="req">*</span></span><input type="file" id="wc-file-${_wCertIdx}" accept="application/pdf"></label>
      <div class="field" style="display:flex;align-items:flex-end;"><button type="button" class="conn-remove" onclick="this.closest('.w-cert-row').remove()" title="Remove">✕</button></div>
    </div>
  </div>`;
  document.getElementById('w-cert-rows').insertAdjacentHTML('beforeend',html);
}
function getWelderCertRows(){
  const rows=document.querySelectorAll('#w-cert-rows .w-cert-row');
  const certs=[];
  let validationError='';
  rows.forEach((row,idx)=>{
    const certNo=(row.querySelector('[id^="wc-certno-"]')||{}).value?.trim()||'';
    const stdSel=row.querySelector('[id^="wc-std-"]');
    const stdNew=row.querySelector('[id^="wc-std-new-"]');
    const std=stdSel&&stdNew?readSelectOther(stdSel.id,stdNew.id):'';
    const procs=(row.querySelector('[id^="wc-procs-"]')||{}).value?.trim()||'';
    const valid=(row.querySelector('[id^="wc-valid-"]')||{}).value||'';
    const renewal=(row.querySelector('[id^="wc-renewal-"]')||{}).value||'';
    const fileInput=row.querySelector('[id^="wc-file-"]');
    const fileName=fileInput&&fileInput.files&&fileInput.files[0]?fileInput.files[0].name:'';
    /* validate all fields are filled */
    if(!certNo) validationError='Certificate number is required.';
    else if(!std) validationError='Standard is required.';
    else if(!procs) validationError='Qualified processes is required.';
    else if(!valid) validationError='Valid until date is required.';
    else if(!renewal) validationError='Renewal due date is required.';
    else if(!fileName) validationError='Certificate PDF is required.';
    if(certNo||std||procs||valid||renewal||fileName) certs.push({certNo,process:procs.split(/\s*\/\s*/)[0]||'',standard:std,procs,validUntil:valid,renewalDue:renewal,fileName});
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
  document.getElementById('input-weld-materials').innerHTML = mats.length? mats.map(m=>`<label class="check-item"><input type="checkbox" value="${m.id}" ${selectedIds.includes(m.id)?'checked':''}> ${posLetter(m.position)} · ${escapeHtml(m.piece)} · ${escapeHtml(m.itemDescription)}</label>`).join('') : '<div class="muted" style="padding:6px 0;">No materials yet — add one first.</div>';
}
function openWeldModal(id=null){
  editingWeldId=id; document.getElementById('weld-form').reset();
  const sel=id!==null?getWeld(id):null;
  buildWeldMaterialChecklist(sel?sel.materialIds:[]);
  if(sel){ document.getElementById('modal-weld-title').textContent='Edit weld';
    setV('input-weld-no',sel.weldNo); setV('input-weld-date',sel.date||TODAY_ISO); setV('input-weld-type',sel.type); setV('input-weld-visual',sel.visual||'OK'); setV('input-weld-endoscopy',sel.endoscopy||'n/a'); setV('input-weld-remarks',sel.remarks||'');
    setV('input-weld-proc',sel.procedure||'');
  } else { document.getElementById('modal-weld-title').textContent='New weld'; setV('input-weld-date',TODAY_ISO); setV('input-weld-type',''); setV('input-weld-proc',''); }
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
function matSource(){
  /* combine ITEM_CATALOG with unique entries from DB.materials */
  const fromDb=DB.materials.map(m=>({piece:m.piece,description:m.itemDescription,code:m.materialCode,dimension:m.dimension,dimension2:m.dimension2||'',dimension3:m.dimension3||'',dien:m.dienNo||'',diameter:m.diameter||'',thickness:m.thickness||''}));
  const combined=[...ITEM_CATALOG,...fromDb];
  /* deduplicate: same piece+description+code+dimension+dimension2+dien+diameter+thickness = same entry */
  const seen=new Set(); const unique=[];
  combined.forEach(i=>{ const key=[i.piece,i.description,i.code,i.dimension,i.dimension2||'',i.dimension3||'',i.dien,i.diameter,i.thickness].join('|||');
    if(!seen.has(key)){ seen.add(key); unique.push(i); } });
  return unique;
}
function matCatalogFiltered(){
  let items=matSource();
  const piece=readSelectOther('input-mat-piece','input-mat-piece-new');
  if(piece) items=items.filter(i=>i.piece===piece);
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
  const filtered=piece?matSource().filter(i=>i.piece===piece):matSource();
  const descs=[...new Set(filtered.map(i=>i.description))];
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
  const desc=document.getElementById('input-mat-desc').value;
  if(desc && desc!=='__other__'){
    const hit=matSource().find(i=>i.description===desc);
    if(hit){
      buildSelectSimple('input-mat-piece',PIECE_OPTIONS,hit.piece);
      toggleDnFields(hit.piece);
      toggleDiameterThicknessFields(hit.piece);
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
  return `<div class="conn-row"><select><option value="">Select material…</option>${opts}</select><button type="button" class="conn-remove" onclick="this.parentElement.remove(); updateConnHint();">✕</button></div>`;
}
function addConnRow(selectedId){ document.getElementById('conn-rows').insertAdjacentHTML('beforeend', connRowHtml(selectedId||0)); updateConnHint(); }
function renderConnRows(preset){
  const wrap=document.getElementById('conn-rows'); wrap.innerHTML='';
  const list = preset || [];
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
  if(editingMaterialId!==null){ const m=getMaterial(editingMaterialId); document.getElementById('modal-material-title').textContent='Edit material';
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
    setV('input-mat-surface',m.surface||'');
    document.getElementById('input-mat-start').checked=!!m.startOfPlumbing; document.getElementById('input-mat-end').checked=!!m.endOfPlumbing;
    renderConnRows(m.connections||[]);
  } else { document.getElementById('modal-material-title').textContent='New material'; setV('input-mat-position', posLetter(pipelineMaterials(PAGE.pipelineId).length+1));
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

/* ================================================================ RENEW ================================================================ */
function openRenewModal(certId){
  renewingCertId=certId; const c=DB.certificates.find(x=>x.id===certId), p=getPerson(c.personId);
  document.getElementById('renew-text').innerHTML=`Renew certificate <strong>${escapeHtml(c.certNo)}</strong> for ${escapeHtml(p.name)} (process ${escapeHtml(c.process)}, ${escapeHtml(c.standard)}).`;
  setV('renew-certno',c.certNo); setV('renew-valid',c.validUntil||''); setV('renew-renewal',c.renewalDue||''); document.getElementById('renew-file').value='';
  openModal('modal-renew');
}
function confirmRenew(){
  const oldCert=DB.certificates.find(x=>x.id===renewingCertId);
  if(!oldCert) return;
  const cn=val('renew-certno');
  const vu=val('renew-valid');
  const rd=val('renew-renewal');
  const f=document.getElementById('renew-file').files[0];
  /* Validate all fields */
  if(!cn){ alert('Certificate number is required.'); return; }
  if(!vu){ alert('Valid until date is required.'); return; }
  if(!rd){ alert('Renewal due date is required.'); return; }
  if(!f){ alert('Renewal attachment PDF is required.'); return; }
  /* Archive the old certificate */
  oldCert.archived=true;
  /* Create new certificate with updated values */
  const pdfUrl=`https://istinox.sharepoint.com/…/certs/${f.name}`;
  DB.certificates.push({ id:nextId('cert'), personId:oldCert.personId, certNo:cn, process:oldCert.process, standard:oldCert.standard, validUntil:vu, renewalDue:rd, pdfUrl });
  saveDB(); closeModal('modal-renew'); rerenderPage();
}

/* ================================================================ ARCHIVE (soft delete) ================================================================ */
function openArchiveModal(type,id){
  deleteContext={type,id}; let label,noun,warn='';
  if(type==='client'){ const c=getClient(id); label=c.name; noun='client'; const n=clientProjects(id).length; if(n) warn=` This client has ${n} project${n!==1?'s':''}.`; }
  else if(type==='project'){ const p=getProject(id); label=p.title; noun='project'; const n=projectPipelines(id).length; if(n) warn=` This project has ${n} pipeline${n!==1?'s':''}.`; }
  else if(type==='welder'){ const p=getPerson(id); label=p.name; noun='welder'; }
  else if(type==='pipeline'){ label=getPipeline(id).no; noun='pipeline'; }
  else if(type==='weld'){ label=getWeld(id).weldNo; noun='weld'; }
  else if(type==='material'){ const m=getMaterial(id); label=`${posLetter(m.position)} · ${m.piece}`; noun='material'; }
  document.getElementById('modal-archive-title').textContent=`Archive ${noun}?`;
  document.getElementById('archive-confirm-text').textContent=`Archive "${label}"? It will be hidden from the lists.${warn}`;
  document.getElementById('archive-confirm-btn').textContent=`Archive ${noun}`;
  openModal('modal-archive'); document.getElementById('archive-cancel-btn').focus();
}
/* keep the old name as an alias so existing call sites keep working */
function openDeleteModal(type,id){ openArchiveModal(type,id); }
async function confirmArchive(){
  const {type,id}=deleteContext;
  const map={client:'clients',project:'projects',pipeline:'pipelines',welder:'people',weld:'welds',material:'materials'};
  const apiMap={client:'/clients',project:'/projects',pipeline:'/pipelines',weld:'/welds',material:'/materials'};
  const rec = DB[map[type]].find(x=>x.id===id); if(rec) rec.archived=true;
  if(apiMap[type]){ try { await apiPost(apiMap[type], {id, archived:true}); } catch(e){ console.error('Archive API error:', e); } }

  if(type==='material'){
    const m=rec;
    const pipeId=m.pipelineId;
    /* Remove all connections from other materials pointing to this one */
    (m.connections||[]).forEach(cid=>{
      const c=getMaterial(cid);
      if(c) c.connections=(c.connections||[]).filter(x=>x!==m.id);
    });
    /* Archive all welds involving this material */
    DB.welds.filter(w=>w.pipelineId===pipeId && w.materialIds.includes(m.id)).forEach(w=>{ w.archived=true; });
    /* Reconnect neighbors if they were both connected to this material */
    const conns=(m.connections||[]);
    if(conns.length===2){
      const [a,b]=conns;
      const mA=getMaterial(a), mB=getMaterial(b);
      if(mA && mB && !(mA.connections||[]).includes(b)){
        mA.connections=mA.connections||[]; mA.connections.push(b);
        mB.connections=mB.connections||[]; mB.connections.push(a);
        ensureWeldForPair(pipeId,a,b);
      }
    }
    m.connections=[];
    /* Reorder positions */
    reorderMaterialPositions(pipeId);
    renumberWelds(pipeId);
  }

  if(type==='weld'){
    const w=rec;
    const pipeId=w.pipelineId;
    /* Remove connections between the materials this weld joined */
    if(w.materialIds&&w.materialIds.length===2){
      const [aId,bId]=w.materialIds;
      const a=getMaterial(aId), b=getMaterial(bId);
      if(a) a.connections=(a.connections||[]).filter(x=>x!==bId);
      if(b) b.connections=(b.connections||[]).filter(x=>x!==aId);
    }
    renumberWelds(pipeId);
  }

  saveDB(); closeModal('modal-archive');
  if(type==='welder') { location.href='welders.html'; return; }
  rerenderPage();
}
function confirmDelete(){ confirmArchive(); }

/* ---- welding-details update step (status 3 → 4) ---- */
let weldingUpdateId=null;
function openWeldingUpdate(id){
  weldingUpdateId=id;
  ['input-wd-start','input-wd-end','input-wd-remarks'].forEach(f=>{ const el=document.getElementById(f); if(el) el.value=''; });
  openModal('modal-welding');
}
function confirmWeldingUpdate(){
  const pl=getPipeline(weldingUpdateId);
  pl.welding={ start:val('input-wd-start'), end:val('input-wd-end'), remarks:val('input-wd-remarks') };
  setPipelineStatus(weldingUpdateId,4);
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
async function initClientsPage(){ PAGE.name='clients'; initDB(); renderChrome('clients','Clients'); mountModals(); wireModalDismiss();
  try { DB.clients = await apiGet('/clients'); } catch(e){ console.error('API error:', e); }
  buildClientFilter(); renderClientsPage();
}
function buildClientFilter(){
  const sel=document.getElementById('client-filter-select');
  sel.innerHTML='<option value="">All clients</option>'+clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  sel.value=clientFilterId;
}
function onClientFilterChange(){ clientFilterId=document.getElementById('client-filter-select').value; renderClientsPage(); }
function clearClientFilter(){ clientFilterId=''; buildClientFilter(); renderClientsPage(); }
function renderClientsPage(){
  const activePipes=pipelines().filter(p=>p.status<3).length, donePipes=pipelines().filter(p=>p.status===3).length;
  document.getElementById('clients-stats').innerHTML=tile(clients().length,'Clients','')+tile(projects().length,'Projects','t-copper')+tile(pipelines().length,'Pipelines','t-neutral')+tile(activePipes,'Active pipelines','t-copper')+tile(donePipes,'Completed pipelines','t-success');
  const tbody=document.getElementById('clients-tbody');
  const filtered=clientFilterId?clients().filter(c=>c.id===Number(clientFilterId)):clients();
  tbody.innerHTML = filtered.length? filtered.map(c=>`<tr class="clickable-row" onclick="rowToClientDetail(event,${c.id})">
    <td class="col-name">${escapeHtml(c.name)}</td>
    <td class="col-address">${escapeHtml(c.name)}<br>${escapeHtml(c.street)}<br>${escapeHtml(c.zipCode)} ${escapeHtml(c.location)}</td>
    <td class="col-remarks">${escapeHtml(c.remarks)||'<span class="muted">—</span>'}</td>
    <td class="col-actions"><a class="btn-link" href="client-detail.html?id=${c.id}">View projects</a><button class="btn-link" onclick="openClientModal(${c.id})">Edit</button>${archiveBtn('client',c.id)}</td>
  </tr>`).join('') : `<tr class="empty-row"><td colspan="4">${clients().length===0?'No clients yet.':'No clients match your filter.'}</td></tr>`;
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
    const [aC, aCA, aP, aPA, aPl, aPlA, aM, aMA, aW, aWA] = await Promise.all([
      apiGet('/clients'), apiGet('/clients?archived=true'),
      apiGet('/projects'), apiGet('/projects?archived=true'),
      apiGet('/pipelines'), apiGet('/pipelines?archived=true'),
      apiGet('/materials'), apiGet('/materials?archived=true'),
      apiGet('/welds'), apiGet('/welds?archived=true')
    ]);
    DB.clients=[...aC,...aCA]; DB.projects=normalizeProjects([...aP,...aPA]); DB.pipelines=[...aPl,...aPlA]; DB.materials=normalizeMaterials([...aM,...aMA]); DB.welds=normalizeWelds([...aW,...aWA]);
    rebuildRelationships();
  } catch(e){ console.error('API error:', e); }
  renderChrome('clients','Archive');
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
  document.getElementById('archive-stats').innerHTML=tile(aC,'Clients','t-neutral')+tile(aP,'Projects','t-neutral')+tile(aPl,'Pipelines','t-neutral')+tile(aM,'Materials','t-neutral')+tile(aW,'Welds','t-neutral');
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
  el.innerHTML=`<div class="table-card"><table><thead><tr><th>Client name</th><th>Address</th><th>Projects</th><th>Remarks</th><th></th></tr></thead><tbody>${items.length?items.map(c=>{
    const prjs=allProjectsForClient(c.id);
    return `<tr><td class="col-name">${escapeHtml(c.name)}</td><td>${escapeHtml(c.street)}<br>${escapeHtml(c.zipCode)} ${escapeHtml(c.location)}</td><td>${prjs.length} project${prjs.length!==1?'s':''}</td><td class="col-remarks">${escapeHtml(c.remarks)||'<span class="muted">\u2014</span>'}</td><td class="col-actions"><button class="btn-link" onclick="viewArchivedClient(${c.id})">View</button><button class="btn-restore" onclick="restoreClient(${c.id})">${RESTORE_ICON} Restore</button></td></tr>`;
  }).join(''):'<tr class="empty-row"><td colspan="5">No archived clients.</td></tr>'}</tbody></table></div>`;
}
function renderArchiveProjects(el){
  const items=archivedProjects();
  el.innerHTML=`<div class="table-card"><table class="table-wide"><thead><tr><th>IST No.</th><th>Project title</th><th>Client</th><th>Location</th><th>Status</th><th></th></tr></thead><tbody>${items.length?items.map(p=>{
    const cli=getClient(p.clientId);
    return `<tr><td class="col-mono">${escapeHtml(p.istProjectNo)||'<span class="muted">\u2014</span>'}</td><td class="col-name">${escapeHtml(p.title)}</td><td>${cli?escapeHtml(cli.name):'\u2014'}</td><td>${escapeHtml(p.location)||'\u2014'}</td><td><span class="status-badge status-${p.status}" style="cursor:default;">${STATUS_LABELS[p.status]||p.status}</span></td><td class="col-actions"><button class="btn-restore" onclick="restoreProject(${p.id})">${RESTORE_ICON} Restore</button></td></tr>`;
  }).join(''):'<tr class="empty-row"><td colspan="6">No archived projects.</td></tr>'}</tbody></table></div>`;
}
function renderArchiveMaterials(el){
  const items=archivedMaterials();
  el.innerHTML=`<div class="table-card"><table class="table-wide"><thead><tr><th>Category</th><th>Item description</th><th>DN</th><th>Material</th><th>Pipeline</th><th></th></tr></thead><tbody>${items.length?items.map(m=>{
    const pl=getPipeline(m.pipelineId);
    let dnDisplay=escapeHtml(m.dimension);
    for(let i=2;i<=6;i++){ if(m[`dimension${i}`]) dnDisplay+=' / '+escapeHtml(m[`dimension${i}`]); }
    return `<tr><td>${escapeHtml(m.piece)}</td><td>${escapeHtml(m.itemDescription)}</td><td class="col-mono">${dnDisplay}</td><td class="col-mono">${escapeHtml(m.materialCode)}</td><td>${pl?escapeHtml(pl.no):'\u2014'}</td><td class="col-actions"><button class="btn-restore" onclick="restoreMaterial(${m.id})">${RESTORE_ICON} Restore</button></td></tr>`;
  }).join(''):'<tr class="empty-row"><td colspan="6">No archived materials.</td></tr>'}</tbody></table></div>`;
}
function renderArchivePipelines(el){
  const items=archivedPipelines();
  el.innerHTML=`<div class="table-card"><table class="table-wide"><thead><tr><th>Pipeline No.</th><th>Project</th><th>Client</th><th>Plant</th><th>Status</th><th></th></tr></thead><tbody>${items.length?items.map(pl=>{
    const pr=getProject(pl.projectId);
    const cli=pr?getClient(pr.clientId):null;
    return `<tr><td class="col-mono">${escapeHtml(pl.no)}</td><td>${pr?escapeHtml(pr.title):'\u2014'}</td><td>${cli?escapeHtml(cli.name):'\u2014'}</td><td class="col-mono">${escapeHtml(pl.plant)||'\u2014'}</td><td>${statusPill(pl.status)}</td><td class="col-actions"><button class="btn-restore" onclick="restorePipeline(${pl.id})">${RESTORE_ICON} Restore</button></td></tr>`;
  }).join(''):'<tr class="empty-row"><td colspan="6">No archived pipelines.</td></tr>'}</tbody></table></div>`;
}
function renderArchiveWelds(el){
  const items=archivedWelds();
  el.innerHTML=`<div class="table-card"><table class="table-wide"><thead><tr><th>Weld No.</th><th>Between</th><th>Procedure</th><th>Pipeline</th><th>Date</th><th></th></tr></thead><tbody>${items.length?items.map(w=>{
    const pl=getPipeline(w.pipelineId);
    const between=w.materialIds.map(id=>{const m=getMaterial(id); return m?m.piece+' ('+posLetter(m.position)+')':'?';}).join(' \u2194 ');
    return `<tr><td class="col-mono">${escapeHtml(w.weldNo)}</td><td>${escapeHtml(between)}</td><td class="col-mono">${escapeHtml(w.procedure)||'\u2014'}</td><td>${pl?escapeHtml(pl.no):'\u2014'}</td><td class="col-mono">${w.date?formatDate(w.date):'\u2014'}</td><td class="col-actions"><button class="btn-restore" onclick="restoreWeld(${w.id})">${RESTORE_ICON} Restore</button></td></tr>`;
  }).join(''):'<tr class="empty-row"><td colspan="6">No archived welds.</td></tr>'}</tbody></table></div>`;
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
      <button class="btn-restore" onclick="restoreClient(${c.id})">${RESTORE_ICON} Restore client</button>
    </div>
    ${c.remarks?`<div class="archive-detail-remarks">${escapeHtml(c.remarks)}</div>`:''}
    <div class="detail-toolbar"><h2>Projects (${prjs.length})</h2></div>
    <div class="table-card"><table class="table-wide"><thead><tr><th>IST Project&nbsp;No.</th><th>Project title</th><th>Location</th><th>Status</th><th></th></tr></thead><tbody>${prjs.length? prjs.map(p=>`<tr>
        <td class="col-mono">${escapeHtml(p.istProjectNo)||'<span class="muted">\u2014</span>'}</td>
        <td class="col-name">${escapeHtml(p.title)}</td>
        <td>${escapeHtml(p.location)||'<span class="muted">\u2014</span>'}</td>
        <td><span class="status-badge status-${p.status}" style="cursor:default;">${STATUS_LABELS[p.status]||p.status}</span></td>
        <td class="col-actions">${p.archived?`<button class="btn-restore" onclick="restoreProject(${p.id})" style="font-size:0.75rem;padding:3px 10px;">Restore</button>`:''}</td>
      </tr>`).join(''):'<tr class="empty-row"><td colspan="5">No projects.</td></tr>'}</tbody></table></div>
  </div>`;
  container.scrollIntoView({behavior:'smooth',block:'start'});
}
async function restoreClient(id){
  const c=DB.clients.find(x=>x.id===id); if(c) c.archived=false;
  DB.projects.filter(p=>p.clientId===id&&p.archived).forEach(p=>p.archived=false);
  try { await apiPost('/clients', {id, archived:false}); } catch(e){ console.error('Restore API error:', e); }
  saveDB(); renderArchivePage();
}
async function restoreProject(id){
  const p=DB.projects.find(x=>x.id===id); if(p) p.archived=false;
  try { await apiPost('/projects', {id, archived:false}); } catch(e){ console.error('Restore API error:', e); }
  saveDB(); renderArchivePage();
}
async function restoreMaterial(id){
  const m=DB.materials.find(x=>x.id===id); if(m) m.archived=false;
  try { await apiPost('/materials', {id, archived:false}); } catch(e){ console.error('Restore API error:', e); }
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
  try {
    const [apiC, apiP] = await Promise.all([apiGet('/clients'), apiGet('/projects')]);
    DB.clients=apiC; DB.projects=normalizeProjects(apiP);
  } catch(e){ console.error('API error:', e); }
  const id=Number(qp('id')); const cli=getClient(id);
  if(!cli){ renderChrome('clients','Clients'); return; }
  PAGE.clientId=id;
  projectFilters.clientId=String(id);
  renderChrome('clients',`<a href="index.html">Clients</a> / ${escapeHtml(cli.name)}`); mountModals(); wireModalDismiss();
  renderClientDetail();
}
function switchClient(id){ if(id&&Number(id)!==PAGE.clientId) location.href='client-detail.html?id='+id; }
function renderClientDetail(){
  const cli=getClient(PAGE.clientId); if(!cli) return;
  document.getElementById('client-context').innerHTML=`<a href="index.html">Clients</a><span class="sep">›</span><span>${escapeHtml(cli.name)}</span>`;
  document.getElementById('client-switch').innerHTML=clients().map(c=>`<option value="${c.id}" ${c.id===cli.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('');
  document.getElementById('client-subtitle').textContent='';
  const item=(k,v,mono)=>`<div class="info-item"><div class="k">${k}</div><div class="v ${mono?'mono':''}">${v}</div></div>`;
  document.getElementById('client-info').innerHTML=item('Company',escapeHtml(cli.name))+item('Address',`${escapeHtml(cli.street)}<br>${escapeHtml(cli.zipCode)} ${escapeHtml(cli.location)}`)+item('Remarks',escapeHtml(cli.remarks)||'—');
  const prjs=clientProjects(cli.id);
  const by=s=>prjs.filter(p=>p.status===s).length;
  document.getElementById('client-detail-stats').innerHTML=tile(prjs.length,'Projects','')+tile(by('not-started'),'Not started','t-neutral')+tile(by('ongoing'),'Ongoing','t-copper')+tile(by('completed'),'Completed','t-success');
  document.getElementById('client-edit-btn').onclick=()=>openClientModal(cli.id);
  const tbody=document.getElementById('client-projects-tbody');
  tbody.innerHTML=prjs.length? prjs.map(p=>`<tr>
    <td class="col-mono">${escapeHtml(p.istProjectNo)||'<span class="muted">—</span>'}</td>
    <td class="col-name"><a class="cell-link" href="project-detail.html?id=${p.id}">${escapeHtml(p.title)}</a></td>
    <td>${escapeHtml(p.location)||'<span class="muted">—</span>'}</td>
    <td class="col-mono">${escapeHtml(p.order)||'<span class="muted">—</span>'}</td>
    <td class="col-remarks">${escapeHtml(p.description)||'<span class="muted">—</span>'}</td>
    <td><button class="status-badge status-${p.status}" onclick="cycleProjectStatus(${p.id})" title="Click to change status">${STATUS_LABELS[p.status]}</button></td>
    <td class="col-actions"><a class="btn-link" href="project-detail.html?id=${p.id}">Open</a><button class="btn-link" onclick="openProjectModal(${p.id})">Edit</button>${archiveBtn('project',p.id)}</td>
  </tr>`).join('') : '<tr class="empty-row"><td colspan="7">No projects for this client yet.</td></tr>';
}

/* ================================================================ PROJECTS PAGE ================================================================ */
let projectFilters={location:'',clientId:'',status:''};
async function initProjectsPage(){
  PAGE.name='projects'; initDB();
  try {
    const [apiC, apiP] = await Promise.all([apiGet('/clients'), apiGet('/projects')]);
    DB.clients=apiC; DB.projects=normalizeProjects(apiP);
  } catch(e){ console.error('API error:', e); }
  const clientParam=qp('client');
  let crumb='Projects';
  if(clientParam){ const c=getClient(Number(clientParam)); if(c){ projectFilters.clientId=clientParam; setSharedClientFilter(clientParam); crumb=`<a href="index.html">Clients</a> / ${escapeHtml(c.name)} / Projects`; } }
  else { const saved=getSharedClientFilter(); if(saved) projectFilters.clientId=saved; }
  renderChrome('projects',crumb); mountModals(); wireModalDismiss();
  buildProjectFilters(); renderProjectsPage();
}
function buildProjectFilters(){
  const locSel=document.getElementById('filter-location'), cliSel=document.getElementById('filter-client'), stSel=document.getElementById('filter-status');
  locSel.innerHTML='<option value="">All locations</option>'+uniqueLocations().map(l=>`<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
  cliSel.innerHTML='<option value="">All clients</option>'+clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  locSel.value=projectFilters.location; cliSel.value=projectFilters.clientId; stSel.value=projectFilters.status;
}
function onProjectFilterChange(){ projectFilters.location=document.getElementById('filter-location').value; projectFilters.clientId=document.getElementById('filter-client').value; projectFilters.status=document.getElementById('filter-status').value; setSharedClientFilter(projectFilters.clientId); setSharedProjectFilter(''); renderProjectsPage(); }
function clearProjectFilters(){ projectFilters={location:'',clientId:'',status:''}; setSharedClientFilter(''); setSharedProjectFilter(''); buildProjectFilters(); renderProjectsPage(); }
function renderProjectsPage(){
  const by=s=>projects().filter(p=>p.status===s).length;
  document.getElementById('projects-stats').innerHTML=tile(projects().length,'Total projects','')+tile(by('not-started'),'Not started','t-neutral')+tile(by('ongoing'),'Ongoing','t-copper')+tile(by('completed'),'Completed','t-success');
  const tbody=document.getElementById('projects-tbody');
  const filtered=projects().filter(p=>{ if(projectFilters.location&&p.location!==projectFilters.location) return false; if(projectFilters.clientId&&p.clientId!==Number(projectFilters.clientId)) return false; if(projectFilters.status&&p.status!==projectFilters.status) return false; return true; });
  tbody.innerHTML=filtered.length? filtered.map(p=>`<tr>
    <td class="col-mono">${escapeHtml(p.istProjectNo)||'<span class="muted">—</span>'}</td>
    <td class="col-name"><a class="cell-link" href="project-detail.html?id=${p.id}">${escapeHtml(p.title)}</a></td>
    <td>${escapeHtml(p.location)||'<span class="muted">—</span>'}</td>
    <td><a class="cell-link" href="projects.html?client=${p.clientId}">${escapeHtml(getClientName(p.clientId))}</a></td>
    <td class="col-mono">${escapeHtml(p.order)||'<span class="muted">—</span>'}</td>
    <td class="col-remarks">${escapeHtml(p.description)||'<span class="muted">—</span>'}</td>
    <td><button class="status-badge status-${p.status}" onclick="cycleProjectStatus(${p.id})" title="Click to change status">${STATUS_LABELS[p.status]}</button></td>
    <td class="col-actions"><a class="btn-link" href="project-detail.html?id=${p.id}">Open</a><button class="btn-link" onclick="openProjectModal(${p.id})">Edit</button>${archiveBtn('project',p.id)}</td>
  </tr>`).join('') : `<tr class="empty-row"><td colspan="7">${projects().length===0?'No projects yet.':'No projects match your filters.'}</td></tr>`;
}
async function cycleProjectStatus(id){ const p=getProject(id); p.status=STATUS_SEQUENCE[(STATUS_SEQUENCE.indexOf(p.status)+1)%STATUS_SEQUENCE.length]; try { await apiPost('/projects', {id, status:p.status}); } catch(e){ console.error('Status update failed:', e); } saveDB(); renderProjectsPage(); }

/* ================================================================ PIPELINES PAGE ================================================================ */
let pipeFilter=null;
let pipeFilters={clientId:'',projectId:'',welderId:'',inspectorId:'',status:'',procedure:'',plant:'',search:''};
async function initPipelinesPage(){
  PAGE.name='pipelines'; initDB();
  try {
    const [apiC, apiP, apiPl] = await Promise.all([apiGet('/clients'), apiGet('/projects'), apiGet('/pipelines')]);
    DB.clients=apiC; DB.projects=normalizeProjects(apiP); DB.pipelines=apiPl;
  } catch(e){ console.error('API error:', e); }
  const projectParam=qp('project'), clientParam=qp('client');
  let crumb='Pipelines';
  if(projectParam){ const p=getProject(Number(projectParam)); if(p){ pipeFilters.projectId=projectParam; pipeFilters.clientId=String(p.clientId); setSharedProjectFilter(projectParam); setSharedClientFilter(String(p.clientId)); crumb=`<a href="projects.html">Projects</a> / ${escapeHtml(p.title)} / Pipelines`; } }
  else if(clientParam){ const c=getClient(Number(clientParam)); if(c){ pipeFilters.clientId=clientParam; setSharedClientFilter(clientParam); setSharedProjectFilter(''); crumb=`<a href="index.html">Clients</a> / ${escapeHtml(c.name)} / Pipelines`; } }
  else {
    const savedProject=getSharedProjectFilter();
    const savedClient=getSharedClientFilter();
    if(savedProject){ pipeFilters.projectId=savedProject; const p=getProject(Number(savedProject)); if(p) pipeFilters.clientId=String(p.clientId); }
    else if(savedClient){ pipeFilters.clientId=savedClient; }
  }
  pipeFilter=null;
  renderChrome('pipelines',crumb); mountModals(); wireModalDismiss(); buildPipeFilters(); renderPipelinesPage();
}
function buildPipeFilters(){
  const cli=document.getElementById('pf-client'); if(!cli) return;
  cli.innerHTML='<option value="">All clients</option>'+clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  const prjSel=document.getElementById('pf-project');
  if(prjSel){
    const prjList=pipeFilters.clientId?projects().filter(p=>p.clientId===Number(pipeFilters.clientId)):projects();
    prjSel.innerHTML='<option value="">All projects</option>'+prjList.map(p=>`<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');
    prjSel.value=pipeFilters.projectId;
  }
  document.getElementById('pf-status').innerHTML='<option value="">All statuses</option>'+PIPE_STATUS.map((s,i)=>`<option value="${i}">${escapeHtml(s)}</option>`).join('');
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
    prjSel.innerHTML='<option value="">All projects</option>'+prjList.map(p=>`<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');
  } else if(prjSel){ pipeFilters.projectId=prjSel.value; }
  setSharedClientFilter(pipeFilters.clientId);
  setSharedProjectFilter(pipeFilters.projectId);
  pipeFilter=null;
  renderPipelinesPage();
}
function onPipeSearchInput(v){ pipeFilters.search=v; renderPipelinesPage(); }
function clearPipeFilters(){ pipeFilters={clientId:'',projectId:'',welderId:'',inspectorId:'',status:'',procedure:'',plant:'',search:''}; pipeFilter=null; setSharedClientFilter(''); setSharedProjectFilter(''); buildPipeFilters(); renderPipelinesPage(); }
function renderPipelinesPage(){
  const by=s=>pipelines().filter(p=>p.status===s).length;
  const expiring=certificates().filter(c=>certStatus(c)==='expiring').length;
  document.getElementById('pipelines-stats').innerHTML=tile(pipelines().length,'Total pipelines','')+tile(by(0),'Not started','t-neutral')+tile(by(1)+by(2),'In progress','t-copper')+tile(by(3),'Completed','t-success')+tile(expiring,'Certs expiring ≤30d','t-danger');
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
      <td class="col-actions"><a class="btn-link" href="pipeline-detail.html?id=${pl.id}">Details</a><button class="btn-link" onclick="openPipelineModal(${pl.id})">Edit</button>${archiveBtn('pipeline',pl.id)}</td>
    </tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="7">${pipelines().length===0?'No pipelines yet.':'No pipelines match this filter.'}</td></tr>`;
}
function rowToDetail(event,id){ if(event.target.closest('a,button,.cell-link,.person-name,.plus-badge,.doc-chip,.pipe-no')) return; location.href='pipeline-detail.html?id='+id; }
function rowToClientDetail(event,id){ if(event.target.closest('a,button,.cell-link,.btn-link,.btn-archive')) return; location.href='client-detail.html?id='+id; }
function showPipelinePeople(plId,kind){ const pl=getPipeline(plId); const ids=kind==='welder'?pl.welderIds:pl.inspectorIds; renderPeoplePopup((kind==='welder'?'Welders on ':'Inspectors on ')+pl.no, ids, pl.status); }
function showWeldPeople(weldId,kind){ const w=getWeld(weldId); const pl=getPipeline(w.pipelineId); const ids=kind==='welder'?w.welderIds:w.inspectorIds; renderPeoplePopup((kind==='welder'?'Welders on ':'Inspectors on ')+w.weldNo, ids, pl.status); }

/* ================================================================ PIPELINE DETAIL PAGE ================================================================ */
let detailView='materials';
async function initPipelineDetailPage(){
  PAGE.name='pipeline-detail'; initDB();
  PAGE.pipelineId=Number(qp('id'));
  try {
    /* Fetch this pipeline first, then load only related data */
    const pl0 = await apiGet('/pipelines/'+PAGE.pipelineId);
    const projId = pl0.projectId;
    const [apiPr, apiPl, apiM, apiW] = await Promise.all([apiGet('/projects/'+projId), apiGet('/pipelines?projectId='+projId), apiGet('/materials?pipelineId='+PAGE.pipelineId), apiGet('/welds?pipelineId='+PAGE.pipelineId)]);
    const apiCl = await apiGet('/clients/'+apiPr.clientId);
    DB.clients=[apiCl]; DB.projects=normalizeProjects([apiPr]); DB.pipelines=apiPl; DB.materials=normalizeMaterials(apiM); DB.welds=normalizeWelds(apiW);
    rebuildRelationships();
  } catch(e){ console.error('API error:', e); }
  const tab=qp('tab'); if(tab==='weldlist'||tab==='materials') detailView=tab; else detailView='materials';
  const pl=getPipeline(PAGE.pipelineId);
  if(!pl){ renderChrome('pipelines','Pipelines'); return; }
  const pr=getProject(pl.projectId);
  PAGE.projectId=pl.projectId;
  if(pr) PAGE.clientId=pr.clientId;
  renumberWelds(PAGE.pipelineId); saveDB();
  renderChrome('pipelines',`<a href="pipelines.html">Pipelines</a> / ${escapeHtml(pl.no)}`); mountModals(); wireModalDismiss();
  renderPipelineDetail();
  const seam=qp('seam'); if(seam){ const w=getWeld(Number(seam)); if(w&&w.pipelineId===PAGE.pipelineId) showSeamDetail(w.id); }
}
function switchPipeline(id){ if(id&&Number(id)!==PAGE.pipelineId) location.href='pipeline-detail.html?id='+id; }
function renderPipelineDetail(){
  const pl=getPipeline(PAGE.pipelineId); if(!pl) return;
  const pr=getProject(pl.projectId), cli=pr?getClient(pr.clientId):null;
  document.getElementById('detail-context').innerHTML=`${cli?`<a href="projects.html?client=${cli.id}">${escapeHtml(cli.name)}</a>`:''}<span class="sep">›</span>${pr?`<a href="project-detail.html?id=${pr.id}">${escapeHtml(pr.title)}</a>`:''}<span class="sep">›</span><span>${escapeHtml(pl.no)}</span>`;
  // pipeline switcher: sibling pipelines within the same project
  const siblings=pr?projectPipelines(pr.id):[pl];
  document.getElementById('pipeline-switch').innerHTML=siblings.map(s=>`<option value="${s.id}" ${s.id===pl.id?'selected':''}>${escapeHtml(s.no)}</option>`).join('');
  document.getElementById('detail-subtitle').textContent=`${pr?pr.title:'—'}${pr&&pr.order?' · Order '+pr.order:''}${siblings.length>1?` · ${siblings.length} pipelines in this project`:''}`;
  const item=(k,v,mono)=>`<div class="info-item"><div class="k">${k}</div><div class="v ${mono?'mono':''}">${v}</div></div>`;
  let infoHtml=item('Client',cli?escapeHtml(cli.name):'—')+item('Order number',pr&&pr.order?escapeHtml(pr.order):'—',true)+item('Plant',escapeHtml(pl.plant)||'—',true)+item('Status',statusPill(pl.status));
  if(pl.status>=4 && pl.welding){
    if(pl.welding.start) infoHtml+=item('Welding start',formatDate(pl.welding.start),true);
    if(pl.welding.end) infoHtml+=item('Welding completion',formatDate(pl.welding.end),true);
  }
  document.getElementById('detail-info').innerHTML=infoHtml;
  renderWorkflowBar(pl); renderMaterialsList(); renderWeldList(); renderMarkDoneBars(pl); showDetailView(detailView);
}
function renderWorkflowBar(pl){
  const steps=['Material list','Weld list','Builder doc','Welding details','Export'];
  let html='<div class="workflow-bar">';
  steps.forEach((s,i)=>{ const stage=i+1; const cls=pl.status>=stage?'done':(pl.status===i?'current':''); const mark=pl.status>=stage?'✓':stage;
    html+=`<div class="workflow-step ${cls}"><span class="step-dot">${mark}</span>${s}</div>`;
    if(i<steps.length-1) html+='<span class="workflow-arrow">→</span>'; });
  // contextual next action for pipeline-level stages
  let action='';
  if(pl.status===2) action=`<button class="btn btn-primary btn-sm" onclick="downloadBuilderDoc(${pl.id})">Download builder document</button>`;
  else if(pl.status===3) action=`<button class="btn btn-primary btn-sm" onclick="openWeldingUpdate(${pl.id})">Update welding details</button>`;
  else if(pl.status===4) action=`<button class="btn btn-success btn-sm" onclick="exportFinalDoc(${pl.id})">Export final document</button>`;
  else if(pl.status===5) action=`<span class="done-chip"><svg viewBox="0 0 24 24" fill="none"><path d="m5 13 4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg> Exported · complete</span>`;
  html+=`<span style="flex:1"></span>${action}</div>`;
  document.getElementById('detail-workflow').innerHTML=html;
}
function renderMarkDoneBars(pl){
  const doneChip=t=>`<span class="done-chip"><svg viewBox="0 0 24 24" fill="none"><path d="m5 13 4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg> ${t}</span>`;
  // material list mark-done
  const mm=document.getElementById('materials-markdone');
  if(pl.status===0){
    const mats=pipelineMaterials(pl.id);
    const hasStart=mats.some(m=>m.startOfPlumbing);
    const hasEnd=mats.some(m=>m.endOfPlumbing);
    if(!hasStart || !hasEnd){
      const missing=[!hasStart?'start':'',!hasEnd?'end':''].filter(Boolean).join(' and ');
      mm.innerHTML=`<div class="mark-done-bar"><div class="md-text">Cannot mark as done — missing <strong>${missing} of plumbing</strong>. Assign start/end to a material first.</div><button class="btn btn-success" disabled>Mark material list as done</button></div>`;
    } else {
      mm.innerHTML=`<div class="mark-done-bar"><div class="md-text">Finished building the master parts list? <strong>Mark it as done</strong> to move this pipeline to weld list creation.</div><button class="btn btn-success" onclick="markMaterialDone(${pl.id})">Mark material list as done</button></div>`;
    }
  } else mm.innerHTML=`<div class="mark-done-bar"><div class="md-text">${doneChip('Material list marked as done')}</div></div>`;
  // weld list mark-done (enabled only once material list is done)
  const wm=document.getElementById('weldlist-markdone');
  if(pl.status===0) wm.innerHTML=`<div class="mark-done-bar"><div class="md-text">Complete and mark the <strong>material list</strong> as done first — then you can finalise the weld list.</div><button class="btn btn-success" disabled>Mark weld list as done</button></div>`;
  else if(pl.status===1) wm.innerHTML=`<div class="mark-done-bar"><div class="md-text">All seams recorded? <strong>Mark the weld list as done</strong> to make the builder document available.</div><button class="btn btn-success" onclick="markWeldlistDone(${pl.id})">Mark weld list as done</button></div>`;
  else wm.innerHTML=`<div class="mark-done-bar"><div class="md-text">${doneChip('Weld list marked as done')}</div></div>`;
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
  const conns=(m.connections||[]).length;
  const isFirst=allMats.length<=1;
  if(isFirst) return false;
  const required=requiredWelds(m.piece);
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
  const myPiece=(m.piece||'').toLowerCase();
  if(!SINGLE_DN_PIECES.includes(myPiece)) return false;
  return m.connections.some(cid=>{
    const c=getMaterial(cid); if(!c || !c.dimension) return false;
    const cPiece=(c.piece||'').toLowerCase();
    if(!SINGLE_DN_PIECES.includes(cPiece)) return false;
    return m.dimension!==c.dimension;
  });
}
function renderMaterialsList(){
  const tbody=document.getElementById('materials-tbody'); const allRows=pipelineMaterials(PAGE.pipelineId);
  const isWire=m=>(m.piece||'').toLowerCase()==='welding wire';
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
    const maxWelds=requiredWelds(m.piece);
    const canDrag=maxWelds<3;
    let extraDnCells='';
    for(let i=2;i<=maxDn;i++){
      extraDnCells+=`<td class="col-mono">${m[`dimension${i}`]?escapeHtml(m[`dimension${i}`]):'<span class="muted">—</span>'}</td>`;
    }
    return `<tr${hasErr?' class="row-error"':''} data-mat-id="${m.id}" ${canDrag?'draggable="true" ondragstart="onMatDragStart(event,'+m.id+')"':''} ondragover="onMatDragOver(event)" ondrop="onMatDrop(event,${m.id})">
      <td class="col-mono">${canDrag?'<span class="drag-handle" title="Drag to reorder">⠿</span> ':''}${posLetter(m.position)}${flags?`<span class="person-sub">${flags}</span>`:''}</td>
      <td>${escapeHtml(m.piece)}</td><td class="col-mono${dnWarn?' dn-warn':''}">${escapeHtml(m.dimension)}</td>${extraDnCells}
      <td class="col-mono">${m.diameter?fmtDia(m.diameter):'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml(m.thickness)||'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml(m.dienNo)||'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml(m.surface)||'<span class="muted">—</span>'}</td>
      <td><a class="cell-link" href="material-detail.html?id=${m.id}">${escapeHtml(m.itemDescription)}</a></td>
      <td class="col-mono">${escapeHtml(m.materialCode)}</td><td>${escapeHtml(m.certificate)}</td>
      <td class="col-mono">${escapeHtml(m.heatNo)}</td>
      <td>${m.wazNo?`<button class="doc-chip doc-weld" onclick="showWaz(${m.id})" title="View WAZ PDF">${escapeHtml(m.wazNo)}</button><button class="btn-link btn-edit-inline" onclick="openEditWazModal(${m.id})" title="Edit WAZ">✎</button>`:`<button class="btn btn-primary btn-sm" onclick="openAddWazModal(${m.id})">+</button>`}</td>
      <td><a class="img-btn" href="material-detail.html?id=${m.id}">Welds</a></td>
      <td class="col-actions"><button class="btn-link" onclick="openMaterialModal(${m.id})">Edit</button>${archiveBtn('material',m.id)}</td>
    </tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="${14+(maxDn-1)}">No materials yet. Click "+ Add material" to build the master list.</td></tr>`;
  /* update table header to include DN columns dynamically */
  const thead=tbody.closest('table').querySelector('thead tr');
  if(thead){
    let dnHeader=maxDn>1?'<th>DN 1</th>':'<th>DN</th>';
    for(let i=2;i<=maxDn;i++) dnHeader+=`<th>DN ${i}</th>`;
    thead.innerHTML=`<th>Pos.</th><th>Category</th>${dnHeader}<th>Diameter</th><th>Thickness</th><th>DIN EN No.</th><th>Surface</th><th>Item description</th><th>Material</th><th>Certificate</th><th>Heat&nbsp;No.</th><th>WAZ&nbsp;No.</th><th>Welds</th><th></th>`;
  }
  // Welding Wire table
  const wireSection=document.getElementById('welding-wire-section');
  if(wireSection){
    wireSection.innerHTML=wireRows.length?`<h3 style="margin-top:24px;">Welding Wire</h3><div class="table-card"><table class="table-wide"><thead><tr><th>Pos.</th><th>Item description</th><th>Material</th><th>Diameter</th><th>Surface</th><th>Certificate</th><th>Heat&nbsp;No.</th><th>WAZ&nbsp;No.</th><th></th></tr></thead><tbody>${wireRows.map(m=>`<tr>
      <td class="col-mono">${posLetter(m.position)}</td>
      <td>${escapeHtml(m.itemDescription)}</td>
      <td class="col-mono">${escapeHtml(m.materialCode)}</td>
      <td class="col-mono">${m.diameter?fmtDia(m.diameter):'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml(m.surface)||'<span class="muted">—</span>'}</td>
      <td>${escapeHtml(m.certificate)}</td>
      <td class="col-mono">${escapeHtml(m.heatNo)}</td>
      <td>${m.wazNo?`<button class="doc-chip doc-weld" onclick="showWaz(${m.id})" title="View WAZ PDF">${escapeHtml(m.wazNo)}</button><button class="btn-link btn-edit-inline" onclick="openEditWazModal(${m.id})" title="Edit WAZ">✎</button>`:`<button class="btn btn-primary btn-sm" onclick="openAddWazModal(${m.id})">+</button>`}</td>
      <td class="col-actions"><button class="btn-link" onclick="openMaterialModal(${m.id})">Edit</button>${archiveBtn('material',m.id)}</td>
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
function onMatDrop(e,targetMatId){
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
  /* Sync reorder to backend */
  try {
    const allMats=pipelineMaterials(pipeId);
    const payload={ pipelineId:pipeId, materials:allMats.map(m=>({
      id:m.id, position:posLetter(m.position),
      connections:(m.connections||[]).map(cid=>{ const c=getMaterial(cid); return c?posLetter(c.position):null; }).filter(Boolean),
      startOfPlumbing:!!m.startOfPlumbing, endOfPlumbing:!!m.endOfPlumbing
    }))};
    apiPost('/materials/reorder', payload);
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
    const photo=w.photoUrl?`<button class="img-btn" onclick="showImage('${escapeHtml(w.weldNo)} — weld photo','${escapeHtml(w.photoUrl)}')">View</button>`:'<span class="img-btn empty">—</span>';
    const endo=w.endoscopyUrl?`<button class="img-btn" onclick="showImage('${escapeHtml(w.weldNo)} — endoscopy','${escapeHtml(w.endoscopyUrl)}')">View</button>`:'<span class="img-btn empty">—</span>';
    const rem=w.remarks?`<button class="remarks-btn" onclick="showRemarks(${w.id})">View</button>`:'<span class="remarks-btn none">—</span>';
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
      <td class="col-actions"><button class="btn-link" onclick="showSeamDetail(${w.id})">Seam</button><button class="btn-link" onclick="openWeldModal(${w.id})">Edit</button>${archiveBtn('weld',w.id)}</td>
    </tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="12">No welds yet — add materials with connections (welds are created automatically) or use "+ Add weld".</td></tr>';
}
function showRemarks(weldId){ document.getElementById('remarks-body').textContent=getWeld(weldId).remarks||'—'; openModal('modal-remarks'); }
function weldWireDropdown(w){
  const isWire=m=>(m.piece||'').toLowerCase().includes('welding') || (m.piece||'').toLowerCase().includes('wire');
  const wires=materials().filter(isWire);
  const selected=w.weldingWireId?getMaterial(w.weldingWireId):null;
  const id=`iwd-${w.id}`;
  if(!wires.length){
    return `<div class="ipd-wrap" id="${id}"><button type="button" class="ipd-btn" onclick="toggleIpd('${id}')" style="color:var(--text-muted);">No wire added</button><div class="ipd-panel"><div class="muted" style="padding:8px;">Add a Welding Wire material first.</div></div></div>`;
  }
  const opts=wires.map(wr=>`<label class="ipd-item"><input type="radio" name="${id}" value="${wr.id}" ${w.weldingWireId===wr.id?'checked':''} onchange="updateWeldWire(${w.id},${wr.id},'${id}')">${escapeHtml(wr.itemDescription)} (${escapeHtml(wr.diameter||'')})</label>`).join('');
  const noneOpt=`<label class="ipd-item"><input type="radio" name="${id}" value="" ${!w.weldingWireId?'checked':''} onchange="updateWeldWire(${w.id},null,'${id}')">— None —</label>`;
  if(selected){
    return `<div class="ipd-wrap" id="${id}">${escapeHtml(selected.itemDescription)}<button class="btn-link btn-edit-inline" onclick="event.stopPropagation();toggleIpd('${id}')" title="Change">✎</button><div class="ipd-panel">${noneOpt}${opts}</div></div>`;
  }
  return `<div class="ipd-wrap" id="${id}"><button type="button" class="ipd-btn" onclick="toggleIpd('${id}')">Select…</button><div class="ipd-panel">${noneOpt}${opts}</div></div>`;
}
function updateWeldWire(weldId, wireId, wrapperId){
  const w=getWeld(weldId); if(!w) return;
  w.weldingWireId=wireId;
  saveDB(); renderWeldList();
}

/* ================================================================ COMBINED VIEW ================================================================ */
function renderCombinedView(){
  const container=document.getElementById('combined-content');
  const mats=pipelineMaterials(PAGE.pipelineId);
  const wlds=pipelineWelds(PAGE.pipelineId);
  if(!mats.length){ container.innerHTML='<div class="archive-empty-page">No materials yet.</div>'; return; }
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
  let allRows=[];
  mainLine.forEach(item=>allRows.push(item));
  branchLines.forEach(bl=>{
    if(bl.junctionWeld) allRows.push({type:'weld', data:bl.junctionWeld});
    bl.line.forEach(item=>allRows.push(item));
  });
  const unvisited=mats.filter(m=>!visited.has(m.id)&&(m.piece||'').toLowerCase()!=='welding wire');
  unvisited.forEach(m=>allRows.push({type:'material', data:m}));

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

  let html=`<div class="table-card"><table class="table-xwide"><thead><tr><th>Type</th><th>Pos./Weld</th><th>Item description</th><th>DN</th><th>Ø</th><th>Thk.</th><th>H/O</th><th>Wire</th><th>Welder</th><th>Inspector</th></tr></thead><tbody>`;
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
      html+=`<tr class="cv-mat-row" id="cv-row-${m.id}"><td>Material${badge}</td><td class="col-mono"><strong>${posLetter(m.position)}</strong>${flags?' <span class="cv-table-flag">('+flags+')</span>':''}</td><td>${escapeHtml(m.itemDescription)}</td><td class="col-mono${dnWarn?' dn-warn':''}">${dnDisplay}</td><td class="col-mono">${m.diameter?fmtDia(m.diameter):''}</td><td class="col-mono">${escapeHtml(m.thickness)||''}</td><td></td><td></td><td></td><td></td></tr>`;
    } else if(row.type==='weld'){
      const w=row.data;
      const wire=w.weldingWireId?getMaterial(w.weldingWireId):null;
      const wireLabel=wire?posLetter(wire.position):'—';
      const typeLabel=w.type==='O'?'Orbital':w.type==='H'?'Hand':w.type==='M'?'Manual':'—';
      const welderNames=(w.welderIds||[]).map(id=>{const p=getPerson(id);return p?escapeHtml(p.name):'';}).filter(Boolean).join(', ');
      const inspNames=(w.inspectorIds||[]).map(id=>{const p=getPerson(id);return p?escapeHtml(p.name):'';}).filter(Boolean).join(', ');
      const jBadge=junctionWeldLabel[w.id]?`<span class="cv-branch-badge" style="cursor:default;">→ ${junctionWeldLabel[w.id].fromPos}</span>`:'';
      html+=`<tr class="cv-weld-row" id="cv-weld-${w.id}"><td>Weld${jBadge}</td><td class="col-mono">${escapeHtml(w.weldNo)}</td><td></td><td></td><td></td><td></td><td>${typeLabel}</td><td class="col-mono">${wireLabel}</td><td>${welderNames||'—'}</td><td>${inspNames||'—'}</td></tr>`;
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
function inlinePersonDropdown(weldId, role, selectedIds){
  const ppl=people();
  const id=`ipd-${weldId}-${role}`;
  const checks=ppl.map(p=>`<label class="ipd-item"><input type="checkbox" value="${p.id}" ${selectedIds.includes(p.id)?'checked':''} onchange="onInlinePersonChange(${weldId},'${role}','${id}')">${escapeHtml(p.name)}</label>`).join('');
  return `<div class="ipd-wrap" id="${id}"><button type="button" class="ipd-btn" onclick="toggleIpd('${id}')">Select…</button><div class="ipd-panel">${checks}</div></div>`;
}
function weldPersonCell(w, pl, role){
  const ids=role==='welder'?(w.welderIds||[]):(w.inspectorIds||[]);
  const id=`ipd-${w.id}-${role}`;
  let items;
  if(role==='welder'){
    /* Welder: single select (radio buttons) */
    items=people().map(p=>`<label class="ipd-item"><input type="radio" name="${id}-radio" value="${p.id}" ${ids.includes(p.id)?'checked':''} onchange="onInlinePersonChange(${w.id},'${role}','${id}')">${escapeHtml(p.name)}</label>`).join('');
    items=`<label class="ipd-item"><input type="radio" name="${id}-radio" value="" ${!ids.length?'checked':''} onchange="onInlinePersonChange(${w.id},'${role}','${id}')"><span class="muted">— None —</span></label>`+items;
  } else {
    /* Inspector: single select (radio buttons) */
    items=people().map(p=>`<label class="ipd-item"><input type="radio" name="${id}-radio" value="${p.id}" ${ids.includes(p.id)?'checked':''} onchange="onInlinePersonChange(${w.id},'${role}','${id}')">${escapeHtml(p.name)}</label>`).join('');
    items=`<label class="ipd-item"><input type="radio" name="${id}-radio" value="" ${!ids.length?'checked':''} onchange="onInlinePersonChange(${w.id},'${role}','${id}')"><span class="muted">— None —</span></label>`+items;
  }
  if(!ids.length){
    return `<div class="ipd-wrap" id="${id}"><button type="button" class="ipd-btn" onclick="toggleIpd('${id}')">Select…</button><div class="ipd-panel">${items}</div></div>`;
  }
  const popupCall=`showWeldPeople(${w.id},'${role}')`;
  return `<div class="ipd-wrap" id="${id}">${personCellHtml(ids,pl.status,popupCall)}<button class="btn-link btn-edit-inline" onclick="event.stopPropagation();toggleIpd('${id}')" title="Change">✎</button><div class="ipd-panel">${items}</div></div>`;
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
  if(role==='welder'){
    /* single select: get the selected radio value */
    const selected=wrap.querySelector('input[type=radio]:checked');
    const val=selected?Number(selected.value):0;
    w.welderIds=val?[val]:[];
  } else {
    /* single select: get the selected radio value */
    const selected=wrap.querySelector('input[type=radio]:checked');
    const val=selected?Number(selected.value):0;
    w.inspectorIds=val?[val]:[];
  }
  /* update button label without re-rendering */
  const currentIds=role==='welder'?w.welderIds:w.inspectorIds;
  const btn=wrap.querySelector('.ipd-btn');
  if(btn){
    const names=currentIds.map(id=>{const p=getPerson(id); return p?p.name:'';}).filter(Boolean);
    btn.textContent=names.length?names.join(', '):'Select\u2026';
  }
  saveDB();
}
function showWaz(matId){ const m=getMaterial(matId); showImageRaw(`WAZ ${m.wazNo} — ${m.itemDescription}`, m.wazPdfUrl, `Certificate ${m.certificate} · Heat No. ${m.heatNo}`); }
let wazMaterialId=null;
function nextWazNo(pipelineId){
  const existing=pipelineMaterials(pipelineId).map(m=>m.wazNo).filter(Boolean);
  const nums=existing.map(w=>{ const n=w.match(/(\d+)$/); return n?Number(n[1]):0; });
  const next=nums.length?Math.max(...nums)+1:1;
  return 'Z'+String(next).padStart(3,'0');
}
function openAddWazModal(matId){
  wazMaterialId=matId; const m=getMaterial(matId);
  const pl=getPipeline(m.pipelineId), pr=pl?getProject(pl.projectId):null;
  // Find matching materials in this pipeline (same piece, code, DN, diameter, thickness) with existing WAZ
  const matchingMats=pipelineMaterials(m.pipelineId).filter(x=>x.id!==m.id && x.wazNo && x.wazPdfUrl &&
    x.piece===m.piece && x.materialCode===m.materialCode &&
    x.dimension===m.dimension && (x.diameter||'')===(m.diameter||'') &&
    (x.thickness||'')===(m.thickness||''));
  const seenWaz=new Set(); const matchingWazList=[];
  matchingMats.forEach(x=>{ if(!seenWaz.has(x.wazNo)){ seenWaz.add(x.wazNo); matchingWazList.push(x); } });
  const existingWaz=[...new Set(pipelineMaterials(m.pipelineId).map(x=>x.wazNo).filter(Boolean))].sort();
  const newWaz=nextWazNo(m.pipelineId);
  const wazSel=document.getElementById('input-waz-no');
  let wazOpts='';
  if(matchingWazList.length){
    matchingWazList.forEach(x=>{
      const xpl=getPipeline(x.pipelineId);
      wazOpts+=`<option value="${escapeHtml(x.wazNo)}">${escapeHtml(x.wazNo)} (same material${xpl?' \u2014 '+escapeHtml(xpl.no):''})</option>`;
    });
    const otherExisting=existingWaz.filter(w=>!seenWaz.has(w));
    otherExisting.forEach(w=>{ wazOpts+=`<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`; });
    wazOpts+=`<option value="${escapeHtml(newWaz)}">${escapeHtml(newWaz)} (new \u2014 upload required)</option>`;
  } else {
    wazOpts=`<option value="${escapeHtml(newWaz)}" selected>${escapeHtml(newWaz)} (new)</option>`;
    existingWaz.forEach(w=>{ wazOpts+=`<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`; });
  }
  wazSel.innerHTML=wazOpts;
  // Certificate dropdown: existing certs from this project's materials
  const projMats=pr?projects().filter(p=>p.clientId===pr.clientId).flatMap(p=>projectPipelines(p.id)).flatMap(pl2=>pipelineMaterials(pl2.id)):[];
  const certs=[...new Set(projMats.map(x=>x.certificate).filter(Boolean))].sort();
  // Heat No. dropdown: existing heats from this project's materials
  const heats=[...new Set(projMats.map(x=>x.heatNo).filter(Boolean))].sort();
  // Auto-fill cert + heat from the pre-selected WAZ (if it exists in pipeline)
  const preSelectedWaz=val('input-waz-no');
  const preMatch=pipelineMaterials(m.pipelineId).find(x=>x.wazNo===preSelectedWaz && x.id!==m.id);
  buildSelectOther('input-waz-cert','input-waz-cert-new',certs,preMatch?preMatch.certificate:(certs[0]||''));
  buildSelectOther('input-waz-heat','input-waz-heat-new',heats,preMatch?preMatch.heatNo:'');
  const fileEl=document.getElementById('input-waz-file'); if(fileEl) fileEl.value='';
  wazDocRemoved=false;
  _wazProjectPdfUrl='';
  document.getElementById('waz-current-doc').innerHTML='';
  document.getElementById('waz-err').classList.remove('show');
  document.getElementById('modal-waz-title').textContent='Add WAZ document';
  document.getElementById('waz-shared-warning').style.display='none';
  /* Show dropdowns, hide edit text inputs */
  document.getElementById('input-waz-cert').style.display='';
  document.getElementById('input-waz-cert-edit').style.display='none';
  document.getElementById('input-waz-heat').style.display='';
  document.getElementById('input-waz-heat-edit').style.display='none';
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
  if(existingMat){
    const pl=getPipeline(m.pipelineId), pr=pl?getProject(pl.projectId):null;
    const projMats=pr?projects().filter(p=>p.clientId===pr.clientId).flatMap(p=>projectPipelines(p.id)).flatMap(pl2=>pipelineMaterials(pl2.id)):[];
    const certs=[...new Set(projMats.map(x=>x.certificate).filter(Boolean))].sort();
    buildSelectOther('input-waz-cert','input-waz-cert-new',certs,existingMat.certificate);
    const heats=[...new Set(projMats.map(x=>x.heatNo).filter(Boolean))].sort();
    buildSelectOther('input-waz-heat','input-waz-heat-new',heats,existingMat.heatNo);
  }
  toggleWazFileVisibility();
  document.getElementById('waz-err').classList.remove('show');
}
function openEditWazModal(matId){
  wazMaterialId=matId; const m=getMaterial(matId);
  const pl=getPipeline(m.pipelineId), pr=pl?getProject(pl.projectId):null;
  const existingWaz=[...new Set(pipelineMaterials(m.pipelineId).map(x=>x.wazNo).filter(Boolean))].sort();
  const newWaz=nextWazNo(m.pipelineId);
  const wazSel=document.getElementById('input-waz-no');
  wazSel.innerHTML=`<option value="${escapeHtml(newWaz)}">${escapeHtml(newWaz)} (new)</option>`+existingWaz.map(w=>`<option value="${escapeHtml(w)}" ${w===m.wazNo?'selected':''}>${escapeHtml(w)}</option>`).join('');
  /* Hide dropdowns, show text inputs for cert and heat */
  document.getElementById('input-waz-cert').style.display='none';
  document.getElementById('input-waz-cert-new').style.display='none';
  const certEdit=document.getElementById('input-waz-cert-edit');
  certEdit.style.display=''; certEdit.value=m.certificate||'';
  document.getElementById('input-waz-heat').style.display='none';
  document.getElementById('input-waz-heat-new').style.display='none';
  const heatEdit=document.getElementById('input-waz-heat-edit');
  heatEdit.style.display=''; heatEdit.value=m.heatNo||'';
  const fileEl=document.getElementById('input-waz-file'); if(fileEl) fileEl.value='';
  wazDocRemoved=false;
  document.getElementById('waz-err').classList.remove('show');
  document.getElementById('modal-waz-title').textContent='Edit WAZ document';
  document.getElementById('waz-shared-warning').style.display='block';
  toggleWazFileVisibility();
  openModal('modal-waz-add');
}
function confirmAddWaz(){
  const m=getMaterial(wazMaterialId); if(!m) return;
  const wazNo=val('input-waz-no');
  const existingWithDoc=pipelineMaterials(m.pipelineId).find(x=>x.wazNo===wazNo && x.wazPdfUrl);
  const f=(document.getElementById('input-waz-file').files[0]||{}).name;
  const errEl=document.getElementById('waz-err');
  if(!existingWithDoc && !_wazProjectPdfUrl && !f && (wazDocRemoved || !getMaterial(wazMaterialId).wazPdfUrl)){
    errEl.textContent='WAZ document is required.';
    errEl.classList.add('show'); return; }
  errEl.classList.remove('show');
  m.wazNo=wazNo;
  const certEditEl=document.getElementById('input-waz-cert-edit');
  const heatEditEl=document.getElementById('input-waz-heat-edit');
  if(certEditEl.style.display!=='none') m.certificate=certEditEl.value.trim()||m.certificate;
  else m.certificate=readSelectOther('input-waz-cert','input-waz-cert-new')||m.certificate;
  if(heatEditEl.style.display!=='none') m.heatNo=heatEditEl.value.trim()||m.heatNo;
  else m.heatNo=readSelectOther('input-waz-heat','input-waz-heat-new')||m.heatNo;
  if(f) m.wazPdfUrl=`https://istinox.sharepoint.com/…/waz/${f}`;
  else if(wazDocRemoved) m.wazPdfUrl='';
  else if(existingWithDoc) m.wazPdfUrl=existingWithDoc.wazPdfUrl;
  else if(_wazProjectPdfUrl) m.wazPdfUrl=_wazProjectPdfUrl;
  else m.wazPdfUrl=`https://istinox.sharepoint.com/…/waz/${wazNo}.pdf`;
  _wazProjectPdfUrl='';
  wazDocRemoved=false;
  saveDB(); closeModal('modal-waz-add'); rerenderPage();
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
    cards+=`<div class="jm-card"><div class="jm-card-head"><span class="jm-item-tag">Item ${idx+1}</span><span class="jm-waz">WAZ ${escapeHtml(m.wazNo)}</span><span style="flex:1"></span><span class="jm-waz">${sideLabels[idx]||''}</span></div>
      <div class="jm-card-body"><div class="jm-title"><a class="cell-link" href="material-detail.html?id=${m.id}">${escapeHtml(m.itemDescription)}</a></div>
        <div class="jm-row"><span class="k">DN</span><span class="v">${seamDn}</span></div>
        <div class="jm-row"><span class="k">diameter</span><span class="v">${m.diameter?fmtDia(m.diameter):'—'}</span></div>
        <div class="jm-row"><span class="k">thickness</span><span class="v">${escapeHtml(m.thickness)||'—'}</span></div>
        <div class="jm-row"><span class="k">material</span><span class="v">${escapeHtml(m.materialCode)}</span></div>
        <div class="jm-row"><span class="k">certificate</span><span class="v">${escapeHtml(m.certificate)}</span></div>
        <div class="jm-row"><span class="k">heat / melt No.</span><span class="v">${escapeHtml(m.heatNo)}</span></div>
        <div class="jm-row"><span class="k">in the seam(s)</span><span class="v">${escapeHtml(inSeams)}</span></div>
        <div class="jm-row"><span class="k">WAZ document</span><span class="v"><button class="doc-chip doc-weld" onclick="showWaz(${m.id})">${escapeHtml(m.wazNo)} PDF</button></span></div></div></div>`; });
  const wallThickness=mats.map(m=>parseFloat(m.thickness)||0).sort((a,b)=>b-a)[0];
  const wallThkLabel=wallThickness?`Wall thickness ${wallThickness} mm`:'Wall thickness —';
  document.getElementById('seam-content').innerHTML=`
    <div class="seam-card"><div class="seam-card-head">Seam ${seamIndex} · joining of ${mats.length} material${mats.length!==1?'s':''}</div>
      <div class="seam-schematic">${schematic}</div>
      <div class="seam-drawing-line">Drawing <strong>${escapeHtml(pl.no)}</strong> · ${wallThkLabel} · ${escapeHtml(w.type)||'—'} · ${typeName} · Procedure ${escapeHtml(w.procedure)||'—'}</div>
      <div class="seam-metrics">
        <div class="seam-metric"><div class="k">Welder No.</div><div class="v">${welderLabel}</div></div>
        <div class="seam-metric"><div class="k">Inspector</div><div class="v">${insLabel}</div></div>
        <div class="seam-metric"><div class="k">Date</div><div class="v">${w.date?formatDate(w.date):'—'}</div></div>
        <div class="seam-metric"><div class="k">Visually</div><div class="v">${tag(w.visual)}</div></div>
        <div class="seam-metric"><div class="k">Endoscopy</div><div class="v">${tag(w.endoscopy)}</div></div>
        <div class="seam-metric"><div class="k">Ferrite test (&lt;3.0%)</div><div class="v">${escapeHtml(w.ferrite)||'—'}</div></div>
        <div class="seam-metric"><div class="k">Note / image No.</div><div class="v">${escapeHtml(w.noteImageNo)||'—'}</div></div>
        <div class="seam-metric"><div class="k">Edit</div><div class="v"><button class="btn-link" onclick="openWeldModal(${w.id})">Edit weld</button></div></div>
      </div></div>
    <div class="jm-head">Joined materials (${mats.length})</div><div class="jm-grid">${cards}</div>`;
  showDetailView('seam');
}

/* ================================================================ MATERIAL DETAIL PAGE ================================================================ */
async function initMaterialDetailPage(){
  PAGE.name='material-detail'; initDB();
  PAGE.materialId=Number(qp('id'));
  try {
    const matData = await apiGet('/materials/'+PAGE.materialId);
    const pid = matData.pipelineId;
    const pl0 = await apiGet('/pipelines/'+pid);
    const projId = pl0.projectId;
    const [apiPr, apiPl, apiM, apiW] = await Promise.all([apiGet('/projects/'+projId), apiGet('/pipelines?projectId='+projId), apiGet('/materials?pipelineId='+pid), apiGet('/welds?pipelineId='+pid)]);
    const apiCl = await apiGet('/clients/'+apiPr.clientId);
    DB.clients=[apiCl]; DB.projects=normalizeProjects([apiPr]); DB.pipelines=apiPl; DB.materials=normalizeMaterials(apiM); DB.welds=normalizeWelds(apiW);
    rebuildRelationships();
  } catch(e){ console.error('API error:', e); }
  PAGE.materialId=Number(qp('id')); const m=getMaterial(PAGE.materialId);
  if(!m){ renderChrome('pipelines','Pipelines'); return; }
  PAGE.pipelineId=m.pipelineId;
  const pl=getPipeline(m.pipelineId);
  PAGE.projectId=pl.projectId;
  const pr=getProject(pl.projectId); if(pr) PAGE.clientId=pr.clientId;
  renderChrome('pipelines',`<a href="pipelines.html">Pipelines</a> / <a href="pipeline-detail.html?id=${pl.id}">${escapeHtml(pl.no)}</a> / ${posLetter(m.position)}`); mountModals(); wireModalDismiss(); renderMaterialDetail();
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
    const photo=w.photoUrl?`<button class="img-btn" onclick="showImage('${escapeHtml(w.weldNo)} \u2014 weld photo','${escapeHtml(w.photoUrl)}')">View</button>`:'<span class="img-btn empty">\u2014</span>';
    const endo=w.endoscopyUrl?`<button class="img-btn" onclick="showImage('${escapeHtml(w.weldNo)} \u2014 endoscopy','${escapeHtml(w.endoscopyUrl)}')">View</button>`:'<span class="img-btn empty">\u2014</span>';
    const rem=w.remarks?`<button class="remarks-btn" onclick="showRemarks(${w.id})">View</button>`:'<span class="remarks-btn none">\u2014</span>';
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
    <td class="col-actions"><a class="btn-link" href="pipeline-detail.html?id=${pl.id}&seam=${w.id}">Seam</a><button class="btn-link" onclick="openWeldModal(${w.id})">Edit</button>${archiveBtn('weld',w.id)}</td>
  </tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="12">No welds reference this material yet.</td></tr>';
  document.getElementById('material-edit-btn').onclick=()=>openMaterialModal(m.id);
}

/* ================================================================ MATERIAL USAGE PAGE ================================================================ */
async function initMaterialUsagePage(){
  PAGE.name='material-usage'; initDB();
  try {
    const [apiC, apiP, apiPl, apiM] = await Promise.all([apiGet('/clients'), apiGet('/projects'), apiGet('/pipelines'), apiGet('/materials')]);
    DB.clients=apiC; DB.projects=normalizeProjects(apiP); DB.pipelines=apiPl; DB.materials=normalizeMaterials(apiM);
  } catch(e){ console.error('API error:', e); }
  renderChrome('materials',`<a href="materials.html">Materials</a> / Usage`); mountModals(); wireModalDismiss();
  renderMaterialUsagePage();
}
function getMaterialUsageParams(){
  return { piece:qp('piece')||'', desc:qp('desc')||'', dn:qp('dn')||'', dien:qp('dien')||'', dia:qp('dia')||'', thk:qp('thk')||'', code:qp('code')||'' };
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
  document.getElementById('mu-stats').innerHTML=tile(matching.length,'Total used','')+tile(uniquePipelines.length,'Pipelines','t-neutral')+tile(uniqueProjects.length,'Projects','t-copper')+tile(uniqueClients.length,'Clients','t-neutral')+tile(uniqueWazNos.length,'WAZ documents','t-success');
  /* usage table */
  const tbody=document.getElementById('mu-usage-tbody');
  tbody.innerHTML=matching.length? matching.map(m=>{
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
  }).join('') : '<tr class="empty-row"><td colspan="8">No materials found with this combination.</td></tr>';
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
function initWeldersPage(){ PAGE.name='welders'; initDB(); renderChrome('welders','Welders'); mountModals(); wireModalDismiss(); renderWeldersPage(); }
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
  let optsHtml=`<button class="cf-clear" onclick="setWelderFilter('${filterKey}','')">Clear filter</button>`;
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
  return `<tr>${wc}
    <td class="col-mono">${escapeHtml(cert.certNo)}</td><td class="col-mono">${escapeHtml(cert.process)}</td><td>${escapeHtml(cert.standard)}</td>
    <td><div class="valid-cell"><span>${cert.validUntil?formatDate(cert.validUntil):'—'}</span>${cert.validUntil?certStatusPill(cert):''}</div></td>
    <td>${cert.renewalDue?formatDate(cert.renewalDue):'—'}</td>
    <td>${cert.pdfUrl?`<a class="doc-chip doc-iso" href="${escapeHtml(cert.pdfUrl)}" target="_blank" rel="noopener">PDF</a>`:'<span class="muted">—</span>'}</td>
    <td class="col-actions"><button class="btn btn-ghost btn-sm" onclick="openRenewModal(${cert.id})">Renew</button></td></tr>`;
}
function archivedCertRow(cert){
  const p=getPerson(cert.personId);
  return `<tr>
    <td class="col-mono">${escapeHtml(p.no)}</td>
    <td class="col-name"><a class="cell-link" href="welder-profile.html?id=${p.id}">${escapeHtml(p.name)}</a></td>
    <td class="col-mono">${escapeHtml(cert.certNo)}</td>
    <td class="col-mono">${escapeHtml(cert.process)}</td>
    <td>${escapeHtml(cert.standard)}</td>
    <td>${formatDate(cert.validUntil)}</td>
    <td>${cert.pdfUrl?`<a class="doc-chip doc-iso" href="${escapeHtml(cert.pdfUrl)}" target="_blank" rel="noopener">PDF</a>`:'<span class="muted">—</span>'}</td>
    <td class="col-actions"><button class="btn-restore" onclick="restoreCert(${cert.id})">${RESTORE_ICON} Restore</button></td>
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
  document.getElementById('welders-stats').innerHTML=tile(people().length,'Welders / personnel','')+tile(certificates().length,'Active certs','t-neutral')+tile(expiring,'Expiring ≤30 days','t-copper')+tile(expired,'Expired','t-danger')+tile(archivedCerts.length,'Archived','t-neutral');
  let rows=certificates().slice().sort((a,b)=>{ const pa=getPerson(a.personId), pb=getPerson(b.personId); return String(pa.no).localeCompare(String(pb.no),undefined,{numeric:true})||a.certNo.localeCompare(b.certNo); });
  if(welderFilters.welder) rows=rows.filter(c=>c.personId===Number(welderFilters.welder));
  if(welderFilters.process) rows=rows.filter(c=>c.process===welderFilters.process);
  if(welderFilters.status) rows=rows.filter(c=>certStatus(c)===welderFilters.status);
  /* build column filter thead */
  const thead=document.getElementById('welders-thead');
  if(thead){
    const welderOpts=people().map(p=>({value:String(p.id),label:p.name+' · '+p.no}));
    const procOpts=[...new Set(certificates().map(c=>c.process).filter(Boolean))].sort();
    const statusOpts=[{value:'valid',label:'Valid'},{value:'expiring',label:'Expiring'},{value:'expired',label:'Expired'}];
    let hdr=`<th>No.</th>`;
    hdr+=welderColFilter('Welder name','welder',welderOpts,welderFilters.welder);
    hdr+=`<th>Certificate No.</th>`;
    hdr+=welderColFilter('Process','process',procOpts,welderFilters.process);
    hdr+=`<th>Standard</th>`;
    hdr+=welderColFilter('Valid until','status',statusOpts,welderFilters.status);
    hdr+=`<th>Renewal due</th><th>PDF</th><th></th>`;
    thead.innerHTML=hdr;
  }
  const tbody=document.getElementById('welders-tbody');
  tbody.innerHTML=rows.length? rows.map(c=>certRow(c,true)).join('') : `<tr class="empty-row"><td colspan="9">${certificates().length===0?'No certificates yet.':'No certificates match your filters.'}</td></tr>`;
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
  let optsHtml=`<button class="cf-clear" onclick="setArchivedCertFilter('${filterKey}','')">Clear filter</button>`;
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
    let hdr=`<th>No.</th>`;
    hdr+=archivedColFilter('Welder name','welder',welderOpts,archivedCertFilters.welder);
    hdr+=`<th>Certificate No.</th>`;
    hdr+=archivedColFilter('Process','process',procOpts,archivedCertFilters.process);
    hdr+=`<th>Standard</th><th>Valid until</th><th>PDF</th><th></th>`;
    thead.innerHTML=hdr;
  }
  const tbody=document.getElementById('welders-archived-tbody');
  tbody.innerHTML=archived.length? archived.map(c=>archivedCertRow(c)).join('') : '<tr class="empty-row"><td colspan="8">No archived certificates.</td></tr>';
}
function restoreCert(id){
  const c=DB.certificates.find(x=>x.id===id); if(c) c.archived=false;
  saveDB(); renderWeldersPage(); renderArchivedCerts();
}

/* ================================================================ WELDER PROFILE PAGE ================================================================ */
function initWelderProfilePage(){
  PAGE.name='welder-profile'; initDB(); PAGE.welderId=Number(qp('id'));
  const p=getPerson(PAGE.welderId);
  if(!p){ renderChrome('welders','Welders'); return; }
  renderChrome('welders',`<a href="welders.html">Welders</a> / ${escapeHtml(p.name)}`); mountModals(); wireModalDismiss(); renderWelderProfile();
}
function renderWelderProfile(){
  const p=getPerson(PAGE.welderId); if(!p) return;
  document.getElementById('profile-avatar').textContent=initials(p.name);
  document.getElementById('profile-name').textContent=p.name;
  document.getElementById('profile-sub').textContent=`No. ${p.no} · Qualified: ${p.procs||'—'}`;
  const certs=personCerts(p.id);
  const expiring=certs.filter(c=>certStatus(c)==='expiring').length;
  const asWelder=pipelines().filter(pl=>(pl.welderIds||[]).includes(p.id)&&pl.status<3).length;
  const asInspector=pipelines().filter(pl=>(pl.inspectorIds||[]).includes(p.id)&&pl.status<3).length;
  const activeProjects=new Set(pipelines().filter(pl=>((pl.welderIds||[]).includes(p.id)||(pl.inspectorIds||[]).includes(p.id))&&pl.status<3).map(pl=>pl.projectId));
  document.getElementById('profile-stats').innerHTML=tile(certs.length,'Certificates','')+tile(expiring,'Expiring ≤1 month','t-copper')+tile(asWelder,'Active pipelines (welder)','t-neutral')+tile(asInspector,'Active pipelines (inspector)','t-neutral')+tile(activeProjects.size,'Active projects','t-success');
  const tbody=document.getElementById('profile-certs-tbody');
  tbody.innerHTML=certs.length? certs.map(c=>certRow(c,false)).join('') : '<tr class="empty-row"><td colspan="7">No certificates on file.</td></tr>';
  document.getElementById('profile-edit-btn').onclick=()=>openWelderModal(p.id);
}

/* ================================================================ ROLE SELECTION ================================================================ */
function initRolePage(){ initDB(); }
function chooseRole(role){
  setRole(role);
  if(role==='vendor'){ setCurrentUserId(getCurrentUserId()||1); }
  location.href='home.html';
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
      <td class="col-actions"><a class="btn-link" href="pipeline-detail.html?id=${pl.id}">Open</a>${archiveBtn('pipeline',pl.id)}</td>
    </tr>`;
  }).join('');
  return `<div class="table-card"><table class="table-wide"><thead><tr><th>Pipeline No.</th><th>Project</th><th>Client</th><th>Status</th><th>Documents</th><th></th></tr></thead><tbody>${list.length?rows:`<tr class="empty-row"><td colspan="6">${escapeHtml(emptyMsg)}</td></tr>`}</tbody></table></div>`;
}
function homeCertTable(list){
  const sorted=list.slice().sort((a,b)=>daysUntil(a.validUntil)-daysUntil(b.validUntil));
  const rows=sorted.length? sorted.map(c=>certRow(c,true)).join('') : '<tr class="empty-row"><td colspan="9">No certificates expiring in the next 30 days.</td></tr>';
  return `<div class="table-card"><table class="table-wide"><thead><tr><th>No.</th><th>Welder name</th><th>Certificate&nbsp;No.</th><th>Process</th><th>Standard</th><th>Valid until</th><th>Renewal due</th><th>PDF</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* ================================================================ HOME (office + vendor dashboards) ================================================================ */
let homeTab=null;
async function initHomePage(){ PAGE.name='home'; initDB();
  try {
    const [apiC, apiP, apiPl, apiM, apiW] = await Promise.all([apiGet('/clients'), apiGet('/projects'), apiGet('/pipelines'), apiGet('/materials'), apiGet('/welds')]);
    DB.clients=apiC; DB.projects=normalizeProjects(apiP); DB.pipelines=apiPl; DB.materials=normalizeMaterials(apiM); DB.welds=normalizeWelds(apiW);
    rebuildRelationships();
  } catch(e){ console.error('API error:', e); }
  renderChrome('home',getRole()==='vendor'?'Home / My work':'Home / Office dashboard'); mountModals(); wireModalDismiss(); renderHomePage();
}
function officeTabs(){
  const byStatus=s=>pipelines().filter(p=>p.status===s);
  const t=(key,label,list,desc,alert)=>({key,label,count:list.length,desc,alert,render:()=>homePipelineTable(list,'Nothing here — all caught up.')});
  const expiry=certsExpiringWithin(30);
  return [
    t('material','Pending material list',byStatus(0),'Pipelines created but whose master parts list has not been finalised yet.'),
    t('weldlist','Pending weld list',byStatus(1),'Material list done — the weld seam list still needs to be completed and marked done.'),
    t('builder','Pending printing welder document',byStatus(2),'Weld list done — the welder document is ready to be generated, downloaded and printed.'),
    t('welding','Pending welding update',byStatus(3),'Builder document downloaded — as-built welding details still need to be entered and verified.'),
    t('export','Pending export',byStatus(4),'Welding details recorded and verified — the final document can now be exported.'),
    t('wazcert','Pending WAZ certificates',pipelinesPendingWaz(),'Pipelines with at least one material whose WAZ (material acceptance) certificate is still missing.',true),
    t('certs','Pending welder certificates',pipelinesPendingCert(),'Active pipelines whose assigned welders have an expired or missing certificate.',true),
    t('assign','Pending welder/inspector assignment',pipelinesUnassignedAny(),'Pipelines still missing a welder and/or an inspector.',true),
    {key:'expiry',label:'Certificate expiry ≤30d',count:expiry.length,alert:true,desc:'Welder certificates expiring within the next 30 days — plan renewals ahead of time.',render:()=>homeCertTable(expiry)}
  ];
}
function vendorTabs(){
  const uid=getCurrentUserId();
  const t=(key,label,list,desc)=>({key,label,count:list.length,desc,render:()=>homePipelineTable(list,'None right now.')});
  return [
    t('assigned','Assigned pipelines',pipelinesForUser(uid),'Pipelines where you are assigned as a welder or inspector.'),
    t('uw','Unassigned welder',pipelinesUnassignedWelder(),'Pipelines that still need a welder assigned — available to pick up.'),
    t('ui','Unassigned inspector',pipelinesUnassignedInspector(),'Pipelines that still need an inspector assigned.')
  ];
}
function setHomeTab(k){ homeTab=k; renderHomePage(); }
function renderHomePage(){
  const role=getRole();
  const tabs=role==='vendor'?vendorTabs():officeTabs();
  if(!homeTab||!tabs.find(t=>t.key===homeTab)) homeTab=tabs[0].key;
  document.getElementById('home-title').textContent=role==='vendor'?'My work':'Office dashboard';
  document.getElementById('home-subtitle').textContent=role==='vendor'?`Signed in as ${escapeHtml((getPerson(getCurrentUserId())||{}).name||'')} · vendor / welder`:'Pipelines grouped by what needs to happen next — the count on each tab is the workload.';
  document.getElementById('home-tabs').innerHTML=tabs.map(t=>`<button class="home-tab ${t.key===homeTab?'active':''} ${t.alert&&t.count?'alert':''}" onclick="setHomeTab('${t.key}')">${escapeHtml(t.label)} <span class="tab-count">${t.count}</span></button>`).join('');
  const active=tabs.find(t=>t.key===homeTab);
  document.getElementById('home-desc').textContent=active.desc||'';
  document.getElementById('home-content').innerHTML=active.render();
}

/* ================================================================ WAZ DOCUMENTS PAGE ================================================================ */
let wazFilters={clientId:'',projectId:''};
async function initWazPage(){ PAGE.name='waz'; initDB();
  try {
    const [apiC, apiP, apiPl, apiM] = await Promise.all([apiGet('/clients'), apiGet('/projects'), apiGet('/pipelines'), apiGet('/materials')]);
    DB.clients=apiC; DB.projects=normalizeProjects(apiP); DB.pipelines=apiPl; DB.materials=normalizeMaterials(apiM);
  } catch(e){ console.error('API error:', e); }
  renderChrome('waz','WAZ Documents'); mountModals(); wireModalDismiss(); buildWazFilters(); renderWazPage();
}
function buildWazFilters(){
  const cliSel=document.getElementById('waz-filter-client'), prSel=document.getElementById('waz-filter-project');
  cliSel.innerHTML='<option value="">All clients</option>'+clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  prSel.innerHTML='<option value="">All projects</option>'+projects().map(p=>`<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');
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
  const keys=Object.keys(groups).sort();
  document.getElementById('waz-stats').innerHTML=tile(keys.length,'WAZ documents','')+tile(mats.length,'Materials covered','t-neutral')+tile(new Set(mats.map(m=>{const pl=getPipeline(m.pipelineId);return pl?pl.projectId:0;})).size,'Projects','t-copper');
  const tbody=document.getElementById('waz-tbody');
  tbody.innerHTML=keys.length? keys.map(waz=>{
    const list=groups[waz], first=list[0];
    const pls=[...new Set(list.map(m=>m.pipelineId))].map(getPipeline).filter(Boolean);
    const prs=[...new Set(pls.map(p=>p.projectId))].map(getProject).filter(Boolean);
    const matList=list.map(m=>`<div><a class="cell-link" href="material-detail.html?id=${m.id}">${posLetter(m.position)} · ${escapeHtml(m.piece)}</a></div>`).join('');
    return `<tr>
      <td><button class="doc-chip doc-weld" onclick="showWaz(${first.id})" title="View merged WAZ PDF">${escapeHtml(waz)}</button></td>
      <td>${matList}</td>
      <td>${escapeHtml([...new Set(list.map(m=>m.certificate).filter(Boolean))].join(', '))||'<span class="muted">—</span>'}</td>
      <td class="col-mono">${escapeHtml([...new Set(list.map(m=>m.heatNo).filter(Boolean))].join(', '))||'<span class="muted">—</span>'}</td>
      <td>${prs.map(p=>`<a class="cell-link" href="project-detail.html?id=${p.id}">${escapeHtml(p.title)}</a>`).join('<br>')}</td>
      <td><a class="doc-chip doc-iso" href="${escapeHtml(first.wazPdfUrl)}" target="_blank" rel="noopener">PDF</a></td>
    </tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="6">No WAZ documents match these filters.</td></tr>';
}

/* ================================================================ MATERIALS PAGE (all pipelines) ================================================================ */
let matFilters={clientId:'',projectId:'',piece:'',dn:'',dien:'',diameter:'',thickness:'',code:''};
async function initMaterialsPage(){ PAGE.name='materials'; initDB();
  try {
    const [apiC, apiP, apiPl, apiM] = await Promise.all([apiGet('/clients'), apiGet('/projects'), apiGet('/pipelines'), apiGet('/materials')]);
    DB.clients=apiC; DB.projects=normalizeProjects(apiP); DB.pipelines=apiPl; DB.materials=normalizeMaterials(apiM);
  } catch(e){ console.error('API error:', e); }
  renderChrome('materials','Materials'); mountModals(); wireModalDismiss(); buildMatClientProjectFilters(); renderMaterialsPage();
}
function buildMatClientProjectFilters(){
  const cliSel=document.getElementById('mat-filter-client'), prSel=document.getElementById('mat-filter-project');
  if(cliSel) cliSel.innerHTML='<option value="">All clients</option>'+clients().map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if(prSel) prSel.innerHTML='<option value="">All projects</option>'+projects().map(p=>`<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');
  if(cliSel) cliSel.value=matFilters.clientId;
  if(prSel) prSel.value=matFilters.projectId;
}
function buildMaterialsFilters(){ buildMatClientProjectFilters(); }
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
  if(el('mat-filter-client')) matFilters.clientId=el('mat-filter-client').value;
  if(el('mat-filter-project')) matFilters.projectId=el('mat-filter-project').value;
  renderMaterialsPage();
}
function clearMaterialsFilters(){ matFilters={clientId:'',projectId:'',piece:'',dn:'',dien:'',diameter:'',thickness:'',code:''}; renderMaterialsPage(); }
function renderMaterialsPage(){
  const allMats=materials().filter(m=>{ const pl=getPipeline(m.pipelineId); if(!pl) return false; const pr=getProject(pl.projectId); if(!pr) return false;
    if(matFilters.projectId && pr.id!==Number(matFilters.projectId)) return false;
    if(matFilters.clientId && pr.clientId!==Number(matFilters.clientId)) return false;
    if(matFilters.piece && m.piece!==matFilters.piece) return false;
    if(matFilters.dn && m.dimension!==matFilters.dn) return false;
    if(matFilters.dien && (m.dienNo||'')!==matFilters.dien) return false;
    if(matFilters.diameter && (m.diameter||'')!==matFilters.diameter) return false;
    if(matFilters.thickness && (m.thickness||'')!==matFilters.thickness) return false;
    if(matFilters.code && m.materialCode!==matFilters.code) return false;
    return true; });
  /* deduplicate: show only unique combinations */
  const seen=new Set(); const mats=[];
  allMats.forEach(m=>{ const key=[m.piece,m.itemDescription,m.dimension,...([2,3,4,5,6].map(i=>m[`dimension${i}`]||'')),m.dienNo||'',m.diameter||'',m.thickness||'',m.materialCode].join('|||');
    if(!seen.has(key)){ seen.add(key); mats.push(m); } });
  document.getElementById('materials-stats').innerHTML=tile(mats.length,'Unique materials','')+tile(allMats.length,'Total used','t-neutral');
  /* find max DN count */
  let maxDn=1;
  mats.forEach(m=>{ for(let i=2;i<=6;i++){ if(m[`dimension${i}`]) maxDn=Math.max(maxDn,i); } });
  const tbody=document.getElementById('materials-page-tbody');
  tbody.innerHTML=mats.length? mats.map(m=>{
    let extraDnCells='';
    for(let i=2;i<=maxDn;i++) extraDnCells+=`<td class="col-mono">${m[`dimension${i}`]?escapeHtml(m[`dimension${i}`]):'<span class="muted">—</span>'}</td>`;
    return `<tr>
      <td>${escapeHtml(m.piece)}</td>
      <td><a class="cell-link" href="material-usage.html?piece=${encodeURIComponent(m.piece)}&desc=${encodeURIComponent(m.itemDescription)}&dn=${encodeURIComponent(m.dimension)}&dien=${encodeURIComponent(m.dienNo||'')}&dia=${encodeURIComponent(m.diameter||'')}&thk=${encodeURIComponent(m.thickness||'')}&code=${encodeURIComponent(m.materialCode)}">${escapeHtml(m.itemDescription)}</a></td>
      <td class="col-mono">${escapeHtml(m.dimension)}</td>${extraDnCells}
      <td class="col-mono">${escapeHtml(m.dienNo||'')}</td>
      <td class="col-mono">${m.diameter?fmtDia(m.diameter):''}</td>
      <td class="col-mono">${escapeHtml(m.thickness||'')}</td>
      <td class="col-mono">${escapeHtml(m.materialCode)}</td>
      <td class="col-actions"><button class="btn-link" onclick="openMaterialsPageEdit(${m.id})">Edit</button></td>
    </tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="${8+(maxDn-1)}">No materials match these filters.</td></tr>`;
  /* update table header with clickable column filter dropdowns */
  const allMatsAll=materials();
  const allPieces=[...new Set(allMatsAll.map(m=>m.piece).filter(Boolean))].sort();
  const allDnOpts=[...new Set(allMatsAll.map(m=>m.dimension).filter(Boolean))].sort();
  const allDienOpts=[...new Set(allMatsAll.map(m=>m.dienNo).filter(Boolean))].sort();
  const allDiaOpts=[...new Set(allMatsAll.map(m=>m.diameter).filter(Boolean))].sort();
  const allThkOpts=[...new Set(allMatsAll.map(m=>m.thickness).filter(Boolean))].sort();
  const allCodeOpts=[...new Set(allMatsAll.map(m=>m.materialCode).filter(Boolean))].sort();
  const thead=document.getElementById('mat-thead');
  if(thead){
    let hdr=colFilterTh('Category','piece',allPieces,matFilters.piece);
    hdr+=`<th>Item description</th>`;
    hdr+=colFilterTh(maxDn>1?'DN 1':'DN','dn',allDnOpts,matFilters.dn);
    for(let i=2;i<=maxDn;i++) hdr+=`<th>DN ${i}</th>`;
    hdr+=colFilterTh('DIN EN No.','dien',allDienOpts,matFilters.dien);
    hdr+=colFilterTh('Diameter','diameter',allDiaOpts,matFilters.diameter);
    hdr+=colFilterTh('Thickness','thickness',allThkOpts,matFilters.thickness);
    hdr+=colFilterTh('Material','code',allCodeOpts,matFilters.code);
    hdr+=`<th></th>`;
    thead.innerHTML=hdr;
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
    dienNo:m.dienNo||'', materialCode:m.materialCode, diameter:m.diameter||'', thickness:m.thickness||''};
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
  setV('mp-surface',m.surface||'');
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
  m.surface=val('mp-surface');
  saveDB(); closeModal('modal-mat-props');
  /* check for materials with the SAME original combination (all fields) */
  const matching=materials().filter(x=>{
    if(x.id===m.id) return false;
    if(x.piece!==_mpOriginal.piece || x.itemDescription!==_mpOriginal.itemDescription) return false;
    if(x.dimension!==_mpOriginal.dimension) return false;
    if((x.dienNo||'')!==_mpOriginal.dienNo) return false;
    if(x.materialCode!==_mpOriginal.materialCode) return false;
    if((x.diameter||'')!==_mpOriginal.diameter) return false;
    if((x.thickness||'')!==_mpOriginal.thickness) return false;
    for(let i=2;i<=6;i++){ if((x[`dimension${i}`]||'')!==(_mpOriginal[`dimension${i}`]||'')) return false; }
    return true;
  });
  if(matching.length){
    document.getElementById('modal-apply-all-count').textContent=matching.length;
    document.getElementById('modal-apply-all-piece').textContent=`${_mpOriginal.piece} · ${_mpOriginal.itemDescription} · ${_mpOriginal.dimension}`;
    openModal('modal-apply-all');
  } else { _materialsPageEditId=null; _mpOriginal=null; rerenderPage(); }
}
function confirmApplyAll(){
  const m=getMaterial(_materialsPageEditId);
  const matching=materials().filter(x=>{
    if(x.id===m.id) return false;
    if(x.piece!==_mpOriginal.piece || x.itemDescription!==_mpOriginal.itemDescription) return false;
    if(x.dimension!==_mpOriginal.dimension) return false;
    if((x.dienNo||'')!==_mpOriginal.dienNo) return false;
    if(x.materialCode!==_mpOriginal.materialCode) return false;
    if((x.diameter||'')!==_mpOriginal.diameter) return false;
    if((x.thickness||'')!==_mpOriginal.thickness) return false;
    for(let i=2;i<=6;i++){ if((x[`dimension${i}`]||'')!==(_mpOriginal[`dimension${i}`]||'')) return false; }
    return true;
  });
  matching.forEach(x=>{
    x.piece=m.piece; x.itemDescription=m.itemDescription;
    x.dimension=m.dimension; x.diameter=m.diameter; x.thickness=m.thickness;
    x.dienNo=m.dienNo; x.materialCode=m.materialCode; x.surface=m.surface;
    for(let i=2;i<=6;i++) x[`dimension${i}`]=m[`dimension${i}`]||'';
  });
  saveDB(); closeModal('modal-apply-all'); _materialsPageEditId=null; _mpOriginal=null; rerenderPage();
}
function confirmApplyOne(){
  closeModal('modal-apply-all'); _materialsPageEditId=null; _mpOriginal=null; rerenderPage();
}

/* ================================================================ PROJECT DETAIL PAGE ================================================================ */
async function initProjectDetailPage(){
  PAGE.name='project-detail'; initDB(); PAGE.projectId=Number(qp('id'));
  try {
    const [apiC, apiP, apiPl] = await Promise.all([apiGet('/clients'), apiGet('/projects'), apiGet('/pipelines')]);
    DB.clients=apiC; DB.projects=normalizeProjects(apiP); DB.pipelines=apiPl;
  } catch(e){ console.error('API error:', e); }
  const pr=getProject(PAGE.projectId);
  if(!pr){ renderChrome('projects','Projects'); return; }
  PAGE.clientId=pr.clientId;
  renderChrome('projects',`<a href="projects.html">Projects</a> / ${escapeHtml(pr.title)}`); mountModals(); wireModalDismiss(); renderProjectDetail();
}
function switchProject(id){ if(id&&Number(id)!==PAGE.projectId) location.href='project-detail.html?id='+id; }
function renderProjectDetail(){
  const pr=getProject(PAGE.projectId); if(!pr) return; const cli=getClient(pr.clientId);
  document.getElementById('project-context').innerHTML=`${cli?`<a href="projects.html?client=${cli.id}">${escapeHtml(cli.name)}</a>`:''}<span class="sep">›</span><span>${escapeHtml(pr.title)}</span>`;
  const siblings=cli?clientProjects(cli.id):[pr];
  document.getElementById('project-switch').innerHTML=siblings.map(s=>`<option value="${s.id}" ${s.id===pr.id?'selected':''}>${escapeHtml(s.title)}</option>`).join('');
  document.getElementById('project-subtitle').textContent=`${cli?cli.name:'—'}${pr.location?' · '+pr.location:''}${siblings.length>1?` · ${siblings.length} projects for this client`:''}`;
  const item=(k,v,mono)=>`<div class="info-item"><div class="k">${k}</div><div class="v ${mono?'mono':''}">${v}</div></div>`;
  document.getElementById('project-info').innerHTML=item('Client',cli?escapeHtml(cli.name):'—')+item('Location',escapeHtml(pr.location)||'—')+item('Order number',pr.order?escapeHtml(pr.order):'—',true)+item('IST Project No.',escapeHtml(pr.istProjectNo)||'—',true)+item('Status',`<span class="status-badge status-${pr.status}">${STATUS_LABELS[pr.status]}</span>`)+item('Description',escapeHtml(pr.description)||'—');
  const pls=projectPipelines(pr.id); const by=s=>pls.filter(p=>p.status===s).length;
  document.getElementById('project-stats').innerHTML=tile(pls.length,'Pipelines','')+tile(pls.filter(p=>p.status<5).length,'In progress','t-copper')+tile(by(5),'Exported','t-success');
  document.getElementById('project-toolbar').innerHTML=`<h2>Pipelines</h2><div style="display:flex;gap:8px;"><a class="btn btn-ghost btn-sm" href="archive.html?tab=pipelines"><svg viewBox="0 0 24 24" width="14" height="14" fill="none"><rect x="3" y="4" width="18" height="4" rx="1" stroke="currentColor" stroke-width="1.8"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M10 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> Archive</a><button class="btn btn-primary btn-sm" onclick="openPipelineModal()">+ New pipeline</button></div>`;
  document.getElementById('project-pipelines').innerHTML=homePipelineTable(pls,'No pipelines in this project yet.');
}

