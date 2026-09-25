import { auth, db, $, esc, toast, fmtTime, answerText, isAnswered } from "./common.js";
import { TEACHER_EMAIL } from "./firebase-config.js";
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, onSnapshot, writeBatch,
  serverTimestamp, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = $("#app");
let cfg = {}, banks = [], unsubMon = null, monItems = {}, monSid = null, monTimer = null, monRows = [];

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
  app.innerHTML = `<div class="card"><h1>Помилка</h1><p>${esc(e.code || e.message)}</p>
  <p class="muted">Найчастіша причина — не опубліковано правила Firestore (файл firestore.rules) або в них інший e-mail викладача.</p></div>`;
}

// ================================================================ DASHBOARD
async function dashboard() {
  app.innerHTML = `
  <div class="grid">
    <div class="card" id="curCard"></div>
    <div class="card" id="openCard"></div>
  </div>
  <div class="card" id="monCard"></div>
  <div class="grid">
    <div class="card" id="expCard"></div>
    <div class="card" id="bankCard"></div>
  </div>`;
  await loadBanks();
  renderOpen(); renderBank(); renderExport();
  onSnapshot(doc(db, "config", "current"), (s) => { cfg = s.data() || {}; renderCurrent(); startMonitor(cfg.sittingId); });
}

async function loadBanks() {
  const snap = await getDocs(collection(db, "banks"));
  banks = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.id.localeCompare(b.id, "uk", { numeric: true }));
}

// ---------------------------------------------------------------- current
const STUDENT_URL = location.href.replace(/teacher\.html.*$/, "").replace(/[?#].*$/, "");
function linkBlock() {
  return `<div class="linkbox">
    <div class="tiny muted">Посилання для студентів</div>
    <div class="linkrow"><a href="${STUDENT_URL}" target="_blank" id="stuLink">${esc(STUDENT_URL)}</a>
      <button class="btn small" id="copyLink">Копіювати</button>
      <button class="btn small" id="qrBtn">QR-код</button></div>
    <div id="qrBox" hidden></div>
  </div>`;
}
function bindLinkBlock() {
  $("#copyLink").onclick = async () => { try { await navigator.clipboard.writeText(STUDENT_URL); toast("Посилання скопійовано"); } catch { toast(STUDENT_URL, 6000); } };
  $("#qrBtn").onclick = () => {
    const box = $("#qrBox"); box.hidden = !box.hidden;
    if (!box.hidden && !box.dataset.done && window.QRCode) { new QRCode(box, { text: STUDENT_URL, width: 220, height: 220 }); box.dataset.done = 1; }
  };
}

function renderCurrent() {
  const c = $("#curCard");
  const gi = $("#of input[name=groups]"); if (gi && !gi.value && cfg.groups?.length) gi.value = cfg.groups.join(", ");
  if (!cfg.sittingId) { c.innerHTML = `<h2>Поточний тест</h2><p class="muted">Жоден тест ще не відкривався.</p>${linkBlock()}`; bindLinkBlock(); return; }
  c.innerHTML = `<h2>Поточний тест</h2>
    <div class="status ${cfg.active ? "on" : "off"}">${cfg.active ? "● Реєстрацію відкрито" : "● Реєстрацію закрито"}</div>
    <p class="big-title">${esc(cfg.title)}</p>
    <p class="muted">Тривалість ${cfg.durationMin} хв${cfg.kind === "seminar" ? ` · питань на студента: ${cfg.qCount || "усі"}` : ` · варіантів: ${cfg.variantCount}`}
      · групи: ${esc((cfg.groups || []).join(", ") || "будь-які")}</p>
    <div class="btns">
      ${cfg.active
        ? `<button class="btn danger" id="closeBtn">Закрити реєстрацію</button>`
        : `<button class="btn" id="reopenBtn">Відкрити реєстрацію знову</button>`}
    </div>
    <p class="tiny muted">Закриття реєстрації не зупиняє тих, хто вже почав: вони дописують до кінця свого часу.</p>
    ${linkBlock()}`;
  bindLinkBlock();
  $("#closeBtn")?.addEventListener("click", () => updateDoc(doc(db, "config", "current"), { active: false }));
  $("#reopenBtn")?.addEventListener("click", () => updateDoc(doc(db, "config", "current"), { active: true }));
}

// ---------------------------------------------------------------- open new
function renderOpen() {
  const c = $("#openCard");
  if (!banks.length) { c.innerHTML = `<h2>Відкрити тест</h2><p class="muted">Спочатку завантажте банк питань (блок «Банк питань» нижче).</p>`; return; }
  const groupsDefault = (cfg.groups || []).join(", ");
  const opts = (sec) => banks.filter((b) => b.id.startsWith(`r${sec}-`))
    .map((b) => `<option value="${b.id}">${esc(b.kind === "test" ? "★ " + b.title : b.title.replace(/^Розділ \d+\.\s*/, ""))}</option>`).join("");
  const secs = [...new Set(banks.map((b) => (b.id.match(/^r(\d+)-/) || [])[1]).filter(Boolean))];
  c.innerHTML = `<h2>Відкрити тест</h2>
    <form id="of">
      <label>Що проводимо
        <select name="bank" required>${secs.map((s) => `<optgroup label="Розділ ${s}">${opts(s)}</optgroup>`).join("")}</select>
      </label>
      <div class="row2">
        <label>Тривалість, хв<input name="dur" type="number" min="1" max="240" value="40" required></label>
        <label id="qcLbl">Питань на студента<input name="qc" type="number" min="0" max="50" value="5"><span class="tiny muted">0 — усі питання</span></label>
      </div>
      <label>Групи (через кому)<input name="groups" placeholder="напр. 201-Т, 202-Т" value="${esc(groupsDefault)}"></label>
      <button class="btn primary big">Відкрити тест</button>
      <p class="tiny muted">Для тематичної варіант кожному студенту видається автоматично, порівну між варіантами.</p>
    </form>`;
  const f = $("#of");
  const sync = () => { const b = banks.find((x) => x.id === f.bank.value); $("#qcLbl").style.display = b?.kind === "seminar" ? "" : "none"; };
  f.bank.onchange = sync; sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const b = banks.find((x) => x.id === f.bank.value);
    const durationMin = Math.max(1, parseInt(f.dur.value, 10));
    const qCount = b.kind === "seminar" ? Math.max(0, parseInt(f.qc.value, 10) || 0) : 0;
    const groups = f.groups.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (cfg.active && !confirm("Зараз відкрито інший тест. Закрити його реєстрацію і відкрити новий?")) return;
    const sref = doc(collection(db, "sittings"));
    const common = { testId: b.id, title: b.title, kind: b.kind, durationMin, qCount, itemCount: b.itemCount, variantCount: b.variantCount, groups };
    await setDoc(sref, { ...common, count: 0, offset: Math.floor(Math.random() * b.variantCount), createdAt: serverTimestamp() });
    await setDoc(doc(db, "config", "current"), { ...common, active: true, sittingId: sref.id, openedAt: serverTimestamp() });
    toast("Тест відкрито. Студенти можуть заходити на сайт.");
    renderExport();
  };
}

// ---------------------------------------------------------------- monitor
async function startMonitor(sid) {
  if (sid === monSid) return;
  monSid = sid; unsubMon?.(); clearInterval(monTimer);
  const c = $("#monCard");
  if (!sid) { c.innerHTML = `<h2>Хто пише зараз</h2><p class="muted">Немає активного тесту.</p>`; return; }
  const sit = (await getDoc(doc(db, "sittings", sid))).data();
  monItems = await loadItems(sit.testId, sit.variantCount);
  c.innerHTML = `<div class="mon-head"><h2>Хто пише зараз</h2><span class="muted" id="monCount"></span></div>
    <div class="table-wrap"><table class="tbl"><thead><tr>
      <th>#</th><th>Група</th><th>ПІБ</th><th>Вар.</th><th>Почав</th><th>Статус</th><th>Відповіді</th>
      <th title="Виходи з вікна">Вих.</th><th title="Спроби вставлення">Вст.</th><th title="Копіювання / знімки екрана">Коп./скр.</th><th></th>
    </tr></thead><tbody id="monBody"></tbody></table></div>`;
  unsubMon = onSnapshot(collection(db, "sittings", sid, "sessions"), (snap) => {
    monRows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.group + a.name).localeCompare(b.group + b.name, "uk"));
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
    const left = st + sit.durationMin * 60000 - now;
    const status = r.submitted ? `<span class="ok">Здано ${time(r.submittedAt)}</span>`
      : left <= 0 ? `<span class="bad">Час вийшов</span>` : `Пише · ${fmtTime(left)}`;
    const ev = r.events || {};
    const flag = (v) => (v > 0 ? `<b class="bad">${v}</b>` : "0");
    return `<tr><td>${i + 1}</td><td>${esc(r.group)}</td><td>${esc(r.name)}</td><td>${r.variant}</td><td>${time(r.startedAt)}</td>
      <td>${status}</td><td>${n}/${items.length}</td><td>${flag(ev.blur)}</td><td>${flag(ev.paste)}</td><td>${flag((ev.copy || 0) + (ev.print || 0))}</td>
      <td><button class="btn tiny-btn" data-reset="${r.id}" data-rk="${esc(r.rosterKey)}">Скинути</button></td></tr>`;
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

async function loadItems(testId, variantCount) {
  const out = {};
  for (let v = 1; v <= variantCount; v++) {
    const s = await getDoc(doc(db, "banks", testId, "variants", String(v)));
    out[v] = s.exists() ? s.data().items : [];
  }
  return out;
}
function pickItems(r, itemsByVariant) {
  const all = itemsByVariant[r.variant] || [];
  return r.qids ? r.qids.map((id) => all.find((q) => q.id === id)).filter(Boolean) : all;
}

// ---------------------------------------------------------------- export
async function renderExport() {
  const c = $("#expCard");
  const snap = await getDocs(query(collection(db, "sittings"), orderBy("createdAt", "desc"), limit(60)));
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  c.innerHTML = `<h2>Вивантажити відповіді</h2>
    ${list.length ? `<label>Тест<select id="expSel">${list.map((s) => `<option value="${s.id}">${esc(dt(s.createdAt))} — ${esc(s.title.slice(0, 80))} (${s.count} студ.)</option>`).join("")}</select></label>
    <button class="btn primary" id="expBtn">Завантажити Excel</button>
    <p class="tiny muted">Файл містить питання й відповіді кожного студента. Цей файл передайте Claude на перевірку.</p>`
    : `<p class="muted">Ще немає проведених тестів.</p>`}`;
  $("#expBtn")?.addEventListener("click", () => exportXlsx($("#expSel").value).catch((e) => { console.error(e); toast("Помилка вивантаження"); }));
}
const dt = (ts) => (ts?.toDate ? ts.toDate().toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

async function exportXlsx(sid) {
  const sit = (await getDoc(doc(db, "sittings", sid))).data();
  const sessions = (await getDocs(collection(db, "sittings", sid, "sessions"))).docs.map((d) => d.data())
    .sort((a, b) => (a.group + a.name).localeCompare(b.group + b.name, "uk"));
  const iv = await loadItems(sit.testId, sit.variantCount);
  const typeName = { choice: "тест", match: "відповідність", seq: "послідовність", open: "відкрите" };

  const answersRows = [["Група", "ПІБ", "Варіант", "№", "ID питання", "Тип", "Питання", "Відповідь студента"]];
  const studRows = [["Група", "ПІБ", "Варіант", "Початок", "Здано", "Тривалість, хв", "Статус", "Відповідей", "Виходів з вікна", "Спроб вставлення", "Копіювання", "Знімки екрана"]];
  for (const s of sessions) {
    const items = pickItems(s, iv);
    items.forEach((q, i) => answersRows.push([s.group, s.name, s.variant, i + 1, q.id, typeName[q.type] || q.type,
      q.text + (q.type === "choice" ? "\n" + q.options.map((o, k) => `${"абвг"[k]}) ${o}`).join("\n") : "")
        + (q.type === "match" ? "\n" + q.left.join("\n") + "\n" + q.right.join("\n") : "")
        + (q.type === "seq" ? "\n" + q.items.join("\n") : ""),
      answerText(q, s.answers?.[q.id])]));
    const st = s.startedAt?.toMillis?.(), en = s.submittedAt?.toMillis?.();
    const ev = s.events || {};
    studRows.push([s.group, s.name, s.variant, dt(s.startedAt), s.submitted ? dt(s.submittedAt) : "", st && en ? Math.round((en - st) / 60000) : "",
      s.submitted ? "здано" : "не надіслав (зараховано збережене)", items.filter((q) => isAnswered(q, s.answers?.[q.id])).length + "/" + items.length,
      ev.blur || 0, ev.paste || 0, ev.copy || 0, ev.print || 0]);
  }
  const info = [["Тест", sit.title], ["ID банку", sit.testId], ["ID сесії", sid], ["Дата", dt(sit.createdAt)],
    ["Тривалість, хв", sit.durationMin], ["Тип", sit.kind === "test" ? "тематична" : "семінар"], ["Студентів", sessions.length]];

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(answersRows); ws1["!cols"] = [{ wch: 10 }, { wch: 26 }, { wch: 8 }, { wch: 5 }, { wch: 8 }, { wch: 14 }, { wch: 70 }, { wch: 70 }];
  const ws2 = XLSX.utils.aoa_to_sheet(studRows); ws2["!cols"] = [{ wch: 10 }, { wch: 28 }, { wch: 8 }, { wch: 17 }, { wch: 17 }, { wch: 10 }, { wch: 22 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
  const ws3 = XLSX.utils.aoa_to_sheet(info); ws3["!cols"] = [{ wch: 16 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Відповіді");
  XLSX.utils.book_append_sheet(wb, ws2, "Студенти");
  XLSX.utils.book_append_sheet(wb, ws3, "Інфо");
  const d = sit.createdAt?.toDate?.() || new Date();
  XLSX.writeFile(wb, `Відповіді_${sit.testId}_${d.toISOString().slice(0, 10)}.xlsx`);
}

// ---------------------------------------------------------------- bank
function renderBank() {
  const c = $("#bankCard");
  c.innerHTML = `<h2>Банк питань</h2>
    <p class="muted">У базі: ${banks.length ? `${banks.filter((b) => b.kind === "seminar").length} семінарів, ${banks.filter((b) => b.kind === "test").length} тематичних` : "порожньо"}.</p>
    <label class="file">Завантажити / оновити файл <b>questions.json</b>
      <input type="file" id="bankFile" accept=".json,application/json"></label>
    <p class="tiny muted">Файл questions.json НЕ кладіть у репозиторій GitHub — завантажуйте лише тут.</p>`;
  $("#bankFile").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      let n = 0;
      for (const b of data.banks) {
        const batch = writeBatch(db);
        const vs = Object.keys(b.variants);
        batch.set(doc(db, "banks", b.id), { title: b.title, kind: b.kind, variantCount: vs.length, itemCount: b.variants[vs[0]].length, updatedAt: serverTimestamp() });
        vs.forEach((v) => batch.set(doc(db, "banks", b.id, "variants", String(v)), { items: b.variants[v] }));
        await batch.commit(); n++;
      }
      toast(`Завантажено: ${n}`);
      await loadBanks(); renderBank(); renderOpen();
    } catch (err) { console.error(err); toast("Помилка: файл пошкоджено або немає прав"); }
  };
}
