import { Router, type IRouter, type Request, type Response } from "express";
import {
  useDoorwayToken,
  peekDoorwayToken,
  doorwayPagePath,
} from "../lib/doorway.js";

const router: IRouter = Router();

/**
 * The magic link from a doorway acknowledgment text. Valid token → redirect
 * to the governed answer surface with the question prefilled (?q=) and the
 * paywall comp attached (&dw=). Expired/exhausted token → still land the user
 * on the right page with their question, just without the comp — never a
 * dead end. Unknown token → the sleep surface, empty.
 */
router.get("/doorway/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");

  const live = await useDoorwayToken(token);
  if (live) {
    const url = `${doorwayPagePath(live.product)}?q=${encodeURIComponent(
      live.question,
    )}&dw=${encodeURIComponent(token)}`;
    return res.redirect(302, url);
  }

  const stale = await peekDoorwayToken(token);
  if (stale) {
    req.log.info("doorway link expired/exhausted — redirecting without comp");
    const url = `${doorwayPagePath(stale.product)}?q=${encodeURIComponent(
      stale.question,
    )}`;
    return res.redirect(302, url);
  }

  return res.redirect(302, doorwayPagePath("nightly"));
});

export default router;
