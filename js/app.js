import { loadSeason, loadTeams, loadRankings, loadPlayers, clearCache } from './api.js';
import { buildModel } from './model.js';

const BASE_SIMS = 20000;
const PATH_SIMS = 5000;
const SEED = 7;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  season: null,
  teamData: null,
  polls: [],
  poll: 0,
  model: null,
  sim: null,
  bracket: null,
  meta: new Map(), // team id -> display info (FBS and non-FBS)
  rank: new Map(), // team id -> rank in the headline poll
  favorites: readJSON('cfb:favorites', []),
  selected: localStorage.getItem('cfb:selected') || null,
  paths: new Map(), // team id -> odds after each successive win
  players: new Map(),
  playerTab: 'passing',
};

function readJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

// ---------- worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 1;
worker.onmessage = ({ data: { id, result, error } }) => {
  const p = pending.get(id);
  pending.delete(id);
  error ? p.reject(new Error(error)) : p.resolve(result);
};
const ask = (type, payload) =>
  new Promise((resolve, reject) => {
    pending.set(nextId, { resolve, reject });
    worker.postMessage({ id: nextId++, type, payload });
  });

// ---------- formatting ----------
function pct(p) {
  const v = p * 100;
  if (v <= 0) return '0%';
  if (v < 0.1) return '<0.1%';
  if (v >= 100) return '100%';
  if (v > 99.9) return '>99.9%';
  return `${v.toFixed(1)}%`;
}
const whole = (p) => `${Math.round(p * 100)}%`;
const fmtNum = (v) => (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = (g) => (g.timeValid ? new Date(g.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'Time TBD');

function textOn(hex) {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111418' : '#ffffff';
}

const info = (id) => state.meta.get(id) || { id, name: 'TBD', abbr: '', logo: '' };
const logo = (id, cls = 'logo') => {
  const t = info(id);
  return t.logo ? `<img class="${cls}" src="${esc(t.logo)}" alt="" loading="lazy" />` : `<span class="${cls} logo-blank"></span>`;
};
const rankTag = (id) => (state.rank.has(id) ? `<span class="rk">${state.rank.get(id)}</span>` : '');
const teamLink = (id, label) => {
  const fbs = state.model.idx.has(id);
  const inner = `${logo(id)}${rankTag(id)}<span class="tname">${esc(label ?? info(id).name)}</span>`;
  return fbs ? `<button type="button" class="team" data-team="${esc(id)}">${inner}</button>` : `<span class="team">${inner}</span>`;
};
const bar = (p, cls = '') => `<span class="bar ${cls}"><span style="width:${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%"></span></span>`;

// ---------- boot ----------
async function boot() {
  try {
    const [season, teamData, polls] = await Promise.all([loadSeason(), loadTeams(), loadRankings()]);
    Object.assign(state, { season, teamData, polls });
    for (const g of season.games) for (const side of [g.home, g.away]) if (!state.meta.has(side.id)) state.meta.set(side.id, side);
    for (const t of teamData.teams) state.meta.set(t.id, { ...state.meta.get(t.id), ...t });
    for (const r of polls[0]?.ranks || []) state.rank.set(r.id, r.rank);

    state.model = buildModel(teamData, season);
    $('status').textContent = `Simulating the rest of the season ${BASE_SIMS.toLocaleString()} times…`;
    await ask('init', { teamData, season });
    state.sim = await ask('simulate', { sims: BASE_SIMS, seed: SEED });
    state.bracket = state.model.projectBracket(state.sim);

    if (state.selected && !state.model.idx.has(state.selected)) state.selected = null;
    state.favorites = state.favorites.filter((id) => state.model.idx.has(id));
    if (!state.selected && state.favorites.length) state.selected = state.favorites[0];

    $('status').hidden = true;
    $('app').hidden = false;
    renderAll();
    if (!state.selected && !state.favorites.length) openPicker();
  } catch (err) {
    console.error(err);
    $('status').innerHTML = `Couldn't load the season data. <button class="btn" id="retry" type="button">Try again</button><br /><small>${esc(err.message)}</small>`;
    $('retry').onclick = () => location.reload();
  }
}

function renderAll() {
  renderFavs();
  renderTeam();
  renderBracket();
  renderRankings();
  renderOdds();
  renderFoot();
}

function renderTeam() {
  const has = !!state.selected;
  for (const id of ['schedule', 'watch', 'players']) $(id).hidden = !has;
  document.querySelectorAll('.subnav a').forEach((a) => {
    a.hidden = !has && ['#schedule', '#watch', '#players'].includes(a.getAttribute('href'));
  });
  renderHero();
  if (!has) return;
  renderSchedule();
  renderWatch();
  renderPlayers();
  ensurePath(state.selected);
  ensurePlayers(state.selected);
}

function select(id) {
  if (!state.model.idx.has(id)) return;
  state.selected = id;
  localStorage.setItem('cfb:selected', id);
  renderFavs();
  renderTeam();
  renderBracket();
  renderRankings();
  renderOdds();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleFavorite(id) {
  const i = state.favorites.indexOf(id);
  i >= 0 ? state.favorites.splice(i, 1) : state.favorites.push(id);
  localStorage.setItem('cfb:favorites', JSON.stringify(state.favorites));
}

// ---------- favorites bar ----------
function renderFavs() {
  $('favs').innerHTML = state.favorites
    .map((id) => {
      const i = state.model.idx.get(id);
      return `<button type="button" class="fav ${id === state.selected ? 'on' : ''}" data-team="${esc(id)}">
        ${logo(id)}<span>${esc(info(id).abbr)}</span><span class="fav-pct">${whole(state.sim.playoff[i] / state.sim.sims)}</span>
      </button>`;
    })
    .join('');
}

// ---------- hero ----------
function renderHero() {
  const el = $('hero');
  if (!state.selected) {
    el.className = 'hero hero-empty';
    el.style.cssText = '';
    el.innerHTML = `<div><h1>Pick a team to follow</h1>
      <p>See its playoff odds, what every win is worth, and which other games matter.</p>
      <button class="btn btn-solid" type="button" data-action="pick">Choose your team</button></div>`;
    return;
  }
  const id = state.selected;
  const t = info(id);
  const i = state.model.idx.get(id);
  const { sim, model } = state;
  const n = sim.sims;
  const color = t.color || '2b3440';
  const conf = state.teamData.confs.find((c) => c.id === t.conf);
  const independent = sim.confTitle[i] === 0 && conf?.id === '18';
  const followed = state.favorites.includes(id);
  const playoff = sim.playoff[i] / n;
  const avgSeed = sim.playoff[i] ? sim.seedSum[i] / sim.playoff[i] : null;
  const projSeed = state.bracket.field.indexOf(i);
  const games = model.games.filter((g) => g.h === i || g.a === i).length;
  const projWins = Math.min(sim.winSum[i] / n, games + 1);

  const tile = (label, value, sub = '') => `<div class="tile"><div class="tile-v">${value}</div><div class="tile-l">${label}</div>${sub ? `<div class="tile-s">${sub}</div>` : ''}</div>`;
  el.className = 'hero';
  el.style.cssText = `--team:#${color};--on-team:${textOn(color)}`;
  el.innerHTML = `
    <div class="hero-id">
      ${logo(id, 'hero-logo')}
      <div>
        <h1>${state.rank.has(id) ? `<span class="hero-rank">#${state.rank.get(id)}</span> ` : ''}${esc(t.full || t.name)}</h1>
        <p>${model.base.wins[i]}–${model.base.losses[i]} · ${esc(conf?.name || '')}</p>
      </div>
      <button type="button" class="btn follow" data-action="follow">${followed ? '★ Following' : '☆ Follow'}</button>
    </div>
    <div class="tiles">
      ${tile('Make the playoff', pct(playoff), projSeed >= 0 ? `Projected ${projSeed + 1} seed` : avgSeed ? `Avg seed ${avgSeed.toFixed(1)} when in` : '')}
      ${tile('Win the national title', pct(sim.title[i] / n), `Reach the final: ${pct(sim.final[i] / n)}`)}
      ${independent ? tile('First-round bye', pct(sim.bye[i] / n), 'Top-4 seed') : tile('Win the conference', pct(sim.confTitle[i] / n), `First-round bye: ${pct(sim.bye[i] / n)}`)}
      ${tile('Projected wins', projWins.toFixed(1), 'Through conference title game')}
    </div>`;
}

// ---------- schedule ----------
function teamGames(i) {
  return state.model.games.filter((g) => g.h === i || g.a === i);
}

function ensurePath(id) {
  if (state.paths.has(id)) return;
  const { model } = state;
  const i = model.idx.get(id);
  const gameIds = model.remaining.filter((g) => g.h === i || g.a === i).map((g) => g.id);
  state.paths.set(id, null);
  ask('winPath', { team: i, gameIds, sims: PATH_SIMS, seed: SEED }).then((rows) => {
    // Winning can't hurt, so iron out any simulation noise that says otherwise.
    let playoff = state.sim.playoff[i] / state.sim.sims;
    let title = state.sim.title[i] / state.sim.sims;
    const map = new Map();
    for (const r of rows) {
      playoff = Math.max(playoff, r.playoff);
      title = Math.max(title, r.title);
      map.set(r.id, { playoff, title });
    }
    state.paths.set(id, map);
    if (state.selected === id) renderSchedule();
  });
}

function renderSchedule() {
  const id = state.selected;
  const { model, sim } = state;
  const i = model.idx.get(id);
  const path = state.paths.get(id);
  const now = sim.playoff[i] / sim.sims;
  let prev = now;
  let streak = 0;

  const rows = teamGames(i).map((g) => {
    const home = g.h === i;
    const opp = home ? g.away : g.home;
    const where = g.neutral ? 'vs' : home ? 'vs' : 'at';
    const oppCell = `<span class="where">${where}</span>${teamLink(opp.id)}${g.neutral ? '<span class="tag">neutral</span>' : ''}`;
    const date = `<span class="d1">${fmtDay(g.date)}</span>`;
    if (g.done) {
      const us = home ? g.hs : g.as;
      const them = home ? g.as : g.hs;
      const won = us > them;
      return `<tr class="played"><td>${date}</td><td>${oppCell}</td>
        <td><span class="res ${won ? 'w' : 'l'}">${won ? 'W' : 'L'}</span> ${us}–${them}</td><td class="muted">Final</td><td></td></tr>`;
    }
    const p = model.predict(g.h, g.a, g.neutral);
    const us = home ? p.hs : p.as;
    const them = home ? p.as : p.hs;
    const win = home ? p.pHome : 1 - p.pHome;
    const tone = win >= 0.65 ? 'good' : win >= 0.4 ? 'even' : 'bad';
    streak++;
    let after = '<span class="muted">Simulating…</span>';
    if (path) {
      const r = path.get(g.id);
      const gain = r.playoff - prev;
      prev = r.playoff;
      after = `<div class="after"><strong>${pct(r.playoff)}</strong>${bar(r.playoff)}
        <span class="gain">${gain >= 0.0005 ? `+${(gain * 100).toFixed(1)}` : '—'}</span></div>
        <div class="sub">Title odds ${pct(r.title)}${streak > 1 ? ` · ${streak} straight wins` : ''}</div>`;
    }
    return `<tr><td>${date}<span class="d2">${g.live ? 'Live now' : fmtTime(g)}${g.tv ? ` · ${esc(g.tv)}` : ''}</span></td>
      <td>${oppCell}</td>
      <td><span class="res proj">${us > them ? 'W' : 'L'}</span> ${us}–${them}<span class="d2">Predicted</span></td>
      <td><span class="chip ${tone}">${whole(win)}</span></td>
      <td>${after}</td></tr>`;
  });

  $('schedule').innerHTML = `
    <div class="card-head"><h2>Schedule &amp; playoff path</h2>
      <p>Playoff chance right now: <strong>${pct(now)}</strong>. The last column shows where it goes after each win, assuming they've also won every game above it.</p></div>
    <div class="scroll"><table class="tbl sched">
      <thead><tr><th>Date</th><th>Opponent</th><th>Score</th><th>Win chance</th><th>Playoff chance after a win</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>`;
}

// ---------- games to watch ----------
function watchList(i) {
  const { model } = state;
  const items = new Map();
  for (const mine of model.remaining.filter((g) => g.h === i || g.a === i)) {
    const o = mine.h === i ? mine.a : mine.h;
    if (o === model.FCS) continue;
    for (const g of model.remaining) {
      if ((g.h !== o && g.a !== o) || g.h === i || g.a === i || g.date >= mine.date) continue;
      if (!items.has(g.id)) items.set(g.id, { g, cheer: [] });
      items.get(g.id).cheer.push({ o, meet: mine });
    }
  }
  return [...items.values()].sort((a, b) => a.g.date.localeCompare(b.g.date));
}

function watchCard({ g, cheer }) {
  const { model } = state;
  const p = model.predict(g.h, g.a, g.neutral);
  // If both teams are still on the schedule, lean toward the stronger one.
  const pick = cheer.length > 1 ? cheer.slice().sort((a, b) => model.rating[b.o] - model.rating[a.o])[0] : cheer[0];
  const cheerHome = pick.o === g.h;
  const cheerId = cheerHome ? g.home.id : g.away.id;
  const win = cheerHome ? p.pHome : 1 - p.pHome;
  const mood = win >= 0.75 ? 'Should handle it' : win >= 0.55 ? 'Favored' : win >= 0.45 ? 'Toss-up' : win >= 0.25 ? 'Needs an upset' : 'Long shot';
  const why =
    cheer.length > 1
      ? `You play both of these teams, so somebody on your schedule gets a boost either way. ${esc(info(cheerId).name)} is the bigger résumé win.`
      : `You play ${esc(info(cheerId).name)} on ${fmtDay(pick.meet.date)}. The better their record looks by then, the more a win over them is worth.`;
  return `<article class="watch">
    <div class="watch-when"><strong>${fmtDay(g.date)}</strong><span>${fmtTime(g)}</span>${g.tv ? `<span class="tag">${esc(g.tv)}</span>` : ''}</div>
    <div class="watch-body">
      <div class="watch-match">${teamLink(g.away.id)}<span class="where">${g.neutral ? 'vs' : 'at'}</span>${teamLink(g.home.id)}</div>
      <div class="cheer">📣 Cheer for <strong>${esc(info(cheerId).name)}</strong></div>
      <p class="sub">${why}</p>
    </div>
    <div class="watch-pred">
      <div class="score">${esc(g.away.abbr)} ${p.as} – ${p.hs} ${esc(g.home.abbr)}</div>
      <div class="sub">Predicted</div>
      <span class="chip ${win >= 0.55 ? 'good' : win >= 0.45 ? 'even' : 'bad'}">${esc(info(cheerId).abbr)} ${whole(win)} · ${mood}</span>
    </div>
  </article>`;
}

function renderWatch() {
  const i = state.model.idx.get(state.selected);
  const items = watchList(i);
  let body = '<p class="empty">No remaining games involve your future opponents.</p>';
  if (items.length) {
    const week = items[0].g.week;
    const soon = items.filter((x) => x.g.week === week);
    const later = items.filter((x) => x.g.week !== week);
    const weekLabel = state.season.weeks.find((w) => w.n === week)?.label || 'Up next';
    body = `<h3 class="group">${esc(weekLabel)}</h3>${soon.map(watchCard).join('')}`;
    if (later.length) {
      body += `<details class="more"><summary>${later.length} more in later weeks</summary>${later.map(watchCard).join('')}</details>`;
    }
  }
  $('watch').innerHTML = `
    <div class="card-head"><h2>Games to watch</h2>
      <p>Your future opponents are playing. Root for them now so there's a bigger scalp waiting when ${esc(info(state.selected).name)} gets its turn.</p></div>
    ${body}`;
}

// ---------- bracket ----------
function renderBracket() {
  const { bracket: b, model, sim } = state;
  const mine = state.selected ? model.idx.get(state.selected) : -1;
  const slot = (s) => {
    const t = model.teams[s.team];
    return `<button type="button" class="slot ${s.win ? 'win' : ''} ${s.team === mine ? 'mine' : ''}" data-team="${esc(t.id)}">
      <span class="seed">${s.seed}</span>${logo(t.id)}<span class="tname">${esc(t.name)}</span><span class="pts">${s.score}</span></button>`;
  };
  const match = (g) => `<div class="match">${slot(g.top)}${slot(g.bottom)}
    <div class="match-meta">${esc(model.teams[g.winner].name)} wins ${whole(g.prob)} of the time</div></div>`;
  const round = (title, sub, games) => `<div class="round"><div class="round-h">${title}<span>${sub}</span></div><div class="round-g">${games.map(match).join('')}</div></div>`;
  const champ = model.teams[b.champion];
  const out = Array.from({ length: model.n }, (_, i) => i)
    .filter((i) => !b.field.includes(i))
    .sort((x, y) => sim.playoff[y] - sim.playoff[x])
    .slice(0, 4);
  const champs = b.field.filter((i) => b.autoBid.has(i)).map((i) => esc(model.teams[i].name));

  $('bracket').innerHTML = `
    <div class="card-head"><h2>Projected playoff bracket</h2>
      <p>The 12 most likely teams, seeded the way the committee would today, with the favorite advancing in every game.</p></div>
    <div class="champ">${logo(champ.id, 'champ-logo')}<div><span class="sub">Projected national champion</span>
      <strong>${esc(champ.name)}</strong><span class="sub">${pct(sim.title[b.champion] / sim.sims)} title chance</span></div></div>
    <div class="scroll"><div class="bracket">
      ${round('First round', 'On campus', b.first)}
      ${round('Quarterfinals', 'Top 4 seeds had byes', b.quarters)}
      ${round('Semifinals', '', b.semis)}
      ${round('Championship', '', [b.final])}
    </div></div>
    <p class="sub foot-note"><strong>Conference champions in the field:</strong> ${champs.join(', ')}.
      <strong>First four out:</strong> ${out.map((i) => `${esc(model.teams[i].name)} (${whole(sim.playoff[i] / sim.sims)})`).join(', ')}.</p>`;
}

// ---------- top 25 ----------
function renderRankings() {
  const { polls, model, sim } = state;
  if (!polls.length) {
    $('rankings').innerHTML = '<div class="card-head"><h2>Top 25</h2></div><p class="empty">No rankings published yet.</p>';
    return;
  }
  const poll = polls[state.poll] || polls[0];
  const tabs = polls.length > 1 ? `<div class="tabs">${polls.map((p, k) => `<button type="button" class="tab ${k === state.poll ? 'on' : ''}" data-poll="${k}">${esc(p.short || p.name)}</button>`).join('')}</div>` : '';
  const rows = poll.ranks.map((r) => {
    const i = model.idx.get(r.id);
    const move = !r.prev ? '<span class="mv new">new</span>' : r.prev > r.rank ? `<span class="mv up">▲${r.prev - r.rank}</span>` : r.prev < r.rank ? `<span class="mv down">▼${r.rank - r.prev}</span>` : '<span class="mv">–</span>';
    const t = info(r.id);
    return `<tr class="${r.id === state.selected ? 'mine' : ''}"><td class="num">${r.rank}</td><td>${move}</td>
      <td><button type="button" class="team" data-team="${esc(r.id)}">${logo(r.id)}<span class="tname">${esc(t.name || r.name)}</span></button></td>
      <td class="num">${esc(r.record)}</td><td class="num">${i === undefined ? '' : whole(sim.playoff[i] / sim.sims)}</td></tr>`;
  });
  $('rankings').innerHTML = `
    <div class="card-head"><h2>Top 25</h2><p>${esc(poll.name)}${poll.week ? ` · ${esc(poll.week)}` : ''}</p></div>
    ${tabs}
    <table class="tbl rank poll"><colgroup><col class="c-rank" /><col class="c-move" /><col /><col class="c-rec" /><col class="c-odds" /></colgroup>
    <thead><tr><th></th><th></th><th>Team</th><th class="num">Rec</th><th class="num" title="Chance to make the playoff">Playoff</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}

function renderOdds() {
  const { model, sim } = state;
  const top = Array.from({ length: model.n }, (_, i) => i)
    .sort((x, y) => sim.title[y] - sim.title[x])
    .slice(0, 10);
  $('odds').innerHTML = `
    <div class="card-head"><h2>Title favorites</h2><p>Chance to win the national championship</p></div>
    <table class="tbl rank"><tbody>${top
      .map((i) => {
        const t = model.teams[i];
        return `<tr class="${t.id === state.selected ? 'mine' : ''}"><td>${teamLink(t.id)}</td><td class="num">${pct(sim.title[i] / sim.sims)}</td></tr>`;
      })
      .join('')}</tbody></table>`;
}

// ---------- players ----------
const PLAYER_TABLES = [
  { key: 'passing', label: 'Passing', top: 4, cols: [['completions', 'CMP'], ['passingAttempts', 'ATT'], ['completionPct', 'CMP%'], ['passingYards', 'YDS'], ['yardsPerPassAttempt', 'AVG'], ['passingTouchdowns', 'TD'], ['interceptions', 'INT'], ['QBRating', 'RTG']] },
  { key: 'rushing', label: 'Rushing', top: 8, cols: [['rushingAttempts', 'CAR'], ['rushingYards', 'YDS'], ['yardsPerRushAttempt', 'AVG'], ['rushingTouchdowns', 'TD'], ['longRushing', 'LNG'], ['rushingYardsPerGame', 'YDS/G']] },
  { key: 'receiving', label: 'Receiving', top: 10, cols: [['receptions', 'REC'], ['receivingYards', 'YDS'], ['yardsPerReception', 'AVG'], ['receivingTouchdowns', 'TD'], ['longReception', 'LNG'], ['receivingYardsPerGame', 'YDS/G']] },
  { key: 'defensive', label: 'Defense', top: 15, cols: [['totalTackles', 'TCKL'], ['soloTackles', 'SOLO'], ['tacklesForLoss', 'TFL'], ['sacks', 'SACK'], ['interceptions', 'INT'], ['passesDefended', 'PD'], ['fumblesForced', 'FF']] },
  { key: 'kicking', label: 'Kicking', top: 3, cols: [['fieldGoalsMade', 'FGM'], ['fieldGoalAttempts', 'FGA'], ['fieldGoalPct', 'FG%'], ['longFieldGoalMade', 'LNG'], ['extraPointsMade', 'XPM'], ['extraPointAttempts', 'XPA'], ['totalKickingPoints', 'PTS']] },
  { key: 'punting', label: 'Punting', top: 3, cols: [['punts', 'PUNTS'], ['puntYards', 'YDS'], ['grossAvgPuntYards', 'AVG'], ['longPunt', 'LNG'], ['puntsInside20', 'IN20']] },
  { key: 'returning', label: 'Returns', top: 6, cols: [['kickReturns', 'KR'], ['kickReturnYards', 'KR YDS'], ['kickReturnTouchdowns', 'KR TD'], ['puntReturns', 'PR'], ['puntReturnYards', 'PR YDS'], ['puntReturnTouchdowns', 'PR TD']] },
];

/** Pick out the players who carry this team. Returns player id -> { player, label, line }. */
function findStars(data) {
  const stars = new Map();
  const add = (p, label, line) => p && !stars.has(p.id) && stars.set(p.id, { player: p, label, line });
  const leader = (list, stat, min = 1) => {
    const best = (list || []).reduce((b, p) => ((p.stats[stat] || 0) > (b?.stats[stat] || 0) ? p : b), null);
    return best && best.stats[stat] >= min ? best : null;
  };
  const s = (p) => p.stats;

  const qb = leader(data.passing, 'passingYards', 300);
  if (qb) add(qb, 'Quarterback', `${fmtNum(s(qb).passingYards)} yds · ${s(qb).passingTouchdowns} TD · ${s(qb).interceptions} INT`);
  const rb = leader(data.rushing, 'rushingYards', 150);
  if (rb) add(rb, 'Leading rusher', `${fmtNum(s(rb).rushingYards)} yds · ${fmtNum(s(rb).yardsPerRushAttempt)} per carry · ${s(rb).rushingTouchdowns} TD`);
  const wr = leader(data.receiving, 'receivingYards', 150);
  if (wr) add(wr, 'Top target', `${s(wr).receptions} catches · ${fmtNum(s(wr).receivingYards)} yds · ${s(wr).receivingTouchdowns} TD`);
  // Anyone else putting up feature-back or WR1 numbers.
  for (const p of data.rushing || []) if (s(p).rushingYardsPerGame >= 75) add(p, 'Workhorse', `${fmtNum(s(p).rushingYardsPerGame)} rush yds a game · ${s(p).rushingTouchdowns} TD`);
  for (const p of data.receiving || []) if (s(p).receivingYardsPerGame >= 70) add(p, 'Big-play threat', `${fmtNum(s(p).receivingYardsPerGame)} rec yds a game · ${s(p).receivingTouchdowns} TD`);
  const sack = leader(data.defensive, 'sacks', 3);
  if (sack) add(sack, 'Sack leader', `${fmtNum(s(sack).sacks)} sacks · ${fmtNum(s(sack).tacklesForLoss)} TFL`);
  const tackler = leader(data.defensive, 'totalTackles', 20);
  if (tackler) add(tackler, 'Leading tackler', `${s(tackler).totalTackles} tackles · ${fmtNum(s(tackler).tacklesForLoss)} TFL`);
  const hawk = leader(data.defensive, 'interceptions', 2);
  if (hawk) add(hawk, 'Ball hawk', `${s(hawk).interceptions} INT · ${s(hawk).passesDefended} passes defended`);
  const k = leader(data.kicking, 'fieldGoalsMade', 6);
  if (k && s(k).fieldGoalPct >= 85) add(k, 'Automatic', `${s(k).fieldGoalsMade}/${s(k).fieldGoalAttempts} FG · long ${s(k).longFieldGoalMade}`);
  return stars;
}

function ensurePlayers(id) {
  if (state.players.has(id)) return;
  state.players.set(id, null);
  loadPlayers(id)
    .then((data) => state.players.set(id, { data, stars: findStars(data) }))
    .catch((err) => state.players.set(id, { error: err.message }))
    .finally(() => state.selected === id && renderPlayers());
}

function renderPlayers() {
  const entry = state.players.get(state.selected);
  const head = `<div class="card-head"><h2>Player stats</h2><p>Season totals. ★ marks the players this team leans on.</p></div>`;
  if (!entry) return void ($('players').innerHTML = `${head}<p class="empty">Loading players…</p>`);
  if (entry.error) return void ($('players').innerHTML = `${head}<p class="empty">Player stats aren't available right now.</p>`);
  const { data, stars } = entry;
  const tables = PLAYER_TABLES.filter((t) => data[t.key]?.length);
  if (!tables.length) return void ($('players').innerHTML = `${head}<p class="empty">No player stats recorded yet this season.</p>`);
  const table = tables.find((t) => t.key === state.playerTab) || tables[0];

  const starCards = [...stars.values()]
    .map(({ player: p, label, line }) => `<div class="star">
      ${p.headshot ? `<img src="${esc(p.headshot)}" alt="" loading="lazy" onerror="this.remove()" />` : ''}
      <div><span class="star-l">★ ${esc(label)}</span><strong>${esc(p.name)}</strong><span class="sub">${esc(p.pos)} · ${esc(line)}</span></div></div>`)
    .join('');

  const players = data[table.key].filter((p) => table.cols.some(([stat]) => p.stats[stat])).slice(0, table.top);
  const rows = players.map((p) => `<tr class="${stars.has(p.id) ? 'starred' : ''}">
      <td class="pname">${stars.has(p.id) ? '<span class="st" title="Star player">★</span>' : ''}${esc(p.name)} <span class="muted">${esc(p.pos)}</span></td>
      <td class="num">${p.stats.gamesPlayed ?? ''}</td>${table.cols.map(([stat]) => `<td class="num">${fmtNum(p.stats[stat] ?? 0)}</td>`).join('')}</tr>`);

  $('players').innerHTML = `${head}
    ${starCards ? `<div class="stars">${starCards}</div>` : ''}
    <div class="tabs">${tables.map((t) => `<button type="button" class="tab ${t === table ? 'on' : ''}" data-ptab="${t.key}">${t.label}</button>`).join('')}</div>
    <div class="scroll"><table class="tbl stats"><thead><tr><th>Player</th><th class="num">GP</th>${table.cols.map(([, h]) => `<th class="num">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

// ---------- footer ----------
function renderFoot() {
  const { model, season } = state;
  $('foot').innerHTML = `
    <p><strong>How the numbers work.</strong> Every team gets an offense and defense rating from this season's ${model.played.length} results, adjusted for opponent and home field.
    Those ratings predict each remaining game, and the rest of the ${season.year} season (conference title games, committee ranking, 12-team bracket) is played out ${BASE_SIMS.toLocaleString()} times.
    The field is the four power-conference champions, the best other champion and the top remaining teams, seeded straight by ranking. These are estimates for fun, not betting advice.</p>
    <p>Scores, schedules, rankings and player stats from ESPN. <button type="button" class="link" data-action="refresh">Refresh data</button></p>`;
}

// ---------- team picker ----------
function openPicker() {
  renderPicker('');
  $('picker-search').value = '';
  $('picker').showModal();
}

function renderPicker(query) {
  const q = query.trim().toLowerCase();
  const groups = state.teamData.confs
    .map((c) => {
      const teams = state.teamData.teams
        .filter((t) => t.conf === c.id && (!q || `${t.full} ${t.abbr} ${c.name}`.toLowerCase().includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!teams.length) return '';
      return `<h3>${esc(c.name)}</h3><div class="pick-grid">${teams
        .map((t) => `<button type="button" class="pick ${state.favorites.includes(t.id) ? 'on' : ''}" data-pick="${esc(t.id)}">${logo(t.id)}<span>${esc(t.name)}</span></button>`)
        .join('')}</div>`;
    })
    .join('');
  $('picker-list').innerHTML = groups || '<p class="empty">No teams match that search.</p>';
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-team],[data-action],[data-poll],[data-ptab],[data-pick]');
  if (!el) return;
  if (el.dataset.pick) {
    const id = el.dataset.pick;
    toggleFavorite(id);
    renderPicker($('picker-search').value);
    if (state.favorites.includes(id)) select(id);
    else {
      renderFavs();
      renderHero();
    }
  } else if (el.dataset.team) {
    select(el.dataset.team);
  } else if (el.dataset.poll) {
    state.poll = Number(el.dataset.poll);
    renderRankings();
  } else if (el.dataset.ptab) {
    state.playerTab = el.dataset.ptab;
    renderPlayers();
  } else if (el.dataset.action === 'pick') {
    openPicker();
  } else if (el.dataset.action === 'follow') {
    toggleFavorite(state.selected);
    renderFavs();
    renderHero();
  } else if (el.dataset.action === 'refresh') {
    clearCache();
    location.reload();
  }
});
$('add-team').addEventListener('click', openPicker);
$('picker-search').addEventListener('input', (e) => renderPicker(e.target.value));

boot();
