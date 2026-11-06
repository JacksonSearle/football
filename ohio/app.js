import { buildModel, roundOdds, pathFor, rootingGuide, ROUND_NAMES } from './model.js';

const DIVISION = 3;
const SIMS = 20000;
// Playoff calendar from the OHSAA football page. Add a new line each season.
const ROUND_DATES = {
  2026: ['Fri, Oct 30', 'Fri, Nov 6', 'Fri, Nov 13', 'Fri, Nov 20', 'Fri, Nov 27', 'Dec 3–5'],
};
const roundDate = (r) => ROUND_DATES[state.data.season]?.[r] || '';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function readJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    // Private mode or storage blocked: favorites just won't persist.
  }
}

const state = {
  data: null,
  model: null,
  bracket: null,
  sim: null,
  odds: null,
  proj: null,
  favorites: readJSON('oh:favorites', []),
  selected: readJSON('oh:selected', null),
  tab: null,
};

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
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const team = (key) => state.model.teamById.get(key);
const nameOf = (key) => state.model.nameOf(key);
const keyAt = (i) => state.model.keys[i];
const isD3 = (key) => team(key)?.div === DIVISION;

function initials(name) {
  const words = name.replace(/\(.*?\)|\[.*?\]/g, '').split(/[\s-]+/).filter((w) => /^[A-Za-z]/.test(w));
  return (words.length > 1 ? words.slice(0, 2).map((w) => w[0]) : [words[0]?.slice(0, 2) || '?']).join('').toUpperCase();
}
// Logos and colors for teams we have them for, keyed by Joe Eitel's team id.
const TEAM_STYLE = {
  184: { logo: 'logos/bellbrook.png', color: 'c3b1e1' }, // Bellbrook
};

function textOn(hex) {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111418' : '#ffffff';
}

const badge = (key, cls = 'badge') => {
  const logo = TEAM_STYLE[key]?.logo;
  return logo
    ? `<img class="${cls} logo-img" src="${esc(logo)}" alt="" loading="lazy" />`
    : `<span class="${cls}" aria-hidden="true">${esc(initials(nameOf(key)))}</span>`;
};
function teamLink(key) {
  const t = team(key);
  const inner = `${badge(key)}<span class="tname">${esc(t ? t.name : nameOf(key))}</span>`;
  return isD3(key) ? `<button type="button" class="team" data-team="${esc(key)}">${inner}</button>` : `<span class="team">${inner}${t ? `<span class="oos">D-${['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][t.div]}</span>` : ''}</span>`;
}
const bar = (p) => `<span class="bar"><span style="width:${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%"></span></span>`;

function record(key) {
  let w = 0;
  let l = 0;
  for (const g of state.model.games) {
    if (!g.done || (g.h !== key && g.a !== key)) continue;
    const homeWon = g.forfeit ? g.forfeit === 'h' : g.hs > g.as;
    (g.h === key) === homeWon ? w++ : l++;
  }
  return `${w}-${l}`;
}

// ---------- boot ----------
async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} loading ${url}`);
  return res.json();
}

async function boot() {
  try {
    const { season } = await getJSON('data/latest.json');
    const [data, prev] = await Promise.all([getJSON(`data/${season}.json`), getJSON(`data/${season - 1}.json`).catch(() => null)]);
    const prior = prev ? buildModel(prev) : null;
    state.data = data;
    state.model = buildModel(data, { prior });
    state.bracket = state.model.bracketFor(DIVISION);
    state.sim = state.model.simulate(state.bracket, { sims: SIMS });
    state.odds = roundOdds(state.sim, state.bracket);
    state.proj = projectBracket();

    state.favorites = state.favorites.filter(isD3);
    if (!isD3(state.selected)) state.selected = state.favorites[0] || null;

    $('status').hidden = true;
    $('app').hidden = false;
    renderAll();
    if (!state.selected) openPicker();
  } catch (err) {
    console.error(err);
    $('status').innerHTML = `Couldn't load the Ohio data. <button class="btn" type="button" onclick="location.reload()">Try again</button><br /><small>${esc(err.message)}</small>`;
  }
}

function renderAll() {
  renderBanner();
  renderFavs();
  renderTeam();
  renderBracket();
  renderRankings();
  renderOdds();
  renderFoot();
}

function select(key) {
  if (!isD3(key)) return;
  state.selected = key;
  save('oh:selected', key);
  state.tab = null;
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleFavorite(key) {
  const i = state.favorites.indexOf(key);
  i >= 0 ? state.favorites.splice(i, 1) : state.favorites.push(key);
  save('oh:favorites', state.favorites);
}

const teamOdds = (key) => state.odds.get(state.model.idx.get(key));

function renderBanner() {
  $('banner').innerHTML = state.data.regularSeasonFinal
    ? ''
    : `<div class="banner">The regular season is still going. Seeds and the bracket use the current unofficial Harbin standings, as if the season ended today.</div>`;
}

function renderFavs() {
  $('favs').innerHTML = state.favorites
    .map((key) => {
      const o = teamOdds(key);
      return `<button type="button" class="fav ${key === state.selected ? 'on' : ''}" data-team="${esc(key)}">
        ${badge(key)}<span>${esc(team(key).name)}</span><span class="fav-pct">${o ? whole(o.win[5]) : 'out'}</span></button>`;
    })
    .join('');
}

// ---------- team view ----------
function renderTeam() {
  const has = !!state.selected;
  for (const id of ['schedule', 'path', 'watch']) $(id).hidden = !has;
  renderHero();
  if (!has) return;
  renderSchedule();
  renderPath();
  renderWatch();
}

function status(key) {
  const t = team(key);
  const seed = state.bracket.seedOf.get(state.model.idx.get(key));
  const o = teamOdds(key);
  if (!seed) return { qualified: false, text: `Finished #${t.rank} in Region ${t.region}. The top 12 make the playoffs.` };
  const alive = o && o.win[5] > 0;
  let out = '';
  if (!alive) {
    const lostIn = [0, 1, 2, 3, 4, 5].find((r) => o.play[r] > 0.999 && o.win[r] < 0.001);
    out = lostIn === undefined ? 'Eliminated' : `Eliminated in the ${ROUND_NAMES[lostIn].toLowerCase()}`;
  }
  return { qualified: true, alive, seed, text: `No. ${seed.seed} seed in Region ${seed.region}${out ? ` · ${out}` : ''}` };
}

function renderHero() {
  const el = $('hero');
  if (!state.selected) {
    el.className = 'hero hero-empty';
    el.style.cssText = '';
    el.innerHTML = `<div><h1>Pick a Division III team</h1>
      <p>See its title odds, who it probably plays next, and which games to root for.</p>
      <button class="btn btn-solid" type="button" data-action="pick">Choose your team</button></div>`;
    return;
  }
  const key = state.selected;
  const t = team(key);
  const s = status(key);
  const o = teamOdds(key);
  const followed = state.favorites.includes(key);
  const tile = (label, value, sub = '') => `<div class="tile"><div class="tile-v">${value}</div><div class="tile-l">${label}</div>${sub ? `<div class="tile-s">${sub}</div>` : ''}</div>`;
  const powerRank = d3ByRating().indexOf(key) + 1;
  const color = TEAM_STYLE[key]?.color;
  el.className = 'hero';
  el.style.cssText = color ? `--team:#${color};--on-team:${textOn(color)}` : '';
  el.innerHTML = `
    <div class="hero-id">
      ${badge(key, 'hero-badge')}
      <div>
        <h1>${esc(t.name)}</h1>
        <p>${record(key)} · ${esc(t.city)} · ${esc(s.text)}</p>
      </div>
      <button type="button" class="btn follow" data-action="follow">${followed ? '★ Following' : '☆ Follow'}</button>
    </div>
    <div class="tiles">
      ${
        s.qualified
          ? `${tile('Win the region', pct(o.win[3]), `Reach regional final: ${pct(o.play[3])}`)}
             ${tile('Reach the state final', pct(o.win[4]), `Reach state semis: ${pct(o.play[4])}`)}
             ${tile('Win the state title', pct(o.win[5]))}`
          : `${tile('Playoffs', 'Missed', `#${t.rank} in Region ${t.region}`)}${tile('State title', '0%')}${tile('Final record', record(key))}`
      }
      ${tile('Harbin points', t.harbin.toFixed(2), `D-III power rank: #${powerRank}`)}
    </div>`;
}

function roundOfWeek(w) {
  return ROUND_NAMES[w - 11] || 'Playoffs';
}

function renderSchedule() {
  const key = state.selected;
  const { model } = state;
  const rows = model.games
    .filter((g) => g.h === key || g.a === key)
    .map((g) => {
      const home = g.h === key;
      const opp = home ? g.a : g.h;
      const where = g.n ? 'vs' : home ? 'vs' : 'at';
      const label = g.w >= 11 ? `<span class="tag">${esc(roundOfWeek(g.w))}</span>` : '';
      const oppCell = `<span class="where">${where}</span>${teamLink(opp)}${label}`;
      const date = `<span class="d1">${fmtDay(g.d)}</span><span class="d2">${esc(g.t)}</span>`;
      if (g.done) {
        const won = g.forfeit ? (g.forfeit === 'h') === home : (home ? g.hs > g.as : g.as > g.hs);
        const score = g.forfeit ? 'forfeit' : `${home ? g.hs : g.as}–${home ? g.as : g.hs}${g.ot ? ' (OT)' : ''}`;
        return `<tr class="played"><td>${date}</td><td>${oppCell}</td><td><span class="res ${won ? 'w' : 'l'}">${won ? 'W' : 'L'}</span> ${score}</td><td class="muted">Final</td></tr>`;
      }
      const p = model.predict(g.hi, g.ai, g.n);
      const us = home ? p.hs : p.as;
      const them = home ? p.as : p.hs;
      const win = home ? p.pHome : 1 - p.pHome;
      return `<tr><td>${date}</td><td>${oppCell}</td>
        <td><span class="res proj">${us > them ? 'W' : 'L'}</span> ${us}–${them}<span class="d2">${g.d < today() ? 'Result not posted yet' : 'Predicted'}</span></td>
        <td><span class="chip ${win >= 0.65 ? 'good' : win >= 0.4 ? 'even' : 'bad'}">${whole(win)}</span></td></tr>`;
    });
  $('schedule').innerHTML = `
    <div class="card-head"><h2>Schedule</h2><p>Every game this season, with predicted scores for anything not yet played.</p></div>
    <div class="scroll"><table class="tbl sched"><thead><tr><th>Date</th><th>Opponent</th><th>Score</th><th>Win chance</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

function renderPath() {
  const key = state.selected;
  const s = status(key);
  const el = $('path');
  if (!s.qualified || !s.alive) {
    el.innerHTML = `<div class="card-head"><h2>Playoff path</h2></div><p class="empty">${esc(team(key).name)}'s season is over. Follow another team to see its path.</p>`;
    return;
  }
  const { model, sim, bracket } = state;
  const i = model.idx.get(key);
  const title = teamOdds(key).win[5];
  const rounds = pathFor(sim, bracket, i).filter((r) => {
    const x = sim.top[r.slot.id];
    const y = sim.bottom[r.slot.id];
    return !(r.reached > 0.9999 && bracket.result(x, y));
  });
  const rows = rounds.map((r) => {
    const [first, second] = r.opponents;
    const o = first.team;
    const neutral = !!r.slot.neutral;
    // The better seed hosts the first two rounds; after that every game is at a neutral site.
    const home = neutral || bracket.seedOf.get(i).seed < bracket.seedOf.get(o).seed;
    const p = home ? model.predict(i, o, neutral) : model.predict(o, i, neutral);
    const us = home ? p.hs : p.as;
    const them = home ? p.as : p.hs;
    const winIfThere = r.won / r.reached;
    const titleAfter = title / r.won;
    const oppLabel = (x) => `${esc(nameOf(keyAt(x.team)))}${bracket.seedOf.get(x.team) ? ` <span class="muted">R${bracket.seedOf.get(x.team).region} #${bracket.seedOf.get(x.team).seed}</span>` : ''}`;
    const site = neutral ? 'Neutral site' : home ? 'Home' : 'Away';
    return `<tr>
      <td><span class="d1">${ROUND_NAMES[r.slot.round]}</span><span class="d2">${[roundDate(r.slot.round), site].filter(Boolean).join(' · ')}${r.reached < 0.9999 ? ` · ${whole(r.reached)} to get here` : ''}</span></td>
      <td><strong>${oppLabel(first)}</strong> ${first.p < 0.9999 ? `<span class="muted">${whole(first.p)}</span>` : ''}${second ? `<span class="opp-alt">or ${oppLabel(second)} ${whole(second.p)}</span>` : ''}</td>
      <td><span class="res proj">${us > them ? 'W' : 'L'}</span> ${us}–${them}<span class="d2">vs ${esc(nameOf(keyAt(o)))}</span></td>
      <td><span class="chip ${winIfThere >= 0.65 ? 'good' : winIfThere >= 0.4 ? 'even' : 'bad'}">${whole(winIfThere)}</span></td>
      <td><div class="after"><strong>${pct(titleAfter)}</strong>${bar(titleAfter)}</div></td></tr>`;
  });
  el.innerHTML = `
    <div class="card-head"><h2>Playoff path</h2>
      <p>State title chance right now: <strong>${pct(title)}</strong>. Each row is the next round, the likeliest opponent, and the title chance once that round is won.</p></div>
    <div class="scroll"><table class="tbl sched path"><thead><tr><th>Round</th><th>Likely opponent</th><th>Predicted</th><th>Win chance</th><th>Title chance after a win</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

function renderWatch() {
  const key = state.selected;
  const s = status(key);
  const el = $('watch');
  if (!s.qualified || !s.alive) {
    el.hidden = true;
    return;
  }
  const { model, sim, bracket } = state;
  const i = model.idx.get(key);
  const items = rootingGuide(sim, bracket, i)
    .filter((g) => g.sides.length === 2)
    .map((g) => {
      const [a, b] = g.sides;
      const impact = Math.max(Math.abs(a.title - b.title), Math.abs(a.region - b.region) / 4);
      return { ...g, impact };
    })
    .filter((g) => g.impact >= 0.001)
    .sort((x, y) => x.slot.round - y.slot.round || y.impact - x.impact);

  if (!items.length) {
    el.innerHTML = `<div class="card-head"><h2>Games to watch</h2></div><p class="empty">No other games left that change ${esc(team(key).name)}'s path.</p>`;
    return;
  }
  const card = (g) => {
    const x = sim.top[g.slot.id];
    const y = sim.bottom[g.slot.id];
    const real = model.games.find((m) => !m.done && ((m.hi === x && m.ai === y) || (m.hi === y && m.ai === x)));
    const p = model.predict(x, y, !!g.slot.neutral);
    const side = (t) => g.sides.find((s) => s.team === t);
    const pick = side(x).title !== side(y).title ? (side(x).title > side(y).title ? x : y) : side(x).region >= side(y).region ? x : y;
    const other = pick === x ? y : x;
    const pickWin = pick === x ? p.pHome : 1 - p.pHome;
    const where = g.slot.region ? `Region ${g.slot.region}` : 'State';
    return `<article class="watch">
      <div class="watch-when"><strong>${real ? fmtDay(real.d) : ROUND_NAMES[g.slot.round]}</strong><span>${real ? esc(real.t) : ''}</span><span class="tag">${where}</span></div>
      <div class="watch-body">
        <div class="watch-match">${teamLink(keyAt(y))}<span class="where">${g.slot.neutral ? 'vs' : 'at'}</span>${teamLink(keyAt(x))}</div>
        <div class="cheer">📣 Root for <strong>${esc(nameOf(keyAt(pick)))}</strong></div>
        <p class="sub root">Your title chance: <strong>${pct(side(pick).title)}</strong> if ${esc(nameOf(keyAt(pick)))} wins, <strong>${pct(side(other).title)}</strong> if ${esc(nameOf(keyAt(other)))} wins.
          ${s.seed.region === g.slot.region ? `Region title: ${pct(side(pick).region)} vs ${pct(side(other).region)}.` : ''}</p>
      </div>
      <div class="watch-pred">
        <div class="score">${esc(nameOf(keyAt(y)))} ${p.as} – ${p.hs} ${esc(nameOf(keyAt(x)))}</div>
        <div class="sub">${ROUND_NAMES[g.slot.round]} · ${real && real.d < today() ? 'result not posted yet' : 'predicted'}</div>
        <span class="chip ${pickWin >= 0.55 ? 'good' : pickWin >= 0.45 ? 'even' : 'bad'}">${esc(nameOf(keyAt(pick)))} ${whole(pickWin)}</span>
      </div></article>`;
  };
  const soon = items.slice(0, 6);
  const later = items.slice(6);
  el.innerHTML = `
    <div class="card-head"><h2>Games to watch</h2>
      <p>The playoff field is set, so these games decide who ${esc(team(key).name)} might face next. Root for the result that leaves the easier road.</p></div>
    ${soon.map(card).join('')}
    ${later.length ? `<details class="more"><summary>${later.length} more games with a smaller effect</summary>${later.map(card).join('')}</details>` : ''}`;
}

// ---------- bracket ----------
/** The single most likely bracket: real results where played, the favorite everywhere else. */
function projectBracket() {
  const { model, bracket } = state;
  const out = new Map();
  for (const s of bracket.slots) {
    const x = s.top.team ?? out.get(s.top.from).winner;
    const y = s.bottom.team ?? out.get(s.bottom.from).winner;
    const real = bracket.result(x, y);
    let entry;
    if (real) {
      entry = { x, y, xs: real.scores.get(x), ys: real.scores.get(y), winner: real.winner, real: true, ot: real.ot, forfeit: real.forfeit };
    } else {
      const p = model.predict(x, y, !!s.neutral);
      entry = { x, y, xs: p.hs, ys: p.as, winner: p.pHome >= 0.5 ? x : y, prob: Math.max(p.pHome, 1 - p.pHome) };
    }
    out.set(s.id, entry);
  }
  return out;
}

function renderBracket() {
  const { bracket, model, proj } = state;
  const mine = state.selected ? model.idx.get(state.selected) : -1;
  const myRegion = bracket.seedOf.get(mine)?.region;
  const tabs = [...bracket.regions.map((r) => ({ id: String(r), label: `Region ${r}` })), { id: 'state', label: 'State' }];
  const tab = state.tab || String(myRegion || bracket.regions[0]);

  const slotHTML = (t, score, win) => {
    const seed = bracket.seedOf.get(t);
    return `<button type="button" class="slot ${win ? 'win' : ''} ${t === mine ? 'mine' : ''}" data-team="${esc(keyAt(t))}">
      <span class="seed">${seed.seed}</span>${badge(keyAt(t))}<span class="tname">${esc(nameOf(keyAt(t)))}${tab === 'state' ? ` <span class="muted">R${seed.region}</span>` : ''}</span><span class="pts">${score ?? ''}</span></button>`;
  };
  const match = (s) => {
    const e = proj.get(s.id);
    const meta = e.real ? `Final${e.ot ? ' (OT)' : ''}${e.forfeit ? ' · forfeit' : ''}` : `${esc(nameOf(keyAt(e.winner)))} wins ${whole(e.prob)} · predicted`;
    return `<div class="match">${slotHTML(e.x, e.forfeit ? '' : e.xs, e.winner === e.x)}${slotHTML(e.y, e.forfeit ? '' : e.ys, e.winner === e.y)}<div class="match-meta">${meta}</div></div>`;
  };
  const round = (title, sub, slots) => {
    const date = roundDate(slots[0]?.round);
    return `<div class="round"><div class="round-h">${title}<span>${[date, sub].filter(Boolean).join(' · ')}</span></div><div class="round-g">${slots.map(match).join('')}</div></div>`;
  };

  let body;
  if (tab === 'state') {
    const semis = bracket.slots.filter((s) => s.round === 4);
    const final = bracket.slots.filter((s) => s.round === 5);
    const champs = bracket.slots.filter((s) => s.round === 3);
    body = `<div class="scroll"><div class="bracket state">
      ${round('Regional finals', 'Neutral sites', champs)}
      ${round('State semifinals', 'Neutral sites', semis)}
      ${round('State championship', 'Canton', final)}
    </div></div>`;
  } else {
    const r = Number(tab);
    const of = (round) => bracket.slots.filter((s) => s.region === r && s.round === round);
    // Order the first round to line up with the quarterfinal it feeds.
    const quarters = of(1);
    const firsts = quarters.map((q) => bracket.slots[q.bottom.from]);
    body = `<div class="scroll"><div class="bracket">
      ${round('First round', 'Top 4 had byes', firsts)}
      ${round('Regional quarterfinals', 'Higher seed hosts', quarters)}
      ${round('Regional semifinals', 'Neutral sites', of(2))}
      ${round('Regional final', 'Neutral site', of(3))}
    </div></div>
    ${regionTable(r)}`;
  }
  const champ = proj.get(bracket.final).winner;
  const champOdds = state.odds.get(champ).win[5];
  $('bracket').innerHTML = `
    <div class="card-head"><h2>Division III bracket</h2>
      <p>Real results where games are final; everywhere else the favorite advances. Seeds are the final unofficial Harbin rankings.</p></div>
    <div class="champ">${badge(keyAt(champ), 'hero-badge champ-badge')}
      <div><span class="sub">Projected state champion</span><strong>${esc(nameOf(keyAt(champ)))}</strong><span class="sub">${pct(champOdds)} title chance</span></div></div>
    <div class="tabs">${tabs.map((t) => `<button type="button" class="tab ${t.id === tab ? 'on' : ''}" data-btab="${t.id}">${t.label}</button>`).join('')}</div>
    ${body}`;
}

function regionTable(r) {
  const { bracket, odds } = state;
  const field = bracket.seeds.get(r);
  return `<div class="region-odds scroll"><table class="tbl stats">
    <thead><tr><th>Seed</th><th>Team</th><th class="num">Rec</th><th class="num">Reach semis</th><th class="num">Win region</th><th class="num">State title</th></tr></thead>
    <tbody>${field
      .map((t, k) => {
        const o = odds.get(t);
        return `<tr class="${keyAt(t) === state.selected ? 'mine' : ''}"><td class="num">${k + 1}</td><td>${teamLink(keyAt(t))}</td><td class="num">${record(keyAt(t))}</td>
          <td class="num">${pct(o.win[1])}</td><td class="num">${pct(o.win[3])}</td><td class="num">${pct(o.win[5])}</td></tr>`;
      })
      .join('')}</tbody></table></div>`;
}

// ---------- side panels ----------
function d3ByRating() {
  const { model } = state;
  return state.data.teams
    .filter((t) => t.div === DIVISION)
    .map((t) => t.id)
    .sort((a, b) => model.rating[model.idx.get(b)] - model.rating[model.idx.get(a)]);
}

function renderRankings() {
  const { bracket, model } = state;
  const rows = d3ByRating()
    .slice(0, 25)
    .map((key, k) => {
      const i = model.idx.get(key);
      const seed = bracket.seedOf.get(i);
      const o = state.odds.get(i);
      return `<tr class="${key === state.selected ? 'mine' : ''}"><td class="num">${k + 1}</td>
        <td><button type="button" class="team" data-team="${esc(key)}">${badge(key)}<span class="tname">${esc(team(key).name)}</span></button></td>
        <td class="num">${record(key)}</td><td class="num">${seed ? `R${seed.region}·${seed.seed}` : '<span class="muted">out</span>'}</td>
        <td class="num">${o ? whole(o.win[5]) : '–'}</td></tr>`;
    });
  $('rankings').innerHTML = `
    <div class="card-head"><h2>D-III power rankings</h2><p>By the model's rating of how good each team is, not by record</p></div>
    <table class="tbl rank poll"><colgroup><col class="c-rank" /><col /><col class="c-rec" /><col class="c-seed" /><col class="c-odds" /></colgroup>
    <thead><tr><th></th><th>Team</th><th class="num">Rec</th><th class="num">Seed</th><th class="num" title="Chance to win the state title">Title</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}

function renderOdds() {
  const top = [...state.odds].sort((a, b) => b[1].win[5] - a[1].win[5]).slice(0, 10);
  $('odds').innerHTML = `
    <div class="card-head"><h2>State title favorites</h2><p>Chance to win the Division III championship</p></div>
    <table class="tbl rank"><tbody>${top
      .map(([t, o]) => `<tr class="${keyAt(t) === state.selected ? 'mine' : ''}"><td>${teamLink(keyAt(t))}</td><td class="num">${pct(o.win[5])}</td></tr>`)
      .join('')}</tbody></table>`;
}

function renderFoot() {
  const updated = new Date(state.data.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  $('foot').innerHTML = `
    <p><strong>How the numbers work.</strong> Each of Ohio's ~700 teams gets an offense and defense rating from every score this season, adjusted for opponent and home field and starting from last season's rating.
    Those ratings predict each playoff game, and the rest of the Division III bracket is played out ${SIMS.toLocaleString()} times. The top four seeds have first-round byes, higher seeds host the first two rounds,
    and the state semifinals are assumed to pair Regions 9/10 and 11/12. These are estimates for fun.</p>
    <p>Scores and unofficial Harbin points from <a href="https://joeeitel.com/hsfoot/">Joe Eitel</a>; official results come from the <a href="https://www.ohsaa.org/sports/football">OHSAA</a>.
    Player stats aren't published anywhere open, so they're not included. Data updated ${esc(updated)}.</p>`;
}

// ---------- picker ----------
function openPicker() {
  $('picker-search').value = '';
  renderPicker('');
  $('picker').showModal();
}

function renderPicker(query) {
  const q = query.trim().toLowerCase();
  const html = state.bracket.regions
    .map((r) => {
      const teams = state.data.teams
        .filter((t) => t.region === r && (!q || `${t.name} ${t.city}`.toLowerCase().includes(q)))
        .sort((a, b) => a.rank - b.rank);
      if (!teams.length) return '';
      return `<h3>Region ${r}</h3><div class="pick-grid">${teams
        .map((t) => `<button type="button" class="pick ${state.favorites.includes(t.id) ? 'on' : ''}" data-pick="${esc(t.id)}">${badge(t.id)}<span>${esc(t.name)}<span class="opp-alt">${esc(t.city)} · #${t.rank}</span></span></button>`)
        .join('')}</div>`;
    })
    .join('');
  $('picker-list').innerHTML = html || '<p class="empty">No Division III schools match that search.</p>';
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-team],[data-action],[data-btab],[data-pick]');
  if (!el) return;
  if (el.dataset.pick) {
    const key = el.dataset.pick;
    toggleFavorite(key);
    renderPicker($('picker-search').value);
    if (state.favorites.includes(key)) select(key);
    else renderFavs(), renderHero();
  } else if (el.dataset.team) {
    select(el.dataset.team);
  } else if (el.dataset.btab) {
    state.tab = el.dataset.btab;
    renderBracket();
  } else if (el.dataset.action === 'pick') {
    openPicker();
  } else if (el.dataset.action === 'follow') {
    toggleFavorite(state.selected);
    renderFavs();
    renderHero();
  }
});
$('add-team').addEventListener('click', openPicker);
$('picker-search').addEventListener('input', (e) => renderPicker(e.target.value));

boot();
