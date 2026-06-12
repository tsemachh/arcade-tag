/**
 * arcade-tag — AI opponent (engine-agnostic, node-testable).
 * Spec section 7: steering behaviors (Reynolds) — Seek/Flee with
 * predictive Pursuit/Evasion. Trails are decorative under the current
 * rules, so no obstacle avoidance is needed; the runner adds wall
 * repulsion so it is not herded into corners.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameAI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    leadTimeMax: 0.6,   // max seconds of foe-position prediction
    wallMargin: 90,     // px from a wall where repulsion kicks in
    wallWeight: 1.6,    // strength of wall repulsion vs flee vector
    jitter: 0.15,       // small randomness so the runner isn't robotic
  };

  /** Difficulty presets: reaction cadence (s) + steering overrides. */
  const PRESETS = {
    easy:   { interval: 0.28, ai: { leadTimeMax: 0.15, jitter: 0.4 } },
    medium: { interval: 0.12, ai: {} },
    hard:   { interval: 0.05, ai: { leadTimeMax: 0.9, jitter: 0.05 } },
  };

  /**
   * Compute the AI's steering direction for the player at `aiIndex`.
   * Pure function of game state; `rand` is injectable for deterministic tests.
   * Returns a normalized [dx, dy].
   */
  function computeAIDirection(game, aiIndex, opts, rand) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const me = game.players[aiIndex];
    const foe = game.players[1 - aiIndex];
    const c = game.cfg;
    const d = Math.hypot(foe.x - me.x, foe.y - me.y);
    const isChaser = game.chaserIndex === aiIndex;

    // predicted foe position (pursuit/evasion): lead grows with distance
    const lead = Math.min(o.leadTimeMax, (d / c.speed) * 0.5);
    const fx = foe.x + foe.dirX * c.speed * lead;
    const fy = foe.y + foe.dirY * c.speed * lead;

    let vx, vy;
    if (isChaser) {
      // pursuit: seek the predicted interception point
      vx = fx - me.x; vy = fy - me.y;
    } else {
      // evasion: flee the predicted chaser position…
      vx = me.x - fx; vy = me.y - fy;
      const m = Math.hypot(vx, vy) || 1;
      vx /= m; vy /= m;
      // …blended with wall repulsion so corners don't become traps
      let wx = 0, wy = 0;
      if (me.x < o.wallMargin) wx += 1 - me.x / o.wallMargin;
      if (me.x > c.width - o.wallMargin) wx -= 1 - (c.width - me.x) / o.wallMargin;
      if (me.y < o.wallMargin) wy += 1 - me.y / o.wallMargin;
      if (me.y > c.height - o.wallMargin) wy -= 1 - (c.height - me.y) / o.wallMargin;
      vx += wx * o.wallWeight; vy += wy * o.wallWeight;
      // tangential escape: when pressed against a wall, flee and repulsion
      // can cancel out (deadlock → easy catch). Add a component along the
      // wall, biased toward the open middle of the arena.
      if (wx !== 0 || wy !== 0) {
        const wlen = Math.hypot(wx, wy);
        let tx = -wy / wlen, ty = wx / wlen;
        // sticky: keep sliding the way we already move, so the choice does
        // not flip every update (dithering pins the runner in place);
        // only on a perpendicular approach, bias toward the open middle.
        const along = tx * me.dirX + ty * me.dirY;
        if (along < -0.05) { tx = -tx; ty = -ty; }
        else if (along <= 0.05) {
          const cxv = c.width / 2 - me.x, cyv = c.height / 2 - me.y;
          if (tx * cxv + ty * cyv < 0) { tx = -tx; ty = -ty; }
        }
        vx += tx * o.wallWeight * 0.9;
        vy += ty * o.wallWeight * 0.9;
      }
      // light jitter for less predictable escape lines
      const r = rand || Math.random;
      vx += (r() - 0.5) * o.jitter;
      vy += (r() - 0.5) * o.jitter;
    }

    const len = Math.hypot(vx, vy);
    if (len < 1e-6) return [1, 0];
    return [vx / len, vy / len];
  }

  return { DEFAULTS, PRESETS, computeAIDirection };
});
