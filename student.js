import { auth, db, $, esc, toast, fmtTime, LETTERS, OPT, isAnswered, toMs } from "./common.js";
import { SITE_TITLE } from "./firebase-config.js";
import { signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, onSnapshot, runTransaction, serverTimestamp, updateDoc, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = $("#app");
$("#siteTitle").textContent = SITE_TITLE;

let cfg = null, uid = null, sessRef = null, sess = null, items = [];
let answers = {}, deadline = 0, clockOffset = 0, tick = null, saveTimer = null;
let finished = false, started = false;

// ---------------------------------------------------------------- start
const CODE = (new URLSearchParams(location.search).get("t") || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
init().catch((e) => fatal(e));


async function init() {
  if (!CODE) return showMsg("Відкрийте посилання на тест", "Скористайтеся посиланням або QR-кодом, які дав викладач на цьому занятті.");
  await signInAnonymously(auth);
  uid = auth.currentUser.uid;
  onSnapshot(doc(db, "open", CODE), (snap) => {
    if (!snap.exists()) { if (!started) showMsg("Посилання недійсне", "Перевірте посилання або попросіть у викладача нове."); return; }
    cfg = snap.data();
    if (!started) route();
  }, (e) => fatal(e));
}

async function route() {
  // чи вже є сесія цього браузера в цьому тесті?
  sessRef = doc(db, "sittings", cfg.sittingId, "sessions", uid);
  let snap;
  try { snap = await getDoc(sessRef); } catch { snap = null; }
  if (snap && snap.exists()) return resume(snap.data());
  if (!cfg.active) return showMsg("Реєстрацію на цей тест закрито", "Якщо ви ще не проходили тест — зверніться до викладача.");
  const from = toMs(cfg.openFrom), to = toMs(cfg.closeAt);
  if (from && Date.now() < from) return showMsg("Тест ще не відкрито", `Тест стане доступним ${fmtDate(from)}. Відкрийте це посилання пізніше.`);
  if (to && Date.now() >= to) return showMsg("Термін виконання минув", `Тест треба було виконати до ${fmtDate(to)}. Якщо ви не встигли з поважної причини — зверніться до викладача.`);
  showRegister();
}

const fmtDate = (ms) => new Date(ms).toLocaleString("uk-UA", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

function showMsg(title, text) {
  app.innerHTML = `<div class="card center"><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p></div>`;
}

function showRegister() {
  const groups = (cfg.groups || []).filter(Boolean);
  app.innerHTML = `
  <div class="card reg">
    <div class="pill">${esc(cfg.subjectName || "Контроль знань")}${cfg.mode === "home" ? " · домашнє завдання" : ""}</div>
    <h1>${esc(cfg.title)}</h1>
    <p class="muted">Тривалість: <b>${cfg.durationMin} хв</b>${cfg.kind === "seminar" && cfg.qCount ? ` · питань: <b>${cfg.qCount}</b>` : ""}</p>
    ${toMs(cfg.closeAt) ? `<div class="deadline">Домашнє завдання: виконати до <b>${fmtDate(toMs(cfg.closeAt))}</b>. Після натискання «Почати» у вас буде ${cfg.durationMin} хв${Date.now() + cfg.durationMin * 60000 > toMs(cfg.closeAt) ? ` — але не пізніше кінцевого терміну, тобто менше` : ""}. Починайте, коли матимете вільний час без перерв.</div>` : ""}
    <form id="reg" autocomplete="off">
      <label>Група
        ${groups.length
          ? `<select name="group" required><option value="">— оберіть групу —</option>${groups.map((g) => `<option>${esc(g)}</option>`).join("")}</select>`
          : `<input name="group" required maxlength="20" placeholder="напр. 201-Т">`}
      </label>
      <div class="row2">
        <label>Прізвище<input name="last" required maxlength="40"></label>
        <label>Ім'я<input name="first" required maxlength="40"></label>
      </div>
      <div class="rules">
        <b>Правила:</b>
        <ul>
          <li>Відповіді вводьте лише вручну — вставлення тексту заблоковано.</li>
          <li>Перехід в інше вікно чи вкладку ховає тест і фіксується.</li>
          <li>Відлік часу почнеться одразу після натискання «Почати». Коли час вийде, відповіді надішлються автоматично.</li>
          <li>Відповіді зберігаються автоматично. Якщо сторінка закриється, відкрийте її знову на тому самому пристрої.</li>
          <li>Оцінюється зміст відповіді, а не орфографія.</li>
        </ul>
        <label class="check"><input type="checkbox" name="ok" required> Я ознайомився(-лась) з правилами</label>
      </div>
      <button class="btn primary big" type="submit">Почати</button>
      <p class="err" id="regErr"></p>
    </form>
  </div>`;
  $("#reg").addEventListener("submit", onRegister);
}

const norm = (s) => s.trim().replace(/\s+/g, " ").replace(/^./, (c) => c.toUpperCase());

async function onRegister(e) {
  e.preventDefault();
  const f = e.target, btn = f.querySelector("button");
  const group = f.group.value.trim();
  const name = `${norm(f.last.value)} ${norm(f.first.value)}`;
  if (name.length < 5) return ($("#regErr").textContent = "Введіть прізвище та ім'я повністю.");
  btn.disabled = true; btn.textContent = "Реєстрація…";
  const sid = cfg.sittingId;
  const rosterKey = `${group}__${name}`.toLowerCase().replace(/[\/.#$\[\]]/g, "").slice(0, 140);
  let qids = null;
  if (cfg.kind === "seminar" && cfg.qCount > 0 && cfg.itemCount > cfg.qCount) {
    const all = Array.from({ length: cfg.itemCount }, (_, i) => "q" + (i + 1));
    shuffle(all); qids = all.slice(0, cfg.qCount);
  }
  try {
    const t0 = Date.now();
    await runTransaction(db, async (tx) => {
      const sref = doc(db, "sittings", sid);
      const s = (await tx.get(sref)).data();
      const count = s.count + 1;
      const variant = ((count + s.offset) % s.variantCount) + 1;
      tx.update(sref, { count });
      tx.set(doc(db, "sittings", sid, "roster", rosterKey), { uid, group, name });
      tx.set(sessRef, {
        uid, group, name, variant, rosterKey, qids,
        startedAt: serverTimestamp(), updatedAt: serverTimestamp(),
        submitted: false, answers: {},
        events: { blur: 0, paste: 0, copy: 0, print: 0 },
      });
    });
    const snap = await getDoc(sessRef);
    clockOffset = snap.data().startedAt.toMillis() - (t0 + Date.now()) / 2;
    resume(snap.data(), true);
  } catch (err) {
    console.error(err);
    btn.disabled = false; btn.textContent = "Почати";
    $("#regErr").textContent = String(err.code || "").includes("permission")
      ? "Не вдалося зареєструватися: можливо, студент з таким ПІБ уже проходить цей тест, або реєстрацію закрито. Зверніться до викладача."
      : "Помилка зв'язку. Перевірте інтернет і спробуйте ще раз.";
  }
}

// ---------------------------------------------------------------- test
async function resume(data, fresh = false) {
  started = true; sess = data;
  answers = data.answers || {};
  if (!fresh) {
    // синхронізація годинника з сервером
    try {
      const t0 = Date.now();
      await updateDoc(sessRef, { updatedAt: serverTimestamp() });
      const s2 = await getDoc(sessRef);
      clockOffset = s2.data().updatedAt.toMillis() - (t0 + Date.now()) / 2;
    } catch { /* тест уже завершено */ }
  }
  if (data.submitted) return showDone();
  const durationMin = cfg.durationMin;
  deadline = Math.min(data.startedAt.toMillis() + durationMin * 60 * 1000, toMs(cfg.closeAt) || Infinity);
  if (now() >= deadline) return showDone(true);

  let v;
  try { v = await getDoc(doc(db, "sittings", cfg.sittingId, "variants", String(data.variant))); }
  catch (e) { return fatal(e); }
  const all = v.data().items;
  items = data.qids ? data.qids.map((id) => all.find((q) => q.id === id)).filter(Boolean) : all;

  renderTest();
  antiCheat(data);
  tick = setInterval(onTick, 500); onTick();
}

const now = () => Date.now() + clockOffset;

let cur = 0;
function renderTest() {
  $("#bar").hidden = false;
  $("#who").innerHTML = `<b>${esc(sess.name)}</b> · ${esc(sess.group)}${cfg.kind === "test" ? ` · варіант ${sess.variant}` : ""}`;
  const html = items.map((q, i) => `
    <section class="q" data-id="${q.id}" data-i="${i}">
      <div class="qhead">Питання ${i + 1} з ${items.length}</div>
      <div class="qt">${esc(q.type === "open" ? splitParts(q.text) : q.text)}</div>
      ${hint(q)}
      ${renderInput(q)}
    </section>`).join("");
  app.innerHTML = `
    <div class="test-head">
      <h1>${esc(cfg.title)}</h1>
      <div class="qnav" id="qnav">${items.map((q, i) => `<button class="qdot" data-go="${i}" data-id="${q.id}">${i + 1}</button>`).join("")}</div>
      <div class="progress"><span id="prog"></span></div>
    </div>
    <div class="wm-host">
      <div class="wm" id="wm"></div>
      ${html}
    </div>
    <div class="pager">
      <button class="btn" id="prevBtn">← Попереднє</button>
      <span class="muted" id="saveState">Відповіді зберігаються автоматично</span>
      <button class="btn primary" id="nextBtn">Наступне →</button>
    </div>
    <div class="submit-row">
      <span class="tiny muted">Можна повертатися до будь-якого питання, натиснувши його номер угорі.</span>
      <button class="btn primary big" id="submitBtn">Завершити й надіслати</button>
    </div>`;
  paintWatermark();
  items.forEach((q) => restore(q, answers[q.id]));
  app.addEventListener("change", onAnswer);
  app.addEventListener("input", onAnswer);
  $("#qnav").addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) go(+b.dataset.go); });
  $("#prevBtn").onclick = () => go(cur - 1);
  $("#nextBtn").onclick = () => (cur < items.length - 1 ? go(cur + 1) : $("#submitBtn").click());
  $("#submitBtn").addEventListener("click", () => {
    const left = items.filter((q) => !isAnswered(q, answers[q.id])).length;
    const msg = left ? `Без відповіді залишилось питань: ${left}. Завершити тест?` : "Завершити тест і надіслати відповіді?";
    confirmBox(msg, () => submit(false));
  });
  updateProgress();
  go(Math.min(Number(sessionStorageGet("cur")) || 0, items.length - 1));
}

function go(i) {
  if (i < 0 || i >= items.length) return;
  cur = i; sessionStorageSet("cur", i);
  app.querySelectorAll(".q").forEach((el) => el.classList.toggle("active", +el.dataset.i === i));
  app.querySelectorAll(".qdot").forEach((el) => el.classList.toggle("cur", +el.dataset.go === i));
  $("#prevBtn").disabled = i === 0;
  $("#nextBtn").textContent = i === items.length - 1 ? "Завершити ✓" : "Наступне →";
  window.scrollTo({ top: 0, behavior: "smooth" });
  const ta = app.querySelector(`.q[data-i="${i}"] textarea`); if (ta && window.innerWidth > 760) setTimeout(() => ta.focus({ preventScroll: true }), 50);
}
function sessionStorageGet(k) { try { return sessionStorage.getItem("kz_" + k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem("kz_" + k, v); } catch { /* ignore */ } }

// розбиває «а) … б) …» та «1) … 2) …» на окремі рядки
function splitParts(t) { return t.replace(/\s+([а-г]|\d)\)\s/g, "\n$1) "); }

function hint(q) {
  const h = { choice: "Оберіть одну правильну відповідь.",
    match: "Для кожного пункту ліворуч (1, 2, 3…) виберіть відповідну літеру праворуч.",
    seq: "Виберіть літери у правильному порядку: спочатку перший етап, потім другий і т. д.",
    open: "Дайте відповідь своїми словами. Головне — суть, орфографія не оцінюється." }[q.type];
  return h ? `<div class="hint">${h}</div>` : "";
}

function renderInput(q) {
  if (q.type === "choice")
    return `<div class="opts">${q.options.map((o, k) => `
      <label class="opt"><input type="radio" name="${q.id}" value="${k}"><span class="ol">${OPT[k]})</span><span>${esc(o)}</span></label>`).join("")}</div>`;
  if (q.type === "match") {
    const letters = q.right.map((_, k) => LETTERS[k]);
    return `<div class="match">
      <div class="mcol">${q.left.map((l) => `<div class="mi">${esc(l)}</div>`).join("")}</div>
      <div class="mcol">${q.right.map((r) => `<div class="mi">${esc(r)}</div>`).join("")}</div></div>
      <div class="pick">${q.left.map((_, i) => `<label>${i + 1} →
        <select data-k="${i + 1}"><option value="">—</option>${letters.map((L) => `<option>${L}</option>`).join("")}</select></label>`).join("")}</div>`;
  }
  if (q.type === "seq") {
    const letters = q.items.map((_, k) => LETTERS[k]);
    return `<div class="seqlist">${q.items.map((t) => `<div class="mi">${esc(t)}</div>`).join("")}</div>
      <div class="pick seq">${q.items.map((_, i) => `<select data-k="${i}"><option value="">—</option>${letters.map((L) => `<option>${L}</option>`).join("")}</select>${i < q.items.length - 1 ? '<span class="arr">→</span>' : ""}`).join("")}</div>`;
  }
  return `<textarea rows="5" autocomplete="off" autocorrect="off" autocapitalize="sentences" spellcheck="false"
    data-gramm="false" placeholder="Введіть відповідь вручну…"></textarea>`;
}

function restore(q, a) {
  if (a == null) return;
  const box = app.querySelector(`.q[data-id="${q.id}"]`);
  if (q.type === "choice") { const r = box.querySelector(`input[value="${a}"]`); if (r) r.checked = true; }
  else if (q.type === "match") box.querySelectorAll("select").forEach((s) => (s.value = a[s.dataset.k] || ""));
  else if (q.type === "seq") box.querySelectorAll("select").forEach((s) => (s.value = a[s.dataset.k] || ""));
  else box.querySelector("textarea").value = a;
}

function read(q) {
  const box = app.querySelector(`.q[data-id="${q.id}"]`);
  if (q.type === "choice") { const r = box.querySelector("input:checked"); return r ? Number(r.value) : null; }
  if (q.type === "match") { const o = {}; box.querySelectorAll("select").forEach((s) => s.value && (o[s.dataset.k] = s.value)); return o; }
  if (q.type === "seq") return [...box.querySelectorAll("select")].map((s) => s.value);
  return box.querySelector("textarea").value;
}

function onAnswer(e) {
  if (finished) return;
  const box = e.target.closest(".q"); if (!box) return;
  const q = items.find((x) => x.id === box.dataset.id);
  answers[q.id] = read(q);
  box.classList.toggle("done", isAnswered(q, answers[q.id]));
  updateProgress();
  $("#saveState").textContent = "Збереження…";
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 2500);
}

function updateProgress() {
  const n = items.filter((q) => isAnswered(q, answers[q.id])).length;
  items.forEach((q) => {
    const ok = isAnswered(q, answers[q.id]);
    app.querySelector(`.q[data-id="${q.id}"]`)?.classList.toggle("done", ok);
    app.querySelector(`.qdot[data-id="${q.id}"]`)?.classList.toggle("done", ok);
  });
  const p = $("#prog"); if (p) { p.style.width = `${(100 * n) / items.length}%`; p.parentElement.dataset.label = `${n} / ${items.length}`; }
}

async function save() {
  if (finished) return;
  try {
    await updateDoc(sessRef, { answers, updatedAt: serverTimestamp() });
    $("#saveState").textContent = "Збережено ✓";
  } catch (e) {
    console.error(e);
    $("#saveState").textContent = "Не вдалося зберегти — перевірте інтернет";
  }
}

function onTick() {
  const left = deadline - now();
  const t = $("#timer"); t.textContent = fmtTime(left);
  t.classList.toggle("warn", left < 5 * 60 * 1000);
  t.classList.toggle("crit", left < 60 * 1000);
  if (left <= 0 && !finished) submit(true);
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "timeout" })), ms))]);

async function submit(auto) {
  if (finished) return;
  finished = true; clearInterval(tick); clearTimeout(saveTimer);
  items.forEach((q) => { if (app.querySelector(`.q[data-id="${q.id}"]`)) answers[q.id] = read(q); });
  app.innerHTML = `<div class="card center"><div class="spinner"></div><p>Надсилання відповідей…</p><p class="tiny muted" id="sendNote"></p></div>`;

  // запис ставиться в чергу SDK і дійде на сервер, щойно буде зв'язок;
  // стежимо за підтвердженням від сервера, щоб не «висіти» без кінця
  let done = false;
  const unsub = onSnapshot(sessRef, { includeMetadataChanges: true }, (snap) => {
    const d = snap.data();
    if (!done && d?.submitted && !snap.metadata.hasPendingWrites) { done = true; unsub(); showDone(auto); }
  }, () => {});
  const write = updateDoc(sessRef, { answers, submitted: true, submittedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  write.then(() => { if (!done) { done = true; unsub(); showDone(auto); } })
    .catch((e) => {
      console.error(e);
      if (done) return;
      done = true; unsub();
      // відмова сервера = тест уже здано або час вийшов; збережені відповіді зараховано
      if (String(e.code).includes("permission")) return showDone(true);
      sendFailed(auto);
    });
  // якщо за 12 с немає підтвердження — підказка; запис при цьому не скасовується
  setTimeout(() => { if (!done) { const n = $("#sendNote"); if (n) n.innerHTML = "Повільний інтернет. <b>Не закривайте сторінку</b> — відповіді надішлються, щойно з'явиться зв'язок. Можна спробувати перемкнути Wi-Fi / мобільний інтернет."; } }, 12000);
}

function sendFailed(auto) {
  app.innerHTML = `<div class="card center"><h1>Не вдалося надіслати</h1>
    <p>Перевірте інтернет і натисніть кнопку ще раз. Відповіді, збережені під час тесту, вже є у викладача.</p>
    <button class="btn primary" id="retry">Надіслати ще раз</button></div>`;
  $("#retry").onclick = () => { finished = false; submit(auto); };
}

function showDone(timeUp = false) {
  finished = true; clearInterval(tick);
  $("#bar").hidden = false;
  if (sess) $("#who").innerHTML = `<b>${esc(sess.name)}</b> · ${esc(sess.group)}`;
  $("#timer").textContent = "✓";
  app.innerHTML = `<div class="card center done">
    <div class="big-check">✓</div>
    <h1>${timeUp ? "Час вичерпано — відповіді зараховано" : "Відповіді надіслано"}</h1>
    <p class="muted">Результати оголосить викладач після перевірки. Сторінку можна закрити.</p></div>`;
}

// ---------------------------------------------------------------- захист
function antiCheat(data) {
  const last = {};
  const bump = (k) => { const t = Date.now(); if (last[k] && t - last[k] < 800) return; last[k] = t; if (!finished) updateDoc(sessRef, { [`events.${k}`]: increment(1), updatedAt: serverTimestamp() }).catch(() => {}); };
  const inField = (el) => el && el.closest && el.closest("textarea, input, select");

  ["copy", "cut"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); bump("copy"); toast("Копіювання заборонено"); }));
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("selectstart", (e) => { if (!inField(e.target)) e.preventDefault(); });
  document.addEventListener("dragstart", (e) => e.preventDefault());

  const blockPaste = (e) => { e.preventDefault(); bump("paste"); toast("Вставлення заборонено — вводьте відповідь вручну"); };
  document.addEventListener("paste", blockPaste, true);
  document.addEventListener("drop", blockPaste, true);
  document.addEventListener("beforeinput", (e) => {
    const t = e.inputType || "";
    if (t.startsWith("insertFromPaste") || t === "insertFromDrop" || t === "insertFromYank") return blockPaste(e);
    // вставка великого шматка тексту «в обхід» (автозаповнення, програми-вставлялки)
    if (t === "insertText" && e.data && e.data.length > 25) return blockPaste(e);
  }, true);

  document.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (e.key === "PrintScreen") { bump("print"); wipeClipboard(); return; }
    if (mod && ["c", "x", "v", "p", "s", "u"].includes(k)) { e.preventDefault(); if (k === "v") blockPaste(e); if (k === "c" || k === "x") bump("copy"); }
    if (mod && k === "a" && !inField(e.target)) e.preventDefault();
    if (e.key === "F12" || (mod && e.shiftKey && ["i", "j", "c", "s"].includes(k))) { e.preventDefault(); if (k === "s") bump("print"); }
    if (e.key === "Insert" && e.shiftKey) blockPaste(e);
  }, true);
  document.addEventListener("keyup", (e) => { if (e.key === "PrintScreen") { bump("print"); wipeClipboard(); } }, true);

  // вихід з вікна / вкладки → приховати питання
  const shield = $("#shield");
  const hide = () => { if (finished || !shield.hidden) return; shield.hidden = false; document.body.classList.add("veiled"); bump("blur"); };
  window.addEventListener("blur", hide);
  document.addEventListener("visibilitychange", () => { if (document.hidden) hide(); });
  $("#shieldBtn").onclick = () => { shield.hidden = true; document.body.classList.remove("veiled"); };
}

function wipeClipboard() { try { navigator.clipboard?.writeText(" "); } catch { /* ignore */ } toast("Знімки екрана фіксуються"); }

function paintWatermark() {
  const txt = `${sess.name} · ${sess.group}`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='360' height='180'><text x='10' y='110' transform='rotate(-22 180 90)'
    font-family='Arial' font-size='16' fill='rgb(19,74,166)' fill-opacity='0.10'>${txt.replace(/[<&]/g, "")}</text></svg>`;
  $("#wm").style.backgroundImage = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

// ---------------------------------------------------------------- utils
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function confirmBox(msg, onYes) {
  const d = document.createElement("div");
  d.className = "modal";
  d.innerHTML = `<div class="modal-box"><p>${esc(msg)}</p><div class="modal-btns">
    <button class="btn" data-a="no">Повернутися</button><button class="btn primary" data-a="yes">Завершити</button></div></div>`;
  document.body.appendChild(d);
  d.addEventListener("click", (e) => { const a = e.target.dataset.a; if (!a) return; d.remove(); if (a === "yes") onYes(); });
}

function fatal(e) {
  console.error(e);
  app.innerHTML = `<div class="card center"><h1>Помилка</h1><p class="muted">Не вдалося з'єднатися з базою даних. Оновіть сторінку. Якщо помилка повторюється — повідомте викладача.</p>
    <p class="tiny">${esc(e?.code || e?.message || e)}</p></div>`;
}
