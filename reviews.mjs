// Public list of approved reviews, read by the website.
import { json, readApproved } from "../lib/common.mjs";

export default async () => {
  try {
    const list = await readApproved();
    return json(list.map(({ name, stars, text, en }) => ({ name, stars, text, en: en || undefined })));
  } catch (err) {
    console.error("reviews failed:", err);
    return json([], 200);
  }
};

export const config = { path: "/api/reviews" };
