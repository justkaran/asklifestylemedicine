import { Router } from "express";

const router = Router();

router.post("/demo-auth", (req, res) => {
  const { password } = req.body as { password?: string };
  const expected = process.env["DEMO_PASSWORD"] ?? "palonur2026";
  if (!password || password !== expected) {
    return res.status(401).json({ ok: false, error: "Falsches Passwort" });
  }
  return res.json({ ok: true });
});

router.post("/admin-auth", (req, res) => {
  const { password } = req.body as { password?: string };
  const expected = process.env["ADMIN_PASSWORD"] ?? "palonur_admin_2026";
  if (!password || password.trim() !== expected) {
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  res.cookie("palonur_admin", "1", {
    signed: true,
    httpOnly: true,
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  });
  return res.json({ ok: true });
});

router.delete("/admin-auth", (_req, res) => {
  res.clearCookie("palonur_admin");
  return res.json({ ok: true });
});

export default router;
