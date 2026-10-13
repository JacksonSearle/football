// Prediction model: opponent-adjusted team ratings from this season's scores,
// a game predictor built on them, and a Monte Carlo simulation of the rest of
// the season through the 12-team playoff.

const HFA = 2.5; // home-field advantage, points
const GAME_SD = 15.5; // std dev of final margin around the predicted margin
const RATING_SD = 3.5; // how unsure we are about each team's true strength
const RIDGE = 1.5; // phantom "average" games that pull thin samples toward the mean
const MARGIN_CAP = 28; // margin beyond this counts for much less
const RATING_WEIGHT = 0.05; // committee score: résumé wins per rating point
const CCG_LOSS_WEIGHT = 0.5; // committee goes easy on conference title game losers

const POWER4 = new Set(['1', '4', '5', '8']); // ACC, Big 12, Big Ten, SEC
const INDEPENDENTS = '18';
const NOTRE_DAME = '87';
const FIELD = 12;

// Logistic stand-in for the normal CDF; plenty accurate for win odds.
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

function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

/**
 * Build the model from the team list and the season's games.
 * All non-FBS opponents share a single rating slot (index n).
 */
export function buildModel({ teams, confs }, season) {
  const n = teams.length;
  const FCS = n;
  const idx = new Map(teams.map((t, i) => [t.id, i]));
  const ix = (id) => (idx.has(id) ? idx.get(id) : FCS);

  const games = season.games
    .filter((g) => !g.off && !/championship/i.test(g.note))
    .map((g) => ({ ...g, h: ix(g.home.id), a: ix(g.away.id) }))
    .filter((g) => g.h !== FCS || g.a !== FCS);

  const played = games.filter((g) => g.done);
  const remaining = games.filter((g) => !g.done);

  // --- Offense / defense ratings (ridge-regularised, alternating least squares) ---
  const off = new Float64Array(n + 1);
  const def = new Float64Array(n + 1);
  let mu = 27;
  if (played.length) {
    const obs = played.map((g) => {
      // Compress blowouts so running up the score on a cupcake isn't rewarded much.
      const m = g.hs - g.as;
      const capped = Math.sign(m) * Math.min(Math.abs(m), MARGIN_CAP + (Math.abs(m) - MARGIN_CAP) * 0.25);
      const total = g.hs + g.as;
      return { h: g.h, a: g.a, hp: (total + capped) / 2, ap: (total - capped) / 2, hfa: g.neutral ? 0 : HFA / 2 };
    });
    mu = obs.reduce((s, o) => s + o.hp + o.ap, 0) / (2 * obs.length);
    const count = new Float64Array(n + 1);
    for (const o of obs) (count[o.h]++, count[o.a]++);
    for (let iter = 0; iter < 60; iter++) {
      const so = new Float64Array(n + 1);
      const sd = new Float64Array(n + 1);
      for (const o of obs) {
        so[o.h] += o.hp - mu + def[o.a] - o.hfa;
        so[o.a] += o.ap - mu + def[o.h] + o.hfa;
        sd[o.h] += mu + off[o.a] - o.hfa - o.ap;
        sd[o.a] += mu + off[o.h] + o.hfa - o.hp;
      }
      for (let i = 0; i <= n; i++) {
        off[i] = so[i] / (count[i] + RIDGE);
        def[i] = sd[i] / (count[i] + RIDGE);
      }
    }
  }
  const rating = Float64Array.from(off, (o, i) => o + def[i]);

  /** Predict a game between team indexes. site: 1 = h at home, 0 = neutral. */
  function predict(h, a, neutral = false) {
    const edge = neutral ? 0 : HFA;
    const margin = rating[h] - rating[a] + edge;
    let hs = Math.max(3, Math.round(mu + off[h] - def[a] + edge / 2));
    let as = Math.max(3, Math.round(mu + off[a] - def[h] - edge / 2));
    if (hs === as) margin >= 0 ? hs++ : as++;
    return { margin, pHome: winProb(margin), hs, as };
  }

  // --- Résumé scoring ("strength of record") ---
  // Each game is worth how surprising the result would be for a bubble-quality
  // playoff team: beating a good team on the road earns a lot, beating a bad
  // team at home earns almost nothing, and losing to one costs nearly a full win.
  const sorted = Array.from(rating.slice(0, n)).sort((x, y) => y - x);
  const bench = sorted[Math.min(FIELD - 1, n - 1)] ?? 0;
  const benchWin = (opp, site) => winProb(bench - rating[opp] + site * HFA);

  const confOf = teams.map((t) => t.conf);
  const confIds = confs.map((c) => c.id).filter((c) => c !== INDEPENDENTS);
  const confIndex = new Map(confIds.map((c, i) => [c, i]));
  const teamConf = Int16Array.from(confOf, (c) => (confIndex.has(c) ? confIndex.get(c) : -1));
  const isP4 = confIds.map((c) => POWER4.has(c));
  const nd = idx.has(NOTRE_DAME) ? idx.get(NOTRE_DAME) : -1;

  const base = {
    resume: new Float64Array(n),
    wins: new Int16Array(n),
    losses: new Int16Array(n),
    cw: new Int16Array(n),
    cl: new Int16Array(n),
  };
  function credit(s, winner, loser, homeIsWinner, neutral, conf) {
    const ws = neutral ? 0 : homeIsWinner ? 1 : -1;
    if (winner < n) {
      s.resume[winner] += 1 - benchWin(loser, ws);
      s.wins[winner]++;
      if (conf) s.cw[winner]++;
    }
    if (loser < n) {
      s.resume[loser] -= benchWin(winner, -ws);
      s.losses[loser]++;
      if (conf) s.cl[loser]++;
    }
  }
  for (const g of played) {
    const homeWon = g.hs > g.as;
    credit(base, homeWon ? g.h : g.a, homeWon ? g.a : g.h, homeWon, g.neutral, g.conf);
  }

  // Flat arrays for the hot loop.
  const R = remaining.length;
  const rh = Int16Array.from(remaining, (g) => g.h);
  const ra = Int16Array.from(remaining, (g) => g.a);
  const rEdge = Float64Array.from(remaining, (g) => (g.neutral ? 0 : HFA));
  const rConf = Uint8Array.from(remaining, (g) => (g.conf ? 1 : 0));
  const remIndex = new Map(remaining.map((g, i) => [g.id, i]));

  /**
   * Simulate the rest of the season `sims` times.
   * `forced` maps remaining-game index -> 1 (home wins) or 0 (away wins).
   */
  function simulate({ sims = 10000, seed = 1, forced = null } = {}) {
    const rand = mulberry32(seed);
    const out = {
      sims,
      playoff: new Float64Array(n),
      bye: new Float64Array(n),
      confTitle: new Float64Array(n),
      quarter: new Float64Array(n),
      semi: new Float64Array(n),
      final: new Float64Array(n),
      title: new Float64Array(n),
      seedSum: new Float64Array(n),
      scoreSum: new Float64Array(n),
      winSum: new Float64Array(n),
    };
    const force = new Int8Array(R).fill(-1);
    if (forced) for (const [i, v] of forced) force[i] = v;

    const shift = new Float64Array(n + 1);
    const s = {
      resume: new Float64Array(n),
      wins: new Int16Array(n),
      losses: new Int16Array(n),
      cw: new Int16Array(n),
      cl: new Int16Array(n),
    };
    const score = new Float64Array(n);
    const order = new Int16Array(n);
    const champ = new Int16Array(confIds.length);
    const best = new Int16Array(confIds.length);
    const second = new Int16Array(confIds.length);
    const inField = new Uint8Array(n);
    const strength = (t) => rating[t] + shift[t];
    const beats = (x, y, edge) => rand() < winProb(strength(x) - strength(y) + edge);

    for (let it = 0; it < sims; it++) {
      for (let i = 0; i < n; i++) shift[i] = gaussian(rand) * RATING_SD;
      s.resume.set(base.resume);
      s.wins.set(base.wins);
      s.losses.set(base.losses);
      s.cw.set(base.cw);
      s.cl.set(base.cl);

      for (let i = 0; i < R; i++) {
        const h = rh[i];
        const a = ra[i];
        // Always draw, so forcing a result doesn't desync the random stream.
        let homeWon = beats(h, a, rEdge[i]);
        if (force[i] >= 0) homeWon = force[i] === 1;
        credit(s, homeWon ? h : a, homeWon ? a : h, homeWon, rEdge[i] === 0, rConf[i] === 1);
      }
      for (let i = 0; i < n; i++) out.winSum[i] += s.wins[i];

      // Conference title games: top two by conference record, power rating as tiebreak.
      best.fill(-1);
      second.fill(-1);
      const standing = (t) => (s.cw[t] - s.cl[t]) * 100 + strength(t) + rand();
      for (let i = 0; i < n; i++) {
        const c = teamConf[i];
        if (c < 0) continue;
        score[i] = standing(i);
        if (best[c] < 0 || score[i] > score[best[c]]) {
          second[c] = best[c];
          best[c] = i;
        } else if (second[c] < 0 || score[i] > score[second[c]]) {
          second[c] = i;
        }
      }
      for (let c = 0; c < confIds.length; c++) {
        const x = best[c];
        const y = second[c];
        if (x < 0) continue;
        if (y < 0) {
          champ[c] = x;
        } else {
          const xWon = beats(x, y, 0);
          const w = xWon ? x : y;
          const l = xWon ? y : x;
          champ[c] = w;
          s.resume[w] += 1 - benchWin(l, 0);
          s.resume[l] -= benchWin(w, 0) * CCG_LOSS_WEIGHT;
          s.wins[w]++;
          s.losses[l]++;
        }
        out.confTitle[champ[c]]++;
      }

      // Committee ranking.
      for (let i = 0; i < n; i++) {
        score[i] = s.resume[i] + RATING_WEIGHT * rating[i] + gaussian(rand) * 0.25;
        out.scoreSum[i] += score[i];
        order[i] = i;
      }
      order.sort((x, y) => score[y] - score[x]);

      const field = selectField(order, score, champ, inField);
      for (let k = 0; k < field.length; k++) {
        const t = field[k];
        out.playoff[t]++;
        out.seedSum[t] += k + 1;
        if (k < 4) out.bye[t]++;
      }

      // Bracket. First round is on the better seed's campus, the rest are neutral.
      const r1 = (hi, lo) => (beats(field[hi], field[lo], HFA) ? field[hi] : field[lo]);
      const q = [
        [field[0], r1(7, 8)],
        [field[3], r1(4, 11)],
        [field[1], r1(6, 9)],
        [field[2], r1(5, 10)],
      ];
      const semis = q.map(([x, y]) => {
        out.quarter[x]++;
        out.quarter[y]++;
        return beats(x, y, 0) ? x : y;
      });
      semis.forEach((t) => out.semi[t]++);
      const f1 = beats(semis[0], semis[1], 0) ? semis[0] : semis[1];
      const f2 = beats(semis[2], semis[3], 0) ? semis[2] : semis[3];
      out.final[f1]++;
      out.final[f2]++;
      out.title[beats(f1, f2, 0) ? f1 : f2]++;
    }
    return out;
  }

  /**
   * 12-team field in seed order: the four power-conference champions, the best
   * other conference champion, Notre Dame if it is ranked in the top 12, then
   * the best remaining teams. Seeding follows the committee ranking straight down.
   */
  function selectField(order, score, champ, inField) {
    inField.fill(0);
    let count = 0;
    let bestOther = -1;
    for (let c = 0; c < champ.length; c++) {
      const t = champ[c];
      if (t < 0) continue;
      if (isP4[c]) {
        inField[t] = 1;
        count++;
      } else if (bestOther < 0 || score[t] > score[bestOther]) {
        bestOther = t;
      }
    }
    if (bestOther >= 0) {
      inField[bestOther] = 1;
      count++;
    }
    if (nd >= 0 && !inField[nd]) {
      for (let k = 0; k < FIELD; k++) {
        if (order[k] === nd) {
          inField[nd] = 1;
          count++;
          break;
        }
      }
    }
    for (let k = 0; k < order.length && count < FIELD; k++) {
      if (!inField[order[k]]) {
        inField[order[k]] = 1;
        count++;
      }
    }
    const field = [];
    for (let k = 0; k < order.length && field.length < FIELD; k++) if (inField[order[k]]) field.push(order[k]);
    return field;
  }

  /** The single most likely bracket: expected committee order, favourites advance. */
  function projectBracket(sim) {
    const score = Float64Array.from(sim.scoreSum, (v) => v / sim.sims);
    const order = Int16Array.from({ length: n }, (_, i) => i).sort((x, y) => score[y] - score[x]);
    const champ = new Int16Array(confIds.length).fill(-1);
    for (let i = 0; i < n; i++) {
      const c = teamConf[i];
      if (c >= 0 && (champ[c] < 0 || sim.confTitle[i] > sim.confTitle[champ[c]])) champ[c] = i;
    }
    const field = selectField(order, score, champ, new Uint8Array(n));
    const seedOf = new Map(field.map((t, k) => [t, k + 1]));
    const autoBid = new Set(Array.from(champ).filter((t) => t >= 0 && seedOf.has(t)));
    const play = (x, y, neutral) => {
      // x is the better seed and hosts when the game isn't at a neutral site.
      const p = predict(x, y, neutral);
      const xWins = p.pHome >= 0.5;
      return {
        top: { team: x, seed: seedOf.get(x), score: p.hs, win: xWins },
        bottom: { team: y, seed: seedOf.get(y), score: p.as, win: !xWins },
        prob: xWins ? p.pHome : 1 - p.pHome,
        winner: xWins ? x : y,
      };
    };
    const better = (x, y) => (seedOf.get(x) < seedOf.get(y) ? [x, y] : [y, x]);
    const first = [play(field[7], field[8]), play(field[4], field[11]), play(field[6], field[9]), play(field[5], field[10])];
    const byes = [field[0], field[3], field[1], field[2]];
    const quarters = first.map((g, i) => play(byes[i], g.winner, true));
    const semis = [0, 2].map((i) => play(...better(quarters[i].winner, quarters[i + 1].winner), true));
    const final = play(...better(semis[0].winner, semis[1].winner), true);
    return { field, autoBid, first, quarters, semis, final, champion: final.winner };
  }

  /** Current committee-style ranking from games already played. */
  function currentOrder() {
    return Array.from({ length: n }, (_, i) => i).sort(
      (x, y) => base.resume[y] + RATING_WEIGHT * rating[y] - (base.resume[x] + RATING_WEIGHT * rating[x]),
    );
  }

  return {
    n,
    FCS,
    teams,
    idx,
    ix,
    games,
    played,
    remaining,
    remIndex,
    rating,
    off,
    def,
    mu,
    base,
    predict,
    simulate,
    projectBracket,
    currentOrder,
  };
}
