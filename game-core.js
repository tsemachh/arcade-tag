/**
 * arcade-tag — Phase 1 MVP core logic (engine-agnostic, node-testable).
 * Spec: Gemini doc "מודרניזציה למשחק תופסת ארקייד מינימליסטי" — Phase 1 (MVP),
 * with revised rules: trails are decorative only (players may cross any trail),
 * walls contain players without harm, and a round ends ONLY by
 * catch (chaser wins) or timeout (runner wins).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONFIG = {
    width: 800,
    height: 520,
    playerRadius: 5,
    trailWidth: 3,
    catchRadius: 14,
    speed: 150,            // px / second
    trailMinGap: 3,        // min px between recorded trail points
    roundSeconds: 30,      // runner survives this long → runner wins
    winsToTakeMatch: 3,    // best of five
    // audio mapping (consumed by browser layer, tested here)
    noteIntervalFarMs: 300,
    noteIntervalNearMs: 70,
    pitchFarMult: 1.0,
    pitchNearMult: 1.6,
  };

  /** Game-speed presets (px/second), selectable on the start screen. */
  const SPEEDS = { slow: 110, normal: 150, fast: 200 };

  // ---------- math helpers ----------
  function dist(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function clamp01(v) { return clamp(v, 0, 1); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /**
   * Distance → audio mapping. Closer players ⇒ shorter note interval
   * (faster tempo) and higher pitch multiplier. Linear, clamped.
   */
  function audioFromDistance(d, cfg) {
    const c = cfg || CONFIG;
    const maxD = dist(0, 0, c.width, c.height);
    const closeness = 1 - clamp01(d / maxD); // 0 far .. 1 touching
    return {
      noteIntervalMs: lerp(c.noteIntervalFarMs, c.noteIntervalNearMs, closeness),
      pitchMult: lerp(c.pitchFarMult, c.pitchNearMult, closeness),
      closeness,
    };
  }

  // ---------- entities ----------
  class Player {
    constructor(id, x, y, dirX, dirY) {
      this.id = id;
      this.reset(x, y, dirX, dirY);
    }
    reset(x, y, dirX, dirY, t) {
      this.x = x; this.y = y;
      this.dirX = dirX; this.dirY = dirY;
      this.trail = [{ x, y, t: t || 0 }];
    }
    /** Steer to a new direction (any direction allowed, incl. reversal). */
    setDirection(dx, dy) {
      if (dx === 0 && dy === 0) return;
      const len = Math.sqrt(dx * dx + dy * dy);
      this.dirX = dx / len; this.dirY = dy / len;
    }
    /** Move; walls contain the player (slide/stop, never lethal).
     *  Trail points carry the game time `t` at which they were laid down,
     *  so the renderer can keep each segment's color persistent. */
    advance(dt, cfg, now) {
      this.x = clamp(this.x + this.dirX * cfg.speed * dt, cfg.playerRadius, cfg.width - cfg.playerRadius);
      this.y = clamp(this.y + this.dirY * cfg.speed * dt, cfg.playerRadius, cfg.height - cfg.playerRadius);
      const last = this.trail[this.trail.length - 1];
      if (dist(last.x, last.y, this.x, this.y) >= cfg.trailMinGap) {
        this.trail.push({ x: this.x, y: this.y, t: now || 0 });
      }
    }
  }

  // ---------- game ----------
  const State = Object.freeze({
    READY: 'ready', COUNTDOWN: 'countdown', PLAYING: 'playing',
    ROUND_OVER: 'round_over', MATCH_OVER: 'match_over',
  });

  class Game {
    constructor(cfg) {
      this.cfg = Object.assign({}, CONFIG, cfg || {});
      this.players = [
        new Player(0, 0, 0, 1, 0),
        new Player(1, 0, 0, -1, 0),
      ];
      this.scores = [0, 0];
      this.round = 0;
      this.chaserIndex = 0; // roles alternate every round
      this.state = State.READY;
      this.stateTime = 0;
      this.time = 0; // total elapsed game time (drives persistent trail colors)
      this.lastRoundResult = null;
      this._resetPositions();
    }

    get chaser() { return this.players[this.chaserIndex]; }
    get runner() { return this.players[1 - this.chaserIndex]; }

    _resetPositions() {
      const c = this.cfg;
      this.players[0].reset(c.width * 0.2, c.height / 2, 1, 0, this.time);
      this.players[1].reset(c.width * 0.8, c.height / 2, -1, 0, this.time);
    }

    startRound() {
      this.round += 1;
      this.chaserIndex = (this.round - 1) % 2;
      this._resetPositions();
      this.state = State.COUNTDOWN;
      this.stateTime = 0;
    }

    /** Back to the menu after a match (keeps user settings intact). */
    resetMatch() {
      this.scores = [0, 0];
      this.round = 0;
      this.chaserIndex = 0;
      this.lastRoundResult = null;
      this.state = State.READY;
      this.stateTime = 0;
      this._resetPositions();
    }

    distanceBetween() {
      const [a, b] = this.players;
      return dist(a.x, a.y, b.x, b.y);
    }

    audioParams() {
      return audioFromDistance(this.distanceBetween(), this.cfg);
    }

    /** Seconds left before the runner wins by timeout (0 when not playing). */
    timeLeft() {
      if (this.state !== State.PLAYING) return 0;
      return Math.max(0, this.cfg.roundSeconds - this.stateTime);
    }

    /** Advance simulation by dt seconds. */
    step(dt) {
      this.stateTime += dt;
      this.time += dt;
      if (this.state === State.COUNTDOWN) {
        if (this.stateTime >= 3) { this.state = State.PLAYING; this.stateTime = 0; }
        return;
      }
      if (this.state !== State.PLAYING) return;

      for (const p of this.players) p.advance(dt, this.cfg, this.time);

      // catch: chaser touches runner → chaser wins the round
      if (this.distanceBetween() <= this.cfg.catchRadius) {
        return this._endRound(this.chaserIndex, 'catch');
      }
      // timeout: runner survived the full round → runner wins
      if (this.stateTime >= this.cfg.roundSeconds) {
        return this._endRound(1 - this.chaserIndex, 'timeout');
      }
    }

    _endRound(winnerIndex, reason) {
      this.scores[winnerIndex] += 1;
      this.lastRoundResult = { winnerIndex, reason };
      this.stateTime = 0;
      this.state = this.scores[winnerIndex] >= this.cfg.winsToTakeMatch
        ? State.MATCH_OVER : State.ROUND_OVER;
    }
  }

  return { CONFIG, SPEEDS, State, Game, Player, dist, audioFromDistance, lerp, clamp, clamp01 };
});
