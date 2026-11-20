// Booking requests: the client asks for a slot, Eliot confirms / declines / proposes other dates
// by email. Once a session is confirmed (by Eliot, or by the client picking a proposed date),
// the whole day is no longer bookable on the website.
//
// Routes (one Netlify function):
//   POST /api/booking-request   the website form
//   GET  /api/blocked-dates     days already taken (read by the website)
//   GET/POST /booking/admin     pages Eliot opens from his email
//   GET/POST /booking/choose    page the client opens to pick a proposed date
//
// Opening a link only SHOWS a page; nothing happens until a button is pressed (POST),
// so email security scanners that open links cannot confirm or decline anything.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export function env(key, fallback) {
  const v = globalThis.Netlify?.env?.get(key) ?? process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

// Netlify Blobs. Tests can swap it via globalThis.__bookingStore.
export function store() {
  return globalThis.__bookingStore ?? getStore({ name: "bookings", consistency: "strong" });
}

const OWNER = () => env("NOTIFY_EMAIL", "eluma.honestself@gmail.com");
const FROM = () => env("BOOKING_FROM", "eluma <bookings@elumabreathwork.sarl>");

export const SLOTS = ["10:00am", "11:00am", "12:00pm"];
const TYPES = ["1:1 session", "Group session"];
const TZ = "Australia/Sydney";
const MIN_DAYS_AHEAD = 2; // bookings close 48 hours before

// ---------- small helpers ----------
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const token = () => crypto.randomBytes(18).toString("hex");
function sameToken(a, b) {
  a = Buffer.from(String(a || ""));
  b = Buffer.from(String(b || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

// ---------- dates (YYYY-MM-DD, Sydney time) ----------
export const todayISO = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const minBookable = () => addDays(todayISO(), MIN_DAYS_AHEAD);
function isISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const fmt = (iso, loc) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};
const fmtEn = (iso) => fmt(iso, "en-AU");
const fmtFr = (iso) => fmt(iso, "fr-FR");

// ---------- storage ----------
async function getBlocked() {
  const v = await store().get("blocked", { type: "json" });
  return Array.isArray(v) ? v : [];
}
async function blockDay(date) {
  const b = await getBlocked();
  if (!b.includes(date)) {
    b.push(date);
    b.sort();
    await store().setJSON("blocked", b.filter((d) => d >= addDays(todayISO(), -1)));
  }
}
async function getBooking(id) {
  if (!/^[a-f0-9]{12}$/.test(id || "")) return null;
  return (await store().get("booking/" + id, { type: "json" })) || null;
}
async function saveBooking(b) {
  b.updated = new Date().toISOString();
  await store().setJSON("booking/" + b.id, b);
}

// ---------- email (Resend) ----------
async function sendEmail({ to, subject, html, replyTo }) {
  const key = env("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY is missing");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM(), to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!r.ok) throw new Error("Resend error " + r.status + ": " + (await r.text()));
}

const C = { ink: "#1f2a5c", soft: "#6b6f8a", bg: "#f6f1ea", card: "#fbeee5", ok: "#3b4b94", alt: "#E8903C", no: "#9a9cb0" };

const mail = (inner) => `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${C.ink};max-width:560px;margin:auto;line-height:1.6">
<p style="font-size:22px;margin:0">eluma</p><p style="margin:0 0 20px;color:${C.soft};font-style:italic">the honest self</p>
${inner}</div>`;
const btn = (href, label, bg = C.ok) =>
  `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;margin:0 8px 8px 0;border-radius:999px;background:${bg};color:#fff;text-decoration:none;font-weight:600">${esc(label)}</a>`;

// Plain text written by Eliot -> email paragraphs
const textToHtml = (t) =>
  String(t || "").trim().split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");

// Default texts, shown pre-filled and fully editable on Eliot's pages
function defaultMessage(kind, b) {
  const sign = "\n\nWith warmth,\nEliot";
  if (kind === "confirm")
    return `Hi ${b.name},\n\nYour session is confirmed. I'm looking forward to breathing with you.\n\nThe session takes place in Bangalow (NSW). I'll send you the exact address and a few tips to prepare before the day.\n\nIf anything changes, simply reply to this email.${sign}`;
  if (kind === "decline")
    return `Hi ${b.name},\n\nThank you so much for your request for ${fmtEn(b.date)}. Unfortunately I'm not able to welcome you for this session.\n\nYou're very welcome to book another date on the website, or simply reply to this email.${sign}`;
  if (kind === "propose")
    return `Hi ${b.name},\n\nThank you for your request for ${fmtEn(b.date)} at ${b.time}. I'm not available then, but I'd love to welcome you on one of the dates below.\n\nJust click the one that suits you and your session will be confirmed straight away.${sign}`;
  return "";
}

function details(b, lang = "fr", over) {
  const date = over?.date || b.date, time = over?.time || b.time;
  const fr = lang === "fr";
  const rows = [
    [fr ? "Séance" : "Session", b.type === "1:1 session" ? (fr ? "Individuelle (1:1)" : "1:1 session") : fr ? "Groupe" : "Group session"],
    ["Date", fr ? fmtFr(date) : fmtEn(date)],
    [fr ? "Heure" : "Start time", time],
  ];
  if (b.type === "Group session") rows.push([fr ? "Personnes" : "People", b.people]);
  rows.push([fr ? "Nom" : "Name", b.name]);
  if (fr) {
    rows.push(["Email", b.email]);
    if (b.phone) rows.push(["Téléphone", b.phone]);
    if (b.age) rows.push(["Âge", b.age]);
    if (b.hobbies) rows.push(["Passions", b.hobbies]);
    if (b.music) rows.push(["Musique", b.music]);
    if (b.message) rows.push(["Message", b.message]);
  }
  return `<table style="border-collapse:collapse;width:100%;background:${C.card};border-radius:14px;margin:6px 0 18px">${rows
    .map(([k, v]) => `<tr><td style="padding:7px 14px;color:${C.soft};vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:7px 14px 7px 0;vertical-align:top">${esc(v).replace(/\n/g, "<br>")}</td></tr>`)
    .join("")}</table>`;
}

const origin = (req) => env("SITE_URL", new URL(req.url).origin).replace(/\/$/, "");
const adminLink = (req, b, a) => `${origin(req)}/booking/admin?id=${b.id}&t=${b.adminToken}${a ? "&a=" + a : ""}`;
const clientLink = (req, b, o) => `${origin(req)}/booking/choose?id=${b.id}&t=${b.clientToken}&o=${o}`;

async function sendConfirmedToClient(b, message) {
  await sendEmail({
    to: b.email,
    replyTo: OWNER(),
    subject: `Your breathwork session is confirmed: ${fmtEn(b.date)}`,
    html: mail(`${textToHtml(message || defaultMessage("confirm", b))}${details(b, "en")}`),
  });
}

// ---------- pages ----------
function page(title, content, status = 200, lang = "fr") {
  return new Response(
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · eluma</title>
<style>
body{margin:0;background:${C.bg};color:${C.ink};font:17px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}
main{max-width:600px;margin:0 auto;padding:40px 16px}
h1{font-weight:600;font-size:26px;margin:0 0 20px}
table{width:100%;border-collapse:collapse;background:${C.card};border-radius:14px;margin-bottom:20px}
td{padding:7px 14px;vertical-align:top}td:first-child{color:${C.soft};white-space:nowrap}
label{display:block;font-weight:600;margin:16px 0 6px}
textarea,input,select{font:inherit;padding:10px 12px;border:1px solid #c9cce0;border-radius:12px;background:#fff;color:inherit;box-sizing:border-box}
textarea{width:100%}
.row{display:flex;gap:8px;margin-bottom:8px}.row input{flex:1}
.hint{color:${C.soft};font-size:14px;font-weight:400}
.note{background:${C.card};border-radius:12px;padding:12px 14px;font-size:15px}
.b{display:inline-block;font:inherit;font-weight:600;border:0;border-radius:999px;padding:12px 24px;margin:12px 8px 0 0;background:${C.ok};color:#fff;cursor:pointer;text-decoration:none}
.b.alt{background:${C.alt}}.b.muted{background:${C.no}}
a{color:${C.ok}}
</style></head><body><main><h1>${esc(title)}</h1>${content}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } }
  );
}

// =====================================================================
// POST /api/booking-request
// =====================================================================
async function bookingRequest(req) {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let f;
  try {
    const ct = req.headers.get("content-type") || "";
    f = ct.includes("application/json") ? await req.json() : Object.fromEntries(await req.formData());
  } catch {
    return json({ ok: false, error: "Invalid request." }, 400);
  }
  if (String(f["bot-field"] || "").trim()) return json({ ok: true }); // honeypot

  const b = {
    type: clip(f.type, 30), date: clip(f.date, 10), time: clip(f.time, 10), people: parseInt(f.people, 10) || 1,
    name: clip(f.name, 80), email: clip(f.email, 120), phone: clip(f.phone, 40),
    age: clip(f.age, 20), hobbies: clip(f.hobbies, 500), music: clip(f.music, 500), message: clip(f.message, 2000),
  };
  if (!TYPES.includes(b.type)) return json({ ok: false, error: "Please choose a session type." }, 400);
  if (!isISODate(b.date)) return json({ ok: false, error: "Please choose a date." }, 400);
  if (b.date < minBookable()) return json({ ok: false, error: "Bookings close 48 hours before the session. Please choose a later date." }, 400);
  if (!SLOTS.includes(b.time)) return json({ ok: false, error: "Please choose a start time." }, 400);
  if (!b.name) return json({ ok: false, error: "Please add your name." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return json({ ok: false, error: "Please add a valid email address." }, 400);
  if (b.type === "Group session" && (b.people < 2 || b.people > 6)) return json({ ok: false, error: "A group session is for 2 to 6 people." }, 400);
  if (b.type === "1:1 session") b.people = 1;
  if ((await getBlocked()).includes(b.date))
    return json({ ok: false, error: "This day is already booked. Please choose another date.", blocked: true }, 409);

  Object.assign(b, {
    id: token().slice(0, 12), adminToken: token(), clientToken: token(),
    status: "pending", proposals: [], created: new Date().toISOString(),
  });

  const price = b.type === "1:1 session" ? "$100" : `$${50 * b.people} (${b.people} × $50)`;
  try {
    await saveBooking(b);
    await sendEmail({
      to: OWNER(),
      replyTo: b.email,
      subject: `Nouvelle demande : ${b.name}, ${fmtFr(b.date)} à ${b.time}`,
      html: mail(`<h2 style="font-weight:600;margin:0 0 12px">Nouvelle demande de séance</h2>
${details(b, "fr")}
<p style="color:${C.soft};font-size:14px;margin-top:-8px">Montant : ${esc(price)}</p>
<p style="margin:22px 0 10px">Que veux-tu faire ? Chaque bouton ouvre une page où tu peux écrire ton message à ${esc(b.name)} avant d'envoyer.</p>
${btn(adminLink(req, b, "confirm"), "Confirmer", C.ok)}${btn(adminLink(req, b, "propose"), "Proposer d’autres dates", C.alt)}${btn(adminLink(req, b, "decline"), "Refuser", C.no)}
<p style="color:${C.soft};font-size:13px;margin-top:16px">Une fois la séance confirmée, toute la journée devient indisponible sur le site.</p>`),
    });
  } catch (err) {
    console.error("booking-request failed:", err);
    return json({ ok: false, error: "Sorry, your request could not be sent. Please write to " + OWNER() + "." }, 500);
  }

  try {
    await sendEmail({
      to: b.email,
      replyTo: OWNER(),
      subject: "I received your breathwork request",
      html: mail(`<p>Hi ${esc(b.name)},</p>
<p>Thank you for your request. I'll come back to you very soon to confirm your session or suggest another time.</p>
${details(b, "en")}
<p>Your session is not confirmed yet: you'll receive a second email once it is.</p>
<p>With warmth,<br>Eliot</p>`),
    });
  } catch (err) {
    console.error("client acknowledgement failed:", err);
  }

  return json({ ok: true, message: `Thank you ${b.name}! Your request for ${fmtEn(b.date)} has been sent. You'll receive an email once Eliot confirms it.` });
}

// =====================================================================
// GET /api/blocked-dates
// =====================================================================
async function blockedDates() {
  const today = todayISO();
  try {
    return json({ blocked: (await getBlocked()).filter((d) => d >= today), min: minBookable() });
  } catch (err) {
    console.error("blocked-dates failed:", err);
    return json({ blocked: [], min: minBookable() });
  }
}

// =====================================================================
// /booking/admin  (Eliot)
// =====================================================================
const OPEN = ["pending", "proposed"];
const STATUS_FR = { pending: "En attente de ta réponse", proposed: "Dates proposées, en attente du client", confirmed: "Confirmée", declined: "Refusée" };

function adminClosed(b) {
  const extra = b.status === "confirmed" ? `<p>Séance confirmée le <strong>${esc(fmtFr(b.date))}</strong> à <strong>${esc(b.time)}</strong>.</p>` : "";
  return page("Demande déjà traitée", `<p>Statut : <strong>${esc(STATUS_FR[b.status] || b.status)}</strong></p>${extra}${details(b, "fr")}`);
}
const adminHidden = (b, a) =>
  `<input type="hidden" name="id" value="${esc(b.id)}"><input type="hidden" name="t" value="${esc(b.adminToken)}"><input type="hidden" name="a" value="${a}">`;
const messageBox = (kind, b) => `<label>Le mail que ${esc(b.name)} va recevoir <span class="hint">: tu peux le modifier ou le réécrire entièrement</span></label>
<textarea name="message" rows="11" required>${esc(defaultMessage(kind, b))}</textarea>`;
const slotSelect = (name, sel) => `<select name="${name}">${SLOTS.map((s) => `<option${s === sel ? " selected" : ""}>${s}</option>`).join("")}</select>`;

async function admin(req) {
  const url = new URL(req.url);
  const f = req.method === "POST" ? Object.fromEntries(await req.formData()) : Object.fromEntries(url.searchParams);
  const b = await getBooking(f.id);
  if (!b || !sameToken(f.t, b.adminToken)) return page("Lien invalide", "<p>Ce lien n'est pas valide ou a expiré.</p>", 403);
  if (!OPEN.includes(b.status)) return adminClosed(b);

  const blocked = await getBlocked();
  const a = f.a;

  // ---------- GET: show the page ----------
  if (req.method !== "POST") {
    const already = b.status === "proposed"
      ? `<p class="note">Tu as déjà proposé : ${b.proposals.map((p) => esc(fmtFr(p.date) + " à " + p.time)).join(" ; ")}. Le client n'a pas encore choisi.</p>` : "";

    if (a === "confirm") {
      if (blocked.includes(b.date))
        return page("Ce jour est déjà pris", `${already}${details(b, "fr")}<p class="note">Une autre séance est déjà confirmée ce jour-là, tu ne peux pas confirmer celle-ci.</p>
<a class="b alt" href="${esc(adminLink(req, b, "propose"))}">Proposer d'autres dates</a>`);
      return page("Confirmer cette séance ?", `${already}${details(b, "fr")}
<form method="POST">${adminHidden(b, "confirm")}${messageBox("confirm", b)}
<p class="hint">Le récapitulatif de la séance (date, heure…) est ajouté automatiquement sous ton message.</p>
<button class="b">Confirmer et envoyer</button></form>
<p class="hint">Le ${esc(fmtFr(b.date))} ne sera plus réservable sur le site.</p>`);
    }
    if (a === "decline") {
      return page("Refuser cette demande ?", `${already}${details(b, "fr")}
<form method="POST">${adminHidden(b, "decline")}${messageBox("decline", b)}
<button class="b muted">Refuser et envoyer</button></form>`);
    }
    if (a === "propose") {
      const min = minBookable();
      const rows = [0, 1, 2].map((i) => `<div class="row"><input type="date" name="d${i}" min="${min}"${i === 0 ? " required" : ""}>${slotSelect("s" + i, b.time)}</div>`).join("");
      const taken = blocked.filter((d) => d >= min).map((d) => esc(fmtFr(d))).join(", ") || "aucun";
      return page("Proposer d'autres dates", `${already}${details(b, "fr")}
<form method="POST">${adminHidden(b, "propose")}
<label>Une à trois dates</label>${rows}
<p class="hint">Jours déjà pris : ${taken}</p>
${messageBox("propose", b)}
<p class="hint">Un bouton par date est ajouté automatiquement sous ton message. Dès que ${esc(b.name)} clique sur une date, la séance est confirmée et ce jour devient indisponible.</p>
<button class="b alt">Envoyer les propositions</button></form>`);
    }
    return page(`Demande de ${b.name}`, `${already}${details(b, "fr")}
<a class="b" href="${esc(adminLink(req, b, "confirm"))}">Confirmer</a><a class="b alt" href="${esc(adminLink(req, b, "propose"))}">Proposer d'autres dates</a><a class="b muted" href="${esc(adminLink(req, b, "decline"))}">Refuser</a>`);
  }

  // ---------- POST: do it ----------
  const message = clip(f.message, 5000);

  if (a === "confirm") {
    if (blocked.includes(b.date))
      return page("Ce jour est déjà pris", `<p>Une autre séance est confirmée le ${esc(fmtFr(b.date))}.</p><a class="b alt" href="${esc(adminLink(req, b, "propose"))}">Proposer d'autres dates</a>`, 409);
    b.status = "confirmed";
    b.confirmedBy = "owner";
    await blockDay(b.date);
    await saveBooking(b);
    try {
      await sendConfirmedToClient(b, message);
    } catch (err) {
      console.error(err);
      return page("Séance confirmée, mais le mail n'est pas parti", `<p>Le jour est bien bloqué sur le site. Écris directement à ${esc(b.email)}.</p>`, 500);
    }
    return page("Séance confirmée ✓", `<p>${esc(b.name)} a reçu ton mail. Le ${esc(fmtFr(b.date))} n'est plus réservable sur le site.</p>${details(b, "fr")}`);
  }

  if (a === "decline") {
    b.status = "declined";
    await saveBooking(b);
    try {
      await sendEmail({ to: b.email, replyTo: OWNER(), subject: "About your breathwork request", html: mail(textToHtml(message || defaultMessage("decline", b))) });
    } catch (err) {
      console.error(err);
      return page("Demande refusée, mais le mail n'est pas parti", `<p>Écris directement à ${esc(b.email)}.</p>`, 500);
    }
    return page("Demande refusée", `<p>${esc(b.name)} a reçu ton mail.</p>`);
  }

  if (a === "propose") {
    const min = minBookable();
    const proposals = [], problems = [];
    for (const i of [0, 1, 2]) {
      const d = String(f["d" + i] || ""), s = String(f["s" + i] || "");
      if (!d) continue;
      if (!isISODate(d) || !SLOTS.includes(s)) { problems.push("date invalide"); continue; }
      if (d < min) { problems.push(`${fmtFr(d)} est trop proche (48 h minimum)`); continue; }
      if (blocked.includes(d)) { problems.push(`${fmtFr(d)} est déjà réservé`); continue; }
      if (!proposals.some((p) => p.date === d && p.time === s)) proposals.push({ date: d, time: s });
    }
    if (!proposals.length)
      return page("Aucune date valide", `<p>${esc(problems.join(" ; ") || "Choisis au moins une date.")}</p><a class="b alt" href="${esc(adminLink(req, b, "propose"))}">Recommencer</a>`, 400);

    b.status = "proposed";
    b.proposals = proposals;
    b.proposalMessage = message;
    await saveBooking(b);
    const buttons = proposals.map((p, i) => btn(clientLink(req, b, i), `${fmtEn(p.date)} · ${p.time}`, C.ok)).join("<br>");
    try {
      await sendEmail({
        to: b.email, replyTo: OWNER(),
        subject: "Another date for your breathwork session?",
        html: mail(`${textToHtml(message || defaultMessage("propose", b))}
<div style="margin:16px 0">${buttons}</div>
<p style="font-size:14px"><a href="${esc(clientLink(req, b, "none"))}" style="color:${C.soft}">None of these dates work for me</a></p>`),
      });
    } catch (err) {
      console.error(err);
      return page("Le mail n'est pas parti", `<p>Les dates sont enregistrées, mais écris directement à ${esc(b.email)}.</p>`, 500);
    }
    const warn = problems.length ? `<p class="note">Ignoré : ${esc(problems.join(" ; "))}</p>` : "";
    return page("Propositions envoyées ✓", `${warn}<p>${esc(b.name)} a reçu :</p><ul>${proposals.map((p) => `<li>${esc(fmtFr(p.date))} à ${esc(p.time)}</li>`).join("")}</ul>
<p>Tu recevras un mail dès qu'une date est choisie.</p>`);
  }

  return page("Action inconnue", "<p>Rien n'a été modifié.</p>", 400);
}

// =====================================================================
// /booking/choose  (client)
// =====================================================================
async function choose(req) {
  const url = new URL(req.url);
  const f = req.method === "POST" ? Object.fromEntries(await req.formData()) : Object.fromEntries(url.searchParams);
  const en = (t, c, s) => page(t, c, s, "en");
  const b = await getBooking(f.id);
  if (!b || !sameToken(f.t, b.clientToken)) return en("Invalid link", "<p>This link is invalid or has expired.</p>", 403);
  if (b.status === "confirmed") return en("Your session is confirmed", `${details(b, "en")}<p>See you soon!</p>`);
  if (b.status !== "proposed") return en("This request is no longer open", "<p>Feel free to make a new booking on the website, or reply to Eliot's email.</p>");

  const hidden = (o) => `<input type="hidden" name="id" value="${esc(b.id)}"><input type="hidden" name="t" value="${esc(b.clientToken)}"><input type="hidden" name="o" value="${esc(o)}">`;
  const blocked = await getBlocked();
  const min = minBookable();
  const stillOpen = (except) =>
    b.proposals.map((p, i) => ({ ...p, i })).filter((p) => p.i !== except && !blocked.includes(p.date) && p.date >= min)
      .map((p) => `<a class="b" href="${esc(clientLink(req, b, p.i))}">${esc(fmtEn(p.date))} · ${esc(p.time)}</a>`).join(" ");
  const unavailable = (i) => {
    const others = stillOpen(i);
    return en("Sorry, this date is no longer available", others ? `<p>These dates are still open:</p>${others}` : "<p>Please reply to Eliot's email or make a new booking on the website.</p>", 409);
  };

  if (f.o === "none") {
    if (req.method !== "POST")
      return en("None of these dates work?", `<form method="POST">${hidden("none")}
<label>Tell Eliot which days or times would suit you better</label>
<textarea name="note" rows="5" placeholder="I'm free most weekends in December…"></textarea>
<button class="b">Send to Eliot</button></form>`);
    const note = clip(f.note, 2000);
    b.status = "pending";
    b.clientNote = note;
    await saveBooking(b);
    try {
      await sendEmail({
        to: OWNER(), replyTo: b.email,
        subject: `${b.name} : aucune des dates proposées ne convient`,
        html: mail(`<p>${esc(b.name)} ne peut venir à aucune des dates proposées.</p>
${note ? `<div style="white-space:pre-line;background:${C.card};border-radius:12px;padding:14px 16px">${esc(note)}</div>` : ""}
${details(b, "fr")}
${btn(adminLink(req, b, "propose"), "Proposer d’autres dates", C.alt)}${btn(adminLink(req, b, "decline"), "Refuser", C.no)}`),
      });
    } catch (err) { console.error(err); }
    return en("Thank you", "<p>Eliot has received your message and will come back to you with other dates.</p>");
  }

  const i = parseInt(f.o, 10);
  const p = b.proposals[i];
  if (!p) return en("Invalid link", "<p>This option does not exist.</p>", 404);
  if (blocked.includes(p.date) || p.date < min) return unavailable(i);

  if (req.method !== "POST")
    return en("Confirm this session?", `${details(b, "en", p)}<form method="POST">${hidden(i)}<button class="b">Yes, confirm my session</button></form>`);

  b.requestedDate = b.date;
  b.requestedTime = b.time;
  b.date = p.date;
  b.time = p.time;
  b.status = "confirmed";
  b.confirmedBy = "client";
  await blockDay(b.date);
  await saveBooking(b);
  try { await sendConfirmedToClient(b); } catch (err) { console.error(err); }
  try {
    await sendEmail({
      to: OWNER(), replyTo: b.email,
      subject: `✓ ${b.name} a confirmé : ${fmtFr(b.date)} à ${b.time}`,
      html: mail(`<p>${esc(b.name)} a choisi une des dates proposées. La séance est confirmée et ce jour n'est plus réservable sur le site.</p>${details(b, "fr")}`),
    });
  } catch (err) { console.error(err); }
  return en("Your session is confirmed ✓", `${details(b, "en")}<p>A confirmation email is on its way. See you soon!</p>`);
}

// ---------- router ----------
export default async (req) => {
  const path = new URL(req.url).pathname.replace(/\/$/, "");
  try {
    if (path === "/api/booking-request") return await bookingRequest(req);
    if (path === "/api/blocked-dates") return await blockedDates();
    if (path === "/booking/admin") return await admin(req);
    if (path === "/booking/choose") return await choose(req);
  } catch (err) {
    console.error("booking failed:", err);
    return path.startsWith("/api/") ? json({ ok: false, error: "Server error. Please write to " + OWNER() + "." }, 500) : page("Erreur", "<p>Une erreur est survenue. Réessaie dans un instant.</p>", 500);
  }
  return new Response("Not found", { status: 404 });
};

export const config = { path: ["/api/booking-request", "/api/blocked-dates", "/booking/admin", "/booking/choose"] };
