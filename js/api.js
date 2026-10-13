// Data layer: pulls live college football data from ESPN's public JSON endpoints
// and trims it down to the handful of fields the app uses.

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const STANDINGS = 'https://site.api.espn.com/apis/v2/sports/football/college-football/standings';
const WEB = 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football';

const CACHE_PREFIX = 'cfb:v1:';
const TTL_MS = 10 * 60 * 1000;

const store = typeof localStorage !== 'undefined' ? localStorage : null;

function cacheGet(key) {
  try {
    const raw = store?.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    return Date.now() - t < TTL_MS ? v : null;
  } catch {
    return null;
  }
}

function cacheSet(key, v) {
  try {
    store?.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v }));
  } catch {
    // Storage full or unavailable: the app still works, it just refetches.
  }
}

export function clearCache() {
  if (!store) return;
  for (const k of Object.keys(store)) if (k.startsWith(CACHE_PREFIX)) store.removeItem(k);
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN request failed (${res.status}): ${url}`);
  return res.json();
}

async function cached(key, loader) {
  const hit = cacheGet(key);
  if (hit) return hit;
  const v = await loader();
  cacheSet(key, v);
  return v;
}

const logoOf = (team) =>
  team.logo || team.logos?.find((l) => l.rel?.includes('default'))?.href || team.logos?.[0]?.href || '';

function slimEvent(e, week) {
  const c = e.competitions[0];
  const home = c.competitors.find((x) => x.homeAway === 'home');
  const away = c.competitors.find((x) => x.homeAway === 'away');
  const state = e.status.type;
  const side = (x) => ({
    id: x.team.id,
    name: x.team.location,
    abbr: x.team.abbreviation,
    logo: logoOf(x.team),
    color: x.team.color,
    alt: x.team.alternateColor,
  });
  return {
    id: e.id,
    week,
    date: e.date,
    timeValid: c.timeValid !== false,
    home: side(home),
    away: side(away),
    hs: Number(home.score),
    as: Number(away.score),
    done: state.completed === true,
    live: state.state === 'in',
    off: /CANCEL|POSTPONE/.test(state.name),
    neutral: !!c.neutralSite,
    conf: !!c.conferenceCompetition,
    tv: c.broadcast || c.broadcasts?.[0]?.names?.[0] || '',
    note: c.notes?.[0]?.headline || '',
    venue: c.venue?.fullName || '',
  };
}

/** Every FBS game of the season, played and unplayed. */
export async function loadSeason() {
  return cached('season', async () => {
    const first = await getJSON(`${SITE}/scoreboard?groups=80&limit=300`);
    const year = first.season.year;
    const cal = first.leagues[0].calendar.find((c) => c.value === '2') || first.leagues[0].calendar[0];
    const weeks = cal.entries.map((w) => ({ n: Number(w.value), label: w.label, start: w.startDate, end: w.endDate }));
    const boards = await Promise.all(
      weeks.map((w) => getJSON(`${SITE}/scoreboard?groups=80&seasontype=2&week=${w.n}&dates=${year}&limit=300`)),
    );
    const games = [];
    boards.forEach((b, i) => b.events.forEach((e) => games.push(slimEvent(e, weeks[i].n))));
    games.sort((a, b) => a.date.localeCompare(b.date));
    const currentWeek = first.season.type === 2 ? first.week.number : first.season.type < 2 ? 1 : weeks.length + 1;
    return { year, weeks, currentWeek, games };
  });
}

/** FBS teams with their conference. Divisions (Sun Belt) are folded into the conference. */
export async function loadTeams() {
  return cached('teams', async () => {
    const d = await getJSON(`${STANDINGS}?group=80`);
    const teams = [];
    const confs = [];
    for (const conf of d.children) {
      confs.push({ id: conf.id, name: conf.name, short: conf.shortName || conf.name });
      const entries = [...(conf.standings?.entries || []), ...(conf.children || []).flatMap((c) => c.standings?.entries || [])];
      for (const e of entries) {
        teams.push({
          id: e.team.id,
          name: e.team.location,
          nick: e.team.name,
          full: e.team.displayName,
          abbr: e.team.abbreviation,
          logo: logoOf(e.team),
          conf: conf.id,
        });
      }
    }
    return { teams, confs };
  });
}

/** FBS polls. The CFP committee ranking is listed first once it starts being published. */
export async function loadRankings() {
  return cached('rankings', async () => {
    const d = await getJSON(`${SITE}/rankings`);
    const polls = d.rankings
      .filter((r) => !/FCS|Division/i.test(r.name))
      .map((r) => ({
        name: r.name,
        short: r.shortName,
        type: r.type,
        week: r.occurrence?.displayValue || '',
        ranks: r.ranks.map((x) => ({
          rank: x.current,
          prev: x.previous,
          id: x.team.id,
          name: x.team.location,
          logo: logoOf(x.team),
          record: x.recordSummary || '',
          points: x.points,
          firsts: x.firstPlaceVotes,
        })),
      }));
    polls.sort((a, b) => /playoff|cfp/i.test(b.name) - /playoff|cfp/i.test(a.name));
    return polls;
  });
}

const num = (s) => Number(String(s ?? '').replace(/,/g, '')) || 0;

/** Per-player season stats for one team, grouped by category. */
export async function loadPlayers(teamId) {
  return cached(`players:${teamId}`, async () => {
    const d = await getJSON(`${WEB}/teams/${teamId}/athletes/statistics`);
    const out = {};
    for (const cat of d.results || []) {
      out[cat.name] = cat.leaders.map((l) => {
        const stats = {};
        for (const group of l.statistics || []) {
          for (const s of group.stats) if (!(s.name in stats)) stats[s.name] = num(s.displayValue);
        }
        return {
          id: l.athlete.id,
          name: l.athlete.displayName,
          pos: l.athlete.position?.abbreviation || '',
          headshot: l.athlete.headshot?.href || '',
          stats,
        };
      });
    }
    return out;
  });
}
