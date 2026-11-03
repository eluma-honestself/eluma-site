// The page opened from the approval email. GET shows the review and asks for confirmation;
// POST publishes or refuses it. (A plain link never publishes on its own, so email
// security scanners that open links cannot approve a review by accident.)
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
  const url = new URL(req.url);
  let id, token, action, en;

  if (req.method === "POST") {
    const f = await req.formData();
    id = String(f.get("id") || "");
    token = String(f.get("t") || "");
    action = String(f.get("action") || "");
    en = String(f.get("en") || "").trim().slice(0, 4000);
  } else {
    id = url.searchParams.get("id") || "";
    token = url.searchParams.get("t") || "";
    action = url.searchParams.get("a") || "approve";
  }

  if (!checkToken(id, token)) return page("Lien invalide", "<p>Ce lien n'est pas valide ou a été modifié.</p>", 403);

  const s = store();
  const review = await s.get("pending/" + id, { type: "json" });
  if (!review) {
    const done = await s.get("done/" + id, { type: "json" });
    const msg = done?.status === "approved" ? "Cet avis est déjà publié sur le site." : done?.status === "rejected" ? "Cet avis a déjà été refusé." : "Cet avis est introuvable.";
    return page("Déjà traité", `<p>${msg}</p>${siteLink(url.origin)}`);
  }

  if (req.method === "POST") {
    if (action === "approve") {
      const list = await readApproved();
      if (!list.some((r) => r.id === id)) {
        list.push({
          id,
          name: review.name,
          stars: review.stars,
          text: review.text,
          en: review.lang === "en" ? null : en || null,
          approvedAt: new Date().toISOString(),
        });
        await s.setJSON("approved", list);
      }
      await s.setJSON("done/" + id, { status: "approved", at: new Date().toISOString() });
      await s.delete("pending/" + id);
      return page("Avis publié", `<p>L'avis de <strong>${esc(review.name)}</strong> est maintenant visible sur le site.</p>${siteLink(url.origin)}`);
    }
    if (action === "reject") {
      await s.setJSON("done/" + id, { status: "rejected", at: new Date().toISOString() });
      await s.delete("pending/" + id);
      return page("Avis refusé", `<p>L'avis de <strong>${esc(review.name)}</strong> ne sera pas publié.</p>${siteLink(url.origin)}`);
    }
    return page("Action inconnue", "<p>Rien n'a été modifié.</p>", 400);
  }

  // GET: confirmation page
  const isEn = review.lang === "en";
  const card = `<p class="who"><strong>${esc(review.name)}</strong> <span class="st">${starsText(review.stars)}</span></p>
    <div class="txt">${esc(review.text)}</div>`;

  if (action === "reject") {
    return page(
      "Refuser cet avis ?",
      `${card}
      <form method="POST">
        ${hidden(id, token)}
        <button class="b muted" name="action" value="reject">Confirmer le refus</button>
      </form>
      <p><a href="?id=${encodeURIComponent(id)}&a=approve&t=${esc(token)}">Finalement, je préfère le publier</a></p>`
    );
  }

  return page(
    "Publier cet avis ?",
    `${card}
    <form method="POST">
      ${hidden(id, token)}
      ${
        isEn
          ? `<p class="hint">Avis en anglais : pas besoin de traduction.</p>`
          : `<label for="en">Traduction anglaise <span class="hint">(affichée avec le bouton « Translate to English »)</span></label>
             <textarea id="en" name="en" rows="7">${esc(review.en || "")}</textarea>
             <p class="hint">Corrige-la si besoin. Laisse vide pour publier sans traduction.</p>`
      }
      <button class="b" name="action" value="approve">Publier sur le site</button>
      <button class="b muted" name="action" value="reject">Refuser</button>
    </form>`
  );
};

const hidden = (id, t) => `<input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="t" value="${esc(t)}">`;
const siteLink = (origin) => `<p><a href="${origin}/#reviews">Voir le site</a></p>`;

function page(title, content, status = 200) {
  return html(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · eluma</title>
<style>
body{margin:0;background:#f6f1ea;color:#1f2a5c;font:17px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}
main{max-width:600px;margin:0 auto;padding:40px 16px}
h1{font-weight:600;font-size:26px;margin:0 0 20px}
.who{margin:0 0 8px}.st{color:#E8903C;letter-spacing:.1em}
.txt{white-space:pre-line;background:#fbeee5;border-radius:14px;padding:16px 18px;margin-bottom:22px}
label{display:block;font-weight:600;margin-bottom:6px}
textarea{width:100%;box-sizing:border-box;font:inherit;padding:12px 14px;border:1px solid #c9cce0;border-radius:12px;background:#fff;color:inherit}
.hint{color:#6b6f8a;font-size:14px;font-weight:400}
.b{font:inherit;font-weight:600;border:0;border-radius:999px;padding:12px 24px;margin:8px 8px 0 0;background:#3b4b94;color:#fff;cursor:pointer}
.b.muted{background:#9a9cb0}
a{color:#3b4b94}
</style></head><body><main><h1>${esc(title)}</h1>${content}</main></body></html>`,
    status
  );
}

export const config = { path: "/api/review-moderate" };
