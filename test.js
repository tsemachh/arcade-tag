/** arcade-tag — Phase 1 MVP core-logic tests (revised rules). Run: node test.js */
'use strict';
const { CONFIG, SPEEDS, State, Game, audioFromDistance } = require('./game-core.js');
const { computeAIDirection, PRESETS } = require('./ai.js');
const fixedRand = () => 0.5; // deterministic: jitter term becomes zero

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }

/** Start a game and fast-forward through the countdown. */
function playingGame(cfg) {
  const g = new Game(cfg);
  g.startRound();
  g.step(3.01); // consume countdown
  return g;
}

console.log('audioFromDistance (distance → tempo/pitch)');
{
  const far = audioFromDistance(Math.hypot(CONFIG.width, CONFIG.height));
  const mid = audioFromDistance(Math.hypot(CONFIG.width, CONFIG.height) / 2);
  const near = audioFromDistance(0);
  assert(approx(far.noteIntervalMs, CONFIG.noteIntervalFarMs), 'max distance → slowest tempo');
  assert(approx(near.noteIntervalMs, CONFIG.noteIntervalNearMs), 'zero distance → fastest tempo');
  assert(far.noteIntervalMs > mid.noteIntervalMs && mid.noteIntervalMs > near.noteIntervalMs,
    'interval shrinks monotonically as players close in');
  assert(near.pitchMult > far.pitchMult, 'pitch rises as players close in');
  assert(approx(audioFromDistance(99999).noteIntervalMs, CONFIG.noteIntervalFarMs),
    'distance beyond diagonal clamps');
}

console.log('state machine');
{
  const g = new Game();
  assert(g.state === State.READY, 'starts READY');
  g.startRound();
  assert(g.state === State.COUNTDOWN, 'startRound → COUNTDOWN');
  g.step(3.01);
  assert(g.state === State.PLAYING, 'countdown elapses → PLAYING');
  assert(g.chaserIndex === 0, 'round 1: P1 chases');
  assert(approx(g.timeLeft(), CONFIG.roundSeconds, 0.1), 'round timer starts full');
}

console.log('catch: chaser reaching runner wins the round');
{
  const g = playingGame();
  g.players[0].x = 400; g.players[0].y = 250;
  g.players[1].x = 400 + CONFIG.catchRadius - 1; g.players[1].y = 250;
  g.players[0].setDirection(1, 0); g.players[1].setDirection(1, 0);
  g.step(0.001);
  assert(g.state === State.ROUND_OVER, 'round ends on catch');
  assert(g.lastRoundResult.winnerIndex === 0 && g.lastRoundResult.reason === 'catch',
    'chaser (P1) wins with reason=catch');
  assert(g.scores[0] === 1 && g.scores[1] === 0, 'score updates');
}

console.log('timeout: runner surviving the round wins');
{
  const g = playingGame({ roundSeconds: 2 });
  // keep players apart and moving in circles near opposite corners
  g.players[0].setDirection(0, 1); g.players[1].setDirection(0, -1);
  for (let i = 0; i < 300 && g.state === State.PLAYING; i++) g.step(1 / 60);
  assert(g.state === State.ROUND_OVER, 'round ends on timeout');
  assert(g.lastRoundResult.reason === 'timeout', 'reason is timeout');
  assert(g.lastRoundResult.winnerIndex === 1, 'runner (P2) wins round 1 timeout');
}

console.log('walls bounce players (never lethal, always moving)');
{
  const g = playingGame({ roundSeconds: 9999 });
  const p = g.players[1];
  // Put the players in different rows so a bounce can't cause a catch, and aim
  // p at the left wall from a spot close enough to bounce within the window.
  p.x = 200; p.y = 60; p.setDirection(-1, 0);
  g.players[0].x = 160; g.players[0].y = CONFIG.height - 60; g.players[0].setDirection(1, 0);
  for (let i = 0; i < 300; i++) g.step(1 / 60); // ~5s: p hits the left wall and bounces back
  assert(g.state === State.PLAYING, 'game continues after wall contact');
  assert(p.x >= CONFIG.playerRadius && p.x <= CONFIG.width - CONFIG.playerRadius &&
         p.y >= CONFIG.playerRadius && p.y <= CONFIG.height - CONFIG.playerRadius,
    'player stays inside the arena bounds');
  assert(p.dirX > 0, 'player reflected off the left wall (heading reversed outward)');
  assert(p.x > CONFIG.playerRadius + 1, 'player moves away from the wall, never resting on it');
}

console.log('trails are decorative: crossing them never ends the round');
{
  const g = playingGame({ roundSeconds: 9999 });
  const p1 = g.players[0], p2 = g.players[1];
  // fabricate a long P1 trail across the middle, then drive P2 through it
  p1.trail = [];
  for (let x = 100; x <= 700; x += 4) p1.trail.push({ x, y: 260 });
  p1.x = 200; p1.y = 450; p1.setDirection(0, 0); // park P1 away (dir keeps old)
  p2.x = 400; p2.y = 200; p2.setDirection(0, 1); // straight through the trail
  for (let i = 0; i < 90; i++) g.step(1 / 60); // 1.5s → crosses y=260
  assert(g.state === State.PLAYING, 'crossing an opponent trail is harmless');
  assert(p2.y > 260, 'P2 actually passed through the trail line');
  // own trail too
  p2.setDirection(0, -1);
  for (let i = 0; i < 90; i++) g.step(1 / 60);
  assert(g.state === State.PLAYING, 'crossing own trail is harmless');
}

console.log('movement: any direction allowed, including reversal');
{
  const g = playingGame();
  const p = g.players[0]; // moving (1,0)
  p.setDirection(-1, 0);
  assert(p.dirX === -1 && p.dirY === 0, '180° reversal allowed');
  p.setDirection(1, 1);
  assert(approx(p.dirX, Math.SQRT1_2) && approx(p.dirY, Math.SQRT1_2), 'diagonal normalized');
}

console.log('trail is recorded while moving, with timestamps for persistent colors');
{
  const g = playingGame({ roundSeconds: 9999 });
  for (let i = 0; i < 60; i++) g.step(1 / 60);
  const trail = g.players[0].trail;
  assert(trail.length > 5, 'trail points accumulate');
  assert(trail.every(pt => typeof pt.t === 'number'), 'every trail point carries a game-time stamp');
  let increasing = true;
  for (let i = 1; i < trail.length; i++) if (trail[i].t < trail[i - 1].t) increasing = false;
  assert(increasing, 'timestamps are non-decreasing along the trail');
  assert(trail[trail.length - 1].t > trail[0].t, 'later points have later timestamps');
}

console.log('roles alternate; match ends at 3 wins');
{
  const g = new Game({ roundSeconds: 1 });
  function winRoundForP1() {
    g.startRound(); g.step(3.01);
    if (g.chaserIndex === 0) { // P1 chases → catch
      g.players[0].x = 400; g.players[0].y = 250;
      g.players[1].x = 405; g.players[1].y = 250;
      g.step(0.001);
    } else { // P1 runs → survive to timeout
      g.players[0].x = 50; g.players[0].y = 50;
      g.players[1].x = 750; g.players[1].y = 470;
      g.step(1.01);
    }
  }
  winRoundForP1(); // round 1, P1 chases
  assert(g.chaserIndex === 0, 'round 1 chaser is P1');
  assert(g.lastRoundResult.reason === 'catch', 'round 1 won by catch');
  winRoundForP1(); // round 2, P2 chases, P1 survives
  assert(g.chaserIndex === 1, 'round 2 chaser is P2');
  assert(g.lastRoundResult.reason === 'timeout', 'round 2 won by timeout');
  winRoundForP1(); // round 3
  assert(g.state === State.MATCH_OVER, 'match over at 3 wins');
  assert(g.scores[0] === 3, 'P1 has 3 wins');
}

console.log('AI: pursuit steers toward the runner (with prediction)');
{
  const g = playingGame({ roundSeconds: 9999 });
  // AI (P1, chaser round 1... chaserIndex=0) — use AI for index 0
  g.players[0].x = 200; g.players[0].y = 260;
  g.players[1].x = 500; g.players[1].y = 260; g.players[1].setDirection(0, 1); // runner heading down
  const [ax, ay] = computeAIDirection(g, 0, null, fixedRand);
  assert(ax > 0.5, 'chaser AI heads toward the runner (x)');
  assert(ay > 0.05, 'chaser AI leads the target toward its predicted position (y, down)');
}

console.log('AI: evasion steers away from the chaser');
{
  const g = playingGame({ roundSeconds: 9999 });
  // round 1: chaser is P1 (index 0); AI runner is index 1, in open field
  g.players[0].x = 300; g.players[0].y = 260; g.players[0].setDirection(1, 0);
  g.players[1].x = 420; g.players[1].y = 260;
  const [ax] = computeAIDirection(g, 1, null, fixedRand);
  assert(ax > 0.5, 'runner AI flees in the opposite direction');
}

console.log('AI: wall repulsion keeps the runner out of corners');
{
  const g = playingGame({ roundSeconds: 9999 });
  // chaser to the right of a runner pressed against the left wall:
  // naive flee would point straight into the wall
  g.players[0].x = 160; g.players[0].y = 260; g.players[0].setDirection(-1, 0);
  g.players[1].x = 20; g.players[1].y = 260;
  const [ax, ay] = computeAIDirection(g, 1, null, fixedRand);
  assert(ax > -0.4, 'runner AI does not push hard into the wall');
  assert(Math.abs(ay) > 0.2 || ax > 0, 'runner AI escapes sideways or back into the field');
}

console.log('AI integration: chaser catches a naive straight runner');
{
  const g = playingGame({ roundSeconds: 60 });
  // P1 chases with AI; P2 runs straight right until clamped at the wall
  g.players[1].setDirection(1, 0);
  let steps = 0;
  while (g.state === State.PLAYING && steps < 60 * 20) {
    if (steps % 7 === 0) { const [ax, ay] = computeAIDirection(g, 0, null, fixedRand); g.players[0].setDirection(ax, ay); }
    g.step(1 / 60); steps++;
  }
  assert(g.state !== State.PLAYING && g.lastRoundResult.reason === 'catch',
    'AI chaser catches the runner');
  assert(g.lastRoundResult.winnerIndex === 0, 'chaser wins the round');
  assert(steps < 60 * 10, `catch happens quickly (took ${(steps / 60).toFixed(1)}s)`);
}

console.log('AI integration: runner evades a direct-seek chaser');
{
  // powerupIntervalS pushed out so a random spawn cannot alter this duel
  const g = playingGame({ roundSeconds: 8, powerupIntervalS: 999 });
  let steps = 0, caught = false;
  while (g.state === State.PLAYING && steps < 60 * 10) {
    // scripted chaser: always seek the runner's current position (same speed)
    const [c0, r1] = [g.players[0], g.players[1]];
    g.players[0].setDirection(r1.x - c0.x, r1.y - c0.y);
    if (steps % 7 === 0) { const [ax, ay] = computeAIDirection(g, 1, null, fixedRand); g.players[1].setDirection(ax, ay); }
    g.step(1 / 60); steps++;
  }
  caught = g.lastRoundResult && g.lastRoundResult.reason === 'catch';
  assert(!caught && g.lastRoundResult && g.lastRoundResult.reason === 'timeout',
    'AI runner survives a same-speed direct chaser to timeout');
  assert(g.lastRoundResult.winnerIndex === 1, 'runner wins by timeout');
}

console.log('presets: speed and AI difficulty');
{
  assert(SPEEDS.slow < SPEEDS.normal && SPEEDS.normal < SPEEDS.fast, 'speed presets ordered');
  assert(SPEEDS.normal === CONFIG.speed, 'normal speed matches the default config');
  const g = new Game({ speed: SPEEDS.fast });
  assert(g.cfg.speed === SPEEDS.fast, 'game accepts a speed override');
  assert(PRESETS.easy.interval > PRESETS.medium.interval && PRESETS.medium.interval > PRESETS.hard.interval,
    'harder AI reacts faster');
  assert((PRESETS.hard.ai.leadTimeMax || 0) > (PRESETS.easy.ai.leadTimeMax || 0),
    'harder AI predicts further ahead');
  assert((PRESETS.easy.ai.jitter || 0) > (PRESETS.hard.ai.jitter || 0),
    'easier AI is noisier');
}

console.log('resetMatch returns to menu with settings-independent state cleared');
{
  const g = new Game({ roundSeconds: 1, winsToTakeMatch: 1 });
  g.startRound(); g.step(3.01);
  g.players[0].x = 400; g.players[0].y = 250;
  g.players[1].x = 405; g.players[1].y = 250;
  g.step(0.001);
  assert(g.state === State.MATCH_OVER, 'match over reached');
  g.resetMatch();
  assert(g.state === State.READY, 'back to READY');
  assert(g.scores[0] === 0 && g.scores[1] === 0, 'scores cleared');
  assert(g.round === 0 && g.lastRoundResult === null, 'round counter and result cleared');
}

// ===================== Phase 2: power-ups =====================

console.log('power-ups: deterministic spawn (interval, margin, max cap)');
{
  const g = playingGame({ powerupIntervalS: 0.5, rand: () => 0.5 });
  assert(g.powerups.length === 0, 'no power-up before the interval elapses');
  g.step(0.6);
  assert(g.powerups.length === 1, 'one power-up spawns after the interval');
  const pu = g.powerups[0];
  assert(pu.x >= 60 && pu.x <= CONFIG.width - 60 && pu.y >= 60 && pu.y <= CONFIG.height - 60,
    'spawn keeps a 60px margin from the walls');
  assert(pu.type === 'freeze', 'rand=0.5 deterministically picks the middle type');
}
{
  // park both players in corners so nothing gets picked up, spawn aggressively
  const g = playingGame({ powerupIntervalS: 0.1, rand: () => 0.5, roundSeconds: 9999 });
  g.players[0].setDirection(-1, -1); g.players[1].setDirection(1, 1);
  for (let i = 0; i < 120; i++) g.step(1 / 60); // 2s → many spawn opportunities
  assert(g.powerups.length === CONFIG.maxPowerups, 'field never exceeds maxPowerups');
  const g2 = playingGame({ rand: () => 0.5 });
  g2.startRound();
  assert(g2.powerups.length === 0, 'powerups cleared at round start');
}

console.log('power-ups: dash pickup, speed boost, expiry');
{
  const g = playingGame({ rand: () => 0.5 });
  const p = g.players[0]; // at (160, 260) heading right
  g.powerups.push({ x: p.x + 20, y: p.y, type: 'dash' });
  g.step(0.1); // moves 15px → within pickup range
  assert(g.powerups.length === 0, 'power-up consumed on contact');
  assert(approx(p.fx.dash, CONFIG.dashSeconds), 'dash effect set to dashSeconds');
  assert(g.lastEvent && g.lastEvent.type === 'pickup', 'pickup sets lastEvent');
  const x0 = p.x;
  g.step(0.1);
  assert(approx(p.x - x0, CONFIG.speed * CONFIG.dashMult * 0.1, 1e-6),
    'dash multiplies movement speed');
  assert(p.fx.dash < CONFIG.dashSeconds, 'dash timer ticks down');
  // steer the players apart so a catch cannot end the round mid-test
  g.players[0].setDirection(0, 1); g.players[1].setDirection(0, -1);
  for (let i = 0; i < 30; i++) g.step(0.1); // 3s ≫ dashSeconds
  assert(p.fx.dash === 0, 'dash expires to exactly 0');
  assert(approx(p.speedFactor(g.cfg), 1), 'speed factor returns to 1 after expiry');
}

console.log('power-ups: freeze slows every OTHER player');
{
  const g = playingGame({ rand: () => 0.5 });
  const p = g.players[0], q = g.players[1];
  g.powerups.push({ x: p.x + 20, y: p.y, type: 'freeze' });
  g.step(0.1);
  assert(approx(q.fx.slow, CONFIG.freezeSeconds), 'opponent gets slowed');
  assert(p.fx.slow === 0, 'collector is not slowed');
  const qx = q.x;
  g.step(0.1); // q heads (-1, 0)
  assert(approx(qx - q.x, CONFIG.speed * CONFIG.freezeMult * 0.1, 1e-6),
    'frozen player moves at freezeMult speed');
  assert(approx(p.speedFactor(Object.assign({}, CONFIG)), 1) &&
    (p.fx.dash = 1, p.fx.slow = 1, approx(p.speedFactor(CONFIG), CONFIG.dashMult * CONFIG.freezeMult)),
    'dash and slow multiply together');
}

console.log('power-ups: ghost stops trail recording, then resumes');
{
  const g = playingGame({ rand: () => 0.5, roundSeconds: 9999 });
  const p = g.players[0];
  g.powerups.push({ x: p.x + 20, y: p.y, type: 'ghost' });
  g.step(0.1);
  assert(approx(p.fx.ghost, CONFIG.ghostSeconds), 'ghost effect set on pickup');
  const len = p.trail.length;
  g.step(0.5); // moves 75px — would normally lay many points
  assert(p.trail.length === len, 'no trail points recorded while ghosting');
  // steer the players apart so a catch cannot end the round mid-test
  g.players[0].setDirection(0, 1); g.players[1].setDirection(0, -1);
  for (let i = 0; i < 5; i++) g.step(0.5); // ghost expires
  assert(p.fx.ghost === 0, 'ghost expires');
  assert(p.trail.length > len, 'trail recording resumes after ghost ends');
}

console.log('AI: ghosting foe kills prediction lead (and stays deterministic)');
{
  const g = playingGame();
  g.players[0].x = 200; g.players[0].y = 260;
  g.players[1].x = 500; g.players[1].y = 260; g.players[1].setDirection(0, 1);
  const [nx, ny] = computeAIDirection(g, 0, null, fixedRand);
  assert(ny > 0.05, 'baseline: chaser leads a visible runner');
  g.players[1].fx.ghost = 1.0;
  const [ax, ay] = computeAIDirection(g, 0, null, fixedRand);
  assert(Math.abs(ay) < 1e-9, 'ghosted foe → zero prediction lead');
  assert(ax > 0.99, 'chaser still heads at the last known position');
}

console.log('lastEvent: catch midpoint and timeout runner position');
{
  const g = playingGame();
  g.players[0].x = 400; g.players[0].y = 250;
  g.players[1].x = 410; g.players[1].y = 250;
  g.step(0.001);
  assert(g.lastEvent && g.lastEvent.type === 'catch', 'catch sets lastEvent.type');
  assert(approx(g.lastEvent.x, 405, 1) && approx(g.lastEvent.y, 250, 1),
    'catch event at the midpoint of the two players');
  assert(typeof g.lastEvent.time === 'number', 'event carries a timestamp');
  const g2 = playingGame({ roundSeconds: 0.1 });
  g2.step(0.2);
  assert(g2.lastEvent && g2.lastEvent.type === 'timeout', 'timeout sets lastEvent.type');
  assert(approx(g2.lastEvent.x, g2.players[1].x, 1e-6), 'timeout event at the runner position');
}

// ===================== Phase 2: game modes =====================

console.log('modes: classic stays a 2-player game (default mode)');
{
  const g = new Game();
  assert(g.mode === 'classic', 'default mode is classic');
  assert(g.players.length === 2, 'classic has 2 players');
  assert(approx(g.players[0].x, CONFIG.width * 0.2, 1e-6) &&
    approx(g.players[1].x, CONFIG.width * 0.8, 1e-6),
    'classic spawn spots unchanged (0.2w / 0.8w)');
}

console.log('koth: zone placement, accrual, win, relocation, timeout, no catch');
{
  const g = playingGame({ mode: 'koth', rand: () => 0.5, kothMoveSeconds: 999 });
  assert(g.players.length === 2, 'koth is a 2-player mode');
  assert(g.zone && g.zone.x >= 100 && g.zone.x <= CONFIG.width - 100 &&
    g.zone.y >= 100 && g.zone.y <= CONFIG.height - 100,
    'zone placed with a 100px margin at round start');
  g.players[0].x = g.zone.x; g.players[0].y = g.zone.y;
  g.step(0.1);
  assert(approx(g.zoneScore[0], 0.1, 1e-6), 'zone time accrues for a player inside');
  assert(g.zoneScore[1] === 0, 'no accrual for a player outside the zone');
}
{
  const g = playingGame({ mode: 'koth', rand: () => 0.5, kothMoveSeconds: 999, kothWinSeconds: 0.5 });
  let n = 0;
  while (g.state === State.PLAYING && n < 200) {
    g.players[0].x = g.zone.x; g.players[0].y = g.zone.y; // pin P1 on the hill
    g.step(1 / 60); n++;
  }
  assert(g.state === State.ROUND_OVER, 'koth round ends when kothWinSeconds accrued');
  assert(g.lastRoundResult.winnerIndex === 0 && g.lastRoundResult.reason === 'zone',
    'zone holder wins with reason=zone');
  assert(g.lastEvent.type === 'zone', 'zone win sets lastEvent');
}
{
  let i = 0; const vals = [0.2, 0.3, 0.7, 0.8];
  const g = playingGame({ mode: 'koth', kothMoveSeconds: 0.5, rand: () => vals[i++ % vals.length] });
  const z0 = { x: g.zone.x, y: g.zone.y };
  for (let k = 0; k < 36; k++) g.step(1 / 60); // 0.6s > kothMoveSeconds
  assert(g.zone.x !== z0.x || g.zone.y !== z0.y, 'zone relocates every kothMoveSeconds');
}
{
  const g = playingGame({ mode: 'koth', rand: () => 0.5, roundSeconds: 0.5, kothWinSeconds: 999 });
  g.zoneScore[0] = 1; g.zoneScore[1] = 3;
  g.step(0.6);
  assert(g.state === State.ROUND_OVER && g.lastRoundResult.reason === 'timeout',
    'koth timer cap resolves the round');
  assert(g.lastRoundResult.winnerIndex === 1, 'highest zoneScore wins the timeout');
}
{
  const g = playingGame({ mode: 'koth', rand: () => 0.5 });
  g.players[0].x = 300; g.players[0].y = 100;
  g.players[1].x = 305; g.players[1].y = 100;
  g.step(0.01);
  assert(g.state === State.PLAYING, 'touching an opponent never ends a koth round (no catch)');
}

console.log('infection: 4 players, spawn ring, initial infected rotation');
{
  const g = playingGame({ mode: 'infection' });
  assert(g.players.length === 4, 'infection spawns 4 players');
  assert(g.scores.length === 4, 'scores track 4 players');
  assert(g.infected.filter(Boolean).length === 1 && g.infected[g.chaserIndex] === true,
    'exactly one initial infected (the rotating chaserIndex)');
  assert(g.chaserIndex === 0, 'round 1 starts with player 0 infected');
  assert(g.players.every(p =>
    p.x >= CONFIG.playerRadius && p.x <= CONFIG.width - CONFIG.playerRadius &&
    p.y >= CONFIG.playerRadius && p.y <= CONFIG.height - CONFIG.playerRadius),
    '4-player spawn positions are inside the arena');
  const distinct = new Set(g.players.map(p => `${Math.round(p.x)},${Math.round(p.y)}`));
  assert(distinct.size === 4, 'spawn positions are distinct (evenly spaced ellipse)');
}

console.log('infection: touch spreads, last healthy player survives');
{
  const g = playingGame({ mode: 'infection' });
  g.players[1].x = g.players[0].x + 5; g.players[1].y = g.players[0].y;
  g.step(0.001);
  assert(g.infected[1] === true, 'infected touch infects a healthy player');
  assert(g.state === State.PLAYING, 'round continues while 2+ healthy remain');
  assert(g.lastEvent.type === 'infect', 'infection sets lastEvent {type:infect}');
  g.players[2].x = g.players[0].x; g.players[2].y = g.players[0].y;
  g.step(0.001);
  assert(g.infected[2] === true, 'second infection lands');
  assert(g.state === State.ROUND_OVER, 'round ends when exactly one healthy remains');
  assert(g.lastRoundResult.winnerIndex === 3 && g.lastRoundResult.reason === 'survivor',
    'last healthy player wins with reason=survivor');
  assert(g.scores[3] === 1, 'survivor takes the point');
  g.startRound(); g.step(3.01);
  assert(g.chaserIndex === 1 && g.infected[1] === true && g.infected[0] === false,
    'round 2 rotates the initial infected to player 1');
}

console.log('infection: timeout — farthest healthy player from any infected wins');
{
  const g = playingGame({ mode: 'infection', roundSeconds: 0.5 });
  g.players[0].x = 100; g.players[0].y = 100; // infected
  g.players[1].x = 150; g.players[1].y = 100; // healthy, close
  g.players[3].x = 300; g.players[3].y = 100; // healthy, mid
  g.players[2].x = 700; g.players[2].y = 300; // healthy, far
  for (const p of g.players) p.setDirection(0, 1); // all drift the same way
  g.step(0.6);
  assert(g.state === State.ROUND_OVER && g.lastRoundResult.reason === 'timeout',
    'infection round resolves on timeout');
  assert(g.lastRoundResult.winnerIndex === 2,
    'winner is the healthy player farthest from the nearest infected');
}

console.log('AI: explicit target {foeIndex, role} drives multi-player steering');
{
  const g = playingGame({ mode: 'infection' });
  // player 0 at (160, 260), player 2 at (640, 260)
  const [cx] = computeAIDirection(g, 0, null, fixedRand, { foeIndex: 2, role: 'chase' });
  assert(cx > 0.9, 'chase role heads toward the chosen foe');
  const [fx] = computeAIDirection(g, 0, null, fixedRand, { foeIndex: 2, role: 'flee' });
  assert(fx < -0.5, 'flee role heads away from the chosen foe');
  const g2 = playingGame();
  g2.players[1].setDirection(0, 1);
  const a = computeAIDirection(g2, 0, null, fixedRand);
  const b = computeAIDirection(g2, 0, null, fixedRand, { foeIndex: 1, role: 'chase' });
  assert(a[0] === b[0] && a[1] === b[1], 'default target reproduces the classic behavior');
}

// ---------- Phase 3: host-authoritative networking ----------
console.log('networking: host snapshot → guest applySnapshot (classic)');
{
  const host = playingGame();
  host.players[0].setDirection(1, 0);
  host.players[1].setDirection(-1, 1);
  for (let i = 0; i < 10; i++) host.step(0.1);
  const guest = new Game();
  const changed = guest.applySnapshot(host.snapshot());
  assert(changed === false, 'matching mode → no rebuild needed');
  assert(guest.state === host.state, 'guest mirrors state');
  assert(guest.round === host.round, 'guest mirrors round number');
  assert(guest.chaserIndex === host.chaserIndex, 'guest mirrors chaser index');
  assert(approx(guest.players[0].x, host.players[0].x, 0.02) &&
         approx(guest.players[0].y, host.players[0].y, 0.02),
    'guest player 0 position matches host (within send rounding)');
  assert(approx(guest.players[1].x, host.players[1].x, 0.02), 'guest player 1 position matches host');
  assert(guest.scores[0] === host.scores[0] && guest.scores[1] === host.scores[1], 'guest mirrors scores');
  assert(guest.players[0].trail.length >= 2, 'guest reconstructs a trail locally from head positions');
}

console.log('networking: trails accumulate across snapshots; new round resets them');
{
  const host = playingGame();
  const guest = new Game();
  host.players[0].setDirection(1, 0);
  for (let i = 0; i < 8; i++) { host.step(0.1); guest.applySnapshot(host.snapshot()); }
  assert(guest.players[0].trail.length > 2, 'trail accumulates points over multiple snapshots');
  host.startRound();
  guest.applySnapshot(host.snapshot());
  assert(guest.round === host.round, 'guest follows the new round');
  assert(guest.players[0].trail.length === 1, 'guest resets its trail on a new round');
}

console.log('networking: ghosting player leaves no guest trail (matches host rule)');
{
  const host = playingGame();
  const guest = new Game();
  host.players[0].fx.ghost = 1.0;       // start ghosting
  host.players[0].setDirection(1, 0);
  guest.applySnapshot(host.snapshot()); // round change reset → trail length 1
  for (let i = 0; i < 5; i++) { host.step(0.1); guest.applySnapshot(host.snapshot()); }
  assert(guest.players[0].trail.length === 1, 'no trail points recorded while ghosting');
}

console.log('networking: koth zone, zoneScore, and powerups round-trip');
{
  const host = playingGame({ mode: 'koth' });
  host.players[0].x = host.zone.x; host.players[0].y = host.zone.y; // sit on the hill
  host.powerups.push({ x: 123.456, y: 222.0, type: 'dash' });
  host.step(0.2);
  const guest = new Game({ mode: 'koth' });
  guest.applySnapshot(host.snapshot());
  assert(guest.zone && approx(guest.zone.x, host.zone.x, 0.02), 'guest mirrors the koth zone position');
  assert(approx(guest.zoneScore[0], host.zoneScore[0], 0.02), 'guest mirrors accumulated zoneScore');
  assert(guest.powerups.length === host.powerups.length, 'guest mirrors powerup count');
  assert(guest.powerups[0] && guest.powerups[0].type === 'dash', 'guest mirrors powerup type');
}

console.log('networking: mode mismatch tells the caller to rebuild');
{
  const host = playingGame({ mode: 'koth' });
  const guest = new Game(); // classic
  assert(guest.applySnapshot(host.snapshot()) === true, 'mode change returns true (caller rebuilds)');
  assert(guest.mode === 'classic', 'mirror is untouched until the caller rebuilds it');
}

console.log('networking: snapshot carries the catch event for guest-side effects');
{
  const host = new Game();
  host.startRound(); host.step(3.01);
  host.chaser.x = host.runner.x; host.chaser.y = host.runner.y; // force a catch
  host.step(0.02);
  const snap = host.snapshot();
  assert(snap.ev && snap.ev.type === 'catch', 'snapshot reports the catch event with type');
  assert(typeof snap.ev.x === 'number' && typeof snap.ev.time === 'number',
    'event carries coords + timestamp for guest dedupe');
  assert(snap.res && snap.res.reason === 'catch', 'snapshot reports the round result');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
