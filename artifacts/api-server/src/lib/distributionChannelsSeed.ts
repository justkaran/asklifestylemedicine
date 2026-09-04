import { db, distributionChannelsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// The original hardcoded faculty "Distribution Channels" cards, used only to
// bootstrap a brand-new (empty) distribution_channels table. Replit Publish
// migrates schema but NOT rows, so production starts with an empty table; this
// seed populates it on first boot. After that the DB is the source of truth —
// the seed is SEED-WHEN-EMPTY (never an upsert), so an admin's later edits,
// reorderings, or deletions are never reverted on subsequent boots.
//
// Keys for the "soon" channels MUST match the historical frontend keys so any
// existing faculty_channel_interest rows keep resolving:
//   think-fast-talk-smart, stanford-medcast, new-york-times, washington-post,
//   time, the-atlantic.
const DEFAULT_CHANNELS: Array<{
  key: string;
  name: string;
  description: string;
  category: string;
  status: "live" | "soon";
  href?: string;
  outlet?: "newsletter" | "matt" | "parentdata";
  isPrimary?: boolean;
}> = [
  {
    key: "slm-newsletter",
    name: "Stanford Lifestyle Medicine Newsletter",
    description:
      "Practical, evidence-based guidance straight to subscribers' inboxes — in your byline.",
    status: "live",
    category: "Newsletter",
    isPrimary: true,
    outlet: "newsletter",
  },
  {
    key: "slm-linkedin",
    name: "Stanford Lifestyle Medicine on LinkedIn",
    description:
      "Vetted science shared with the program's professional community.",
    status: "live",
    category: "Social",
    href: "https://www.linkedin.com/company/stanford-lifestyle-medicine",
  },
  {
    key: "slm-instagram",
    name: "Stanford Lifestyle Medicine on Instagram",
    description: "Bite-sized, trustworthy health guidance for a broad audience.",
    status: "live",
    category: "Social",
    href: "https://www.instagram.com/stanfordlifestylemedicine/",
  },
  {
    key: "palonur-com",
    name: "Palonur.com",
    description:
      "Your approved answers, surfaced to readers searching for them.",
    status: "live",
    category: "Search",
    href: "https://palonur.com",
  },
  {
    key: "offer-to-matt",
    name: "Offer to Matt",
    description:
      "Communication-angle articles, reviewed by Matt Abrahams in his own queue. Opening soon.",
    status: "soon",
    category: "Communication",
    outlet: "matt",
  },
  {
    key: "think-fast-talk-smart",
    name: "Think Fast, Talk Smart",
    description: "Matt Abrahams' podcast — a future channel for your voice.",
    status: "soon",
    category: "Podcast",
  },
  {
    key: "stanford-medcast",
    name: "Stanford Medcast",
    description:
      "Stanford Medicine's podcast — a future channel for your voice.",
    status: "soon",
    category: "Podcast",
  },
  {
    key: "new-york-times",
    name: "The New York Times",
    description:
      "Reaching a national readership — a channel we're working toward.",
    status: "soon",
    category: "News outlet",
  },
  {
    key: "washington-post",
    name: "The Washington Post",
    description: "National news reach — a channel we're working toward.",
    status: "soon",
    category: "News outlet",
  },
  {
    key: "time",
    name: "TIME",
    description: "A flagship national magazine — a channel we're working toward.",
    status: "soon",
    category: "Magazine",
  },
  {
    key: "the-atlantic",
    name: "The Atlantic",
    description: "Long-form ideas journalism — a channel we're working toward.",
    status: "soon",
    category: "Magazine",
  },
];

/**
 * Seed the default distribution channels ONLY when the table is empty. Safe to
 * call on every boot: it no-ops the moment any row exists, so it never reverts
 * an admin's later create/edit/delete. DML only — the table itself is created
 * by Drizzle (dev push) / Replit Publish (prod), never here.
 */
export async function seedDistributionChannels(): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(distributionChannelsTable);

  if (count > 0) {
    logger.info(
      { count },
      "Distribution channels already present — skipping seed",
    );
    return;
  }

  await db.insert(distributionChannelsTable).values(
    DEFAULT_CHANNELS.map((c, i) => ({
      key: c.key,
      name: c.name,
      description: c.description,
      category: c.category,
      status: c.status,
      href: c.href ?? null,
      outlet: c.outlet ?? null,
      isPrimary: c.isPrimary ?? false,
      sortOrder: i,
    })),
  );

  logger.info(
    { count: DEFAULT_CHANNELS.length },
    "Seeded default distribution channels",
  );
}
