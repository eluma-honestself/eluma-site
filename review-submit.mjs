// Receives a review from the website, stores it as "pending" and emails Eliot for approval.
import crypto from "node:crypto";
import { env, store, sign, esc, json, translate, LANG_NAMES, starsText } from "../lib/common.mjs";

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
