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

console.log('walls contain players (never lethal)');
{
  const g = playingGame({ roundSeconds: 9999 });
  const p2 = g.players[1]; // heading (-1,0) toward left wall
  g.players[0].setDirection(0, -1); // send P1 to the top edge, out of catch range
  for (let i = 0; i < 600; i++) g.step(1 / 60); // ~10s, way past wall contact
  assert(g.state === State.PLAYING, 'game continues after wall contact');
  assert(p2.x >= CONFIG.playerRadius && p2.x <= CONFIG.width - CONFIG.playerRadius,
    'player stays inside arena bounds');
  assert(approx(p2.x, CONFIG.playerRadius, 0.5), 'player rests against the wall');
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
  const g = playingGame({ roundSeconds: 8 });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
