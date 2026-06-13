/**
 * arcade-tag — Phase 1 MVP core logic (engine-agnostic, node-testable).
 * Spec: Gemini doc "מודרניזציה למשחק תופסת ארקייד מינימליסטי" — Phase 1 (MVP),
 * with revised rules: trails are decorative only (players may cross any trail),
 * walls contain players without harm, and a round ends ONLY by
 * catch (chaser wins) or timeout (runner wins).
 *
 * Phase 2 additions: power-ups (dash / freeze / ghost), game modes
 * ('classic' | 'koth' king-of-the-hill | 'infection' 4-player tag),
 * and lastEvent reporting for renderer effects.
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
    trailWidth: 6,         // bolder "spaghetti" lines (Phase 4 feel pass)
    catchRadius: 14,
    speed: 150,            // px / second
    trailMinGap: 3,        // min px between recorded trail points
    roundSeconds: 30,      // runner survives this long → runner wins
    winsToTakeMatch: 3,    // best of five
    // decoy "spaghetti" laid on the field at round start (camouflage for radar)
    decoyLines: 6,
    decoyStep: 14,         // px between decoy points
    decoyMin: 26,          // min / max points per decoy line
    decoyMax: 60,
    // audio mapping (consumed by browser layer, tested here)
    noteIntervalFarMs: 300,
    noteIntervalNearMs: 70,
    pitchFarMult: 1.0,
    pitchNearMult: 1.6,
    // power-ups
    powerupIntervalS: 6,   // seconds between spawns (while playing)
    powerupRadius: 10,
    maxPowerups: 2,        // max simultaneously on the field
    dashMult: 1.8,
    dashSeconds: 2.0,
    freezeMult: 0.35,
    freezeSeconds: 1.6,
    ghostSeconds: 2.0,
    wideMult: 3,           // ↔ wide: triples the grabber's catch reach (Arkanoid-style)
    wideSeconds: 5.0,
    // modes
    infectionPlayers: 4,
    kothZoneRadius: 70,
    kothMoveSeconds: 5,    // zone relocates this often
    kothWinSeconds: 15,    // accumulated zone time to take the round
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
      this.fx = { dash: 0, slow: 0, ghost: 0, wide: 0 }; // power-up effect timers (s)
    }
    /** Steer to a new direction (any direction allowed, incl. reversal). */
    setDirection(dx, dy) {
      if (dx === 0 && dy === 0) return;
      const len = Math.sqrt(dx * dx + dy * dy);
      this.dirX = dx / len; this.dirY = dy / len;
    }
    /** Current speed multiplier from active power-up effects. */
    speedFactor(cfg) {
      return (this.fx.dash > 0 ? cfg.dashMult : 1) * (this.fx.slow > 0 ? cfg.freezeMult : 1);
    }
    /** Move; walls contain the player (slide/stop, never lethal).
     *  Trail points carry the game time `t` at which they were laid down,
     *  so the renderer can keep each segment's color persistent.
     *  While ghosting, no trail is recorded (the player goes invisible). */
    advance(dt, cfg, now) {
      const sp = cfg.speed * this.speedFactor(cfg);
      const lo = cfg.playerRadius, hiX = cfg.width - cfg.playerRadius, hiY = cfg.height - cfg.playerRadius;
      let nx = this.x + this.dirX * sp * dt;
      let ny = this.y + this.dirY * sp * dt;
      // Walls bounce (reflect heading) instead of pinning — the actor never
      // stops, so the game is always in motion.
      if (nx < lo) { nx = lo; this.dirX = Math.abs(this.dirX); }
      else if (nx > hiX) { nx = hiX; this.dirX = -Math.abs(this.dirX); }
      if (ny < lo) { ny = lo; this.dirY = Math.abs(this.dirY); }
      else if (ny > hiY) { ny = hiY; this.dirY = -Math.abs(this.dirY); }
      this.x = nx; this.y = ny;
      if (this.fx.ghost > 0) return; // invisible: leave no trace
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

  const POWERUP_TYPES = ['dash', 'freeze', 'ghost', 'wide'];

  class Game {
    constructor(cfg) {
      this.cfg = Object.assign({}, CONFIG, cfg || {});
      this.mode = this.cfg.mode || 'classic'; // 'classic' | 'koth' | 'infection'
      this.rand = this.cfg.rand || Math.random; // injectable for deterministic tests
      const n = this.mode === 'infection' ? this.cfg.infectionPlayers : 2;
      this.players = [];
      for (let i = 0; i < n; i++) this.players.push(new Player(i, 0, 0, 1, 0));
      this.scores = this.players.map(() => 0);
      this.round = 0;
      this.chaserIndex = 0; // roles rotate every round (initial infected in infection)
      this.state = State.READY;
      this.stateTime = 0;
      this.time = 0; // total elapsed game time (drives persistent trail colors)
      this.lastRoundResult = null;
      this.lastEvent = null; // {type, x, y, time} — consumed by renderer effects
      this.powerups = []; // {x, y, type}
      this._powerupTimer = 0;
      this.zone = null; // koth: {x, y}
      this.zoneScore = this.players.map(() => 0); // koth: seconds spent in zone
      this._zoneTimer = 0;
      this.infected = this.players.map(() => false); // infection mode
      this._resetPositions();
    }

    get chaser() { return this.players[this.chaserIndex]; }
    get runner() { return this.players[1 - this.chaserIndex]; }

    /** Spawn N players evenly spaced on an ellipse around the arena center,
     *  facing inward. For N=2 this reproduces the classic 0.2w / 0.8w spots. */
    _resetPositions() {
      const c = this.cfg, n = this.players.length;
      const cx = c.width / 2, cy = c.height / 2;
      const rx = c.width * 0.3, ry = c.height * 0.3;
      for (let i = 0; i < n; i++) {
        const a = Math.PI + (i / n) * Math.PI * 2; // player 0 on the left
        const x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry;
        const dx = cx - x, dy = cy - y;
        const len = Math.hypot(dx, dy) || 1;
        this.players[i].reset(x, y, dx / len, dy / len, this.time);
      }
      this.decoys = this._makeDecoys();
    }

    /** Random-walk "spaghetti" lines laid on the field at round start. They
     *  are purely decorative camouflage (the renderer shows them in radar mode
     *  so a real trail is hard to pick out). Uses this.rand for determinism. */
    _makeDecoys() {
      const c = this.cfg, lines = [];
      const lo = c.playerRadius, hiX = c.width - c.playerRadius, hiY = c.height - c.playerRadius;
      const n = c.decoyLines || 0;
      for (let i = 0; i < n; i++) {
        let x = lo + this.rand() * (hiX - lo);
        let y = lo + this.rand() * (hiY - lo);
        let a = this.rand() * Math.PI * 2;
        const steps = (c.decoyMin || 26) + Math.floor(this.rand() * ((c.decoyMax || 60) - (c.decoyMin || 26)));
        const pts = [{ x, y }];
        for (let s = 0; s < steps; s++) {
          a += (this.rand() - 0.5) * 0.9; // gentle wander
          x = clamp(x + Math.cos(a) * (c.decoyStep || 14), lo, hiX);
          y = clamp(y + Math.sin(a) * (c.decoyStep || 14), lo, hiY);
          pts.push({ x, y });
        }
        lines.push({ pts, hue: this.rand() * 360 });
      }
      return lines;
    }

    startRound() {
      this.round += 1;
      this.chaserIndex = (this.round - 1) % this.players.length;
      this._resetPositions();
      this.powerups = [];
      this._powerupTimer = 0;
      this.zoneScore = this.players.map(() => 0);
      this._zoneTimer = 0;
      if (this.mode === 'koth') this._placeZone();
      this.infected = this.players.map((p, i) =>
        this.mode === 'infection' && i === this.chaserIndex);
      this.state = State.COUNTDOWN;
      this.stateTime = 0;
    }

    /** Back to the menu after a match (keeps user settings intact). */
    resetMatch() {
      this.scores = this.players.map(() => 0);
      this.round = 0;
      this.chaserIndex = 0;
      this.lastRoundResult = null;
      this.lastEvent = null;
      this.powerups = [];
      this._powerupTimer = 0;
      this.zone = null;
      this.zoneScore = this.players.map(() => 0);
      this.infected = this.players.map(() => false);
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

    // ---------- networking (host-authoritative state sync) ----------
    /** Compact authoritative state for the guest. Trails are NOT sent — the
     *  guest reconstructs them locally from successive head positions, so the
     *  payload stays tiny (a few hundred bytes) regardless of round length. */
    snapshot() {
      const r2 = (v) => Math.round(v * 100) / 100;
      const r3 = (v) => Math.round(v * 1000) / 1000;
      return {
        mode: this.mode,
        st: this.state, sTime: r3(this.stateTime), time: r3(this.time),
        round: this.round, ci: this.chaserIndex,
        sc: this.scores.slice(),
        zs: this.zoneScore.map(r3),
        inf: this.infected.slice(),
        zone: this.zone ? { x: r2(this.zone.x), y: r2(this.zone.y) } : null,
        pu: this.powerups.map(p => ({ x: r2(p.x), y: r2(p.y), type: p.type })),
        pl: this.players.map(p => [r2(p.x), r2(p.y), r3(p.dirX), r3(p.dirY),
          r3(p.fx.dash), r3(p.fx.slow), r3(p.fx.ghost), r3(p.fx.wide)]),
        ev: this.lastEvent
          ? { type: this.lastEvent.type, x: r2(this.lastEvent.x), y: r2(this.lastEvent.y), time: r3(this.lastEvent.time) }
          : null,
        res: this.lastRoundResult
          ? { winnerIndex: this.lastRoundResult.winnerIndex, reason: this.lastRoundResult.reason }
          : null,
      };
    }

    /** Apply a host snapshot to this (guest) game and grow trails locally.
     *  Returns true if the mode changed (caller should rebuild the Game). */
    applySnapshot(s) {
      if (s.mode !== this.mode) return true; // caller rebuilds with the new mode
      const roundChanged = s.round !== this.round;
      if (roundChanged) this._resetPositions(); // clears trails to a single point
      this.state = s.st; this.stateTime = s.sTime; this.time = s.time;
      this.round = s.round; this.chaserIndex = s.ci;
      this.scores = s.sc.slice();
      this.zoneScore = s.zs.slice();
      this.infected = s.inf.slice();
      this.zone = s.zone ? { x: s.zone.x, y: s.zone.y } : null;
      this.powerups = s.pu.map(p => ({ x: p.x, y: p.y, type: p.type }));
      this.lastRoundResult = s.res ? { winnerIndex: s.res.winnerIndex, reason: s.res.reason } : null;
      this.lastEvent = s.ev ? { type: s.ev.type, x: s.ev.x, y: s.ev.y, time: s.ev.time } : this.lastEvent;
      for (let i = 0; i < this.players.length; i++) {
        const p = this.players[i], a = s.pl[i];
        p.x = a[0]; p.y = a[1]; p.dirX = a[2]; p.dirY = a[3];
        p.fx = { dash: a[4], slow: a[5], ghost: a[6], wide: a[7] || 0 };
        if (p.fx.ghost > 0) continue; // ghosting: leave no trace (matches host)
        const last = p.trail[p.trail.length - 1];
        if (!last || dist(last.x, last.y, p.x, p.y) >= this.cfg.trailMinGap) {
          p.trail.push({ x: p.x, y: p.y, t: s.time });
        }
      }
      return false;
    }

    /** Seconds left before the round resolves by timeout (0 when not playing). */
    timeLeft() {
      if (this.state !== State.PLAYING) return 0;
      return Math.max(0, this.cfg.roundSeconds - this.stateTime);
    }

    _placeZone() {
      const c = this.cfg, m = 100;
      this.zone = {
        x: m + this.rand() * (c.width - 2 * m),
        y: m + this.rand() * (c.height - 2 * m),
      };
    }

    _stepPowerups(dt) {
      const c = this.cfg;
      this._powerupTimer += dt;
      if (this._powerupTimer >= c.powerupIntervalS && this.powerups.length < c.maxPowerups) {
        this._powerupTimer = 0;
        const m = 60; // keep clear of the walls
        this.powerups.push({
          x: m + this.rand() * (c.width - 2 * m),
          y: m + this.rand() * (c.height - 2 * m),
          type: POWERUP_TYPES[Math.min(POWERUP_TYPES.length - 1,
            Math.floor(this.rand() * POWERUP_TYPES.length))],
        });
      }
      for (let k = this.powerups.length - 1; k >= 0; k--) {
        const pu = this.powerups[k];
        const grab = this.players.find(p =>
          dist(p.x, p.y, pu.x, pu.y) <= c.powerupRadius + c.playerRadius);
        if (!grab) continue;
        this.powerups.splice(k, 1);
        if (pu.type === 'dash') grab.fx.dash = c.dashSeconds;
        else if (pu.type === 'freeze') {
          for (const q of this.players) if (q !== grab) q.fx.slow = c.freezeSeconds;
        } else if (pu.type === 'wide') grab.fx.wide = c.wideSeconds;
        else grab.fx.ghost = c.ghostSeconds;
        this.lastEvent = { type: 'pickup', x: pu.x, y: pu.y, time: this.time };
      }
    }

    _stepKoth(dt) {
      const c = this.cfg;
      this._zoneTimer += dt;
      if (this._zoneTimer >= c.kothMoveSeconds) { this._zoneTimer = 0; this._placeZone(); }
      for (let i = 0; i < this.players.length; i++) {
        const p = this.players[i];
        if (dist(p.x, p.y, this.zone.x, this.zone.y) <= c.kothZoneRadius) {
          this.zoneScore[i] += dt;
          if (this.zoneScore[i] >= c.kothWinSeconds) {
            this.lastEvent = { type: 'zone', x: p.x, y: p.y, time: this.time };
            return this._endRound(i, 'zone');
          }
        }
      }
      if (this.stateTime >= c.roundSeconds) {
        let w = 0;
        for (let i = 1; i < this.zoneScore.length; i++) {
          if (this.zoneScore[i] > this.zoneScore[w]) w = i;
        }
        const p = this.players[w];
        this.lastEvent = { type: 'timeout', x: p.x, y: p.y, time: this.time };
        return this._endRound(w, 'timeout');
      }
    }

    _stepInfection(dt) {
      const c = this.cfg;
      // spread: any infected player touching an uninfected one infects them
      for (let i = 0; i < this.players.length; i++) {
        if (!this.infected[i]) continue;
        for (let j = 0; j < this.players.length; j++) {
          if (this.infected[j]) continue;
          const a = this.players[i], b = this.players[j];
          const reach = c.catchRadius * (a.fx.wide > 0 ? c.wideMult : 1);
          if (dist(a.x, a.y, b.x, b.y) > reach) continue;
          this.infected[j] = true;
          this.lastEvent = { type: 'infect', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, time: this.time };
          const healthy = [];
          for (let k = 0; k < this.players.length; k++) if (!this.infected[k]) healthy.push(k);
          if (healthy.length === 1) {
            const p = this.players[healthy[0]];
            this.lastEvent = { type: 'survivor', x: p.x, y: p.y, time: this.time };
            return this._endRound(healthy[0], 'survivor');
          }
        }
      }
      if (this.stateTime >= c.roundSeconds) {
        // among the uninfected, the one farthest from the nearest infected wins
        let w = -1, bestD = -1;
        for (let i = 0; i < this.players.length; i++) {
          if (this.infected[i]) continue;
          let near = Infinity;
          for (let j = 0; j < this.players.length; j++) {
            if (!this.infected[j]) continue;
            near = Math.min(near,
              dist(this.players[i].x, this.players[i].y, this.players[j].x, this.players[j].y));
          }
          if (near > bestD) { bestD = near; w = i; }
        }
        if (w < 0) w = this.chaserIndex; // degenerate: nobody healthy
        const p = this.players[w];
        this.lastEvent = { type: 'timeout', x: p.x, y: p.y, time: this.time };
        return this._endRound(w, 'timeout');
      }
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

      for (const p of this.players) {
        p.fx.dash = Math.max(0, p.fx.dash - dt);
        p.fx.slow = Math.max(0, p.fx.slow - dt);
        p.fx.ghost = Math.max(0, p.fx.ghost - dt);
        p.fx.wide = Math.max(0, p.fx.wide - dt);
        p.advance(dt, this.cfg, this.time);
      }

      this._stepPowerups(dt);

      if (this.mode === 'koth') return this._stepKoth(dt);
      if (this.mode === 'infection') return this._stepInfection(dt);

      // classic — catch: chaser touches runner → chaser wins the round.
      // The ↔ wide power-up triples the chaser's reach while active.
      const reach = this.cfg.catchRadius * (this.chaser.fx.wide > 0 ? this.cfg.wideMult : 1);
      if (this.distanceBetween() <= reach) {
        const a = this.chaser, b = this.runner;
        this.lastEvent = { type: 'catch', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, time: this.time };
        return this._endRound(this.chaserIndex, 'catch');
      }
      // timeout: runner survived the full round → runner wins
      if (this.stateTime >= this.cfg.roundSeconds) {
        this.lastEvent = { type: 'timeout', x: this.runner.x, y: this.runner.y, time: this.time };
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
