#!/usr/bin/env node
// Pulls Ohio high school football scores and region standings from Joe Eitel's
// site (joeeitel.com/hsfoot) and writes them to ohio/data/<year>.json for the
// Ohio page to read. Makes 44 requests, one per second, so run it sparingly
// (the GitHub Action runs it twice a week during the season).
//
//   node scripts/fetch-ohio.mjs [year]

import { writeFile, mkdir } from 'node:fs/promises';

const YEAR = Number(process.argv[2]) || new Date().getFullYear();
const BASE = 'https://joeeitel.com/hsfoot';
const WEEKS = 16;
const REGIONS = 28;
const OUT = new URL(`../ohio/data/${YEAR}.json`, import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

async function get(path) {
  const res = await fetch(`${BASE}/${path}`, {
    headers: { 'User-Agent': 'ohio-playoff-tracker (personal, non-commercial; twice-weekly)' },
  });
  if (!res.ok) throw new Error(`${res.status} for ${path}`);
  await sleep(1000);
  return res.text();
}

function parseRegion(html, region) {
  const teams = [];
  const status = clean(html.match(/Week 10 status:\s*([^<]+)/)?.[1] || '');
  for (const [, row] of html.matchAll(/<tr class="[^"]*">([\s\S]*?)<\/tr>/g)) {
    const td = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (td.length < 10) continue;
    const id = row.match(/teamID=(\d+)/)?.[1] || clean(td[2]);
    teams.push({
      id,
      name: clean(td[4]),
      city: clean(td[3]),
      div: Math.ceil(region / 4),
      region,
      rank: teams.length + 1, // rows are in ranked order; the rank cell is blank for some ties
      wl: clean(td[1]),
      harbin: Number(clean(td[5])),
    });
  }
  return { teams, final: /complete/i.test(status) };
}

const SCORE = '<span class="text-\\w+">([^<]*)</span>';
const LINE = new RegExp(`^(\\d{4}-\\d\\d-\\d\\d)\\s+(\\S+)\\s+(.+?)\\s+${SCORE}\\s+(at|vs)\\s+(.+?)\\s+${SCORE}\\s*(.*)$`);

function parseWeek(html, week, keyOf) {
  const pre = html.match(/<pre>([\s\S]*?)<\/pre>/)?.[1] || '';
  const games = [];
  let region = 0;
  for (const raw of pre.split('<br>')) {
    const line = raw.trim();
    if (!line) continue;
    const header = line.match(/^<b>Region (\d+)<\/b>$/);
    if (header) {
      region = Number(header[1]);
      continue;
    }
    if (line.startsWith('<b>')) continue;
    const m = line.match(LINE);
    if (!m) continue; // cancellations and other notes
    const [, date, time, away, as, sep, home, hs, tail] = m;
    if (/TBD/.test(away + home) || /Non-varsity/.test(away + home)) continue;
    const g = { d: date, t: time, w: week, a: keyOf(clean(away)), h: keyOf(clean(home)) };
    if (sep === 'vs') g.n = 1;
    if (region) g.po = region;
    if (/^\d+$/.test(as) && /^\d+$/.test(hs)) {
      g.as = Number(as);
      g.hs = Number(hs);
      if (/OT/.test(tail)) g.ot = 1;
    } else if (/Win|Loss/.test(as + hs)) {
      g.forfeit = as === 'Win' || hs === 'Loss' ? 'a' : 'h';
    }
    games.push(g);
  }
  return games;
}

const regions = [];
for (let r = 1; r <= REGIONS; r++) regions.push(parseRegion(await get(`rankings/${YEAR}/region-${r}`), r));
const teams = regions.flatMap((r) => r.teams);
const byName = new Map(teams.map((t) => [`${t.name} (${t.city})`, t.id]));
const others = new Map();
const keyOf = (name) => {
  if (byName.has(name)) return byName.get(name);
  if (!others.has(name)) others.set(name, `x${others.size}`);
  return others.get(name);
};

const games = [];
for (let w = 1; w <= WEEKS; w++) games.push(...parseWeek(await get(`scoreboard/${YEAR}/week-${w}`), w, keyOf));

const data = {
  season: YEAR,
  updated: new Date().toISOString(),
  source: 'Scores and unofficial Harbin points from Joe Eitel (joeeitel.com/hsfoot)',
  regularSeasonFinal: regions.every((r) => r.final),
  teams,
  others: Object.fromEntries([...others].map(([name, key]) => [key, name])),
  games,
};
await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(data));
// The page reads latest.json to find the current season (and uses the one before as a prior).
if (!process.argv[2] || YEAR >= new Date().getFullYear()) {
  await writeFile(new URL('latest.json', OUT), JSON.stringify({ season: YEAR, updated: data.updated }));
}
console.log(`Wrote ${teams.length} teams, ${others.size} other opponents, ${games.length} games to ${OUT.pathname}`);
