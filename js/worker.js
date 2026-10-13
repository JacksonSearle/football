// Runs the season simulations off the main thread so the page stays responsive.
import { buildModel } from './model.js';

let model = null;

const handlers = {
  init({ teamData, season }) {
    model = buildModel(teamData, season);
    return true;
  },
  simulate(opts) {
    return model.simulate(opts);
  },
  // Playoff / title odds for one team after it wins each of its next games in turn.
  winPath({ team, gameIds, sims, seed }) {
    const forced = [];
    return gameIds.map((id) => {
      const i = model.remIndex.get(id);
      forced.push([i, model.remaining[i].h === team ? 1 : 0]);
      const r = model.simulate({ sims, seed, forced });
      return { id, playoff: r.playoff[team] / sims, title: r.title[team] / sims, bye: r.bye[team] / sims };
    });
  },
};

self.onmessage = ({ data: { id, type, payload } }) => {
  try {
    self.postMessage({ id, result: handlers[type](payload) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
