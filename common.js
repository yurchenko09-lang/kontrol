import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// окремий іменований застосунок — не заважає іншим сайтам на тому ж проєкті
export const app = initializeApp(firebaseConfig, "kontrol");
export const auth = getAuth(app);
// автоматичний перехід на long-polling — стабільніше на iPhone/Safari та у слабких мережах
export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

export const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const LETTERS = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З"];
export const OPT = ["а", "б", "в", "г", "д", "е"];

export function toast(msg, ms = 2600) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms);
}

export function fmtTime(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Відповідь у вигляді тексту (для таблиці викладача та Excel)
export function answerText(item, a) {
  if (a == null || a === "") return "";
  if (item.type === "choice") return `${OPT[a] ?? a}) ${item.options?.[a] ?? ""}`;
  if (item.type === "match") return item.left.map((_, i) => `${i + 1} – ${a[i + 1] || "?"}`).join("; ");
  if (item.type === "seq") return (a || []).map((x) => x || "?").join(" → ");
  return String(a);
}

export function isAnswered(item, a) {
  if (a == null || a === "") return false;
  if (item.type === "match") return item.left.every((_, i) => a[i + 1]);
  if (item.type === "seq") return Array.isArray(a) && a.length === item.items.length && a.every(Boolean);
  if (item.type === "open") return String(a).trim().length > 0;
  return true;
}

// Firestore Timestamp / Date / рядок → мілісекунди
export const toMs = (v) => (v == null ? null : v.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : typeof v === "object" && "seconds" in v ? v.seconds * 1000 : new Date(v).getTime());
