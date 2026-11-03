// Receives a review from the website, stores it as "pending" and emails Eliot for approval.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export function env(key, fallback) {
  const v = globalThis.Netlify?.env?.get(key) ?? process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

// Where reviews are kept (Netlify Blobs). Tests can swap it via globalThis.__reviewStore.
export function store() {
  return globalThis.__reviewStore ?? getStore({ name: "reviews", consistency: "strong" });
}

// Secure links: only someone holding REVIEW_SECRET can create a valid token.
export function sign(id) {
  const secret = env("REVIEW_SECRET");
  if (!secret || secret.length < 16) throw new Error("REVIEW_SECRET is missing or too short");
  return crypto.createHmac("sha256", secret).update("review:" + id).digest("hex").slice(0, 40);
}

export function checkToken(id, token) {
  try {
    const a = Buffer.from(sign(String(id || "")));
    const b = Buffer.from(String(token || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export const html = (body, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

// Detects the language and proposes an English translation (free, no key).
// If it fails, the review simply has no translation: Eliot can write one on the approval page.
export async function translate(text) {
  try {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" + encodeURIComponent(text);
    const r = await fetch(url);
    if (!r.ok) return { lang: null, en: null };
    const d = await r.json();
    const lang = typeof d?.[2] === "string" ? d[2] : null;
    if (lang === "en") return { lang, en: null };
    const en = Array.isArray(d?.[0]) ? d[0].map((x) => (x && x[0]) || "").join("").trim() : "";
    return { lang, en: en || null };
  } catch {
    return { lang: null, en: null };
  }
}

export const LANG_NAMES = {
  fr: "français", en: "anglais", es: "espagnol", it: "italien", de: "allemand", pt: "portugais", nl: "néerlandais",
};

export const starsText = (n) => (n ? "★".repeat(n) + "☆".repeat(5 - n) : "pas de note");

export async function readApproved() {
  const list = await store().get("approved", { type: "json" });
  return Array.isArray(list) ? list : [];
}

// ---- function ----
export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

  let f;
  try {
    f = await req.formData();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  // Honeypot: bots fill this hidden field. Pretend success, store nothing.
  if (String(f.get("bot-field") || "").trim()) return json({ ok: true });

  const name = String(f.get("name") || "").trim().slice(0, 60);
  const text = String(f.get("review") || "").trim().slice(0, 3000);
  const stars = parseInt(f.get("rating"), 10);
  if (!(stars >= 1 && stars <= 5) || !name || !text || f.get("consent") !== "yes") return json({ ok: false, error: "missing" }, 400);

  const id = crypto.randomUUID();
  const { lang, en } = await translate(text);
  const review = { id, name, stars, text, lang, en, createdAt: new Date().toISOString() };

  try {
    await store().setJSON("pending/" + id, review);
    await sendApprovalEmail(review, new URL(req.url).origin);
  } catch (err) {
    console.error("review-submit failed:", err);
    return json({ ok: false, error: "server" }, 500);
  }
  return json({ ok: true });
};

async function sendApprovalEmail(r, origin) {
  const key = env("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY is missing");
  const t = sign(r.id);
  const link = (a) => `${origin}/api/review-moderate?id=${encodeURIComponent(r.id)}&a=${a}&t=${t}`;
  const langName = r.lang ? LANG_NAMES[r.lang] || r.lang : null;

  const btn = (href, label, bg) =>
    `<a href="${href}" style="display:inline-block;padding:12px 22px;margin:0 8px 8px 0;border-radius:999px;background:${bg};color:#fff;text-decoration:none;font-weight:600">${label}</a>`;

  const translation = r.en
    ? `<p style="margin:22px 0 6px;color:#6b6f8a;font-size:13px;text-transform:uppercase;letter-spacing:.06em">Traduction anglaise proposée</p>
       <div style="white-space:pre-line;background:#eef0f8;border-radius:12px;padding:14px 16px;line-height:1.6">${esc(r.en)}</div>
       <p style="color:#6b6f8a;font-size:13px">Tu pourras la corriger avant de publier.</p>`
    : r.lang === "en"
      ? ""
      : `<p style="color:#6b6f8a;font-size:13px">La traduction automatique n'a pas fonctionné. Tu pourras en écrire une avant de publier.</p>`;

  const body = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2a5c;max-width:560px;margin:auto">
    <h2 style="font-weight:600;margin:0 0 4px">Nouvel avis sur eluma</h2>
    <p style="margin:0 0 18px;color:#6b6f8a">Il ne sera pas visible sur le site tant que tu ne l'as pas publié.</p>
    <p style="margin:0"><strong>${esc(r.name)}</strong> &nbsp;<span style="color:#E8903C;letter-spacing:.1em">${starsText(r.stars)}</span></p>
    ${langName ? `<p style="margin:4px 0 0;color:#6b6f8a;font-size:13px">Langue détectée : ${esc(langName)}</p>` : ""}
    <div style="white-space:pre-line;background:#fbeee5;border-radius:12px;padding:14px 16px;margin-top:12px;line-height:1.6">${esc(r.text)}</div>
    ${translation}
    <div style="margin-top:24px">${btn(link("approve"), "Publier", "#3b4b94")}${btn(link("reject"), "Refuser", "#9a9cb0")}</div>
    <p style="color:#6b6f8a;font-size:13px">Chaque bouton ouvre une page où tu confirmes ton choix.</p>
  </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env("REVIEW_FROM", "eluma reviews <onboarding@resend.dev>"),
      to: [env("NOTIFY_EMAIL", "eluma.honestself@gmail.com")],
      subject: `Nouvel avis de ${r.name}${r.stars ? " (" + r.stars + "★)" : ""}`,
      html: body,
    }),
  });
  if (!res.ok) throw new Error("Resend error " + res.status + ": " + (await res.text()));
}

export const config = { path: "/api/review-submit" };
