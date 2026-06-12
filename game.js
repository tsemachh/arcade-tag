/**
 * arcade-tag — Phase 1 MVP browser layer: rendering, input, adaptive audio.
 * Audio: Web Audio square-wave ostinato (POKEY homage). Note rate + pitch
 * are driven directly by the Euclidean distance between the two players.
 * Visuals: both players share one hue-cycling color; trail segments keep
 * the hue they were laid down with (persistent rainbow); player heads are
 * the live tip of the line; a white ring marks the chaser.
 * Input: keyboard (P1 WASD, P2 arrows), tap-to-select menus, and a
 * floating virtual touch joystick for P1 (spec section 9.1).
 */
(function () {
  'use strict';
  const { Game, State, SPEEDS } = window.GameCore;
  const { computeAIDirection, PRESETS } = window.GameAI;

  const canvas = document.getElementById('arena');
  const ctx = canvas.getContext('2d');
  const game = new Game({ width: canvas.width, height: canvas.height });
  window.__game = game; // exposed for automated verification

  // ---------- settings (start-screen selectable) ----------
  const settings = { aiMode: true, difficulty: 'medium', speed: 'normal' };
  window.__settings = settings; // verification hook
  function p2Name() { return settings.aiMode ? 'המחשב' : 'שחקן 2'; }
  function applySpeed() { game.cfg.speed = SPEEDS[settings.speed]; }

  let aiTimer = 0;

  // ---------- input: keyboard ----------
  const keys = new Set();
  const P1 = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' };
  const P2 = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

  function dirFor(map) {
    let dx = 0, dy = 0;
    if (keys.has(map.left)) dx -= 1;
    if (keys.has(map.right)) dx += 1;
    if (keys.has(map.up)) dy -= 1;
    if (keys.has(map.down)) dy += 1;
    return [dx, dy];
  }

  function advanceState() {
    audio.ensureStarted();
    if (game.state === State.READY || game.state === State.ROUND_OVER) { applySpeed(); game.startRound(); }
    else if (game.state === State.MATCH_OVER) { game.resetMatch(); }
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); advanceState(); return; }
    if (e.code === 'Escape') { game.resetMatch(); return; } // back to menu anytime
    if (e.code === 'KeyM') { audio.muted = !audio.muted; return; }
    if (game.state === State.READY && (e.code === 'Digit1' || e.code === 'Digit2')) {
      settings.aiMode = e.code === 'Digit1';
      return;
    }
    keys.add(e.code);
  });
  document.addEventListener('keyup', (e) => keys.delete(e.code));

  // ---------- input: pointer (menu buttons + floating joystick) ----------
  let buttons = []; // rebuilt on every READY frame: {x,y,w,h,fn}
  let joy = null;   // active touch joystick: {id, ax, ay, x, y}

  function canvasPos(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return [(clientX - r.left) * canvas.width / r.width,
            (clientY - r.top) * canvas.height / r.height];
  }

  function uiTapAt(x, y) {
    audio.ensureStarted();
    if (game.state === State.READY || game.state === State.ROUND_OVER || game.state === State.MATCH_OVER) {
      const b = buttons.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      if (b) { b.fn(); return; }
      // tap anywhere else still advances between rounds
      if (game.state === State.ROUND_OVER) { applySpeed(); game.startRound(); }
    }
  }
  window.__uiTap = uiTapAt; // verification hook

  canvas.addEventListener('click', (e) => {
    const [x, y] = canvasPos(e.clientX, e.clientY);
    uiTapAt(x, y);
  });

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    const [x, y] = canvasPos(t.clientX, t.clientY);
    if (game.state === State.PLAYING) {
      // floating joystick: base anchors wherever the finger lands
      joy = { id: t.identifier, ax: x, ay: y, x, y };
    } else {
      uiTapAt(x, y);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!joy) return;
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) {
        const [x, y] = canvasPos(t.clientX, t.clientY);
        joy.x = x; joy.y = y;
      }
    }
  }, { passive: false });

  function endTouch(e) {
    if (!joy) return;
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) joy = null; // direction persists (continuous movement)
    }
  }
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);

  // ---------- adaptive audio (POKEY-style square ostinato) ----------
  const audio = {
    ctx: null, muted: false, nextNoteTime: 0, noteIndex: 0,
    notes: [82.41, 73.42, 65.41, 61.74], // E2 D2 C2 B1 — Space Invaders homage
    ensureStarted() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.nextNoteTime = this.ctx.currentTime + 0.1;
    },
    blip(freq, when) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12, when);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.09);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(when); osc.stop(when + 0.1);
    },
    schedule() {
      if (!this.ctx || this.muted || game.state !== State.PLAYING) return;
      const { noteIntervalMs, pitchMult } = game.audioParams();
      const lookahead = this.ctx.currentTime + 0.12;
      while (this.nextNoteTime < lookahead) {
        if (this.nextNoteTime < this.ctx.currentTime) this.nextNoteTime = this.ctx.currentTime;
        this.blip(this.notes[this.noteIndex % this.notes.length] * pitchMult, this.nextNoteTime);
        this.noteIndex += 1;
        this.nextNoteTime += noteIntervalMs / 1000;
      }
    },
    catchJingle() {
      if (!this.ctx || this.muted) return;
      const t = this.ctx.currentTime;
      [523.25, 659.25, 783.99].forEach((f, i) => this.blip(f, t + i * 0.09));
    },
  };

  // ---------- rendering ----------
  /** Hue at a given game time (seconds). 40°/s → full cycle every 9s. */
  function hueAt(t) { return (t * 40) % 360; }
  function colorAt(t) { return `hsl(${hueAt(t)}, 100%, 55%)`; }

  function drawPlayer(p, isChaser) {
    const color = colorAt(game.time);
    ctx.lineWidth = game.cfg.trailWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const t = p.trail;
    for (let i = 1; i < t.length; i++) {
      ctx.strokeStyle = colorAt(t[i].t);
      ctx.beginPath();
      ctx.moveTo(t[i - 1].x, t[i - 1].y);
      ctx.lineTo(t[i].x, t[i].y);
      ctx.stroke();
    }
    if (t.length) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(t[t.length - 1].x, t[t.length - 1].y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, game.cfg.trailWidth / 2 + 0.5, 0, Math.PI * 2);
    ctx.fill();
    if (isChaser) {
      ctx.shadowColor = '#ffffff';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, game.cfg.trailWidth / 2 + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function centerText(text, y, size, color) {
    ctx.fillStyle = color || '#ffffff';
    ctx.font = `${size}px "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.direction = 'rtl';
    ctx.fillText(text, canvas.width / 2, y);
  }

  function drawButton(label, cx, y, w, h, selected, fn) {
    const x = cx - w / 2;
    ctx.save();
    ctx.beginPath();
    const r = h / 2;
    ctx.roundRect(x, y, w, h, r);
    if (selected) {
      ctx.shadowColor = colorAt(game.time);
      ctx.shadowBlur = 12;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fill();
      ctx.strokeStyle = '#666666';
      ctx.lineWidth = 1;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = selected ? '#ffffff' : '#bbbbbb';
    ctx.font = '16px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.direction = 'rtl';
    ctx.fillText(label, cx, y + h / 2 + 1);
    ctx.restore();
    buttons.push({ x, y, w, h, fn });
  }

  /** A row of mutually exclusive options, drawn right-to-left. */
  function drawChoiceRow(rowLabel, options, selectedKey, y, onPick) {
    centerText(rowLabel, y - 7, 13, '#888888'); // label above the row
    const w = 92, h = 30, gap = 10;
    const total = options.length * w + (options.length - 1) * gap;
    let cx = canvas.width / 2 + total / 2 - w / 2; // rightmost first (RTL)
    for (const opt of options) {
      drawButton(opt.label, cx, y, w, h, selectedKey === opt.key, () => onPick(opt.key));
      cx -= w + gap;
    }
  }

  function drawMenu() {
    buttons = [];
    ctx.save();
    ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 18;
    centerText('תופסת ארקייד', 78, 40);
    ctx.restore();
    centerText('הרודף (טבעת לבנה) מנסה לתפוס את הבורח לפני שנגמר הזמן.', 118, 16);
    centerText('תפיסה = נקודה לרודף · נגמר הזמן = נקודה לבורח · ראשון ל־3 מנצח.', 142, 16);
    centerText('השובלים צבעוניים בלבד — מותר לחצות אותם. הסאונד מאיץ כשהמרחק מתקצר!', 166, 16);

    drawChoiceRow('מצב משחק', [
      { key: true, label: 'נגד המחשב' },
      { key: false, label: 'שני שחקנים' },
    ], settings.aiMode, 212, (k) => { settings.aiMode = k; });

    if (settings.aiMode) {
      drawChoiceRow('רמת קושי', [
        { key: 'easy', label: 'קל' },
        { key: 'medium', label: 'בינוני' },
        { key: 'hard', label: 'קשה' },
      ], settings.difficulty, 274, (k) => { settings.difficulty = k; });
    }

    drawChoiceRow('מהירות', [
      { key: 'slow', label: 'איטי' },
      { key: 'normal', label: 'רגיל' },
      { key: 'fast', label: 'מהיר' },
    ], settings.speed, 336, (k) => { settings.speed = k; });

    // start button
    ctx.save();
    ctx.shadowColor = colorAt(game.time);
    ctx.shadowBlur = 16;
    drawButton('התחל משחק', canvas.width / 2, 392, 180, 44, true, advanceState);
    ctx.restore();

    centerText(settings.aiMode
      ? 'שחקן 1 — W,A,S,D או מגע · רווח להתחלה · M להשתקה'
      : 'שחקן 1 — W,A,S,D · שחקן 2 — חצים · רווח להתחלה · M להשתקה',
      472, 14, '#888888');
  }

  function drawJoystick() {
    if (!joy) return;
    const dx = joy.x - joy.ax, dy = joy.y - joy.ay;
    const len = Math.hypot(dx, dy);
    const max = 42;
    const kx = joy.ax + (len > max ? dx / len * max : dx);
    const ky = joy.ay + (len > max ? dy / len * max : dy);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(joy.ax, joy.ay, max, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    ctx.arc(kx, ky, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function draw() {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const { closeness } = game.audioParams();
    ctx.strokeStyle = `rgba(255,255,255,${0.25 + 0.6 * closeness})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

    if (game.state !== State.READY) {
      game.players.forEach((p, i) => drawPlayer(p, i === game.chaserIndex));
    }

    ctx.font = '16px "Helvetica Neue", Arial, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(`P1 ${game.scores[0]}`, 14, 24);
    ctx.textAlign = 'right';
    ctx.fillText(`${game.scores[1]} P2`, canvas.width - 14, 24);

    if (game.state === State.PLAYING) {
      // prominent round timer — pulses red when time is almost up
      const tl = game.timeLeft();
      const urgent = tl <= 5;
      ctx.save();
      ctx.translate(canvas.width / 2, 34);
      const pulse = urgent ? 1 + 0.15 * Math.sin(game.time * 10) : 1;
      ctx.scale(pulse, pulse);
      ctx.shadowColor = urgent ? '#ff3333' : '#ffffff';
      ctx.shadowBlur = urgent ? 16 : 6;
      ctx.fillStyle = urgent ? '#ff5555' : '#ffffff';
      ctx.font = '30px "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.ceil(tl)), 0, 0);
      ctx.restore();
      drawJoystick();
    }

    if (game.state === State.READY) {
      drawMenu();
    } else if (game.state === State.COUNTDOWN) {
      const remain = 3 - game.stateTime;
      const left = Math.ceil(remain);
      const frac = remain - (left - 1); // 1 → 0 within each second
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      const pop = 1 + 0.6 * Math.max(0, frac - 0.7) / 0.3;
      ctx.scale(pop, pop);
      ctx.shadowColor = colorAt(game.time);
      ctx.shadowBlur = 26;
      ctx.fillStyle = '#ffffff';
      ctx.font = '72px "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(left), 0, 26);
      ctx.restore();
      const chaserName = game.chaserIndex === 0 ? 'שחקן 1' : p2Name();
      const runnerName = game.chaserIndex === 0 ? p2Name() : 'שחקן 1';
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2 + 78);
      const breathe = 1 + 0.06 * Math.sin(game.time * 6);
      ctx.scale(breathe, breathe);
      ctx.shadowColor = colorAt(game.time);
      ctx.shadowBlur = 14;
      ctx.fillStyle = '#ffffff';
      ctx.font = '24px "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.direction = 'rtl';
      ctx.fillText(`${chaserName} רודף את ${runnerName}`, 0, 0);
      ctx.restore();
      game.players.forEach((p, i) => {
        const isC = i === game.chaserIndex;
        const bob = Math.sin(game.time * 5 + i) * 4;
        ctx.save();
        ctx.shadowColor = isC ? '#ff4444' : '#44ff88';
        ctx.shadowBlur = 12;
        ctx.fillStyle = isC ? '#ff8888' : '#88ffbb';
        ctx.font = '15px "Helvetica Neue", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.direction = 'rtl';
        ctx.fillText(isC ? 'רודף' : 'בורח', p.x, p.y - 18 + bob);
        ctx.restore();
      });
    } else if (game.state === State.ROUND_OVER || game.state === State.MATCH_OVER) {
      buttons = [];
      const r = game.lastRoundResult;
      const who = r.winnerIndex === 0 ? 'שחקן 1' : p2Name();
      const why = r.reason === 'catch' ? 'תפיסה!' : 'הזמן נגמר';
      const headline = game.state === State.MATCH_OVER
        ? `${who} ניצח את המשחק!`
        : `${who} לקח את הסיבוב — ${why}`;
      centerText(headline, canvas.height / 2 - 30, 26);
      if (game.state === State.MATCH_OVER) {
        drawButton('משחק חדש', canvas.width / 2 - 100, canvas.height / 2 + 14, 160, 40, true,
          () => { applySpeed(); game.resetMatch(); game.startRound(); });
        drawButton('מסך הבית', canvas.width / 2 + 100, canvas.height / 2 + 14, 160, 40, false,
          () => game.resetMatch());
      } else {
        drawButton('לסיבוב הבא', canvas.width / 2 - 100, canvas.height / 2 + 14, 160, 40, true,
          () => { applySpeed(); game.startRound(); });
        drawButton('מסך הבית', canvas.width / 2 + 100, canvas.height / 2 + 14, 160, 40, false,
          () => game.resetMatch());
      }
      centerText('רווח להמשך · Esc למסך הבית', canvas.height / 2 + 84, 14, '#888888');
    }
  }
  window.__draw = draw; // verification/debug hook

  // ---------- main loop ----------
  let last = performance.now();
  let prevState = game.state;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (game.state === State.PLAYING) {
      // P1: floating joystick (if active) takes priority over keys
      if (joy) {
        const dx = joy.x - joy.ax, dy = joy.y - joy.ay;
        if (Math.hypot(dx, dy) > 12) game.players[0].setDirection(dx, dy);
      } else {
        const [d1x, d1y] = dirFor(P1);
        game.players[0].setDirection(d1x, d1y);
      }
      if (settings.aiMode) {
        aiTimer -= dt;
        if (aiTimer <= 0) { // reaction cadence per difficulty preset
          const preset = PRESETS[settings.difficulty];
          aiTimer = preset.interval;
          const [ax, ay] = computeAIDirection(game, 1, preset.ai);
          game.players[1].setDirection(ax, ay);
        }
      } else {
        const [d2x, d2y] = dirFor(P2);
        game.players[1].setDirection(d2x, d2y);
      }
    }
    game.step(dt);
    if ((game.state === State.ROUND_OVER || game.state === State.MATCH_OVER) && prevState === State.PLAYING) {
      audio.catchJingle();
    }
    prevState = game.state;
    audio.schedule();
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
