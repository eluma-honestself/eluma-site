// Shared helpers for the review functions.
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
