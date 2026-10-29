/* TTL Dispatch — copy of the G7 Leasing truck-sales CRM.
   Login: Firebase Auth (one account per salesman, managed by admins in Settings > Users).
   Data: Firestore, loaded only after login and guarded by firestore.rules; nothing is in this source.
   Claude edits the same Firestore data with tools/dispatch.py.
   Demo mode (no Firebase config + a local data.json) keeps edits in memory for testing. */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = n => (n == null || n === "" || isNaN(n)) ? "—" : Number(n).toLocaleString("en-US", {maximumFractionDigits: 0});
const fmtC = n => (n == null || n === "" || isNaN(n)) ? "—" : "$" + fmt(n);
const fmtK = n => n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? "$" + (n / 1e3).toFixed(1) + "K" : fmtC(n);
const todayStr = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const daysSince = ts => ts ? Math.floor((Date.now() - new Date(ts)) / 864e5) : 9999;
const initials = n => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
const WEEKS_PER_MONTH = 4.333;
const LS = {get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
            set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }};

const stageMeta = {
  working:     {name: "Working",       color: "var(--blue)",       short: "Being contacted — no truck picked yet"},
  assigned:    {name: "Assigned",      color: "var(--text-muted)", short: "Truck picked, next step: agreement"},
  agreement:   {name: "Agreement out", color: "var(--amber)",      short: "Contract sent, awaiting signature"},
  downpayment: {name: "Down payment",  color: "var(--purple)",     short: "Signed, collecting down payment"},
  ready:       {name: "Ready",         color: "var(--purple)",     short: "Paid up, awaiting dispatch"},
  active:      {name: "Active lease",  color: "var(--accent)",     short: "Dispatched, running"},
};
const STAGES = Object.keys(stageMeta);
const FLEETS = ["TTL", "DT", "VKL", "G7"];
const SOLD_STATUSES = ["Active", "Accident", "Returned", "Paid off"];
const COLLS = ["trucks", "drivers", "deals", "users"];
// fields copied to the public driver ads page — nothing about drivers, deals, cost or salesmen
const PUBLIC_TRUCK_FIELDS = ["unit", "year", "make", "model", "miles", "weekly", "term_weeks", "apu", "warranty", "engine", "trans", "photos"];

let S = {trucks: [], drivers: [], deals: [], users: [], activity: [], fees: {}, meta: {}};
let me = null;
let store = null;

/* ---------------------------------------------------------------- storage */
const FB = window.FIREBASE_CONFIG || {};
const firebaseStore = () => {
  firebase.initializeApp(FB);
  const db = firebase.firestore(), auth = firebase.auth();
  let unsubs = [];
  return {
    auth,
    listen(onChange) {
      COLLS.forEach(c => unsubs.push(db.collection(c).onSnapshot(s => { S[c] = s.docs.map(d => ({...d.data(), _id: d.id})); onChange(); }, err)));
      unsubs.push(db.collection("activity").orderBy("ts", "desc").limit(200).onSnapshot(s => { S.activity = s.docs.map(d => d.data()); onChange(); }, err));
      unsubs.push(db.collection("config").onSnapshot(s => { s.docs.forEach(d => { S[d.id] = d.data(); }); onChange(); }, err));
    },
    stop() { unsubs.forEach(u => u()); unsubs = []; },
    async save(coll, id, obj) {
      const clean = JSON.parse(JSON.stringify(obj, (k, v) => k === "_id" ? undefined : v));
      await db.collection(coll).doc(String(id)).set(clean, {merge: true});
    },
    async replace(coll, id, obj) {
      const clean = JSON.parse(JSON.stringify(obj, (k, v) => k === "_id" ? undefined : v));
      await db.collection(coll).doc(String(id)).set(clean);
    },
    async del(coll, id) { await db.collection(coll).doc(String(id)).delete(); },
    async log(what) { await db.collection("activity").add({ts: nowIso(), who: me?.name || "?", what}); },
  };
};
const demoStore = () => ({
  demo: true,
  listen() {},
  stop() {},
  async save(coll, id, obj) {
    if (coll === "config") { S[id] = {...S[id], ...obj}; return renderAll(); }
    const key = coll === "trucks" ? "unit" : "id";
    const cur = S[coll].find(x => String(x[key]) === String(id));
    if (cur) Object.assign(cur, obj); else S[coll].push({...obj});
    renderAll();
  },
  async replace(coll, id, obj) { const key = coll === "trucks" ? "unit" : "id"; S[coll] = S[coll].filter(x => String(x[key]) !== String(id)); S[coll].push(obj); renderAll(); },
  async del(coll, id) { const key = coll === "trucks" ? "unit" : "id"; S[coll] = S[coll].filter(x => String(x[key]) !== String(id)); renderAll(); },
  async log(what) { S.activity.unshift({ts: nowIso(), who: me?.name || "demo", what}); },
});
function err(e) { console.error(e); toast("⚠ " + (e.code === "permission-denied" ? "No access — ask Joey to enable your account" : e.message)); }
async function write(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); return true; }
  catch (e) { err(e); return false; }
}

/* ---------------------------------------------------------------- lookups */
const truckBy = u => S.trucks.find(t => String(t.unit) === String(u));
const driverBy = id => S.drivers.find(d => d.id === id);
const dealBy = id => S.deals.find(d => d.id === id);
const userBy = id => S.users.find(u => u.id === id);
const isAdmin = () => me?.role === "admin";
const isSold = d => !!d.sold;
const openDeals = () => S.deals.filter(d => !isSold(d) && d.stage !== "active");
const soldDeals = () => S.deals.filter(isSold);
const termMonths = t => t.term_weeks ? Math.round(t.term_weeks / WEEKS_PER_MONTH) : (t.term_months || null);
function termBucket(m) { if (m == null) return "none"; if (m <= 12) return "short"; if (m <= 16) return "mid"; if (m <= 22) return "long"; return "ext"; }
function nextId(list, prefix, start) {
  const nums = list.map(x => String(x.id || "")).filter(i => i.startsWith(prefix)).map(i => +i.slice(prefix.length)).filter(n => !isNaN(n));
  return prefix + (Math.max(start - 1, ...nums) + 1);
}

function truckStatus(t) {
  const u = String(t.unit);
  const s = S.deals.find(d => String(d.unit) === u && isSold(d) && (d.sold.status || "Active") !== "Returned");
  if (s) return {kind: "sold", label: s.sold.status && s.sold.status !== "Active" ? "Sold · " + s.sold.status : "Sold", deal: s};
  if (t.status === "sold") return {kind: "sold", label: "Sold"};
  const a = S.deals.find(d => String(d.unit) === u && d.stage === "active");
  if (a) return {kind: "sold", label: "Under lease", deal: a};
  const p = S.deals.find(d => String(d.unit) === u && d.stage !== "working" && !isSold(d));
  if (p) {
    const lbl = {assigned: "Assigned", agreement: "Agreement out", downpayment: "Collecting down", ready: "Ready to dispatch"}[p.stage];
    return {kind: p.stage === "ready" || p.stage === "agreement" ? "hold" : "assigned", label: lbl, deal: p};
  }
  if (t.status === "on_hold") return {kind: "hold", label: "On hold"};
  return {kind: "available", label: "For sale"};
}
function driverContactStatus(d) {
  const deals = S.deals.filter(x => x.driver_id === d.id);
  const act = deals.find(x => x.stage === "active" || isSold(x));
  if (act) return {kind: "active", label: "Active lease", cls: "available", deal: act};
  const pipe = deals.find(x => ["assigned", "agreement", "downpayment", "ready"].includes(x.stage));
  if (pipe) return {kind: "pipeline", label: "In pipeline · " + stageMeta[pipe.stage].name, cls: "hold", deal: pipe};
  const w = deals.find(x => x.stage === "working");
  if (w) return {kind: "working", label: "Being worked", cls: "assigned", deal: w};
  return {kind: "uncontacted", label: "Not contacted", cls: "", deal: null};
}
function allTasks() {
  const out = [];
  S.deals.forEach(d => (d.tasks || []).forEach(t => out.push({...t, deal: d, driver: driverBy(d.driver_id)})));
  return out;
}

/* ---------------------------------------------------------------- sold metrics */
function soldCalc(d) {
  const s = d.sold || {};
  const weekly = +s.weekly || 0;
  const termW = s.term_months ? Math.round(s.term_months * WEEKS_PER_MONTH) : 0;
  const payments = s.payments || [];
  const paidLogged = payments.reduce((a, p) => a + (+p.amount || 0), 0);
  // weeks_paid is the running count (imports start with it); payments[] is the itemised log
  const paidWeekly = Math.max(paidLogged, weekly * (+s.weeks_paid || 0));
  const totalDue = +s.loan || weekly * termW;
  const remaining = Math.max(0, totalDue - paidWeekly);
  const collected = (+s.down || 0) + paidWeekly;
  const weeksPaid = +s.weeks_paid || (weekly ? Math.round(paidWeekly / weekly) : 0);
  const pct = totalDue ? Math.min(1, paidWeekly / totalDue) : 0;
  const lastPay = payments.map(p => p.date).sort().pop() || null;
  return {weekly, termW, totalDue, remaining, collected, weeksPaid, pct, lastPay, status: s.status || "Active", monthly: weekly * WEEKS_PER_MONTH};
}
function soldTotals() {
  const all = soldDeals().map(d => ({d, c: soldCalc(d)}));
  const active = all.filter(x => x.c.status === "Active");
  return {count: all.length, active: active.length,
    collected: all.reduce((a, x) => a + x.c.collected, 0), remaining: active.reduce((a, x) => a + x.c.remaining, 0),
    monthly: active.reduce((a, x) => a + x.c.monthly, 0), all, activeList: active};
}

/* ---------------------------------------------------------------- navigation */
const SETTINGS_PAGES = new Set(["fees", "calculator", "users"]);
function show(page) {
  if (page === "settings") page = "fees";
  const el = $("#page-" + page);
  if (!el) return;
  $$(".page").forEach(p => p.classList.remove("on"));
  el.classList.add("on");
  $$(".nav a").forEach(a => a.classList.toggle("active", a.dataset.page === page || (a.dataset.page === "settings" && SETTINGS_PAGES.has(page))));
  $(".rail").classList.remove("mobile-open");
  LS.set("dispatch-page", page);
  renderPage(page);
}
function renderPage(page) {
  ({dashboard: renderDashboard, inventory: renderInventory, pipeline: renderPipeline, sold: renderSold, followups: renderFollowups,
    drivers: renderDrivers, kpi: renderKpi, fees: renderFees, calculator: renderCalculator, users: renderUsers}[page] || (() => {}))();
}
function renderSubnavs() {
  $$(".subnav").forEach(el => {
    const cur = el.dataset.sub;
    el.innerHTML = [["fees", "Fees & terms"], ["calculator", "Calculator"], ["users", "Users"]]
      .map(([k, l]) => `<button class="chip ${k === cur ? "on" : ""}" data-go="${k}">${l}</button>`).join("");
  });
}
let renderT;
function renderAll() {
  clearTimeout(renderT);
  renderT = setTimeout(() => {
    if (me) me = userBy(me.id) || me;
    document.body.classList.toggle("admin-hidden", !isAdmin());
    updateNavCounts();
    renderFresh();
    // don't wipe a form someone is typing in
    const page = ($(".page.on") || {}).id?.replace("page-", "") || "dashboard";
    if (!(page === "fees" && $("#page-fees").contains(document.activeElement))) renderPage(page);
    if (curDeal) { curDeal = dealBy(curDeal.id); curDeal ? renderSheet() : closeSheet(); }
  }, 60);
}
function updateNavCounts() {
  $("#navInv").textContent = S.trucks.length;
  $("#navPipe").textContent = openDeals().length;
  $("#navSold").textContent = soldDeals().length;
  $("#navFu").textContent = allTasks().filter(t => !t.done && t.due <= todayStr()).length;
  $("#navDrv").textContent = S.drivers.length;
}
function renderFresh() {
  const upd = S.meta?.checked_at;
  const el = $("#freshBar");
  el.textContent = (store?.demo ? "DEMO MODE — changes are not saved · " : "") + (upd ? `Checked by Claude ${daysSince(upd) === 0 ? "today" : daysSince(upd) + " day(s) ago"}${S.meta.miles_synced_at ? " · mileage synced " + new Date(S.meta.miles_synced_at).toLocaleDateString() : ""}` : "");
  el.classList.toggle("stale", !!upd && daysSince(upd) > 2);
}

/* ---------------------------------------------------------------- dashboard */
function greet() {
  const h = new Date().getHours();
  return (h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening") + (me ? ", " + String(me.name).split(" ")[0] : "");
}
function renderDashboard() {
  $("#dashGreet").textContent = greet();
  const due = allTasks().filter(t => !t.done && t.due <= todayStr());
  $("#kpiDue").textContent = due.length;
  const od = openDeals();
  $("#kpiPipe").textContent = od.length;
  $("#kpiPipeSub").textContent = `${od.filter(d => d.stage === "downpayment").length} collecting down · ${od.filter(d => d.stage === "ready").length} ready`;
  $("#kpiAvail").textContent = S.trucks.filter(t => truckStatus(t).kind === "available").length;
  $("#kpiAvailSub").textContent = `of ${S.trucks.length} trucks in fleet`;
  const st = soldTotals();
  $("#kpiSold").textContent = st.count;
  $("#kpiSoldSub").textContent = `${st.active} active · ${st.count - st.active} other`;
  $("#kpiCollected").textContent = fmtK(st.collected);
  $("#kpiCollectedSub").textContent = "down payments + weekly";
  $("#kpiRemaining").textContent = fmtK(st.remaining);
  $("#kpiRemainingSub").textContent = `across ${st.active} active leases`;
  $("#kpiMonthly").textContent = fmtK(st.monthly);
  $("#pipeStrip").innerHTML = STAGES.map(s => {
    const n = S.deals.filter(d => d.stage === s && !isSold(d)).length;
    return `<div class="ps" style="--c:${stageMeta[s].color}" data-go="pipeline"><b>${n}</b><span>${stageMeta[s].name}</span></div>`;
  }).join("");
  renderInsights();
  renderWeek();
  renderActivity();
  $("#dueList").innerHTML = due.length ? due.sort((a, b) => a.due.localeCompare(b.due)).slice(0, 12).map(taskRow).join("") : `<div class="empty">Nothing due. 🎉</div>`;
}
function taskRow(t) {
  const over = !t.done && t.due < todayStr();
  return `<div class="fo" data-deal="${esc(t.deal.id)}">
    <div class="chk ${t.done ? "done" : ""}" data-task-toggle="${esc(t.deal.id)}|${esc(t.id)}" title="Mark done"></div>
    <div class="body">${esc(t.body)}<small>${esc(t.driver?.name || t.deal.driver_id)} · Unit ${esc(t.deal.unit ?? "—")} · ${isSold(t.deal) ? "Sold" : stageMeta[t.deal.stage]?.name || ""}</small></div>
    <div class="due ${over ? "over" : ""}">${t.done ? "done" : over ? daysSince(t.due) + "d overdue" : t.due === todayStr() ? "today" : esc(t.due)}</div></div>`;
}
function computeInsights() {
  const out = [];
  const add = (sev, title, desc, act) => out.push({sev, title: esc(title), desc: esc(desc), act});
  const name = id => driverBy(id)?.name || id;
  const overdue = allTasks().filter(t => !t.done && t.due < todayStr()).sort((a, b) => a.due.localeCompare(b.due));
  if (overdue.length) add("red", `${overdue.length} overdue follow-up${overdue.length > 1 ? "s" : ""}`, "Oldest: " + overdue[0].body, ["followups", "Open"]);
  S.deals.filter(d => d.stage === "working" && !isSold(d)).forEach(d => {
    const last = [d.created, ...(d.notes || []).map(n => n.ts)].filter(Boolean).sort().pop();
    if (daysSince(last) >= 7) add("amber", `${name(d.driver_id)} cold for ${daysSince(last)} days`, "Working deal with no activity — follow up or release.", ["deal:" + d.id, "View"]);
  });
  S.deals.filter(d => d.stage === "agreement" && !d.agreement_signed && daysSince(d.agreement_sent) >= 3 && daysSince(d.agreement_sent) < 9999).forEach(d =>
    add("amber", `${name(d.driver_id)}: agreement out ${daysSince(d.agreement_sent)} days`, "Chase the signature.", ["deal:" + d.id, "View"]));
  const noAgent = S.deals.filter(d => (d.stage === "active" || isSold(d)) && !d.agent_id);
  if (noAgent.length) add("blue", `${noAgent.length} active deal${noAgent.length > 1 ? "s" : ""} with no sales agent`, "Commission can't be credited until an agent is set.", ["sold", "Open"]);
  soldTotals().activeList.forEach(({d, c}) => {
    if (c.lastPay && daysSince(c.lastPay) > 14) add("red", `${name(d.driver_id)}: no payment in ${daysSince(c.lastPay)} days`, `Unit ${d.unit} · $${fmt(c.weekly)}/wk`, ["deal:" + d.id, "View"]);
  });
  const uncont = S.drivers.filter(d => driverContactStatus(d).kind === "uncontacted");
  if (uncont.length) add("blue", `${uncont.length} drivers not contacted yet`, "Start with the longest-tenured.", ["drivers", "Open"]);
  const noPhotos = S.trucks.filter(t => truckStatus(t).kind === "available" && !(t.photos || []).length);
  if (noPhotos.length) add("amber", `${noPhotos.length} for-sale trucks missing photos`, "Trucks with photos sell faster.", ["inventory", "Open"]);
  const noPhone = S.drivers.filter(d => !d.phone);
  if (noPhone.length) add("amber", `${noPhone.length} drivers with no phone number`, "", ["drivers", "Open"]);
  const badVin = S.trucks.filter(t => t.vin && String(t.vin).length !== 17);
  if (badVin.length) add("amber", `${badVin.length} trucks with invalid VIN`, badVin.slice(0, 5).map(t => "Unit " + t.unit).join(", "), ["inventory", "Open"]);
  const names = {}; S.drivers.forEach(d => { const k = (d.name || "").trim().toLowerCase(); names[k] = (names[k] || 0) + 1; });
  const dupes = Object.entries(names).filter(([k, n]) => k && n > 1);
  if (dupes.length) add("amber", `${dupes.length} possible duplicate driver${dupes.length > 1 ? "s" : ""}`, dupes.map(([k]) => k).join(", "), ["drivers", "Open"]);
  if (!store?.demo && S.meta?.checked_at && daysSince(S.meta.checked_at) > 2) add("amber", "Claude's daily check hasn't run", "Last check " + daysSince(S.meta.checked_at) + " days ago.", null);
  return out;
}
function renderInsights() {
  const ins = computeInsights();
  $("#aiCount").textContent = ins.length ? `${ins.length} item${ins.length > 1 ? "s" : ""}` : "";
  const col = {red: "var(--red)", amber: "var(--amber)", blue: "var(--blue)"};
  $("#aiList").innerHTML = ins.length ? ins.map(i => `<div class="ai-item"><div class="dot" style="--c:${col[i.sev]}"></div>
      <div><div class="t">${i.title}</div><div class="d">${i.desc}</div></div>
      ${i.act ? `<button class="btn ghost sm" data-ins="${esc(i.act[0])}">${i.act[1]}</button>` : ""}</div>`).join("")
    : `<div class="empty">All clear — nothing needs attention.</div>`;
}
function renderWeek() {
  const since = Date.now() - 7 * 864e5;
  const inWeek = ts => ts && new Date(ts) >= since;
  const pays = soldDeals().flatMap(d => (d.sold.payments || []).filter(p => inWeek(p.date)));
  const rows = [
    ["New deals", S.deals.filter(d => inWeek(d.created)).length],
    ["Agreements signed", S.deals.filter(d => inWeek(d.agreement_signed)).length],
    ["Dispatched / activated", S.deals.filter(d => inWeek(d.activated)).length],
    ["Trucks sold", soldDeals().filter(d => inWeek(d.sold.date)).length],
    ["Payments received", `${pays.length} · ${fmtC(pays.reduce((a, p) => a + (+p.amount || 0), 0))}`],
    ["Follow-ups closed", allTasks().filter(t => t.done && inWeek(t.done_at)).length],
  ];
  $("#weekSnap").innerHTML = `<div class="wk">${rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join("")}</div>`;
}
function timeAgo(ts) {
  const m = Math.floor((Date.now() - new Date(ts)) / 6e4);
  return m < 60 ? Math.max(0, m) + "m ago" : m < 1440 ? Math.floor(m / 60) + "h ago" : Math.floor(m / 1440) + "d ago";
}
// activity text may contain <b> only; everything else is escaped
const safeActivity = s => esc(s).replace(/&lt;(\/?)b&gt;/g, "<$1b>");
function renderActivity() {
  const a = (S.activity || []).slice(0, 40);
  $("#activityFeed").innerHTML = a.length ? a.map(x => `<div class="fi"><b>${esc(x.who)}</b> ${safeActivity(x.what)}<small>${timeAgo(x.ts)}</small></div>`).join("") : `<div class="empty">No activity yet.</div>`;
}

/* ---------------------------------------------------------------- trucks */
let inv = {term: "all", avail: "all", sort: "unit", asc: true, q: ""};
function renderInventory() {
  const rows = S.trucks.map(t => ({t, st: truckStatus(t), m: termMonths(t)}));
  const cnt = k => rows.filter(r => k === "all" || termBucket(r.m) === k).length;
  [["cAll", "all"], ["cShort", "short"], ["cMid", "mid"], ["cLong", "long"], ["cExt", "ext"]].forEach(([id, k]) => $("#" + id).textContent = cnt(k));
  let list = rows.filter(r => inv.term === "all" || termBucket(r.m) === inv.term)
    .filter(r => inv.avail === "all" || (inv.avail === "available" && r.st.kind === "available") || (inv.avail === "sold" && r.st.kind === "sold") || (inv.avail === "inpipe" && ["assigned", "hold"].includes(r.st.kind)));
  const q = inv.q.toLowerCase();
  if (q) list = list.filter(r => [r.t.unit, r.t.vin, r.t.year, r.t.miles, r.t.make, r.t.model, driverBy(r.st.deal?.driver_id)?.name].join(" ").toLowerCase().includes(q));
  const key = {unit: r => +r.t.unit || 0, year: r => +r.t.year || 0, miles: r => +r.t.miles || 0, term: r => r.m || 0, total: r => +r.t.price_total || 0}[inv.sort];
  list.sort((a, b) => (key(a) - key(b)) * (inv.asc ? 1 : -1));
  $$("#page-inventory th.sortable").forEach(th => { th.classList.toggle("sorted", th.dataset.sort === inv.sort); th.classList.toggle("asc", inv.asc); });
  $("#invTbody").innerHTML = list.length ? list.map(({t, st, m}) => {
    const drv = st.deal ? driverBy(st.deal.driver_id) : null;
    return `<tr data-truck="${esc(t.unit)}">
      <td class="u">${esc(t.unit)}</td><td>${esc(userBy(t.salesman)?.name || "—")}</td><td>${esc(t.year || "—")}</td>
      <td class="num">${fmt(t.miles)}</td><td>${m ? m + " mo" : "—"}</td><td class="num">${fmtC(t.price_total)}</td>
      <td><span class="pill ${st.kind}">${esc(st.label)}</span> ${drv ? esc(drv.name) : ""}</td>
      <td>${(t.photos || []).length ? "📷 " + t.photos.length : ""}</td></tr>`;
  }).join("") : `<tr><td colspan="8" class="empty">No trucks yet — click "+ Add truck" or send Claude the list.</td></tr>`;
}
function openTruck(u) {
  const t = truckBy(u);
  if (!t) return;
  const st = truckStatus(t);
  const drv = st.deal ? driverBy(st.deal.driver_id) : null;
  const kv = [["Status", `<span class="pill ${st.kind}">${esc(st.label)}</span> ${drv ? esc(drv.name) : ""}`], ["Year / make / model", esc([t.year, t.make, t.model].filter(Boolean).join(" ") || "—")],
    ["VIN", `<span class="mono">${esc(t.vin || "—")}</span>`], ["Miles", fmt(t.miles) + (t.miles_synced ? ` <span class="faint sm">Datatruck ${esc(t.miles_synced.slice(0, 10))}</span>` : "")],
    ["Engine", esc(t.engine || "—")], ["Transmission", esc(t.trans || "—")],
    ["APU / warranty", (t.apu ? "APU" : "No APU") + " · " + (t.warranty ? "Warranty" : "No warranty")], ["Term", termMonths(t) ? `${termMonths(t)} mo (${t.term_weeks || "?"} wks)` : "—"],
    ["Weekly", fmtC(t.weekly)], ["Total price", fmtC(t.price_total)], ...(isAdmin() && t.cost ? [["Cost", fmtC(t.cost)], ["Markup", fmtC(t.price_total - t.cost)]] : []),
    ["Salesman", esc(userBy(t.salesman)?.name || "—")], ["Location", esc(t.location || "—")], ["Notes", esc(t.notes || "—")]];
  modal(`Unit ${esc(t.unit)}`, `<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${(t.photos || []).length ? `<div class="secttl">Photos</div><div class="photos">${t.photos.map((p, i) => `<img src="${esc(p)}" loading="lazy" data-lbunit="${esc(t.unit)}" data-lbi="${i}" alt="Unit ${esc(t.unit)} photo ${i + 1}">`).join("")}</div>` : ""}`,
    `${st.deal ? `<button class="btn" data-deal="${esc(st.deal.id)}">Open deal</button>` : `<button class="btn" data-act="newDeal" data-unit="${esc(t.unit)}">Assign truck</button>`}
     <button class="btn" data-act="copyTruckLink" data-unit="${esc(t.unit)}">Copy ad link</button>
     <button class="btn" data-act="flyer" data-unit="${esc(t.unit)}">Flyer</button>
     <button class="btn primary" data-act="editTruck" data-unit="${esc(t.unit)}">Edit</button>`);
}

/* ---------------------------------------------------------------- pipeline */
let pipe = {mine: false, q: ""};
function renderPipeline() {
  const q = pipe.q.toLowerCase();
  const list = S.deals.filter(d => !isSold(d)).filter(d => !pipe.mine || (me && d.agent_id === me.id))
    .filter(d => !q || [driverBy(d.driver_id)?.name, d.unit, d.id, driverBy(d.driver_id)?.phone].join(" ").toLowerCase().includes(q));
  $("#kanban").innerHTML = STAGES.map(s => {
    const ds = list.filter(d => d.stage === s);
    return `<div class="col" data-drop-stage="${s}"><div class="col-head" style="--c:${stageMeta[s].color}"><b>${stageMeta[s].name}</b> <span class="faint mono">${ds.length}</span><small>${stageMeta[s].short}</small></div>
      <div class="col-body">${ds.map(dealCard).join("") || `<div class="faint sm" style="padding:6px">—</div>`}</div></div>`;
  }).join("");
}
function dealCard(d) {
  const drv = driverBy(d.driver_id) || {};
  const open = (d.tasks || []).filter(t => !t.done);
  const over = open.filter(t => t.due < todayStr()).length;
  const downPaid = (d.installments || []).filter(i => i.paid).reduce((a, i) => a + i.amount, 0);
  const downTot = (d.installments || []).reduce((a, i) => a + i.amount, 0);
  return `<div class="dcard" draggable="true" data-deal="${esc(d.id)}"><div class="n">${esc(drv.name || d.driver_id)}</div>
    <div class="m">${d.unit != null && d.unit !== "" ? "Unit " + esc(d.unit) : "No truck yet"} · ${esc(drv.fleet || "")} · ${esc(userBy(d.agent_id)?.name || "no agent")}</div>
    <div class="tags">${d.plan ? `<span class="pill">${esc(d.plan)}</span>` : ""}${downTot ? `<span class="pill">${fmtC(downPaid)}/${fmtC(downTot)}</span>` : ""}
    ${over ? `<span class="pill red">${over} overdue</span>` : open.length ? `<span class="pill">${open.length} task${open.length > 1 ? "s" : ""}</span>` : ""}</div></div>`;
}

/* ---------------------------------------------------------------- deal edits */
function planParams(p) {
  if (p === "warranty") return {down: 8000, weekly: 1100, splitOverWeeks: 1, label: "Warranty · $8K down + $1,100/wk"};
  if (p === "split") return {down: 5000, weekly: 1000, splitOverWeeks: 5, label: "$5,000 split · 5 wks"};
  return {down: 5000, weekly: 1000, splitOverWeeks: 1, label: "$5,000 upfront"};
}
function buildInstallments(plan, start) {
  const p = planParams(plan), each = p.down / p.splitOverWeeks;
  return Array.from({length: p.splitOverWeeks}, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i * 7); return {n: i + 1, amount: each, due: d.toISOString().slice(0, 10), paid: false}; });
}
const dealLabel = d => `<b>${esc(driverBy(d.driver_id)?.name || d.driver_id)}</b>${d.unit != null && d.unit !== "" ? " — <b>Unit " + esc(d.unit) + "</b>" : ""}`;
async function updateDeal(d, patch, what) {
  const next = {...d, ...patch, updated: nowIso()};
  const ok = await write(async () => { await store.save("deals", d.id, next); if (what) await store.log(what); });
  if (ok) await syncPublic();
  return ok;
}
async function setStage(d, stage) {
  if (d.stage === stage) return;
  const patch = {stage};
  if (stage === "active" && !d.activated) patch.activated = nowIso();
  await updateDeal(d, patch, `moved ${dealLabel(d)} to ${stageMeta[stage].name}`);
}

/* ---------------------------------------------------------------- deal sheet */
let curDeal = null, curTab = "overview";
function openDeal(id) {
  const d = dealBy(id);
  if (!d) return;
  closeModal();
  curDeal = d; curTab = "overview";
  renderSheet();
  $("#sheet").classList.add("on"); $("#sheetOverlay").classList.add("on");
}
function closeSheet() { $("#sheet").classList.remove("on"); $("#sheetOverlay").classList.remove("on"); curDeal = null; }
function renderSheet() {
  const d = curDeal, drv = driverBy(d.driver_id) || {}, t = truckBy(d.unit) || {};
  $("#sAvatar").textContent = initials(drv.name);
  $("#sName").textContent = drv.name || d.driver_id;
  $("#sMeta").textContent = [d.id, d.unit != null && d.unit !== "" ? "Unit " + d.unit : null, isSold(d) ? "Sold · " + soldCalc(d).status : stageMeta[d.stage]?.name, drv.fleet].filter(Boolean).join(" · ");
  $$("#sheetTabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === curTab));
  const body = $("#sheetBody");
  const ck = (field, ok, label, extra = "") => `<label class="ci"><input type="checkbox" data-deal-check="${field}" ${ok ? "checked" : ""} style="width:auto"> ${label} ${extra}</label>`;
  if (curTab === "overview") {
    const downOk = (d.installments || []).length > 0 && d.installments.every(i => i.paid);
    body.innerHTML = `<dl class="kv">
      <dt>Driver</dt><dd><a href="#" data-act="editDriver" data-id="${esc(drv.id)}">${esc(drv.name || "—")}</a> ${drv.phone ? `· <a href="tel:${esc(drv.phone)}">${esc(drv.phone)}</a>` : ""}</dd>
      <dt>Fleet / position</dt><dd>${esc([drv.fleet, drv.position, drv.pay].filter(Boolean).join(" · ") || "—")}</dd>
      <dt>Truck</dt><dd>${d.unit != null && d.unit !== "" ? `<a href="#" data-truck="${esc(d.unit)}">Unit ${esc(d.unit)}</a> · ${esc([t.year, t.make, t.model].filter(Boolean).join(" "))}` : "—"}</dd>
      <dt>Stage</dt><dd>${isSold(d) ? "Sold" : `<select data-deal-field="stage" style="width:auto">${STAGES.map(s => `<option value="${s}" ${s === d.stage ? "selected" : ""}>${stageMeta[s].name}</option>`).join("")}</select>`}</dd>
      <dt>Plan</dt><dd>${esc(planParams(d.plan).label)}</dd>
      <dt>Sales agent</dt><dd>${esc(userBy(d.agent_id)?.name || "—")}</dd>
      <dt>Est. weekly gross</dt><dd>${fmtC(d.gross)}</dd>
      <dt>Created</dt><dd>${esc((d.created || "").slice(0, 10))}</dd></dl>
      ${isSold(d) ? "" : `<div class="secttl">Agreement checklist</div><div class="checklist">
      ${ck("agreement_sent", !!d.agreement_sent, "Agreement sent", d.agreement_sent ? `<span class="faint sm">${esc(d.agreement_sent.slice(0, 10))}</span>` : "")}
      ${ck("agreement_signed", !!d.agreement_signed, "Agreement signed", d.agreement_signed ? `<span class="faint sm">${esc(d.agreement_signed.slice(0, 10))}</span>` : "")}
      ${ck("escrow_paid", !!d.escrow_paid, "Escrow received")}
      <div class="ci">${downOk ? "✅" : "⬜"} Down payment complete <span class="faint sm">(Payments tab)</span></div>
      ${ck("activated", d.stage === "active", "Dispatched")}</div>`}
      <div class="secttl">Follow-ups</div>
      ${(d.tasks || []).map(x => taskRow({...x, deal: d, driver: drv})).join("") || `<div class="faint sm">None</div>`}
      <form class="btnrow" style="margin-top:8px" data-form="addTask"><input name="body" placeholder="New follow-up…" style="flex:1;min-width:160px"><input name="due" type="date" value="${todayStr()}" style="width:150px"><button class="btn sm">Add</button></form>
      <div class="secttl">Notes</div>
      ${(d.notes || []).slice().reverse().map(n => `<div class="note">${esc(n.body)}<small>${esc(n.who)} · ${esc((n.ts || "").slice(0, 16).replace("T", " "))}</small></div>`).join("") || `<div class="faint sm">No notes</div>`}
      <form data-form="addNote"><textarea name="body" placeholder="Add a note…" style="min-height:60px"></textarea><button class="btn sm" style="margin-top:6px">Add note</button></form>
      <div class="btnrow" style="margin-top:14px"><button class="btn primary" data-act="editDeal">Edit deal</button>${isSold(d) ? "" : `<button class="btn" data-act="markSold">Mark as sold</button>`}<button class="btn" data-act="contract">Contract summary</button>
      ${isAdmin() ? `<button class="btn danger" data-act="deleteDeal">Delete</button>` : ""}</div>`;
  } else if (curTab === "payments") {
    const ins = d.installments || [];
    body.innerHTML = `<div class="secttl">Down payment installments</div>` + (ins.length ? `<table><thead><tr><th>#</th><th class="num">Amount</th><th>Due</th><th>Paid</th></tr></thead><tbody>
      ${ins.map((i, k) => `<tr><td>${i.n}</td><td class="num">${fmtC(i.amount)}</td><td>${esc(i.due)}</td><td><label><input type="checkbox" data-inst="${k}" ${i.paid ? "checked" : ""} style="width:auto"> ${i.paid ? esc((i.paid_date || "").slice(0, 10)) : i.due < todayStr() ? '<span class="bad">overdue</span>' : ""}</label></td></tr>`).join("")}
      </tbody></table>` : `<div class="faint sm">No installments — set a plan in Edit deal.</div>`) +
      `<div class="secttl">Escrow</div><label class="ci"><input type="checkbox" data-deal-check="escrow_paid" ${d.escrow_paid ? "checked" : ""} style="width:auto"> Received · ${fmtC(S.fees.esc)}</label>`;
  } else if (curTab === "received") {
    if (!isSold(d)) { body.innerHTML = `<div class="faint">Weekly payments are tracked once the truck is sold. Use “Mark as sold” on the Overview tab.</div>`; return; }
    const c = soldCalc(d), s = d.sold;
    body.innerHTML = `<dl class="kv"><dt>Sold date</dt><dd>${esc(s.date || "—")}</dd><dt>Status</dt><dd>${esc(c.status)}</dd>
      ${isAdmin() ? `<dt>Acquisition cost</dt><dd>${fmtC(s.acq_cost)}</dd>` : ""}<dt>Loan amount</dt><dd>${fmtC(s.loan)}</dd><dt>Down payment</dt><dd>${fmtC(s.down)}</dd>
      <dt>Weekly</dt><dd>${fmtC(c.weekly)} · ${esc(s.term_months || "?")} mo</dd><dt>Weeks paid</dt><dd>${c.weeksPaid} of ${c.termW || "?"}</dd>
      <dt>Collected</dt><dd>${fmtC(c.collected)}</dd><dt>Remaining</dt><dd>${fmtC(c.remaining)}</dd></dl>
      <div class="progress"><i style="width:${(c.pct * 100).toFixed(1)}%"></i></div>
      <div class="secttl">Payment log</div>
      ${(s.payments || []).length ? `<table><thead><tr><th>Date</th><th class="num">Amount</th><th>Method</th><th>Note</th>${isAdmin() ? "<th></th>" : ""}</tr></thead><tbody>${s.payments.map((p, k) => ({p, k})).sort((a, b) => b.p.date.localeCompare(a.p.date)).map(({p, k}) => `<tr><td>${esc(p.date)}</td><td class="num">${fmtC(p.amount)}</td><td>${esc(p.method)}</td><td>${esc(p.note)}</td>${isAdmin() ? `<td><button class="btn ghost sm" data-del-pay="${k}">✕</button></td>` : ""}</tr>`).join("")}</tbody></table>` : `<div class="faint sm">No individual payments logged — weeks paid: ${c.weeksPaid}.</div>`}
      <div class="btnrow" style="margin-top:14px"><button class="btn primary" data-act="logPayment">Log a payment</button><button class="btn" data-act="editSold">Edit sale terms</button></div>`;
  } else {
    const nm = (drv.name || "").toLowerCase();
    const acts = (S.activity || []).filter(a => a.what.includes(d.id) || (nm && a.what.toLowerCase().includes(nm)) || (d.unit != null && d.unit !== "" && a.what.includes("Unit " + d.unit)));
    body.innerHTML = acts.map(x => `<div class="note"><b>${esc(x.who)}</b> ${safeActivity(x.what)}<small>${esc(x.ts.slice(0, 16).replace("T", " "))}</small></div>`).join("") || `<div class="faint">No activity.</div>`;
  }
}

/* ---------------------------------------------------------------- sold */
let sold = {status: "all", q: "", sort: "date", asc: false};
function renderSold() {
  const st = soldTotals();
  $("#soldSummary").innerHTML = `<div class="soldsum">
    ${kpiBox("Sold trucks", st.count, `${st.active} active`)}${isAdmin() ? kpiBox("Collected to date", fmtK(st.collected), "down + weekly", "good") + kpiBox("Remaining to collect", fmtK(st.remaining), "active leases") + kpiBox("Monthly run-rate", fmtK(st.monthly), "at full collection") : ""}</div>
    ${isAdmin() && st.active ? forecastCard(st.activeList) + healthCard(st) : ""}`;
  $("#soldFilters").innerHTML = ["all", ...SOLD_STATUSES].map(s => `<button class="chip ${sold.status === s ? "on" : ""}" data-sold-status="${s}">${s === "all" ? "All" : s} <span class="n">${s === "all" ? st.count : st.all.filter(x => x.c.status === s).length}</span></button>`).join("")
    + `<div class="filtergap"></div>` + [["date", "Sold date"], ["remaining", "Remaining"], ["unit", "Unit"]].map(([k, l]) => `<button class="chip ${sold.sort === k ? "on" : ""}" data-sold-sort="${k}">${l}${sold.sort === k ? (sold.asc ? " ↑" : " ↓") : ""}</button>`).join("");
  const q = sold.q.toLowerCase();
  const list = st.all.filter(x => sold.status === "all" || x.c.status === sold.status)
    .filter(x => !q || [x.d.unit, driverBy(x.d.driver_id)?.name, x.d.sold.vin].join(" ").toLowerCase().includes(q));
  const key = {date: x => x.d.sold.date || "", remaining: x => x.c.remaining, unit: x => +x.d.unit || 0}[sold.sort];
  list.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * (sold.asc ? 1 : -1));
  $("#soldList").innerHTML = `<div class="tablewrap"><div class="tscroll"><table><thead><tr><th>Unit</th><th>Driver</th><th>Sold</th><th>Status</th>
    <th class="num">Weekly</th><th>Paid</th><th class="num">Collected</th><th class="num">Remaining</th><th>Last payment</th></tr></thead><tbody>
    ${list.map(({d, c}) => `<tr data-deal="${esc(d.id)}"><td class="u">${esc(d.unit)}</td><td>${esc(driverBy(d.driver_id)?.name || d.driver_id)}</td><td>${esc(d.sold.date || "—")}</td>
      <td><span class="pill ${c.status === "Active" ? "available" : c.status === "Paid off" ? "sold" : "red"}">${esc(c.status)}</span></td>
      <td class="num">${fmtC(c.weekly)}</td><td><div class="progress" title="${c.weeksPaid}/${c.termW} weeks"><i style="width:${(c.pct * 100).toFixed(0)}%"></i></div><span class="faint sm">${c.weeksPaid}/${c.termW || "?"} wks</span></td>
      <td class="num">${fmtC(c.collected)}</td><td class="num">${fmtC(c.remaining)}</td><td class="${c.lastPay && daysSince(c.lastPay) > 14 ? "bad" : ""}">${esc(c.lastPay || "—")}</td></tr>`).join("")
      || `<tr><td colspan="9" class="empty">No sold trucks yet — click "+ Add sold truck" or send Claude the list.</td></tr>`}
    </tbody></table></div></div>`;
}
const kpiBox = (l, v, s, cls = "") => `<div class="kpi"><div class="label">${l}</div><div class="val num ${cls}">${v}</div><div class="delta">${s}</div></div>`;
function forecastCard(active) {
  const months = 12, buckets = Array(months).fill(0);
  active.forEach(({c}) => { let rem = c.remaining; for (let i = 0; i < months && rem > 0; i++) { const m = Math.min(rem, c.monthly); buckets[i] += m; rem -= m; } });
  const max = Math.max(...buckets, 1);
  const lbl = i => { const x = new Date(); x.setMonth(x.getMonth() + i + 1, 1); return x.toLocaleString("en-US", {month: "short"}); };
  return `<div class="card"><div class="card-head"><h3>Cash-flow forecast · next 12 months</h3><span class="muted sm">${fmtK(buckets.reduce((a, b) => a + b, 0))} expected</span></div>
    <div class="bars">${buckets.map(b => `<div class="b" style="height:${(b / max * 100).toFixed(1)}%" data-v="${fmtC(b)}"></div>`).join("")}</div>
    <div class="barlbl">${buckets.map((_, i) => `<span>${lbl(i)}</span>`).join("")}</div></div>`;
}
function healthCard(st) {
  const late = st.activeList.filter(x => x.c.lastPay && daysSince(x.c.lastPay) > 14).length;
  const avgPct = st.activeList.reduce((a, x) => a + x.c.pct, 0) / (st.active || 1);
  return `<div class="card"><div class="card-head"><h3>Portfolio health</h3></div><div class="pad wk">
    <span>Active leases paying on time (≤14 days since last logged payment)</span><b>${st.active - late}/${st.active}</b>
    <span>Accident / returned / paid off</span><b>${st.count - st.active}</b>
    <span>Average progress to payoff</span><b>${(avgPct * 100).toFixed(0)}%</b></div></div>`;
}

/* ---------------------------------------------------------------- follow-ups */
function renderFollowups() {
  const t = todayStr(), wk = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const all = allTasks();
  const groups = [["Overdue", all.filter(x => !x.done && x.due < t)], ["Today", all.filter(x => !x.done && x.due === t)],
    ["Next 7 days", all.filter(x => !x.done && x.due > t && x.due <= wk)], ["Later", all.filter(x => !x.done && x.due > wk)],
    ["Done (last 14 days)", all.filter(x => x.done && daysSince(x.done_at) <= 14)]];
  $("#fuGroups").innerHTML = groups.map(([n, l]) => `<div class="card"><div class="card-head"><h3>${n} <span class="faint mono">${l.length}</span></h3></div>
    ${l.sort((a, b) => a.due.localeCompare(b.due)).map(taskRow).join("") || `<div class="empty">—</div>`}</div>`).join("");
}

/* ---------------------------------------------------------------- drivers */
let drv = {fleet: "all", contact: "all", q: "", view: LS.get("dispatch-drv-view", "table")};
function renderDrivers() {
  const rows = S.drivers.map(d => ({d, cs: driverContactStatus(d)}));
  $("#drvFleetChips").innerHTML = ["all", ...FLEETS].map(f => `<button class="chip ${drv.fleet === f ? "on" : ""}" data-drv-fleet="${f}">${f === "all" ? "All" : f} <span class="n">${rows.filter(r => f === "all" || r.d.fleet === f).length}</span></button>`).join("");
  $("#drvContactChips").innerHTML = [["all", "All contact status"], ["uncontacted", "Not contacted"], ["working", "Being worked"], ["pipeline", "In pipeline"], ["active", "Active lease"]]
    .map(([k, l]) => `<button class="chip ${drv.contact === k ? "on" : ""}" data-drv-contact="${k}">${l}${k !== "all" ? ` <span class="n">${rows.filter(r => r.cs.kind === k).length}</span>` : ""}</button>`).join("");
  $$("#drvView button").forEach(b => b.classList.toggle("on", b.dataset.view === drv.view));
  const q = drv.q.toLowerCase();
  const list = rows.filter(r => drv.fleet === "all" || r.d.fleet === drv.fleet).filter(r => drv.contact === "all" || r.cs.kind === drv.contact)
    .filter(r => !q || [r.d.name, r.d.phone, r.d.email, r.d.fleet].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (a.d.name || "").localeCompare(b.d.name || ""));
  const digits = p => String(p || "").replace(/\D/g, "");
  const actions = d => d.phone ? `<a class="btn ghost sm" href="tel:${esc(d.phone)}">📞</a><a class="btn ghost sm" href="sms:${esc(d.phone)}">💬</a><a class="btn ghost sm" href="https://wa.me/1${digits(d.phone).slice(-10)}" target="_blank" rel="noopener">WA</a>` : "";
  $("#driverGrid").hidden = drv.view !== "cards";
  $("#driverTable").hidden = drv.view !== "table";
  if (drv.view === "cards") {
    $("#driverGrid").innerHTML = list.map(({d, cs}) => `<div class="dvcard" data-driver="${esc(d.id)}"><div class="top"><div class="avatar">${initials(d.name)}</div><div><b>${esc(d.name)}</b><div class="faint sm">${esc([d.fleet, d.position, d.pay].filter(Boolean).join(" · "))}</div></div></div>
      <span class="pill ${cs.cls}">${esc(cs.label)}</span><div class="muted sm" style="margin-top:6px">${esc(d.phone || "no phone")}${cs.deal?.unit != null ? " · Unit " + esc(cs.deal.unit) : ""}</div><div class="acts">${actions(d)}</div></div>`).join("") || `<div class="empty">No drivers.</div>`;
  } else {
    $("#driverTable").innerHTML = `<div class="tablewrap"><div class="tscroll"><table><thead><tr><th>Name</th><th>Fleet</th><th>Position</th><th>Phone</th><th>Status</th><th>Truck</th><th>Salesman</th><th></th></tr></thead><tbody>
      ${list.map(({d, cs}) => `<tr data-driver="${esc(d.id)}"><td><b>${esc(d.name)}</b></td><td>${esc(d.fleet || "—")}</td><td>${esc([d.position, d.pay].filter(Boolean).join(" · ") || "—")}</td>
        <td class="mono">${esc(d.phone || "—")}</td><td><span class="pill ${cs.cls}">${esc(cs.label)}</span></td><td>${cs.deal?.unit != null ? "Unit " + esc(cs.deal.unit) : "—"}</td>
        <td>${esc(userBy(d.salesman)?.name || "—")}</td><td>${actions(d)}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">No drivers yet.</td></tr>`}</tbody></table></div></div>`;
  }
}
function openDriver(id) {
  const d = driverBy(id);
  if (!d) return;
  const cs = driverContactStatus(d);
  modal(esc(d.name), `<dl class="kv"><dt>Fleet</dt><dd>${esc(d.fleet || "—")}</dd><dt>Position / pay</dt><dd>${esc([d.position, d.pay].filter(Boolean).join(" · ") || "—")}</dd>
    <dt>Phone</dt><dd>${d.phone ? `<a href="tel:${esc(d.phone)}">${esc(d.phone)}</a>` : "—"}</dd><dt>Email</dt><dd>${esc(d.email || "—")}</dd>
    <dt>CDL</dt><dd>${esc(d.cdl || "—")}</dd><dt>Tenure</dt><dd>${esc(d.tenure || "—")}</dd><dt>Salesman</dt><dd>${esc(userBy(d.salesman)?.name || "—")}</dd><dt>Status</dt><dd>${esc(cs.label)}</dd><dt>Notes</dt><dd>${esc(d.notes || "—")}</dd></dl>`,
    `<button class="btn" data-act="copyDriver" data-id="${esc(d.id)}">Copy info</button><button class="btn" data-act="editDriver" data-id="${esc(d.id)}">Edit</button>
     ${cs.deal ? `<button class="btn primary" data-deal="${esc(cs.deal.id)}">Open deal</button>` : `<button class="btn primary" data-act="newDeal" data-driver="${esc(d.id)}">Assign truck</button>`}`);
}

/* ---------------------------------------------------------------- KPI */
let kpiPeriod = "month";
function inPeriod(ts) {
  if (!ts) return false;
  const d = new Date(ts), n = new Date();
  if (kpiPeriod === "month") return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
  if (kpiPeriod === "year") return d.getFullYear() === n.getFullYear();
  return true;
}
const isKpiEligible = d => isSold(d) || (d.stage === "active" && d.agreement_signed && d.escrow_paid && (d.installments || []).every(i => i.paid));
function renderKpi() {
  $$("#kpiPeriod button").forEach(b => b.classList.toggle("on", b.dataset.period === kpiPeriod));
  const rows = S.users.filter(u => u.is_sales && u.active !== false).map(u => {
    const deals = S.deals.filter(d => d.agent_id === u.id);
    const closed = deals.filter(d => isKpiEligible(d) && inPeriod(isSold(d) ? d.sold.date : d.activated));
    return {u, closed: closed.length, comm: closed.length * (+S.fees.commission || 0)};
  }).sort((a, b) => b.closed - a.closed);
  const max = Math.max(1, ...rows.map(r => r.closed));
  const badge = r => r.closed >= 10 ? "🏆" : r.closed >= 5 ? "🥇" : r.closed >= 1 ? "⭐" : "";
  $("#kpiContent").innerHTML = `<div class="kpigrid g3">${kpiBox("Deals closed", rows.reduce((a, r) => a + r.closed, 0), "eligible for commission")}
    ${kpiBox("Commission earned", fmtC(rows.reduce((a, r) => a + r.comm, 0)), fmtC(S.fees.commission) + " per truck")}${kpiBox("Open deals", openDeals().length, "in pipeline")}</div>
    <div class="card"><div class="card-head"><h3>Leaderboard</h3></div><div class="leader">
    ${rows.map((r, i) => `<div class="lr"><b class="mono">${i + 1}</b><span>${esc(r.u.name)} ${badge(r)}</span><div class="lbw"><div class="lb" style="width:${(r.closed / max * 100).toFixed(0)}%;background:${esc(r.u.color || "var(--accent)")}"></div></div><span class="mono">${r.closed} · ${fmtC(r.comm)}</span></div>`).join("") || `<div class="empty">No sales users.</div>`}
    </div></div>`;
}

/* ---------------------------------------------------------------- settings */
const FEE_DEFS = [
  ["commission", "Sales commission", "Flat amount earned by the sales agent per truck sold, when a deal reaches Active with all docs done.", v => fmtC(v)],
  ["dispatch", "Dispatch fee", "Percentage of gross retained for dispatch services on every load.", v => v + "%"],
  ["mile", "Mileage fee", "Per-mile charge on all loaded miles.", v => Math.round(v * 100) + "¢"],
  ["admin", "Admin fee", "Weekly administrative fee — settlements, IFTA, permits.", v => fmtC(v)],
  ["trailer", "Trailer rental", "Weekly trailer rental.", v => fmtC(v)],
  ["ins", "Insurance", "Weekly commercial insurance charge.", v => fmtC(v)],
  ["oci", "OCI", "Weekly occupational / cargo insurance charge.", v => fmtC(v)],
  ["esc", "Escrow (one-time)", "Held on account for damages and end-of-lease reconciliation.", v => fmtC(v)],
  ["payout", "Standard driver payout", "Percent of gross paid to the driver on the standard plan.", v => v + "%"],
  ["contact_phone", "Contact phone (ads page)", "Shown on the driver ads page so drivers can call about a truck.", v => v || "—"],
];
function renderFees() {
  renderSubnavs();
  $("#feesGrid").innerHTML = FEE_DEFS.map(([k, n, d, f]) => `<div class="fee"><div class="fname">${n}</div><div class="fdesc">${d}</div>
    <div class="frow"><span class="fval">${esc(f(S.fees[k] ?? ""))}</span><input data-fee="${k}" value="${esc(S.fees[k] ?? "")}" ${isAdmin() ? "" : "disabled"}></div></div>`).join("")
    + `<div class="fee"><div class="fname">Warranty plan pricing</div><div class="fdesc">Fixed at <b>$8,000 down</b> + <b>$1,100/week</b> instead of $5,000 down + $1,000/week.</div><div class="frow"><span class="fval muted" style="font-size:14px">Built into plan</span></div></div>`;
}
function computeDeal(t, gross, miles, plan, fees) {
  const p = planParams(plan);
  const mile = miles * fees.mile;
  const weekly = (t && +t.weekly) || p.weekly;
  const splitDown = plan === "split" ? 1000 : 0;
  const driverGross = gross * fees.payout / 100;
  const net = driverGross - mile - fees.admin - fees.trailer - fees.ins - fees.oci - weekly - splitDown;
  return {rows: [["Weekly gross", gross], [`Company share (${100 - fees.payout}% incl. ${fees.dispatch}% dispatch)`, -(gross - driverGross)], [`Mileage (${miles} × $${fees.mile})`, -mile],
    ["Admin", -fees.admin], ["Trailer", -fees.trailer], ["Insurance", -fees.ins], ["OCI", -fees.oci], ["Truck payment", -weekly], ...(splitDown ? [["Down-payment installment", -splitDown]] : [])], net, p};
}
let calcPlan = "standard";
function renderCalculator() {
  renderSubnavs();
  const sel = $("#cTruck");
  const avail = S.trucks.filter(t => truckStatus(t).kind !== "sold");
  if (sel.options.length !== avail.length + 1) sel.innerHTML = `<option value="">— Any truck —</option>` + avail.map(t => `<option value="${esc(t.unit)}">Unit ${esc(t.unit)} · ${esc(t.year || "")} · ${fmt(t.miles)} mi</option>`).join("");
  $$("#cPlan .opt").forEach(o => o.classList.toggle("on", o.dataset.plan === calcPlan));
  const t = truckBy(sel.value);
  $("#cTruckHint").textContent = t ? `${fmtC(t.weekly || 1000)}/wk · ${termMonths(t) || "?"} mo · total ${fmtC(t.price_total)}` : "";
  const r = computeDeal(t, +$("#cGross").value.replace(/\D/g, "") || 0, +$("#cMiles").value.replace(/\D/g, "") || 0, calcPlan, S.fees);
  $("#calcOut").innerHTML = `<div class="card">${r.rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span class="mono">${v < 0 ? "−" : ""}${fmtC(Math.abs(v))}</span></div>`).join("")}
    <div class="row total"><span>Driver take-home</span><span class="mono ${r.net < 0 ? "bad" : ""}">${fmtC(r.net)}</span></div>
    <div class="row"><span class="muted">Plan</span><span>${esc(r.p.label)} · escrow ${fmtC(S.fees.esc)} one-time</span></div></div>`;
}
function renderUsers() {
  renderSubnavs();
  $("#usersList").innerHTML = `<div class="tablewrap"><div class="tscroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Commission</th><th>Access</th><th class="num">Deals</th><th></th></tr></thead><tbody>
    ${S.users.map(u => `<tr><td><span class="avatar" style="display:inline-grid;width:24px;height:24px;font-size:10px;margin-right:8px;vertical-align:middle">${initials(u.name)}</span>${esc(u.name)}</td><td>${esc(u.email || "")}</td><td>${esc(u.role)}</td>
      <td>${u.is_sales ? "Yes" : "No"}</td><td>${u.active === false ? '<span class="pill red">Disabled</span>' : '<span class="pill available">Active</span>'}</td><td class="num">${S.deals.filter(d => d.agent_id === u.id).length}</td>
      <td>${isAdmin() ? `<button class="btn ghost sm" data-act="editUser" data-id="${esc(u.id)}">Edit</button>` : ""}</td></tr>`).join("")}
    </tbody></table></div></div>`;
}

/* ---------------------------------------------------------------- forms */
function modal(title, body, foot = "") {
  $("#modal").innerHTML = `<div class="mh"><h3>${title}</h3><button class="sheet-close" data-act="closeModal">✕</button></div><div class="mb">${body}</div><div class="mf">${foot}<button class="btn ghost" data-act="closeModal">Close</button></div>`;
  $("#modalOverlay").classList.add("on");
}
function closeModal() { $("#modalOverlay").classList.remove("on"); }
// fields: {k, l, v, type: text|number|date|select|area|check, options:[[value,label]], ph, full}
let formSubmit = null;
function form(title, fields, onSubmit, extraFoot = "") {
  const opt = o => Array.isArray(o) ? o : [o, o];
  const input = f => f.type === "select" ? `<select name="${f.k}">${f.options.map(o => { const [v, l] = opt(o); return `<option value="${esc(v)}" ${String(v) === String(f.v ?? "") ? "selected" : ""}>${esc(l)}</option>`; }).join("")}</select>`
    : f.type === "area" ? `<textarea name="${f.k}" placeholder="${esc(f.ph || "")}">${esc(f.v ?? "")}</textarea>`
    : f.type === "check" ? `<label class="ci"><input type="checkbox" name="${f.k}" ${f.v ? "checked" : ""} style="width:auto"> ${esc(f.l)}</label>`
    : `<input name="${f.k}" type="${f.type || "text"}" value="${esc(f.v ?? "")}" placeholder="${esc(f.ph || "")}" ${f.type === "number" ? 'step="any"' : ""} ${f.req ? "required" : ""}>`;
  modal(title, `<form id="mform" class="grid2">${fields.map(f => `<div class="field" ${f.full || f.type === "area" ? 'style="grid-column:1/-1"' : ""}>${f.type === "check" ? "" : `<label>${esc(f.l)}${f.req ? " *" : ""}</label>`}${input(f)}</div>`).join("")}<button hidden></button></form>`,
    `${extraFoot}<button class="btn primary" data-act="submitForm">Save</button>`);
  formSubmit = async () => {
    const fd = {};
    fields.forEach(f => {
      const el = $(`#mform [name="${f.k}"]`);
      let v = f.type === "check" ? el.checked : el.value.trim();
      if (f.type === "number") v = v === "" ? null : +v;
      fd[f.k] = v;
    });
    const missing = fields.filter(f => f.req && (fd[f.k] === "" || fd[f.k] == null));
    if (missing.length) return toast("Required: " + missing.map(f => f.l).join(", "));
    if (await onSubmit(fd) !== false) closeModal();
  };
}
const userOpts = (blank = "—") => [["", blank], ...S.users.filter(u => u.active !== false).map(u => [u.id, u.name])];
const lines = s => String(s || "").split(/\n+/).map(x => x.trim()).filter(Boolean);
const stripNulls = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== ""));

async function syncPublic() {
  // keep the public ads collection in step: for-sale trucks only, whitelisted fields
  if (store.demo || !store.saveDirect) return;
}
const FORMS = {
  newTruck: () => truckForm(null),
  editTruck: el => truckForm(truckBy(el.dataset.unit)),
  newDriver: () => driverForm(null),
  editDriver: el => driverForm(driverBy(el.dataset.id)),
  newDeal: el => {
    const avail = S.trucks.filter(t => truckStatus(t).kind === "available");
    form("Assign truck", [
      {k: "driver_id", l: "Driver", type: "select", options: [["", "— new driver (type name below) —"], ...S.drivers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(d => [d.id, d.name])], v: el?.dataset.driver || ""},
      {k: "new_name", l: "New driver name", ph: "only if not in the list"},
      {k: "unit", l: "Truck", type: "select", options: [["", "— no truck yet (working) —"], ...avail.map(t => [t.unit, `Unit ${t.unit} · ${t.year || ""} · ${fmt(t.miles)} mi`])], v: el?.dataset.unit || ""},
      {k: "plan", l: "Plan", type: "select", options: [["standard", "$5,000 upfront"], ["split", "$5,000 split · 5 wks"], ["warranty", "Warranty · $8K down"]], v: "standard"},
      {k: "agent_id", l: "Sales agent", type: "select", options: userOpts(), v: me?.id},
      {k: "gross", l: "Est. weekly gross", type: "number", v: 12000},
      {k: "note", l: "Note", type: "area"}], async f => {
        let driverId = f.driver_id;
        if (!driverId) {
          if (!f.new_name) return toast("Pick a driver or type a new name"), false;
          driverId = nextId(S.drivers, "D-", 101);
          if (!await write(() => store.save("drivers", driverId, {id: driverId, name: f.new_name, created: nowIso()}))) return false;
        }
        const id = nextId(S.deals, "S-", 1001);
        const unit = f.unit === "" ? null : (isNaN(f.unit) ? f.unit : +f.unit);
        const deal = {id, driver_id: driverId, unit, stage: unit != null ? "assigned" : "working", plan: f.plan, agent_id: f.agent_id || null, gross: f.gross,
          installments: buildInstallments(f.plan, todayStr()), notes: f.note ? [{ts: nowIso(), who: me?.name, body: f.note}] : [],
          tasks: unit != null ? [{id: "T-1", body: "Send lease agreement to driver", due: todayStr(), done: false, kind: "agreement"}] : [], created: nowIso()};
        const ok = await write(async () => { await store.save("deals", id, deal); await store.log(`created deal for ${dealLabel(deal)}`); }, "Deal created");
        if (ok) { await syncPublic(); setTimeout(() => openDeal(id), 300); }
      });
  },
  editDeal: () => {
    const d = curDeal;
    const units = S.trucks.filter(t => truckStatus(t).kind === "available" || String(t.unit) === String(d.unit));
    form(`Edit ${esc(d.id)}`, [
      {k: "unit", l: "Truck", type: "select", options: [["", "— none —"], ...units.map(t => [t.unit, "Unit " + t.unit])], v: d.unit ?? ""},
      {k: "plan", l: "Plan", type: "select", options: [["standard", "$5,000 upfront"], ["split", "$5,000 split · 5 wks"], ["warranty", "Warranty · $8K down"]], v: d.plan || "standard"},
      {k: "agent_id", l: "Sales agent", type: "select", options: userOpts(), v: d.agent_id || ""},
      {k: "gross", l: "Est. weekly gross", type: "number", v: d.gross}], async f => {
        const patch = {unit: f.unit === "" ? null : (isNaN(f.unit) ? f.unit : +f.unit), plan: f.plan, agent_id: f.agent_id || null, gross: f.gross};
        if (f.plan !== d.plan && !(d.installments || []).some(i => i.paid)) patch.installments = buildInstallments(f.plan, todayStr());
        await updateDeal(d, patch, `updated ${dealLabel({...d, ...patch})}`);
      });
  },
  markSold: () => soldForm(curDeal),
  editSold: () => soldForm(curDeal),
  newSold: () => soldForm(null),
  logPayment: () => {
    const d = curDeal;
    form(`Log payment · ${esc(d.id)}`, [
      {k: "amount", l: "Amount", type: "number", v: d.sold?.weekly, req: true}, {k: "date", l: "Date", type: "date", v: todayStr(), req: true},
      {k: "method", l: "Method", type: "select", options: ["settlement", "zelle", "cash", "check", "wire"], v: "settlement"},
      {k: "weeks", l: "Weeks covered", type: "number", v: 1}, {k: "note", l: "Note", full: true}], async f => {
        const sold = {...d.sold, payments: [...(d.sold.payments || []), {date: f.date, amount: f.amount, method: f.method, note: f.note}], weeks_paid: (+d.sold.weeks_paid || 0) + (+f.weeks || 0)};
        await updateDeal(d, {sold}, `recorded payment ${fmtC(f.amount)} on ${dealLabel(d)}`);
      });
  },
  newUser: () => form("Invite user", [
    {k: "name", l: "Name", req: true}, {k: "email", l: "Email", type: "email", req: true},
    {k: "role", l: "Role", type: "select", options: [["sales", "Sales"], ["admin", "Admin"]], v: "sales"}, {k: "is_sales", l: "Earns commission", type: "check", v: true}], async f => {
      if (store.demo) return write(() => store.save("users", "U-" + Date.now(), {id: "U-" + Date.now(), ...f, active: true}), "Demo user added");
      try {
        // create the login on a secondary app so the admin stays signed in, then email a set-password link
        const sec = firebase.apps.find(a => a.name === "invite") || firebase.initializeApp(FB, "invite");
        const tmp = crypto.getRandomValues(new Uint32Array(4)).join("-") + "Aa!";
        const cred = await sec.auth().createUserWithEmailAndPassword(f.email, tmp);
        const uid = cred.user.uid;
        await sec.auth().signOut();
        await store.save("users", uid, {id: uid, name: f.name, email: f.email, role: f.role, is_sales: f.is_sales, active: true, created: nowIso()});
        await store.auth.sendPasswordResetEmail(f.email);
        await store.log(`invited user <b>${esc(f.name)}</b>`);
        toast(`Invited — ${f.email} got an email to set a password`);
      } catch (e) { err(e); return false; }
    }),
  editUser: el => {
    const u = userBy(el.dataset.id);
    form(`Edit ${esc(u.name)}`, [
      {k: "name", l: "Name", v: u.name, req: true}, {k: "role", l: "Role", type: "select", options: [["sales", "Sales"], ["admin", "Admin"]], v: u.role},
      {k: "is_sales", l: "Earns commission", type: "check", v: u.is_sales}, {k: "active", l: "Can log in (uncheck to disable)", type: "check", v: u.active !== false}], async f => {
        if (u.id === me.id && (!f.active || f.role !== "admin")) return toast("You can't remove your own admin access"), false;
        await write(async () => { await store.save("users", u.id, f); await store.log(`updated user <b>${esc(f.name)}</b>${f.active ? "" : " (disabled)"}`); }, "User saved");
      }, store.demo ? "" : `<button class="btn" data-act="resetPw" data-email="${esc(u.email || "")}">Send password reset</button>`);
  },
};
function truckForm(t) {
  const isNew = !t; t = t || {make: "Freightliner", model: "Cascadia", weekly: 1000};
  form(isNew ? "Add truck" : `Edit Unit ${esc(t.unit)}`, [
    {k: "unit", l: "Unit", v: t.unit, req: true}, {k: "year", l: "Year", type: "number", v: t.year},
    {k: "make", l: "Make", v: t.make}, {k: "model", l: "Model", v: t.model},
    {k: "vin", l: "VIN (17 chars)", v: t.vin}, {k: "miles", l: "Miles", type: "number", v: t.miles},
    {k: "price_total", l: "Total price", type: "number", v: t.price_total}, {k: "weekly", l: "Weekly payment", type: "number", v: t.weekly},
    {k: "term_weeks", l: "Term (weeks)", type: "number", v: t.term_weeks}, ...(isAdmin() ? [{k: "cost", l: "Our cost (admin only)", type: "number", v: t.cost}] : []),
    {k: "engine", l: "Engine", v: t.engine}, {k: "trans", l: "Transmission", v: t.trans},
    {k: "salesman", l: "Salesman", type: "select", options: userOpts(), v: t.salesman || ""},
    {k: "status", l: "Status override", type: "select", options: [["", "Automatic (from deals)"], ["on_hold", "On hold"], ["sold", "Sold (outside the app)"]], v: t.status || ""},
    {k: "location", l: "Location", v: t.location}, {k: "apu", l: "APU", type: "check", v: t.apu}, {k: "warranty", l: "Warranty available", type: "check", v: t.warranty},
    {k: "photos", l: "Photo links (one per line)", type: "area", v: (t.photos || []).join("\n")}, {k: "notes", l: "Notes", type: "area", v: t.notes}], async f => {
      const unit = isNaN(f.unit) ? f.unit : +f.unit;
      if (isNew && truckBy(unit)) return toast(`Unit ${unit} already exists`), false;
      if (f.vin && f.vin.length !== 17) toast("Note: VIN is not 17 characters");
      const doc = {...f, unit, photos: lines(f.photos), status: f.status || null, salesman: f.salesman || null, updated: nowIso(), ...(isNew ? {created: nowIso()} : {})};
      const ok = await write(async () => {
        if (!isNew && String(unit) !== String(t.unit)) { await store.replace("trucks", unit, {...t, ...doc}); await store.del("trucks", t.unit); }
        else await store.save("trucks", unit, doc);
        await store.log(`${isNew ? "added" : "updated"} <b>Unit ${esc(unit)}</b>`);
      }, isNew ? "Truck added" : "Truck saved");
      if (ok) await syncPublic();
    }, isNew || !isAdmin() ? "" : `<button class="btn danger" data-act="deleteTruck" data-unit="${esc(t.unit)}">Delete</button>`);
}
function driverForm(d) {
  const isNew = !d; d = d || {fleet: "TTL", position: "LO"};
  form(isNew ? "Add driver" : `Edit ${esc(d.name)}`, [
    {k: "name", l: "Full name", v: d.name, req: true}, {k: "phone", l: "Phone", v: d.phone}, {k: "email", l: "Email", type: "email", v: d.email},
    {k: "fleet", l: "Fleet", type: "select", options: FLEETS, v: d.fleet}, {k: "position", l: "Position", type: "select", options: [["LO", "LO — lease operator"], ["OO", "OO — owner operator"], ["C", "C — company driver"]], v: d.position},
    {k: "pay", l: "Pay", v: d.pay, ph: "85% from gross"}, {k: "cdl", l: "CDL / experience", v: d.cdl}, {k: "tenure", l: "Tenure with us", v: d.tenure},
    {k: "salesman", l: "Salesman", type: "select", options: userOpts(), v: d.salesman || ""}, {k: "notes", l: "Notes", type: "area", v: d.notes}], async f => {
      const dup = S.drivers.find(x => x.id !== d.id && x.name?.trim().toLowerCase() === f.name.toLowerCase());
      if (dup && !confirm(`${dup.name} already exists (${dup.phone || "no phone"}). Save anyway?`)) return false;
      const id = d.id || nextId(S.drivers, "D-", 101);
      await write(async () => { await store.save("drivers", id, {...f, id, salesman: f.salesman || null, updated: nowIso(), ...(isNew ? {created: nowIso()} : {})}); await store.log(`${isNew ? "added" : "updated"} driver <b>${esc(f.name)}</b>`); }, "Driver saved");
    }, isNew || !isAdmin() ? "" : `<button class="btn danger" data-act="deleteDriver" data-id="${esc(d.id)}">Delete</button>`);
}
function soldForm(d) {
  const s = d?.sold || {status: "Active", date: todayStr()};
  const drvName = d ? driverBy(d.driver_id)?.name : "";
  form(d ? (d.sold ? `Sale terms · ${esc(d.id)}` : `Mark sold · ${esc(drvName)}`) : "Add sold truck", [
    ...(d ? [] : [{k: "driver_name", l: "Driver name", req: true, ph: "existing or new"}, {k: "unit", l: "Unit", req: true}, {k: "year", l: "Year", type: "number"}, {k: "vin", l: "VIN"}]),
    ...(d && (d.unit == null || d.unit === "") ? [{k: "unit", l: "Unit", req: true}] : []),
    {k: "date", l: "Sold date", type: "date", v: s.date, req: true}, {k: "status", l: "Status", type: "select", options: SOLD_STATUSES, v: s.status},
    ...(isAdmin() ? [{k: "acq_cost", l: "Acquisition cost", type: "number", v: s.acq_cost}] : []),
    {k: "loan", l: "Loan amount", type: "number", v: s.loan}, {k: "down", l: "Down payment", type: "number", v: s.down},
    {k: "weekly", l: "Weekly payment", type: "number", v: s.weekly}, {k: "term_months", l: "Term (months)", type: "number", v: s.term_months},
    {k: "weeks_paid", l: "Weeks paid so far", type: "number", v: s.weeks_paid}, {k: "agent_id", l: "Sales agent", type: "select", options: userOpts(), v: d?.agent_id || me?.id}], async f => {
      const soldDoc = stripNulls({date: f.date, status: f.status, acq_cost: f.acq_cost ?? s.acq_cost, loan: f.loan, down: f.down, weekly: f.weekly, term_months: f.term_months, weeks_paid: f.weeks_paid});
      soldDoc.payments = s.payments || [];
      if (d) {
        const patch = {sold: soldDoc, stage: "active", activated: d.activated || f.date, agent_id: f.agent_id || null};
        if (f.unit) patch.unit = isNaN(f.unit) ? f.unit : +f.unit;
        return updateDeal(d, patch, `${d.sold ? "updated sale terms for" : "marked sold:"} ${dealLabel({...d, ...patch})}`);
      }
      const unit = isNaN(f.unit) ? f.unit : +f.unit;
      let drvRec = S.drivers.find(x => x.name?.trim().toLowerCase() === f.driver_name.toLowerCase());
      const id = nextId(S.deals, "S-", 1001);
      return write(async () => {
        if (!drvRec) { drvRec = {id: nextId(S.drivers, "D-", 101), name: f.driver_name, created: nowIso()}; await store.save("drivers", drvRec.id, drvRec); }
        if (!truckBy(unit)) await store.save("trucks", unit, stripNulls({unit, year: f.year, vin: f.vin, status: "sold", created: nowIso()}));
        const deal = {id, driver_id: drvRec.id, unit, stage: "active", activated: f.date, agent_id: f.agent_id || null, sold: soldDoc, notes: [], tasks: [], created: nowIso()};
        await store.save("deals", id, deal);
        await store.log(`added sold truck ${dealLabel(deal)}`);
      }, "Sold truck added").then(ok => ok && syncPublic());
    });
}

/* ---------------------------------------------------------------- search */
function globalSearch(q) {
  const box = $("#gsResults");
  q = q.trim().toLowerCase();
  if (!q) { box.hidden = true; return; }
  const res = [];
  S.drivers.filter(d => [d.name, d.phone, d.email].join(" ").toLowerCase().includes(q)).slice(0, 8)
    .forEach(d => res.push(`<div class="gs-item" data-driver="${esc(d.id)}">👤 ${esc(d.name)}<small>${esc([d.fleet, d.phone].filter(Boolean).join(" · "))}</small></div>`));
  S.trucks.filter(t => [t.unit, t.vin].join(" ").toLowerCase().includes(q)).slice(0, 8)
    .forEach(t => res.push(`<div class="gs-item" data-truck="${esc(t.unit)}">🚛 Unit ${esc(t.unit)}<small>${esc([t.year, t.make, truckStatus(t).label].filter(Boolean).join(" · "))}</small></div>`));
  box.innerHTML = res.join("") || `<div class="gs-item faint">No matches</div>`;
  box.hidden = false;
}

/* ---------------------------------------------------------------- extras */
async function copyText(t, msg = "Copied") {
  try { await navigator.clipboard.writeText(t); toast(msg); }
  catch (e) { modal("Copy this", `<pre class="req">${esc(t)}</pre>`); }
}
function exportCsv(name, headers, rows) {
  const q = v => { v = String(v ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const blob = new Blob([[headers, ...rows].map(r => r.map(q).join(",")).join("\n")], {type: "text/csv"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${name}-${todayStr()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const EXPORTS = {
  exportTrucks: () => exportCsv("trucks", ["Unit", "Year", "Make", "Model", "VIN", "Miles", "Term weeks", "Weekly", "Total", "Status", "Salesman"],
    S.trucks.map(t => [t.unit, t.year, t.make, t.model, t.vin, t.miles, t.term_weeks, t.weekly, t.price_total, truckStatus(t).label, userBy(t.salesman)?.name])),
  exportDeals: () => exportCsv("deals", ["Deal", "Driver", "Unit", "Stage", "Plan", "Agent", "Created"],
    openDeals().map(d => [d.id, driverBy(d.driver_id)?.name, d.unit, stageMeta[d.stage].name, d.plan, userBy(d.agent_id)?.name, (d.created || "").slice(0, 10)])),
  exportSold: () => exportCsv("sold-trucks", ["Deal", "Unit", "Driver", "Sold date", "Status", ...(isAdmin() ? ["Acq cost"] : []), "Loan", "Down", "Weekly", "Term months", "Weeks paid", "Collected", "Remaining", "Last payment"],
    soldDeals().map(d => { const c = soldCalc(d), s = d.sold; return [d.id, d.unit, driverBy(d.driver_id)?.name, s.date, c.status, ...(isAdmin() ? [s.acq_cost] : []), s.loan, s.down, s.weekly, s.term_months, c.weeksPaid, c.collected, c.remaining, c.lastPay]; })),
  exportFollowups: () => exportCsv("follow-ups", ["Due", "Task", "Driver", "Unit", "Done"], allTasks().map(t => [t.due, t.body, t.driver?.name, t.deal.unit, t.done ? "yes" : ""])),
  exportDrivers: () => exportCsv("drivers", ["Name", "Phone", "Email", "Fleet", "Position", "Pay", "Status"], S.drivers.map(d => [d.name, d.phone, d.email, d.fleet, d.position, d.pay, driverContactStatus(d).label])),
};
function readAloud() {
  if (!("speechSynthesis" in window)) return toast("Speech not supported");
  speechSynthesis.cancel();
  const tmp = document.createElement("div");
  const ins = computeInsights();
  tmp.innerHTML = ins.length ? ins.slice(0, 5).map(i => i.title).join(". ") : "All clear.";
  speechSynthesis.speak(new SpeechSynthesisUtterance(tmp.textContent));
}
function batchSms() {
  const list = S.drivers.filter(d => d.phone && driverContactStatus(d).kind === "uncontacted");
  modal("Batch SMS", `<p class="muted sm" style="margin-top:0">Opens your phone's SMS app for each driver not contacted yet (${list.length}). On desktop, copy the numbers.</p>
    <div class="field"><label>Message</label><textarea id="smsText">Hi! We have lease-to-purchase trucks available: ${esc(adsUrl())}</textarea></div>
    ${list.slice(0, 50).map(d => `<div class="fo" style="padding:6px 0"><div class="body">${esc(d.name)}<small>${esc(d.phone)}</small></div><a class="btn sm" data-sms="${esc(d.phone)}" href="#">Text</a></div>`).join("") || `<div class="faint">No uncontacted drivers with a phone.</div>`}`,
    `<button class="btn" data-act="copyPhones">Copy numbers</button>`);
}
function wallboard() {
  const wb = document.createElement("div");
  wb.className = "wallboard";
  const render = () => {
    const st = soldTotals();
    wb.innerHTML = `<div class="topbar"><div><div class="crumbs">${esc(window.APP_NAME)} · Team board</div><h1>${new Date().toLocaleString()}</h1></div><button class="btn" data-act="closeWall">Exit (Esc)</button></div>
      <div class="wb-grid">${kpiBox("Trucks for sale", S.trucks.filter(t => truckStatus(t).kind === "available").length, "")}${kpiBox("Open deals", openDeals().length, "")}
      ${kpiBox("Sold trucks", st.count, st.active + " active")}${kpiBox("Due today", allTasks().filter(t => !t.done && t.due <= todayStr()).length, "follow-ups")}</div>
      <div class="pipestrip" style="margin-top:24px">${$("#pipeStrip").innerHTML}</div>`;
  };
  render();
  document.body.appendChild(wb);
  wb.requestFullscreen?.().catch(() => {});
  const iv = setInterval(render, 60000);
  wb._close = () => { clearInterval(iv); wb.remove(); if (document.fullscreenElement) document.exitFullscreen(); };
}
function weeklyReport() {
  renderWeek();
  const st = soldTotals();
  const w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups to open the report");
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Weekly report ${todayStr()}</title><style>body{font:14px system-ui;margin:32px;color:#111}table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #ccc;padding:5px 10px;text-align:left}</style>
    <h1>${esc(window.APP_NAME)} — weekly report</h1><div>${new Date().toDateString()}</div>
    <h3>This week</h3><table>${$$("#weekSnap .wk > *").reduce((a, el, i, arr) => i % 2 ? a : a + `<tr><th>${el.textContent}</th><td>${arr[i + 1].textContent}</td></tr>`, "")}</table>
    <h3>Portfolio</h3><table><tr><th>Trucks</th><td>${S.trucks.length}</td></tr><tr><th>For sale</th><td>${S.trucks.filter(t => truckStatus(t).kind === "available").length}</td></tr>
    <tr><th>Open deals</th><td>${openDeals().length}</td></tr><tr><th>Sold</th><td>${st.count} (${st.active} active)</td></tr>
    ${isAdmin() ? `<tr><th>Collected</th><td>${fmtC(st.collected)}</td></tr><tr><th>Remaining</th><td>${fmtC(st.remaining)}</td></tr><tr><th>Monthly run-rate</th><td>${fmtC(st.monthly)}</td></tr>` : ""}</table>
    <h3>Needs attention</h3><ul>${computeInsights().map(i => `<li>${i.title}</li>`).join("") || "<li>Nothing</li>"}</ul><script>print()<\/script>`);
  w.document.close();
}
function flyer(u) {
  const t = truckBy(u), w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups to open the flyer");
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Unit ${esc(t.unit)}</title><style>body{font:16px system-ui;margin:40px;color:#111}h1{font-size:40px;margin:0}img{width:48%;margin:1%;border-radius:8px}.p{font-size:28px;color:#3c7a1c;font-weight:700}</style>
    <h1>${esc([t.year, t.make, t.model].filter(Boolean).join(" "))}</h1><div>Unit ${esc(t.unit)} · ${fmt(t.miles)} miles · ${esc(t.engine || "")}</div>
    <p class="p">${fmtC(t.weekly || 1000)}/week · lease-to-purchase${termMonths(t) ? " · " + termMonths(t) + " months" : ""}</p>
    <div>${(t.photos || []).slice(0, 4).map(p => `<img src="${esc(p)}">`).join("")}</div>
    <p>${t.apu ? "✔ APU " : ""}${t.warranty ? "✔ Warranty available " : ""}</p><p>Call: ${esc(S.fees.contact_phone || "")}</p><p>${esc(adsUrl(t.unit))}</p><script>setTimeout(print,600)<\/script>`);
  w.document.close();
}
function contractSummary() {
  const d = curDeal, drvR = driverBy(d.driver_id) || {}, t = truckBy(d.unit) || {}, p = planParams(d.plan);
  modal("Contract summary", `<pre class="req">LEASE-TO-PURCHASE SUMMARY — ${esc(d.id)}
Driver: ${esc(drvR.name || "")}  ${esc(drvR.phone || "")}
Truck: Unit ${esc(d.unit ?? "")} · ${esc([t.year, t.make, t.model].filter(Boolean).join(" "))} · VIN ${esc(t.vin || "")}
Plan: ${esc(p.label)}
Down payment: ${fmtC(p.down)} · Weekly: ${fmtC(t.weekly || p.weekly)} · Term: ${esc(t.term_weeks || "?")} weeks
Escrow: ${fmtC(S.fees.esc)} · Admin ${fmtC(S.fees.admin)}/wk · Insurance ${fmtC(S.fees.ins)}/wk · Trailer ${fmtC(S.fees.trailer)}/wk · OCI ${fmtC(S.fees.oci)}/wk
Mileage fee: $${S.fees.mile}/mi · Driver payout: ${S.fees.payout}% of gross</pre>
<p class="faint sm">A summary only — the signed agreement is the binding document.</p>`, `<button class="btn" data-act="copyPre">Copy</button>`);
}
function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  LS.set("dispatch-theme", root.dataset.theme);
}
let lb = {photos: [], i: 0, unit: null};
function openLightbox(unit, i) { lb = {photos: truckBy(unit).photos, i: +i, unit}; $("#lightbox").classList.add("on"); lbUpdate(); }
function lbUpdate() { $("#lbImg").src = lb.photos[lb.i]; $("#lbCaption").textContent = `Unit ${lb.unit} · ${lb.i + 1}/${lb.photos.length}`; }
let toastT;
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 2600); }
const adsUrl = u => location.origin + location.pathname.replace(/[^/]*$/, "") + "ads.html" + (u != null ? "#" + encodeURIComponent(u) : "");

/* ---------------------------------------------------------------- events */
async function toggleTask(dealId, taskId) {
  const d = dealBy(dealId);
  const tasks = (d.tasks || []).map(t => t.id === taskId ? {...t, done: !t.done, done_at: !t.done ? nowIso() : null} : t);
  const t = tasks.find(x => x.id === taskId);
  await updateDeal(d, {tasks}, `${t.done ? "closed" : "reopened"} follow-up on ${dealLabel(d)}: ${esc(t.body)}`);
}
function bindEvents() {
  document.addEventListener("click", e => {
    const el = e.target.closest("[data-task-toggle],[data-page],[data-go],[data-act],[data-deal],[data-truck],[data-driver],[data-ins],[data-term],[data-avail],[data-mine],[data-sold-status],[data-sold-sort],[data-drv-fleet],[data-drv-contact],[data-view],[data-period],[data-plan],[data-tab],[data-lbunit],[data-lb],[data-sms],[data-del-pay],th.sortable");
    if (!el) return;
    const ds = el.dataset;
    if (el.tagName === "A" && !ds.sms && !ds.act && !ds.truck && el.getAttribute("href") !== "#") return;
    if (ds.taskToggle) { e.stopPropagation(); const [d, t] = ds.taskToggle.split("|"); return toggleTask(d, t); }
    if (ds.page || ds.go) { e.preventDefault(); closeModal(); closeSheet(); return show(ds.page || ds.go); }
    if (ds.ins) { const a = ds.ins; return a.startsWith("deal:") ? openDeal(a.slice(5)) : show(a); }
    if (ds.term) { inv.term = ds.term; $$("[data-term]").forEach(c => c.classList.toggle("on", c === el)); return renderInventory(); }
    if (ds.avail) { inv.avail = ds.avail; $$("[data-avail]").forEach(c => c.classList.toggle("on", c === el)); return renderInventory(); }
    if (el.matches("th.sortable")) { inv.asc = inv.sort === ds.sort ? !inv.asc : true; inv.sort = ds.sort; return renderInventory(); }
    if (ds.mine) { pipe.mine = ds.mine === "mine"; $$("[data-mine]").forEach(c => c.classList.toggle("on", c === el)); return renderPipeline(); }
    if (ds.soldStatus) { sold.status = ds.soldStatus; return renderSold(); }
    if (ds.soldSort) { sold.asc = sold.sort === ds.soldSort ? !sold.asc : false; sold.sort = ds.soldSort; return renderSold(); }
    if (ds.drvFleet) { drv.fleet = ds.drvFleet; return renderDrivers(); }
    if (ds.drvContact) { drv.contact = ds.drvContact; return renderDrivers(); }
    if (ds.view) { drv.view = ds.view; LS.set("dispatch-drv-view", ds.view); return renderDrivers(); }
    if (ds.period) { kpiPeriod = ds.period; return renderKpi(); }
    if (ds.plan) { calcPlan = ds.plan; return renderCalculator(); }
    if (ds.tab) { curTab = ds.tab; return renderSheet(); }
    if (ds.lbunit) return openLightbox(ds.lbunit, ds.lbi);
    if (ds.lb) { if (ds.lb === "close") return $("#lightbox").classList.remove("on"); lb.i = (lb.i + +ds.lb + lb.photos.length) % lb.photos.length; return lbUpdate(); }
    if (ds.sms) { e.preventDefault(); location.href = `sms:${ds.sms}?&body=${encodeURIComponent($("#smsText").value)}`; return; }
    if (ds.delPay) { const d = curDeal; if (!confirm("Delete this payment?")) return; const payments = d.sold.payments.filter((_, k) => k !== +ds.delPay); return updateDeal(d, {sold: {...d.sold, payments}}, `deleted a payment on ${dealLabel(d)}`); }
    if (ds.act) { e.preventDefault(); return act(ds.act, el); }
    if (ds.deal) { e.preventDefault(); return openDeal(ds.deal); }
    if (ds.truck) { e.preventDefault(); $("#gsResults").hidden = true; return openTruck(ds.truck); }
    if (ds.driver) { $("#gsResults").hidden = true; return openDriver(ds.driver); }
  });
  document.addEventListener("change", e => {
    const t = e.target;
    if (!curDeal) return;
    const d = curDeal;
    if (t.dataset.dealField === "stage") return setStage(d, t.value);
    if (t.dataset.dealCheck) {
      const f = t.dataset.dealCheck;
      if (f === "activated") return t.checked ? setStage(d, "active") : setStage(d, "ready");
      const val = f === "escrow_paid" ? t.checked : (t.checked ? nowIso() : null);
      const patch = {[f]: val};
      if (f === "agreement_sent" && t.checked && d.stage === "assigned") patch.stage = "agreement";
      if (f === "agreement_signed" && t.checked && d.stage === "agreement") patch.stage = "downpayment";
      return updateDeal(d, patch, `${t.checked ? "checked" : "unchecked"} "${f.replace(/_/g, " ")}" on ${dealLabel(d)}`);
    }
    if (t.dataset.inst != null) {
      const installments = d.installments.map((i, k) => k === +t.dataset.inst ? {...i, paid: t.checked, paid_date: t.checked ? nowIso() : null} : i);
      const patch = {installments};
      if (installments.every(i => i.paid) && d.escrow_paid && d.stage === "downpayment") patch.stage = "ready";
      return updateDeal(d, patch, `${t.checked ? "collected" : "un-marked"} installment #${installments[+t.dataset.inst].n} on ${dealLabel(d)}`);
    }
  });
  document.addEventListener("submit", async e => {
    const f = e.target;
    if (f.id === "mform") { e.preventDefault(); return formSubmit?.(); }
    if (f.id === "loginForm") return;
    if (!curDeal || !f.dataset.form) return;
    e.preventDefault();
    const body = f.elements.body.value.trim();
    if (!body) return;
    const d = curDeal;
    if (f.dataset.form === "addNote") await updateDeal(d, {notes: [...(d.notes || []), {ts: nowIso(), who: me?.name, body}]}, `logged note on ${dealLabel(d)}`);
    if (f.dataset.form === "addTask") {
      const tasks = d.tasks || [];
      await updateDeal(d, {tasks: [...tasks, {id: nextId(tasks, "T-", 1), body, due: f.elements.due.value || todayStr(), done: false, kind: "general"}]}, `added follow-up on ${dealLabel(d)}: ${esc(body)}`);
    }
  });
  // drag a deal card to another stage column
  document.addEventListener("dragstart", e => { const c = e.target.closest?.(".dcard"); if (c) e.dataTransfer.setData("text/deal", c.dataset.deal); });
  document.addEventListener("dragover", e => { if (e.target.closest?.("[data-drop-stage]")) e.preventDefault(); });
  document.addEventListener("drop", e => {
    const col = e.target.closest?.("[data-drop-stage]"); const id = e.dataTransfer.getData("text/deal");
    if (col && id) { e.preventDefault(); setStage(dealBy(id), col.dataset.dropStage); }
  });
  $("#railFoot").addEventListener("click", e => { if (!e.target.closest("#themeTog")) accountMenu(); });
  $("#themeTog").addEventListener("click", toggleTheme);
  $("#sheetOverlay").addEventListener("click", closeSheet);
  $("#sheetClose").addEventListener("click", closeSheet);
  $("#modalOverlay").addEventListener("click", e => { if (e.target.id === "modalOverlay") closeModal(); });
  $("#lightbox").addEventListener("click", e => { if (e.target.id === "lightbox") $("#lightbox").classList.remove("on"); });
  $("#mobileMenu").addEventListener("click", () => $(".rail").classList.toggle("mobile-open"));
  $("#globalSearch").addEventListener("input", e => globalSearch(e.target.value));
  document.addEventListener("click", e => { if (!e.target.closest(".searchwrap")) $("#gsResults").hidden = true; });
  $("#invSearch").addEventListener("input", e => { inv.q = e.target.value; renderInventory(); });
  $("#pipeSearch").addEventListener("input", e => { pipe.q = e.target.value; renderPipeline(); });
  $("#soldSearch").addEventListener("input", e => { sold.q = e.target.value; renderSold(); });
  $("#drvSearch").addEventListener("input", e => { drv.q = e.target.value; renderDrivers(); });
  ["#cTruck", "#cGross", "#cMiles"].forEach(s => $(s).addEventListener("input", renderCalculator));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeModal(); closeSheet(); $("#lightbox").classList.remove("on"); $(".wallboard")?._close(); return; }
    if (!me || e.target.matches("input,textarea,select") || e.ctrlKey || e.metaKey || e.altKey || $("#modalOverlay").classList.contains("on")) return;
    const k = e.key.toLowerCase();
    if (k === "d") show("dashboard"); else if (k === "t") show("inventory"); else if (k === "p") show("pipeline");
    else if (k === "n") FORMS.newDeal(); else if (k === "/") { e.preventDefault(); show("dashboard"); $("#globalSearch").focus(); }
  });
}
function accountMenu() {
  modal(esc(me?.name || ""), `<p class="muted" style="margin-top:0">${esc(me?.email || "")} · ${esc(me?.role || "")}</p>`,
    `${store.demo ? "" : `<button class="btn" data-act="resetPw" data-email="${esc(me?.email || "")}">Change password (email link)</button>`}<button class="btn primary" data-act="signOut">Sign out</button>`);
}
function act(name, el) {
  if (FORMS[name]) return FORMS[name](el);
  if (EXPORTS[name]) return EXPORTS[name]();
  const map = {
    closeModal, readAloud, batchSms, wallboard, weeklyReport, theme: toggleTheme, contract: contractSummary,
    submitForm: () => formSubmit?.(),
    reload: () => { renderAll(); toast("Up to date — data syncs live"); },
    closeWall: () => $(".wallboard")?._close(),
    flyer: () => flyer(el.dataset.unit),
    copyTruckLink: () => copyText(adsUrl(el.dataset.unit), "Ad link copied"),
    shareCatalog: () => modal("Driver ads page", `<p class="muted sm" style="margin-top:0">Public page for drivers: for-sale trucks only — photos, year, miles, weekly payment, term. No driver, deal, cost or salesman data. Send this link to drivers:</p><pre class="req">${esc(adsUrl())}</pre>`,
      `<button class="btn" data-act="copyPre">Copy link</button><a class="btn primary" href="${esc(adsUrl())}" target="_blank" rel="noopener">Open</a>`),
    copyPre: () => copyText($("#modal pre").textContent),
    copyPhones: () => copyText(S.drivers.filter(d => d.phone && driverContactStatus(d).kind === "uncontacted").map(d => d.phone).join("\n")),
    copyDriver: () => { const d = driverBy(el.dataset.id); copyText([d.name, d.phone, d.email, d.fleet, d.position].filter(Boolean).join("\n")); },
    saveFees: async () => {
      const fees = {...S.fees};
      $$("[data-fee]").forEach(i => { const v = i.value.trim(); fees[i.dataset.fee] = i.dataset.fee === "contact_phone" ? v : (v === "" ? null : +v); });
      if (Object.values(fees).some(v => typeof v === "number" && isNaN(v))) return toast("Fees must be numbers");
      await write(async () => { await store.save("config", "fees", fees); if (!store.demo) await store.savePublicConfig({contact_phone: fees.contact_phone || "", app: window.APP_NAME}); await store.log("updated fees & terms"); }, "Fees saved");
    },
    deleteTruck: async () => { if (!confirm(`Delete Unit ${el.dataset.unit}? This can't be undone.`)) return; await write(async () => { await store.del("trucks", el.dataset.unit); await store.log(`removed <b>Unit ${esc(el.dataset.unit)}</b>`); }, "Truck deleted"); closeModal(); syncPublic(); },
    deleteDriver: async () => { const d = driverBy(el.dataset.id); if (S.deals.some(x => x.driver_id === d.id)) return toast("Driver has deals — delete those first"); if (!confirm(`Delete ${d.name}?`)) return; await write(async () => { await store.del("drivers", d.id); await store.log(`removed driver <b>${esc(d.name)}</b>`); }, "Driver deleted"); closeModal(); },
    deleteDeal: async () => { const d = curDeal; if (!confirm(`Delete deal ${d.id}? This can't be undone.`)) return; await write(async () => { await store.del("deals", d.id); await store.log(`deleted deal ${esc(d.id)} (${dealLabel(d)})`); }, "Deal deleted"); closeSheet(); syncPublic(); },
    resetPw: async () => { if (!el.dataset.email) return toast("No email on file"); await write(() => store.auth.sendPasswordResetEmail(el.dataset.email), "Password reset email sent to " + el.dataset.email); },
    signOut: () => store.auth ? store.auth.signOut() : location.reload(),
  };
  (map[name] || (() => toast("Unknown action " + name)))();
}

/* ---------------------------------------------------------------- boot */
function showApp(on) { $("#login").hidden = on; $("#app").hidden = !on; }
function startApp() {
  showApp(true);
  document.body.classList.toggle("admin-hidden", !isAdmin());
  $("#railAvatar").textContent = initials(me?.name);
  $("#railName").textContent = me?.name || "—";
  $("#railRole").textContent = me?.role || "";
  renderSubnavs();
  updateNavCounts();
  renderFresh();
  show(LS.get("dispatch-page", "dashboard"));
}
(async function init() {
  const th = LS.get("dispatch-theme", null);
  if (th) document.documentElement.dataset.theme = th;
  document.title = window.APP_NAME;
  $("#brandName").textContent = String(window.APP_NAME).replace(/^\S+\s/, "");
  $("#brandMark").textContent = $("#loginMark").textContent = window.APP_BRAND;
  $("#loginTitle").textContent = "Sign in to " + window.APP_NAME;
  bindEvents();

  if (!FB.projectId) {
    // local demo: data.json next to this page, edits stay in memory
    try {
      const r = await fetch("data.json", {cache: "no-store"});
      if (!r.ok) throw 0;
      Object.assign(S, await r.json());
      store = demoStore();
      me = S.users.find(u => u.role === "admin") || S.users[0];
      return startApp();
    } catch (e) { $("#loginErr").textContent = "App not configured yet."; return; }
  }

  store = firebaseStore();
  const db = firebase.firestore();
  store.savePublicConfig = obj => db.collection("public_config").doc("site").set(obj, {merge: true});
  syncPublic = async () => {
    // public ads collection = for-sale trucks with whitelisted fields only
    const want = new Map(S.trucks.filter(t => truckStatus(t).kind === "available").map(t => [String(t.unit), Object.fromEntries(PUBLIC_TRUCK_FIELDS.filter(k => t[k] != null).map(k => [k, t[k]]))]));
    try {
      const cur = await db.collection("public_trucks").get();
      const batch = db.batch();
      cur.docs.forEach(doc => { if (!want.has(doc.id)) batch.delete(doc.ref); });
      want.forEach((v, k) => batch.set(db.collection("public_trucks").doc(k), v));
      await batch.commit();
    } catch (e) { console.warn("public sync", e); }
  };
  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault(); $("#loginErr").textContent = "";
    try { await store.auth.signInWithEmailAndPassword($("#loginEmail").value.trim(), $("#loginPw").value); }
    catch (x) { $("#loginErr").textContent = /password|credential|user-not-found/.test(x.code) ? "Wrong email or password." : x.message; }
  });
  $("#loginForgot").addEventListener("click", async () => {
    const em = $("#loginEmail").value.trim();
    if (!em) return ($("#loginErr").textContent = "Type your email first.");
    try { await store.auth.sendPasswordResetEmail(em); $("#loginErr").textContent = "Reset link sent — check your email."; }
    catch (x) { $("#loginErr").textContent = x.message; }
  });
  // Owner bootstrap: the owner picks their own password here; rules only accept the admin profile after email verification.
  const OWNER = String(window.OWNER_EMAIL || "").toLowerCase();
  $("#loginOwner").hidden = !OWNER;
  $("#loginOwner").addEventListener("click", async () => {
    const em = $("#loginEmail").value.trim().toLowerCase(), pw = $("#loginPw").value;
    if (em !== OWNER) return ($("#loginErr").textContent = "Only the owner (" + OWNER + ") can set up here. Others are invited by an admin.");
    if (pw.length < 8) return ($("#loginErr").textContent = "Choose a password of at least 8 characters.");
    try {
      const cred = await store.auth.createUserWithEmailAndPassword(em, pw);
      await cred.user.sendEmailVerification();
      await store.auth.signOut();
      $("#loginErr").textContent = "Account created. Open the verification email, click the link, then sign in here.";
    } catch (x) {
      $("#loginErr").textContent = x.code === "auth/email-already-in-use" ? "Owner account already exists — just sign in (or use Forgot password)." : x.message;
    }
  });
  let started = false;
  store.auth.onAuthStateChanged(async user => {
    store.stop();
    if (!user) { me = null; started = false; S = {trucks: [], drivers: [], deals: [], users: [], activity: [], fees: {}, meta: {}}; return showApp(false); }
    try {
      let p = await db.collection("users").doc(user.uid).get();
      if (!p.exists && OWNER && String(user.email).toLowerCase() === OWNER) {
        await user.reload();
        if (!store.auth.currentUser.emailVerified) {
          await store.auth.currentUser.sendEmailVerification().catch(() => {});
          await store.auth.signOut();
          $("#loginErr").textContent = "Verify your email first — we just sent the link again.";
          return;
        }
        await store.auth.currentUser.getIdToken(true);
        await db.collection("users").doc(user.uid).set({id: user.uid, name: "Joey", email: user.email, role: "admin", is_sales: true, active: true, created: nowIso()});
        p = await db.collection("users").doc(user.uid).get();
      }
      if (!p.exists || p.data().active === false) { await store.auth.signOut(); $("#loginErr").textContent = "Your account has no access. Ask Joey."; return; }
      me = {...p.data(), id: user.uid};
    } catch (x) { $("#loginErr").textContent = x.message; return; }
    store.listen(() => { if (!started) { started = true; startApp(); } renderAll(); });
  });
})();
