import { auth, db, $, esc, toast, fmtTime, answerText, isAnswered, LETTERS, toMs } from "./common.js";
import { TEACHER_EMAIL } from "./firebase-config.js";
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, onSnapshot, writeBatch,
  serverTimestamp, query, orderBy, limit, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = $("#app");
let subjects = [], banks = [], itemsCache = {};
let unsubMon = null, monItems = {}, monSid = null, monTimer = null, monRows = [];
let bankSubject = null; // вибраний предмет у блоці «Банк питань»

const KIND = { seminar: "Семінар", test: "Тематична" };
const TYPE_UA = { open: "відкрите", choice: "тест", match: "відповідність", seq: "послідовність" };
const TYPE_FROM_UA = { "відкрите": "open", "тест": "choice", "відповідність": "match", "послідовність": "seq" };
const NO_SUBJ = "__none";

onAuthStateChanged(auth, (u) => {
  if (!u || u.isAnonymous) return showLogin();
  if (u.email !== TEACHER_EMAIL) { showLogin("Цей обліковий запис не має прав викладача."); return; }
  $("#tbar").hidden = false; $("#tWho").textContent = u.email;
  dashboard().catch(showErr);
});
$("#logout").onclick = () => signOut(auth);

function showLogin(msg = "") {
  $("#tbar").hidden = true;
  app.innerHTML = `<div class="card reg">
    <h1>Вхід для викладача</h1>
    <form id="lf">
      <label>E-mail<input name="e" type="email" required value="${esc(TEACHER_EMAIL)}"></label>
      <label>Пароль<input name="p" type="password" required></label>
      <button class="btn primary big">Увійти</button>
      <p class="err">${esc(msg)}</p>
    </form></div>`;
  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    try { await signInWithEmailAndPassword(auth, e.target.e.value.trim(), e.target.p.value); }
    catch (err) { $("#lf .err").textContent = "Невірний e-mail або пароль."; console.error(err); }
  };
}

function showErr(e) {
  console.error(e);
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box"><h2>Помилка</h2><p>${esc(e.code || e.message)}</p>
    <p class="tiny muted">Найчастіша причина — не опубліковано нові правила Firestore (файл firestore.rules).</p>
    <div class="modal-btns"><button class="btn primary">Закрити</button></div></div>`;
  m.querySelector("button").onclick = () => m.remove();
  document.body.appendChild(m);
}

// ================================================================ DATA
async function loadAll() {
  const [s, b] = await Promise.all([getDocs(collection(db, "subjects")), getDocs(collection(db, "banks"))]);
  subjects = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name, "uk"));
  banks = b.docs.map((d) => {
    const x = { id: d.id, ...d.data() };
    // старі записи без розділу: «r1-…» → «Розділ 1»
    if (!x.section) { const m = x.id.match(/^r(\d+)-/); x.section = m ? `Розділ ${m[1]}` : "Без розділу"; x.title = x.title.replace(/^Розділ \d+\.\s*/, ""); }
    if (!x.subjectId || !subjects.find((s) => s.id === x.subjectId)) x.subjectId = NO_SUBJ;
    return x;
  }).sort(bankSort);
}
const bankSort = (a, b) => a.section.localeCompare(b.section, "uk", { numeric: true }) || (a.kind === b.kind ? a.title.localeCompare(b.title, "uk", { numeric: true }) : a.kind === "seminar" ? -1 : 1);
const subjName = (id) => (id === NO_SUBJ ? "Без предмета" : subjects.find((s) => s.id === id)?.name || "—");
const subjList = () => [...subjects, ...(banks.some((b) => b.subjectId === NO_SUBJ) ? [{ id: NO_SUBJ, name: "Без предмета", groups: [] }] : [])];
const fullTitle = (b) => `${b.section}. ${b.title}`;

async function bankItems(b) {
  if (itemsCache[b.id]) return itemsCache[b.id];
  const out = {};
  for (let v = 1; v <= (b.variantCount || 1); v++) {
    const s = await getDoc(doc(db, "banks", b.id, "variants", String(v)));
    out[v] = s.exists() ? s.data().items || [] : [];
  }
  return (itemsCache[b.id] = out);
}

// ---------------------------------------------------------------- рекомендований час
function partsCount(text) {
  const letters = (text.match(/(^|\s)[а-г]\)\s/g) || []).length;
  const nums = (text.match(/(^|\s)\d\)\s/g) || []).length;
  return letters >= 2 ? letters : nums >= 2 ? nums : 0;
}
function perItemMin(q) {
  const txt = [q.text, ...(q.options || []), ...(q.left || []), ...(q.right || []), ...(q.items || [])].join(" ");
  const read = txt.split(/\s+/).filter(Boolean).length / 120; // читання ~120 слів/хв
  let work = { choice: 0.7, match: 1.5, seq: 1.2 }[q.type];
  if (q.type === "open") { const p = partsCount(q.text); work = p ? 2 * p : 3; }
  return read + (work || 2);
}
function estimate(itemsByVariant, kind, qCount) {
  let best = 0;
  for (const items of Object.values(itemsByVariant)) {
    if (!items.length) continue;
    let t = items.reduce((a, q) => a + perItemMin(q), 0);
    if (kind === "seminar" && qCount > 0 && qCount < items.length) t = (t / items.length) * qCount;
    best = Math.max(best, t);
  }
  return Math.max(5, Math.ceil((best * 1.1) / 5) * 5);
}

// ================================================================ DASHBOARD
let activeList = [];
async function dashboard() {
  app.innerHTML = `
  <div class="grid">
    <div class="card" id="curCard"></div>
    <div class="card" id="openCard"></div>
  </div>
  <div class="card" id="monCard"></div>
  <div class="grid">
    <div class="card" id="expCard"></div>
    <div class="card" id="subjCard"></div>
  </div>
  <div class="card" id="bankCard"></div>`;
  await loadAll();
  renderOpen(); renderSubjects(); renderBank(); renderExport();
  onSnapshot(query(collection(db, "sittings"), where("active", "==", true)), (snap) => {
    activeList = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.active)
      .sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0));
    renderCurrent();
    if (!monSid || !activeList.some((x) => x.id === monSid)) startMonitor(activeList[0]?.id || monSid || null);
  }, showErr);
}
async function refreshAll() { await loadAll(); renderOpen(); renderSubjects(); renderBank(); }

// ---------------------------------------------------------------- відкриті тести
const BASE_URL = location.href.replace(/teacher\.html.*$/, "").replace(/[?#].*$/, "");
const testUrl = (code) => `${BASE_URL}?t=${code}`;
const fmtDT = (ms) => (ms ? new Date(ms).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
function windowText(x) {
  const f = toMs(x.openFrom), t = toMs(x.closeAt);
  if (x.mode !== "home") return "На занятті";
  return `Домашнє: ${f ? "з " + fmtDT(f) + " " : ""}до ${fmtDT(t)}`;
}
async function setActive(active, x) {
  const batch = writeBatch(db);
  batch.update(doc(db, "sittings", x.id), { active });
  if (x.code) batch.update(doc(db, "open", x.code), { active });
  await batch.commit();
}
function renderCurrent() {
  const c = $("#curCard");
  if (!activeList.length) { c.innerHTML = `<h2>Відкриті тести</h2><p class="muted">Зараз немає відкритих тестів. Відкрийте тест — тут з'являться посилання та QR-код для студентів.</p>`; return; }
  c.innerHTML = `<h2>Відкриті тести <span class="muted tiny">(${activeList.length})</span></h2>
    <div class="act-list">${activeList.map((x) => {
      const url = testUrl(x.code), expired = x.mode === "home" && toMs(x.closeAt) < Date.now();
      return `<div class="act ${x.id === monSid ? "sel" : ""}" data-id="${x.id}">
        <div class="act-top"><span class="pill">${esc(x.subjectName || "")}</span><span class="tag ${x.mode === "home" ? "home" : ""}">${windowText(x)}${expired ? " · термін минув" : ""}</span></div>
        <div class="big-title">${esc(x.title)}</div>
        <div class="tiny muted">Тривалість ${x.durationMin} хв${x.kind === "seminar" ? ` · питань: ${x.qCount || "усі"}` : ` · варіантів: ${x.variantCount}`} · групи: ${esc((x.groups || []).join(", ") || "будь-які")} · зареєстровано: ${x.count}</div>
        <div class="linkrow"><a href="${url}" target="_blank">${esc(url)}</a></div>
        <div class="btns">
          <button class="btn tiny-btn" data-a="copy">Копіювати</button>
          <button class="btn tiny-btn" data-a="qr">QR-код</button>
          <button class="btn tiny-btn" data-a="mon">Хто пише</button>
          ${x.mode === "home" ? `<button class="btn tiny-btn" data-a="term">Змінити термін</button>` : ""}
          <button class="btn tiny-btn danger" data-a="close">Закрити</button>
        </div>
        <div class="qrBox" hidden></div>
      </div>`; }).join("")}</div>
    <p class="tiny muted">«Закрити» — нові студенти за посиланням не зайдуть; ті, хто вже почав, дописують до кінця свого часу.</p>`;
  c.querySelectorAll(".act").forEach((el) => {
    const x = activeList.find((a) => a.id === el.dataset.id), url = testUrl(x.code);
    el.querySelector("[data-a=copy]").onclick = async () => { try { await navigator.clipboard.writeText(url); toast("Посилання скопійовано"); } catch { toast(url, 6000); } };
    el.querySelector("[data-a=qr]").onclick = () => {
      const box = el.querySelector(".qrBox"); box.hidden = !box.hidden;
      if (!box.hidden && !box.dataset.done && window.QRCode) { new QRCode(box, { text: url, width: 220, height: 220 }); box.dataset.done = 1; }
    };
    el.querySelector("[data-a=mon]").onclick = () => { startMonitor(x.id); renderCurrent(); $("#monCard").scrollIntoView({ behavior: "smooth" }); };
    el.querySelector("[data-a=close]").onclick = () => { if (confirm(`Закрити «${x.title}»?`)) setActive(false, x).catch(showErr); };
    el.querySelector("[data-a=term]")?.addEventListener("click", () => editTerm(x));
  });
}
const toLocalInput = (ms) => { const d = new Date(ms - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
function editTerm(x) {
  const m = modal(`<h2>Термін виконання</h2><p class="muted">${esc(x.title)}</p>
    <div class="row2"><label>Відкрито з<input type="datetime-local" id="tFrom" value="${toMs(x.openFrom) ? toLocalInput(toMs(x.openFrom)) : ""}"></label>
    <label>Виконати до<input type="datetime-local" id="tTo" value="${toLocalInput(toMs(x.closeAt))}"></label></div>
    <div class="modal-btns"><button class="btn" data-x>Скасувати</button><button class="btn primary" id="tSave">Зберегти</button></div>`);
  $("#tSave").onclick = async () => {
    const from = $("#tFrom").value ? new Date($("#tFrom").value) : null, to = new Date($("#tTo").value);
    if (!(to > (from || 0))) return toast("Дата завершення має бути пізніше за дату початку");
    const batch = writeBatch(db);
    batch.update(doc(db, "sittings", x.id), { openFrom: from, closeAt: to });
    batch.update(doc(db, "open", x.code), { openFrom: from, closeAt: to });
    await batch.commit().catch(showErr); m.remove(); toast("Термін змінено");
  };
}

// ---------------------------------------------------------------- open new
function renderOpen() {
  const c = $("#openCard");
  const subs = subjList().filter((s) => banks.some((b) => b.subjectId === s.id));
  if (!subs.length) { c.innerHTML = `<h2>Відкрити тест</h2><p class="muted">Спочатку додайте предмет і питання (блоки «Предмети» та «Банк питань» нижче).</p>`; return; }
  const now = Date.now(), weekEnd = new Date(now + 7 * 864e5); weekEnd.setHours(23, 59, 0, 0);
  c.innerHTML = `<h2>Відкрити тест</h2>
    <form id="of">
      <label>Предмет<select name="subj">${subs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></label>
      <div class="row2">
        <label>Розділ<select name="sec"></select></label>
        <label>Заняття<select name="bank" required></select></label>
      </div>
      <div class="seg" id="modeSeg">
        <label><input type="radio" name="mode" value="class" checked> На занятті</label>
        <label><input type="radio" name="mode" value="home"> Домашнє завдання</label>
      </div>
      <div class="row2" id="homeRow" hidden>
        <label>Відкрито з<input type="datetime-local" name="from" value="${toLocalInput(now)}"></label>
        <label>Виконати до<input type="datetime-local" name="to" value="${toLocalInput(weekEnd.getTime())}"></label>
      </div>
      <div class="row2">
        <label>Тривалість, хв<input name="dur" type="number" min="1" max="240" value="40" required>
          <span class="tiny rec" id="recTime"></span></label>
        <label id="qcLbl">Питань на студента<input name="qc" type="number" min="0" max="50" value="5"><span class="tiny muted">0 — усі питання</span></label>
      </div>
      <label>Групи (через кому)<input name="groups" placeholder="напр. 201-Т, 202-Т"></label>
      <button class="btn primary big">Відкрити тест</button>
      <p class="tiny muted" id="modeHint">Тест відкривається одразу; закриваєте його ви. Для тематичної варіант кожному студенту видається автоматично, порівну між варіантами.</p>
    </form>`;
  const f = $("#of");
  const cur = () => banks.find((x) => x.id === f.bank.value);
  const mode = () => f.querySelector("input[name=mode]:checked").value;
  f.querySelectorAll("input[name=mode]").forEach((r) => (r.onchange = () => {
    $("#homeRow").hidden = mode() !== "home";
    $("#modeHint").textContent = mode() === "home"
      ? "Студент може почати тест будь-коли в цьому проміжку; після початку в нього є «Тривалість» хвилин, але не довше, ніж до кінцевого терміну."
      : "Тест відкривається одразу; закриваєте його ви. Для тематичної варіант кожному студенту видається автоматично, порівну між варіантами.";
  }));
  const fillSec = () => {
    const secs = [...new Set(banks.filter((b) => b.subjectId === f.subj.value).map((b) => b.section))];
    f.sec.innerHTML = secs.map((s) => `<option>${esc(s)}</option>`).join("");
    const s = subjects.find((x) => x.id === f.subj.value);
    f.groups.value = (s?.groups || []).join(", ");
    fillBank();
  };
  const fillBank = () => {
    const list = banks.filter((b) => b.subjectId === f.subj.value && b.section === f.sec.value);
    f.bank.innerHTML = list.map((b) => `<option value="${b.id}">${b.kind === "test" ? "★ " : ""}${esc(b.title)}</option>`).join("");
    sync();
  };
  const sync = async () => {
    const b = cur(); if (!b) return;
    $("#qcLbl").style.display = b.kind === "seminar" ? "" : "none";
    $("#recTime").textContent = "рахую…";
    const est = estimate(await bankItems(b), b.kind, b.kind === "seminar" ? parseInt(f.qc.value, 10) || 0 : 0);
    f.dur.value = est;
    $("#recTime").innerHTML = `Рекомендовано: <b>${est} хв</b> (розраховано за кількістю й типом питань)`;
  };
  f.subj.onchange = fillSec; f.sec.onchange = fillBank; f.bank.onchange = sync; f.qc.oninput = sync;
  fillSec();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const b = cur();
    const durationMin = Math.max(1, parseInt(f.dur.value, 10));
    const qCount = b.kind === "seminar" ? Math.max(0, parseInt(f.qc.value, 10) || 0) : 0;
    const groups = f.groups.value.split(",").map((s) => s.trim()).filter(Boolean);
    const m = mode();
    let openFrom = null, closeAt = null;
    if (m === "home") {
      openFrom = f.from.value ? new Date(f.from.value) : null; closeAt = new Date(f.to.value);
      if (!(closeAt.getTime() > Date.now())) return toast("Кінцевий термін має бути в майбутньому");
      if (openFrom && !(closeAt > openFrom)) return toast("Кінцевий термін має бути пізніше за початок");
    }
    const btn = f.querySelector("button.primary"); btn.disabled = true; btn.textContent = "Відкриваю…";
    try {
      const iv = await bankItems(b);
      const sref = doc(collection(db, "sittings"));
      const code = makeCode();
      const common = { testId: b.id, title: fullTitle(b), subjectName: subjName(b.subjectId), kind: b.kind, durationMin, qCount,
        itemCount: iv[1].length, variantCount: b.variantCount, groups, mode: m, openFrom, closeAt };
      const batch = writeBatch(db);
      for (let v = 1; v <= b.variantCount; v++) batch.set(doc(db, "sittings", sref.id, "variants", String(v)), { items: iv[v] });
      batch.set(sref, { ...common, code, active: true, count: 0, offset: Math.floor(Math.random() * b.variantCount), createdAt: serverTimestamp() });
      batch.set(doc(db, "open", code), { ...common, active: true, sittingId: sref.id });
      await batch.commit();
      monSid = null; startMonitor(sref.id);
      toast("Тест відкрито. Дайте студентам посилання або QR-код (блок «Відкриті тести»).", 4000);
      renderExport();
    } catch (err) { showErr(err); }
    btn.disabled = false; btn.textContent = "Відкрити тест";
  };
}

// ---------------------------------------------------------------- monitor
async function startMonitor(sid) {
  if (sid === monSid && sid) return;
  monSid = sid; unsubMon?.(); clearInterval(monTimer);
  const c = $("#monCard");
  if (!sid) { c.innerHTML = `<h2>Хто пише</h2><p class="muted">Немає відкритих тестів.</p>`; return; }
  const sit = (await getDoc(doc(db, "sittings", sid))).data();
  monItems = await loadSittingItems(sit, sid);
  c.innerHTML = `<div class="mon-head"><h2>Хто пише</h2><span class="muted" id="monCount"></span></div>
    <div class="tiny muted">${esc(sit.subjectName || "")} · ${esc(sit.title)} · ${windowText(sit)}${sit.active ? "" : " · закрито"}</div>
    <div class="table-wrap"><table class="tbl"><thead><tr>
      <th>#</th><th>Група</th><th>ПІБ</th><th>Вар.</th><th>Почав</th><th>Статус</th><th>Відповіді</th>
      <th title="Виходи з вікна">Вих.</th><th title="Спроби вставлення">Вст.</th><th title="Копіювання / знімки екрана">Коп./скр.</th><th></th>
    </tr></thead><tbody id="monBody"></tbody></table></div>
    <p class="tiny muted">Вих. — виходи з вікна · Вст. — спроби вставити текст · Коп./скр. — спроби копіювання та знімки екрана (Print Screen)</p>`;
  unsubMon = onSnapshot(collection(db, "sittings", sid, "sessions"), (snap) => {
    monRows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.group + a.name).localeCompare(b.group + b.name, "uk"));
    paintMonitor(sid, sit);
  });
  monTimer = setInterval(() => paintMonitor(sid, sit), 1000);
}
function paintMonitor(sid, sit) {
  const body = $("#monBody"); if (!body) return;
  $("#monCount").textContent = `зареєстровано: ${monRows.length} · здали: ${monRows.filter((r) => r.submitted).length}`;
  const now = Date.now();
  body.innerHTML = monRows.map((r, i) => {
    const items = pickItems(r, monItems);
    const n = items.filter((q) => isAnswered(q, r.answers?.[q.id])).length;
    const st = r.startedAt?.toMillis?.() || now;
    const left = Math.min(st + sit.durationMin * 60000, toMs(sit.closeAt) || Infinity) - now;
    const status = r.submitted ? `<span class="ok">Здано ${time(r.submittedAt)}</span>` : left <= 0 ? `<span class="bad">Час вийшов</span>` : `Пише · ${fmtTime(left)}`;
    const ev = r.events || {};
    const flag = (v) => (v > 0 ? `<b class="bad">${v}</b>` : "0");
    return `<tr><td>${i + 1}</td><td>${esc(r.group)}</td><td>${esc(r.name)}</td><td>${r.variant}</td><td>${time(r.startedAt)}</td>
      <td>${status}</td><td>${n}/${items.length}</td><td>${flag(ev.blur)}</td><td>${flag(ev.paste)}</td><td>${flag((ev.copy || 0) + (ev.print || 0))}</td>
      <td><button class="btn tiny-btn" data-reset="${r.id}">Скинути</button></td></tr>`;
  }).join("") || `<tr><td colspan="11" class="muted center">Поки ніхто не зареєструвався</td></tr>`;
  body.querySelectorAll("[data-reset]").forEach((b) => (b.onclick = async () => {
    const r = monRows.find((x) => x.id === b.dataset.reset);
    if (!confirm(`Скинути спробу студента «${r.name}»? Його відповіді буде видалено, і він зможе пройти тест заново.`)) return;
    await deleteDoc(doc(db, "sittings", sid, "sessions", r.id));
    if (r.rosterKey) await deleteDoc(doc(db, "sittings", sid, "roster", r.rosterKey));
    toast("Спробу скинуто");
  }));
}
const time = (ts) => (ts?.toDate ? ts.toDate().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "—");
async function loadSittingItems(sit, sid) {
  const out = {};
  for (let v = 1; v <= sit.variantCount; v++) {
    let s = await getDoc(doc(db, "sittings", sid, "variants", String(v)));
    if (!s.exists()) s = await getDoc(doc(db, "banks", sit.testId, "variants", String(v)));
    out[v] = s.exists() ? s.data().items : [];
  }
  return out;
}
const makeCode = () => { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)]; return s; };
function pickItems(r, byVariant) {
  const all = byVariant[r.variant] || [];
  return r.qids ? r.qids.map((id) => all.find((q) => q.id === id)).filter(Boolean) : all;
}

// ---------------------------------------------------------------- export answers
async function renderExport() {
  const c = $("#expCard");
  const snap = await getDocs(query(collection(db, "sittings"), orderBy("createdAt", "desc"), limit(80)));
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  c.innerHTML = `<h2>Вивантажити відповіді</h2>
    ${list.length ? `<label>Тест<select id="expSel">${list.map((s) => `<option value="${s.id}">${esc(dt(s.createdAt))}${s.mode === "home" ? " [дом.]" : ""} — ${esc((s.subjectName ? s.subjectName.slice(0, 25) + " · " : "") + s.title.slice(0, 70))} (${s.count} студ.)</option>`).join("")}</select></label>
    <div class="btns"><button class="btn primary" id="expBtn">Завантажити Excel</button><button class="btn" id="monBtn">Хто писав</button></div>
    <p class="tiny muted">Файл містить питання й відповіді кожного студента. Цей файл передайте Claude на перевірку.</p>`
    : `<p class="muted">Ще немає проведених тестів.</p>`}`;
  $("#expBtn")?.addEventListener("click", () => exportXlsx($("#expSel").value).catch(showErr));
  $("#monBtn")?.addEventListener("click", () => { startMonitor($("#expSel").value); renderCurrent(); $("#monCard").scrollIntoView({ behavior: "smooth" }); });
}
const dt = (ts) => (ts?.toDate ? ts.toDate().toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

async function exportXlsx(sid) {
  const sit = (await getDoc(doc(db, "sittings", sid))).data();
  const sessions = (await getDocs(collection(db, "sittings", sid, "sessions"))).docs.map((d) => d.data())
    .sort((a, b) => (a.group + a.name).localeCompare(b.group + b.name, "uk"));
  const iv = await loadSittingItems(sit, sid);
  const answersRows = [["Група", "ПІБ", "Варіант", "№", "ID питання", "Тип", "Питання", "Відповідь студента"]];
  const studRows = [["Група", "ПІБ", "Варіант", "Початок", "Здано", "Тривалість, хв", "Статус", "Відповідей", "Виходів з вікна", "Спроб вставлення", "Копіювання", "Знімки екрана"]];
  for (const s of sessions) {
    const items = pickItems(s, iv);
    items.forEach((q, i) => answersRows.push([s.group, s.name, s.variant, i + 1, q.id, TYPE_UA[q.type] || q.type,
      q.text + (q.type === "choice" ? "\n" + q.options.map((o, k) => `${"абвгде"[k]}) ${o}`).join("\n") : "")
        + (q.type === "match" ? "\n" + q.left.join("\n") + "\n" + q.right.join("\n") : "")
        + (q.type === "seq" ? "\n" + q.items.join("\n") : ""),
      answerText(q, s.answers?.[q.id])]));
    const st = s.startedAt?.toMillis?.(), en = s.submittedAt?.toMillis?.();
    const ev = s.events || {};
    studRows.push([s.group, s.name, s.variant, dt(s.startedAt), s.submitted ? dt(s.submittedAt) : "", st && en ? Math.round((en - st) / 60000) : "",
      s.submitted ? "здано" : "не надіслав (зараховано збережене)", items.filter((q) => isAnswered(q, s.answers?.[q.id])).length + "/" + items.length,
      ev.blur || 0, ev.paste || 0, ev.copy || 0, ev.print || 0]);
  }
  const info = [["Предмет", sit.subjectName || ""], ["Тест", sit.title], ["ID банку", sit.testId], ["ID сесії", sid], ["Дата", dt(sit.createdAt)],
    ["Тривалість, хв", sit.durationMin], ["Тип", sit.kind === "test" ? "тематична" : "семінар"], ["Студентів", sessions.length]];
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(answersRows); ws1["!cols"] = [{ wch: 10 }, { wch: 26 }, { wch: 8 }, { wch: 5 }, { wch: 8 }, { wch: 14 }, { wch: 70 }, { wch: 70 }];
  const ws2 = XLSX.utils.aoa_to_sheet(studRows); ws2["!cols"] = [{ wch: 10 }, { wch: 28 }, { wch: 8 }, { wch: 17 }, { wch: 17 }, { wch: 10 }, { wch: 22 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
  const ws3 = XLSX.utils.aoa_to_sheet(info); ws3["!cols"] = [{ wch: 16 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Відповіді");
  XLSX.utils.book_append_sheet(wb, ws2, "Студенти");
  XLSX.utils.book_append_sheet(wb, ws3, "Інфо");
  const d = sit.createdAt?.toDate?.() || new Date();
  XLSX.writeFile(wb, `Відповіді_${fileSafe(sit.subjectName || "")}_${sit.testId}_${d.toISOString().slice(0, 10)}.xlsx`);
}
const fileSafe = (s) => s.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 30);

// ================================================================ ПРЕДМЕТИ
function renderSubjects() {
  const c = $("#subjCard");
  c.innerHTML = `<h2>Предмети</h2>
    <div class="subj-list">${subjects.map((s) => `
      <div class="subj-row">
        <div><b>${esc(s.name)}</b><div class="tiny muted">Групи: ${esc((s.groups || []).join(", ") || "—")} · занять: ${banks.filter((b) => b.subjectId === s.id).length}</div></div>
        <div class="btns"><button class="btn tiny-btn" data-edit="${s.id}">Змінити</button><button class="btn tiny-btn" data-del="${s.id}">✕</button></div>
      </div>`).join("") || `<p class="muted">Предметів ще немає.</p>`}</div>
    <form id="sf" class="subj-add">
      <input name="name" placeholder="Назва нового предмета" required maxlength="120">
      <input name="groups" placeholder="Групи через кому (необов'язково)">
      <button class="btn primary">Додати предмет</button>
    </form>`;
  $("#sf").onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim(); if (!name) return;
    const groups = e.target.groups.value.split(",").map((x) => x.trim()).filter(Boolean);
    await setDoc(doc(collection(db, "subjects")), { name, groups, createdAt: serverTimestamp() }).catch(showErr);
    toast("Предмет додано"); await refreshAll();
  };
  c.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editSubject(subjects.find((s) => s.id === b.dataset.edit))));
  c.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    const s = subjects.find((x) => x.id === b.dataset.del);
    const n = banks.filter((x) => x.subjectId === s.id).length;
    if (n) return toast(`Спочатку видаліть або перенесіть заняття цього предмета (${n})`, 4000);
    if (!confirm(`Видалити предмет «${s.name}»?`)) return;
    await deleteDoc(doc(db, "subjects", s.id)).catch(showErr); await refreshAll();
  }));
}
function editSubject(s) {
  const m = modal(`<h2>Предмет</h2>
    <label>Назва<input id="esName" value="${esc(s.name)}"></label>
    <label>Групи (через кому)<input id="esGroups" value="${esc((s.groups || []).join(", "))}"></label>
    <div class="modal-btns"><button class="btn" data-x>Скасувати</button><button class="btn primary" id="esSave">Зберегти</button></div>`);
  $("#esSave").onclick = async () => {
    await updateDoc(doc(db, "subjects", s.id), { name: $("#esName").value.trim() || s.name, groups: $("#esGroups").value.split(",").map((x) => x.trim()).filter(Boolean) }).catch(showErr);
    m.remove(); await refreshAll();
  };
}
async function ensureSubject(name) {
  const n = name.trim();
  let s = subjects.find((x) => x.name.trim().toLowerCase() === n.toLowerCase());
  if (s) return s.id;
  const ref = doc(collection(db, "subjects"));
  await setDoc(ref, { name: n, groups: [], createdAt: serverTimestamp() });
  subjects.push({ id: ref.id, name: n, groups: [] });
  return ref.id;
}

// ================================================================ БАНК ПИТАНЬ
function renderBank() {
  const c = $("#bankCard");
  const subs = subjList();
  if (!bankSubject || !subs.find((s) => s.id === bankSubject)) bankSubject = subs[0]?.id || null;
  const list = banks.filter((b) => b.subjectId === bankSubject);
  const secs = [...new Set(list.map((b) => b.section))];
  c.innerHTML = `<div class="mon-head"><h2>Банк питань</h2>
      <div class="btns">
        <button class="btn small primary" id="newBank" ${subjects.length ? "" : "disabled"}>+ Нове заняття</button>
        <label class="btn small filebtn">Завантажити з Excel<input type="file" id="xlsFile" accept=".xlsx,.xls" hidden></label>
        <button class="btn small" id="xlsTpl">Шаблон Excel</button>
        <button class="btn small" id="xlsOut" ${list.length ? "" : "disabled"}>Вивантажити предмет в Excel</button>
      </div></div>
    ${subs.length ? `<div class="tabs">${subs.map((s) => `<button class="tab ${s.id === bankSubject ? "on" : ""}" data-s="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : `<p class="muted">Додайте предмет у блоці «Предмети» або завантажте Excel-файл з питаннями — предмет створиться автоматично.</p>`}
    ${secs.map((sec) => `<div class="sec-title">${esc(sec)}</div>
      <div class="table-wrap"><table class="tbl"><tbody>${list.filter((b) => b.section === sec).map((b) => `
        <tr><td style="width:100%;white-space:normal">${b.kind === "test" ? "★ " : ""}${esc(b.title)}</td><td>${KIND[b.kind] || b.kind}</td>
        <td>${b.variantCount > 1 ? `${b.variantCount} вар. × ` : ""}${b.itemCount} пит.</td>
        <td><button class="btn tiny-btn" data-ed="${b.id}">Редагувати</button></td><td><button class="btn tiny-btn" data-rm="${b.id}">✕</button></td></tr>`).join("")}
      </tbody></table></div>`).join("")}
    <details class="adv"><summary class="tiny muted">Додатково: завантажити файл questions.json</summary>
      <input type="file" id="bankFile" accept=".json,application/json">
      <p class="tiny muted">Файли з питаннями НЕ кладіть у репозиторій GitHub — завантажуйте лише тут.</p></details>`;
  c.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { bankSubject = b.dataset.s; renderBank(); }));
  c.querySelectorAll("[data-ed]").forEach((b) => (b.onclick = () => openEditor(banks.find((x) => x.id === b.dataset.ed))));
  c.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => removeBank(banks.find((x) => x.id === b.dataset.rm))));
  $("#newBank").onclick = () => openEditor(null);
  $("#xlsTpl").onclick = downloadTemplate;
  $("#xlsOut").onclick = () => exportSubject(bankSubject).catch(showErr);
  $("#xlsFile").onchange = (e) => importExcel(e.target.files[0]).catch(showErr).finally(() => (e.target.value = ""));
  $("#bankFile").onchange = (e) => importJson(e.target.files[0]).catch(showErr).finally(() => (e.target.value = ""));
}

async function removeBank(b) {
  if (!confirm(`Видалити «${b.title}» (${b.section}) з банку питань? Уже проведені тести й відповіді не зміняться.`)) return;
  const batch = writeBatch(db);
  for (let v = 1; v <= (b.variantCount || 1); v++) batch.delete(doc(db, "banks", b.id, "variants", String(v)));
  batch.delete(doc(db, "banks", b.id));
  await batch.commit(); delete itemsCache[b.id];
  toast("Видалено"); await refreshAll();
}

// збереження одного заняття (усі варіанти)
async function saveBank(id, meta, variants) {
  const vs = Object.keys(variants).sort((a, b) => a - b);
  const old = banks.find((b) => b.id === id);
  const batch = writeBatch(db);
  const clean = {};
  vs.forEach((v, i) => { clean[i + 1] = normalizeItems(variants[v]); });
  Object.entries(clean).forEach(([v, items]) => batch.set(doc(db, "banks", id, "variants", String(v)), { items }));
  for (let v = vs.length + 1; v <= (old?.variantCount || 0); v++) batch.delete(doc(db, "banks", id, "variants", String(v)));
  batch.set(doc(db, "banks", id), { ...meta, variantCount: vs.length, itemCount: clean[1].length, updatedAt: serverTimestamp() });
  await batch.commit();
  itemsCache[id] = clean;
}
const stripPrefix = (s) => String(s).replace(/^\s*(?:[А-ЯІЇЄҐA-Z]|\d{1,2})[.)]\s+/, "").trim();
function normalizeItems(items) {
  return items.filter((q) => q.text?.trim()).map((q, i) => {
    const o = { id: "q" + (i + 1), type: q.type, text: q.text.trim() };
    if (q.type === "choice") o.options = q.options.map(stripPrefix).filter(Boolean);
    if (q.type === "match") { o.left = q.left.map(stripPrefix).filter(Boolean).map((t, k) => `${k + 1}. ${t}`); o.right = q.right.map(stripPrefix).filter(Boolean).map((t, k) => `${LETTERS[k]}. ${t}`); }
    if (q.type === "seq") o.items = q.items.map(stripPrefix).filter(Boolean).map((t, k) => `${LETTERS[k]}. ${t}`);
    return o;
  });
}
const hashId = (s) => { let h = 5381; for (const ch of s) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0; return "b" + h.toString(36); };

// ---------------------------------------------------------------- редактор
function openEditor(b) {
  const st = {
    id: b?.id || null, subjectId: b ? (b.subjectId === NO_SUBJ ? subjects[0]?.id : b.subjectId) : (bankSubject !== NO_SUBJ ? bankSubject : subjects[0]?.id),
    section: b?.section || "", title: b?.title || "", kind: b?.kind || "seminar", variants: { 1: [] }, v: 1,
  };
  const secsOf = (sid) => [...new Set(banks.filter((x) => x.subjectId === sid).map((x) => x.section))];
  const m = modal(`<div class="editor"><div class="spinner"></div></div>`, "wide");
  const box = m.querySelector(".editor");
  (async () => {
    if (b) { const iv = await bankItems(b); st.variants = JSON.parse(JSON.stringify(iv)); }
    Object.values(st.variants).forEach((items) => items.forEach((q) => {
      if (q.options) q.options = q.options.map(stripPrefix);
      if (q.left) q.left = q.left.map(stripPrefix);
      if (q.right) q.right = q.right.map(stripPrefix);
      if (q.items) q.items = q.items.map(stripPrefix);
    }));
    draw();
  })().catch(showErr);

  function draw() {
    const items = st.variants[st.v] || (st.variants[st.v] = []);
    const vk = Object.keys(st.variants);
    box.innerHTML = `
      <div class="mon-head"><h2>${st.id ? "Редагування заняття" : "Нове заняття"}</h2><button class="btn small" data-x>Закрити</button></div>
      <div class="row2">
        <label>Предмет<select id="edSubj">${subjects.map((s) => `<option value="${s.id}" ${s.id === st.subjectId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
        <label>Тип заняття<select id="edKind"><option value="seminar" ${st.kind === "seminar" ? "selected" : ""}>Семінар (випадкові питання з переліку)</option><option value="test" ${st.kind === "test" ? "selected" : ""}>Тематична (варіанти)</option></select></label>
      </div>
      <div class="row2">
        <label>Розділ<input id="edSec" list="secList" value="${esc(st.section)}" placeholder="напр. Розділ 3"><datalist id="secList">${secsOf(st.subjectId).map((s) => `<option value="${esc(s)}">`).join("")}</datalist></label>
        <label>Назва заняття<input id="edTitle" value="${esc(st.title)}" placeholder="напр. Семінарське заняття 1. …"></label>
      </div>
      ${st.kind === "test" ? `<div class="tabs">${vk.map((v) => `<button class="tab ${+v === +st.v ? "on" : ""}" data-v="${v}">Варіант ${v}</button>`).join("")}
        <button class="tab" id="addV">+ варіант</button>${vk.length > 1 ? `<button class="tab" id="delV">✕ видалити варіант ${st.v}</button>` : ""}</div>` : ""}
      <div class="ed-list">${items.map((q, i) => itemEditor(q, i, items.length)).join("") || `<p class="muted">Питань ще немає.</p>`}</div>
      <div class="btns"><button class="btn" id="addQ">+ Питання</button></div>
      <div class="ed-foot"><span class="muted tiny" id="edEst"></span><button class="btn primary" id="edSave">Зберегти</button></div>`;
    const est = estimate({ 1: normalizeItems(items) }, st.kind, 0);
    $("#edEst").textContent = items.length ? `Орієнтовний час на ${st.kind === "test" ? "варіант" : "всі питання"}: ${est} хв` : "";
    box.querySelector("[data-x]").onclick = () => m.remove();
    $("#edSubj").onchange = (e) => { st.subjectId = e.target.value; };
    $("#edKind").onchange = (e) => { st.kind = e.target.value; if (st.kind === "seminar") { st.variants = { 1: st.variants[1] || [] }; st.v = 1; } draw(); };
    $("#edSec").oninput = (e) => (st.section = e.target.value);
    $("#edTitle").oninput = (e) => (st.title = e.target.value);
    box.querySelectorAll("[data-v]").forEach((t) => (t.onclick = () => { st.v = +t.dataset.v; draw(); }));
    $("#addV")?.addEventListener("click", () => { const n = vk.length + 1; st.variants[n] = JSON.parse(JSON.stringify(st.variants[st.v] || [])); st.v = n; toast("Створено копію поточного варіанта — змініть питання"); draw(); });
    $("#delV")?.addEventListener("click", () => {
      if (!confirm(`Видалити варіант ${st.v}?`)) return;
      const rest = Object.keys(st.variants).filter((v) => +v !== +st.v).map((v) => st.variants[v]);
      st.variants = {}; rest.forEach((it, i) => (st.variants[i + 1] = it)); st.v = 1; draw();
    });
    $("#addQ").onclick = () => { items.push({ type: "open", text: "", options: ["", "", "", ""], left: [], right: [], items: [] }); draw(); box.querySelector(".ed-item:last-child textarea")?.focus(); };
    box.querySelectorAll(".ed-item").forEach((el) => {
      const i = +el.dataset.i, q = items[i];
      el.querySelector("[data-f=type]").onchange = (e) => { q.type = e.target.value; q.options ||= ["", "", "", ""]; q.left ||= []; q.right ||= []; q.items ||= []; draw(); };
      el.querySelector("[data-f=text]").oninput = (e) => (q.text = e.target.value);
      el.querySelectorAll("[data-list]").forEach((ta) => (ta.oninput = () => (q[ta.dataset.list] = ta.value.split("\n"))));
      el.querySelector("[data-a=up]").onclick = () => { if (i > 0) { [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); } };
      el.querySelector("[data-a=down]").onclick = () => { if (i < items.length - 1) { [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); } };
      el.querySelector("[data-a=del]").onclick = () => { if (confirm("Видалити це питання?")) { items.splice(i, 1); draw(); } };
    });
    $("#edSave").onclick = save;
  }
  async function save() {
    if (!st.subjectId) return toast("Спочатку додайте предмет");
    if (!st.section.trim() || !st.title.trim()) return toast("Вкажіть розділ і назву заняття");
    const vs = Object.values(st.variants);
    if (vs.some((it) => !normalizeItems(it).length)) return toast("У кожному варіанті має бути хоча б одне питання");
    for (const it of vs) for (const q of it) {
      if (!q.text?.trim()) continue;
      if (q.type === "choice" && q.options.filter((x) => x.trim()).length < 2) return toast("У тестовому питанні потрібно щонайменше 2 варіанти відповіді");
      if (q.type === "match" && (!q.left.some((x) => x.trim()) || q.right.filter((x) => x.trim()).length < q.left.filter((x) => x.trim()).length)) return toast("У питанні на відповідність праворуч має бути не менше пунктів, ніж ліворуч");
      if (q.type === "seq" && q.items.filter((x) => x.trim()).length < 2) return toast("У питанні на послідовність потрібно щонайменше 2 елементи");
    }
    const id = st.id || hashId(`${st.subjectId}|${st.section.trim()}|${st.title.trim()}|${Date.now()}`);
    await saveBank(id, { subjectId: st.subjectId, section: st.section.trim(), title: st.title.trim(), kind: st.kind }, st.variants);
    toast("Збережено"); m.remove(); bankSubject = st.subjectId; await refreshAll();
  }
}
function itemEditor(q, i, n) {
  const ta = (f, v, ph, rows = 4) => `<textarea data-list="${f}" rows="${rows}" placeholder="${ph}">${esc((v || []).join("\n"))}</textarea>`;
  return `<div class="ed-item" data-i="${i}">
    <div class="ed-head"><b>${i + 1}.</b>
      <select data-f="type">${Object.entries(TYPE_UA).map(([k, v]) => `<option value="${k}" ${q.type === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      <span class="grow"></span>
      <button class="btn tiny-btn" data-a="up" ${i === 0 ? "disabled" : ""}>↑</button><button class="btn tiny-btn" data-a="down" ${i === n - 1 ? "disabled" : ""}>↓</button><button class="btn tiny-btn" data-a="del">✕</button></div>
    <textarea data-f="text" rows="2" placeholder="Текст питання">${esc(q.text)}</textarea>
    ${q.type === "choice" ? `<div class="tiny muted">Варіанти відповіді — кожен з нового рядка (без «а)», літери додаються автоматично):</div>${ta("options", q.options, "варіант 1\nваріант 2\nваріант 3\nваріант 4")}` : ""}
    ${q.type === "match" ? `<div class="row2"><div><div class="tiny muted">Ліва частина (1, 2, 3…) — з нового рядка:</div>${ta("left", q.left, "пункт 1\nпункт 2")}</div>
      <div><div class="tiny muted">Права частина (А, Б, В…) — з нового рядка, у перемішаному порядку:</div>${ta("right", q.right, "відповідь А\nвідповідь Б")}</div></div>` : ""}
    ${q.type === "seq" ? `<div class="tiny muted">Елементи — з нового рядка, у ПЕРЕМІШАНОМУ порядку (студент має розставити їх правильно):</div>${ta("items", q.items, "етап …\nетап …")}` : ""}
  </div>`;
}

function modal(html, cls = "") {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-box ${cls}">${html}</div>`;
  m.addEventListener("click", (e) => { if (e.target.matches("[data-x]")) m.remove(); });
  document.body.appendChild(m);
  return m;
}

// ---------------------------------------------------------------- Excel
const XHEAD = ["Предмет", "Розділ", "Назва заняття", "Тип заняття", "Варіант", "№", "Тип питання", "Питання",
  "Відповідь 1", "Відповідь 2", "Відповідь 3", "Відповідь 4", "Відповідь 5", "Відповідь 6", "Ліва частина (для відповідності)", "Правильна відповідь (на сайт не завантажується)"];

function rowsForBank(b, iv) {
  const rows = [];
  for (const [v, items] of Object.entries(iv)) items.forEach((q, i) => {
    const ans = q.type === "choice" ? q.options : q.type === "match" ? q.right : q.type === "seq" ? q.items : [];
    const a = (ans || []).map(stripPrefix);
    rows.push([subjName(b.subjectId), b.section, b.title, b.kind === "test" ? "тематична" : "семінар", +v, i + 1, TYPE_UA[q.type], q.text,
      a[0] || "", a[1] || "", a[2] || "", a[3] || "", a[4] || "", a[5] || "", q.type === "match" ? q.left.map(stripPrefix).join("\n") : "", ""]);
  });
  return rows;
}
function writeQuestionsXlsx(rows, name) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([XHEAD, ...rows]);
  ws["!cols"] = [{ wch: 26 }, { wch: 12 }, { wch: 34 }, { wch: 11 }, { wch: 8 }, { wch: 5 }, { wch: 14 }, { wch: 60 }, ...Array(6).fill({ wch: 24 }), { wch: 30 }, { wch: 24 }];
  ws["!autofilter"] = { ref: `A1:P${rows.length + 1}` };
  XLSX.utils.book_append_sheet(wb, ws, "Питання");
  const help = [
    ["Як заповнювати"],
    ["Кожен рядок — одне питання. Рядки з однаковими «Предмет + Розділ + Назва заняття» складають одне заняття."],
    ["Тип заняття: «семінар» (студент отримує випадкові питання з переліку) або «тематична» (варіанти; стовпець «Варіант» = 1, 2, …)."],
    ["Тип питання: «відкрите», «тест», «відповідність», «послідовність»."],
    ["тест — варіанти відповіді у стовпцях «Відповідь 1…6» (без «а)», літери додаються автоматично)."],
    ["відповідність — ліві пункти в стовпці «Ліва частина», кожен з нового рядка (Alt+Enter); праві — у «Відповідь 1…6» у перемішаному порядку."],
    ["послідовність — елементи у «Відповідь 1…6» у ПЕРЕМІШАНОМУ порядку."],
    ["відкрите — лише текст питання. Підпункти можна писати як «а) … б) …» — на сайті вони стануть окремими рядками."],
    ["Стовпець «Правильна відповідь» — лише для вас і для перевірки; на сайт він не завантажується."],
    ["Якщо предмета ще немає на сайті — він створиться автоматично. Заняття з такою самою назвою буде ЗАМІНЕНО новим вмістом."],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(help); ws2["!cols"] = [{ wch: 140 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Інструкція");
  XLSX.writeFile(wb, name);
}
function downloadTemplate() {
  const s = subjects.find((x) => x.id === bankSubject)?.name || "Назва предмета";
  writeQuestionsXlsx([
    [s, "Розділ 1", "Семінарське заняття 1. Назва теми", "семінар", 1, 1, "відкрите", "Що таке …? Наведіть приклад.", "", "", "", "", "", "", "", ""],
    [s, "Розділ 1", "Семінарське заняття 1. Назва теми", "семінар", 1, 2, "відкрите", "Назвіть … а) … б) …", "", "", "", "", "", "", "", ""],
    [s, "Розділ 1", "Тематична контрольна робота", "тематична", 1, 1, "тест", "Питання з вибором відповіді", "варіант 1", "варіант 2", "варіант 3", "варіант 4", "", "", "", "б"],
    [s, "Розділ 1", "Тематична контрольна робота", "тематична", 1, 2, "відповідність", "Установіть відповідність …", "праве Б", "праве А", "праве Г", "праве В", "", "", "лівий 1\nлівий 2\nлівий 3\nлівий 4", "1-Б; 2-А; 3-Г; 4-В"],
    [s, "Розділ 1", "Тематична контрольна робота", "тематична", 1, 3, "послідовність", "Установіть послідовність …", "етап В", "етап А", "етап Б", "", "", "", "", "Б → В → А"],
    [s, "Розділ 1", "Тематична контрольна робота", "тематична", 2, 1, "відкрите", "Логічна задача … а) … б) …", "", "", "", "", "", "", "", ""],
  ], "Шаблон_питань.xlsx");
}
async function exportSubject(sid) {
  const rows = [];
  for (const b of banks.filter((x) => x.subjectId === sid)) rows.push(...rowsForBank(b, await bankItems(b)));
  writeQuestionsXlsx(rows, `Питання_${fileSafe(subjName(sid))}.xlsx`);
}
async function importExcel(file) {
  if (!file) return;
  const wb = XLSX.read(await file.arrayBuffer());
  const ws = wb.Sheets["Питання"] || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }).slice(1).filter((r) => String(r[7]).trim());
  if (!rows.length) return toast("У файлі не знайдено питань");
  const groups = new Map();
  const errors = [];
  rows.forEach((r, idx) => {
    const [subj, sec, title, kindUa, v, n, typeUa, text] = r.map((x) => String(x).trim());
    const type = TYPE_FROM_UA[typeUa.toLowerCase()] || (typeUa ? null : "open");
    if (!subj || !sec || !title) return errors.push(`рядок ${idx + 2}: не заповнено предмет/розділ/назву`);
    if (!type) return errors.push(`рядок ${idx + 2}: невідомий тип питання «${typeUa}»`);
    const kind = /тем/i.test(kindUa) ? "test" : "seminar";
    const key = `${subj}|${sec}|${title}`;
    if (!groups.has(key)) groups.set(key, { subj, sec, title, kind, variants: {} });
    const g = groups.get(key);
    const vn = kind === "test" ? Math.max(1, parseInt(v, 10) || 1) : 1;
    const ans = r.slice(8, 14).map((x) => String(x).trim()).filter(Boolean);
    const q = { n: parseFloat(n) || idx, type, text };
    if (type === "choice") q.options = ans;
    if (type === "match") { q.right = ans; q.left = String(r[14]).split(/\n|\s\|\s/).map((x) => x.trim()).filter(Boolean); }
    if (type === "seq") q.items = ans;
    (g.variants[vn] ||= []).push(q);
  });
  if (errors.length) return showErr({ message: "Файл не завантажено:\n" + errors.slice(0, 8).join("\n") });
  const summary = [...groups.values()].map((g) => `• ${g.subj} → ${g.sec} → ${g.title} (${Object.keys(g.variants).length > 1 ? Object.keys(g.variants).length + " вар., " : ""}${g.variants[Object.keys(g.variants)[0]].length} пит.)`).join("\n");
  if (!confirm(`Буде завантажено ${groups.size} занять:\n${summary}\n\nЗаняття з такими самими назвами буде замінено. Продовжити?`)) return;
  for (const g of groups.values()) {
    const subjectId = await ensureSubject(g.subj);
    const existing = banks.find((b) => b.subjectId === subjectId && b.section === g.sec && b.title === g.title);
    const id = existing?.id || hashId(`${subjectId}|${g.sec}|${g.title}`);
    Object.values(g.variants).forEach((it) => it.sort((a, b) => a.n - b.n));
    await saveBank(id, { subjectId, section: g.sec, title: g.title, kind: g.kind }, g.variants);
  }
  toast(`Завантажено занять: ${groups.size}`, 4000);
  await refreshAll();
}
async function importJson(file) {
  if (!file) return;
  const data = JSON.parse(await file.text());
  let n = 0;
  for (const b of data.banks) {
    const subjectId = b.subject ? await ensureSubject(b.subject) : null;
    const section = b.section || (b.id.match(/^r(\d+)-/) ? `Розділ ${b.id.match(/^r(\d+)-/)[1]}` : "Без розділу");
    const title = b.title.replace(/^Розділ \d+\.\s*/, "");
    await saveBank(b.id, { subjectId, section, title, kind: b.kind }, b.variants);
    n++;
  }
  toast(`Завантажено занять: ${n}`); await refreshAll();
}
