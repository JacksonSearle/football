// Ohio high school model: opponent-adjusted ratings from every Ohio game this
// season, then a Monte Carlo run of the remaining playoff bracket for one division.

const HFA = 3; // home-field advantage, points
const GAME_SD = 18.5; // std dev of final margin around the prediction (back-tested)
const RATING_SD = 4; // uncertainty in each team's true strength
const RIDGE = 1.5; // phantom games pulling thin samples toward the prior
const PRIOR_GAMES = 3; // how many games last season's rating is worth
const CARRYOVER = 0.8; // share of last season's rating that carries over
const MARGIN_CAP = 28; // Ohio's running clock kicks in at 30, so blowouts say little
const PLAYOFF_TEAMS = 12;

// Which regions meet in the state semifinals. The OHSAA has paired 9/10 and
// 11/12 in Division III; confirm against the official bracket each year.
export const STATE_SEMIS = { 3: [[9, 10], [11, 12]] };

const winProb = (margin) => 1 / (1 + Math.exp((-1.702 * margin) / GAME_SD));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussian = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

export const ROUND_NAMES = ['First round', 'Regional quarterfinal', 'Regional semifinal', 'Regional final', 'State semifinal', 'State championship'];

/**
 * prior: last season's model, used as each team's starting point.
 * asOfWeek: ignore results after this week (for back-testing).
 */
export function buildModel(data, { prior = null, asOfWeek = Infinity } = {}) {
  const keys = [...data.teams.map((t) => t.id), ...Object.keys(data.others)];
  const idx = new Map(keys.map((k, i) => [k, i]));
  const N = keys.length;
  const teamById = new Map(data.teams.map((t) => [t.id, t]));
  const nameOf = (k) => teamById.get(k)?.name || data.others[k] || 'TBD';

  const games = data.games.map((g) => ({
    ...g,
    hi: idx.get(g.h),
    ai: idx.get(g.a),
    done: g.w <= asOfWeek && (g.as != null || !!g.forfeit),
    scored: g.w <= asOfWeek && g.as != null,
  }));

  // --- ratings ---
  const off = new Float64Array(N);
  const def = new Float64Array(N);
  const obs = games
    .filter((g) => g.scored)
    .map((g) => {
      const m = g.hs - g.as;
      const capped = Math.sign(m) * Math.min(Math.abs(m), MARGIN_CAP + (Math.abs(m) - MARGIN_CAP) * 0.25);
      const total = g.hs + g.as;
      return { h: g.hi, a: g.ai, hp: (total + capped) / 2, ap: (total - capped) / 2, e: g.n ? 0 : HFA / 2 };
    });
  const mu = obs.reduce((s, o) => s + o.hp + o.ap, 0) / (2 * obs.length || 1);
  const count = new Float64Array(N);
  for (const o of obs) (count[o.h]++, count[o.a]++);
  const pOff = new Float64Array(N);
  const pDef = new Float64Array(N);
  const pW = Float64Array.from(keys, () => RIDGE);
  if (prior) {
    keys.forEach((k, i) => {
      const j = prior.idx.get(k);
      if (j === undefined || !prior.teamById.has(k)) return;
      pOff[i] = prior.off[j] * CARRYOVER;
      pDef[i] = prior.def[j] * CARRYOVER;
      pW[i] = PRIOR_GAMES;
    });
  }
  for (let iter = 0; iter < 80; iter++) {
    const so = new Float64Array(N);
    const sd = new Float64Array(N);
    for (const o of obs) {
      so[o.h] += o.hp - mu + def[o.a] - o.e;
      so[o.a] += o.ap - mu + def[o.h] + o.e;
      sd[o.h] += mu + off[o.a] - o.e - o.ap;
      sd[o.a] += mu + off[o.h] + o.e - o.hp;
    }
    for (let i = 0; i < N; i++) {
      off[i] = (so[i] + pW[i] * pOff[i]) / (count[i] + pW[i]);
      def[i] = (sd[i] + pW[i] * pDef[i]) / (count[i] + pW[i]);
    }
  }
  const rating = Float64Array.from(off, (o, i) => o + def[i]);

  /** Predicted result with team h at home (or the "top" team at a neutral site). */
  function predict(h, a, neutral) {
    const edge = neutral ? 0 : HFA;
    const margin = rating[h] - rating[a] + edge;
    let hs = Math.max(0, Math.round(mu + off[h] - def[a] + edge / 2));
    let as = Math.max(0, Math.round(mu + off[a] - def[h] - edge / 2));
    if (hs === as) margin >= 0 ? hs++ : as++;
    return { pHome: winProb(margin), hs, as };
  }

  /** One division's playoff bracket as a list of slots, each fed by seeds or earlier slots. */
  function bracketFor(div) {
    const regions = [1, 2, 3, 4].map((k) => (div - 1) * 4 + k);
    const seeds = new Map(); // region -> [team index by seed - 1]
    for (const r of regions) {
      const field = data.teams
        .filter((t) => t.region === r)
        .sort((x, y) => x.rank - y.rank)
        .slice(0, PLAYOFF_TEAMS)
        .map((t) => idx.get(t.id));
      seeds.set(r, field);
    }
    const seedOf = new Map();
    for (const [r, field] of seeds) field.forEach((t, k) => seedOf.set(t, { region: r, seed: k + 1 }));

    const slots = [];
    const add = (s) => (slots.push({ ...s, id: slots.length }), slots.length - 1);
    const regionFinal = new Map();
    for (const r of regions) {
      const S = (seed) => ({ team: seeds.get(r)[seed - 1] });
      const F = (slot) => ({ from: slot });
      const r1 = [[5, 12], [6, 11], [7, 10], [8, 9]].map(([x, y]) => add({ round: 0, region: r, top: S(x), bottom: S(y) }));
      // Byes: 1 meets the 8/9 winner, 4 the 5/12 winner, 2 the 7/10 winner, 3 the 6/11 winner.
      const q = [
        add({ round: 1, region: r, top: S(1), bottom: F(r1[3]) }),
        add({ round: 1, region: r, top: S(4), bottom: F(r1[0]) }),
        add({ round: 1, region: r, top: S(2), bottom: F(r1[2]) }),
        add({ round: 1, region: r, top: S(3), bottom: F(r1[1]) }),
      ];
      const sf = [add({ round: 2, region: r, top: F(q[0]), bottom: F(q[1]), neutral: true }), add({ round: 2, region: r, top: F(q[2]), bottom: F(q[3]), neutral: true })];
      regionFinal.set(r, add({ round: 3, region: r, top: F(sf[0]), bottom: F(sf[1]), neutral: true }));
    }
    const pairs = STATE_SEMIS[div] || [[regions[0], regions[1]], [regions[2], regions[3]]];
    const semis = pairs.map(([x, y]) => add({ round: 4, top: { from: regionFinal.get(x) }, bottom: { from: regionFinal.get(y) }, neutral: true }));
    add({ round: 5, top: { from: semis[0] }, bottom: { from: semis[1] }, neutral: true });

    // Attach real results. A game between two teams in week 11+ is that playoff game.
    const playoffGames = games.filter((g) => g.w >= 11 && g.done);
    const result = (x, y) => {
      const g = playoffGames.find((g) => (g.hi === x && g.ai === y) || (g.hi === y && g.ai === x));
      if (!g) return null;
      const homeWon = g.forfeit ? g.forfeit === 'h' : g.hs > g.as;
      const scores = new Map([[g.hi, g.hs], [g.ai, g.as]]);
      return { winner: homeWon ? g.hi : g.ai, scores, ot: !!g.ot, forfeit: !!g.forfeit };
    };
    return { div, regions, seeds, seedOf, slots, result, final: slots.length - 1 };
  }

  /** Simulate the bracket. Keeps every slot's participants so any question can be asked afterwards. */
  function simulate(bracket, { sims = 20000, seed = 11 } = {}) {
    const rand = mulberry32(seed);
    const S = bracket.slots.length;
    const top = new Int32Array(sims * S);
    const bottom = new Int32Array(sims * S);
    const winner = new Int32Array(sims * S);
    const shift = new Map();
    const teams = [...bracket.seedOf.keys()];
    const fixed = new Map(); // memoise real results by slot participants
    for (let it = 0; it < sims; it++) {
      for (const t of teams) shift.set(t, gaussian(rand) * RATING_SD);
      const base = it * S;
      for (const s of bracket.slots) {
        const x = s.top.team ?? winner[base + s.top.from];
        const y = s.bottom.team ?? winner[base + s.bottom.from];
        top[base + s.id] = x;
        bottom[base + s.id] = y;
        const key = `${x}-${y}`;
        if (!fixed.has(key)) fixed.set(key, bracket.result(x, y));
        const real = fixed.get(key);
        const p = winProb(rating[x] + shift.get(x) - rating[y] - shift.get(y) + (s.neutral ? 0 : HFA));
        const draw = rand();
        winner[base + s.id] = real ? real.winner : draw < p ? x : y;
      }
    }
    return { sims, S, top, bottom, winner };
  }

  return { data, keys, idx, N, nameOf, teamById, games, rating, off, def, mu, predict, bracketFor, simulate };
}

// ---------- questions to ask a finished simulation ----------

/** For each team: share of sims in which it plays in, and wins, each round. */
export function roundOdds(sim, bracket) {
  const out = new Map();
  const get = (t) => {
    if (!out.has(t)) out.set(t, { play: new Float64Array(6), win: new Float64Array(6) });
    return out.get(t);
  };
  for (let it = 0; it < sim.sims; it++) {
    const base = it * sim.S;
    for (const s of bracket.slots) {
      const x = sim.top[base + s.id];
      const y = sim.bottom[base + s.id];
      get(x).play[s.round]++;
      get(y).play[s.round]++;
      get(sim.winner[base + s.id]).win[s.round]++;
    }
  }
  for (const v of out.values()) for (const a of [v.play, v.win]) for (let k = 0; k < 6; k++) a[k] /= sim.sims;
  return out;
}

/** Opponent distribution for `team` in the slot it would play in each round. */
export function pathFor(sim, bracket, team) {
  const rounds = [];
  for (const s of bracket.slots) {
    let reached = 0;
    let won = 0;
    const opp = new Map();
    for (let it = 0; it < sim.sims; it++) {
      const base = it * sim.S;
      const x = sim.top[base + s.id];
      const y = sim.bottom[base + s.id];
      if (x !== team && y !== team) continue;
      reached++;
      const o = x === team ? y : x;
      opp.set(o, (opp.get(o) || 0) + 1);
      if (sim.winner[base + s.id] === team) won++;
    }
    if (reached) rounds.push({ slot: s, reached: reached / sim.sims, won: won / sim.sims, opponents: [...opp].map(([t, c]) => ({ team: t, p: c / reached })).sort((a, b) => b.p - a.p) });
  }
  return rounds.sort((a, b) => a.slot.round - b.slot.round);
}

/**
 * How much each undecided game elsewhere in the bracket matters to `team`:
 * its title (and regional title) odds when each side wins.
 */
export function rootingGuide(sim, bracket, team) {
  const finalSlot = bracket.final;
  const regionFinal = bracket.slots.find((s) => s.round === 3 && bracket.seedOf.get(team)?.region === s.region);
  const out = [];
  for (const s of bracket.slots) {
    const tally = new Map(); // winner -> [count, titles, regionTitles]
    let involved = false;
    let total = 0;
    let pair = null;
    for (let it = 0; it < sim.sims; it++) {
      const base = it * sim.S;
      const x = sim.top[base + s.id];
      const y = sim.bottom[base + s.id];
      if (x === team || y === team) {
        involved = true;
        break;
      }
      if (pair === null) pair = `${x}-${y}`;
      else if (pair !== `${x}-${y}`) {
        involved = true; // matchup not set yet; only report games whose teams are known
        break;
      }
      const w = sim.winner[base + s.id];
      const row = tally.get(w) || [0, 0, 0];
      row[0]++;
      if (sim.winner[base + finalSlot] === team) row[1]++;
      if (regionFinal && sim.winner[base + regionFinal.id] === team) row[2]++;
      tally.set(w, row);
      total++;
    }
    if (involved || tally.size < 2) continue; // decided, or a game the team itself might be in
    const sides = [...tally].map(([t, [c, titles, reg]]) => ({ team: t, p: c / total, title: titles / c, region: reg / c })).sort((a, b) => b.p - a.p);
    out.push({ slot: s, sides });
  }
  return out;
}
