import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  BOT_UA_RE,
  DATACENTER_CIDRS,
  isDataCenterIp,
  isBotRequest,
  backfillBotIpFlags,
} from "../lib/botDetect.js";
import pool from "../lib/db.js";

describe("BOT_UA_RE", () => {
  test("flags well-known crawlers", () => {
    const bots = [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.0; +https://openai.com/gptbot)",
      "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
      "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
      "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
      "curl/8.5.0",
      "python-requests/2.31.0",
      "Mozilla/5.0 HeadlessChrome/120.0.0.0",
    ];
    for (const ua of bots) expect(ua).toMatch(BOT_UA_RE);
  });

  test("does not flag normal browsers", () => {
    const humans = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
    ];
    for (const ua of humans) expect(ua).not.toMatch(BOT_UA_RE);
  });
});

describe("isDataCenterIp", () => {
  test("flags known Bingbot / Googlebot / cloud ranges", () => {
    expect(isDataCenterIp("157.55.39.10")).toBe(true); // Bingbot
    expect(isDataCenterIp("207.46.13.5")).toBe(true); // Bingbot
    expect(isDataCenterIp("40.77.167.42")).toBe(true); // Bingbot
    expect(isDataCenterIp("66.249.66.1")).toBe(true); // Googlebot
    expect(isDataCenterIp("35.196.10.20")).toBe(true); // GCP (35.192.0.0/12)
    expect(isDataCenterIp("20.42.10.1")).toBe(true); // Azure (20.32.0.0/11)
  });

  test("does not flag residential / non-listed IPs", () => {
    expect(isDataCenterIp("98.14.22.7")).toBe(false); // residential US
    expect(isDataCenterIp("71.184.10.3")).toBe(false);
    expect(isDataCenterIp("192.168.1.5")).toBe(false); // private
    expect(isDataCenterIp("8.8.8.8")).toBe(false); // Google DNS, not a listed range
  });

  test("does not flag IPv6 or malformed input", () => {
    expect(isDataCenterIp("2601:19b:700::1")).toBe(false);
    expect(isDataCenterIp("")).toBe(false);
    expect(isDataCenterIp("not-an-ip")).toBe(false);
    expect(isDataCenterIp("300.1.1.1")).toBe(false);
  });

  test("every CIDR entry is well-formed IPv4/prefix", () => {
    for (const cidr of DATACENTER_CIDRS) {
      expect(cidr).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/);
      const bits = Number(cidr.split("/")[1]);
      expect(bits).toBeGreaterThanOrEqual(8);
      expect(bits).toBeLessThanOrEqual(32);
    }
  });
});

describe("backfillBotIpFlags (boot-time IP-range backfill)", () => {
  const SESSION = "botdetect-backfill-test";

  // Tests import app.ts, not index.ts, so boot DDL never runs here —
  // self-provision the table/column idempotently (same shape as index.ts).
  beforeAll(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS palonur_pageviews (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        page TEXT NOT NULL,
        referrer TEXT,
        referrer_domain TEXT,
        device TEXT,
        ip TEXT,
        duration_ms INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      ALTER TABLE palonur_pageviews
        ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await pool.query("DELETE FROM palonur_pageviews WHERE session_id = $1", [SESSION]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM palonur_pageviews WHERE session_id = $1", [SESSION]);
  });

  test("flags data-center rows, survives malformed IPs, leaves humans alone", async () => {
    // ip → expected is_bot after backfill. The malformed values would crash a
    // naive `ip::inet` cast — the backfill must skip them, not throw.
    const expected: Record<string, boolean> = {
      "157.55.39.10": true,
      "66.249.66.1": true,
      "98.14.22.7": false,
      "300.1.1.1": false,
      "999.999.999.999": false,
      "not-an-ip": false,
      "": false,
      "2601:19b:700::1": false,
    };
    for (const ip of Object.keys(expected)) {
      await pool.query(
        `INSERT INTO palonur_pageviews (session_id, page, ip) VALUES ($1, '/', $2)`,
        [SESSION, ip],
      );
    }

    // Must not throw despite malformed rows being present.
    await expect(backfillBotIpFlags(pool)).resolves.toBeGreaterThanOrEqual(2);

    const { rows: got } = await pool.query<{ ip: string; is_bot: boolean }>(
      "SELECT ip, is_bot FROM palonur_pageviews WHERE session_id = $1",
      [SESSION],
    );
    for (const r of got) expect(r.is_bot, `ip=${r.ip}`).toBe(expected[r.ip]);
    expect(got.length).toBe(Object.keys(expected).length);

    // Idempotent: second run flips nothing further and still doesn't throw.
    await expect(backfillBotIpFlags(pool)).resolves.toBeDefined();
  });
});

describe("isBotRequest", () => {
  test("either signal alone flags", () => {
    expect(isBotRequest("Mozilla/5.0 (compatible; bingbot/2.0)", "98.14.22.7")).toBe(true);
    expect(isBotRequest("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0", "157.55.39.10")).toBe(true);
  });
  test("human UA + residential IP is not a bot", () => {
    expect(isBotRequest("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0", "98.14.22.7")).toBe(false);
    expect(isBotRequest("", "98.14.22.7")).toBe(false);
  });
});
