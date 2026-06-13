/**
 * arcade-tag — browser layer: rendering, input, adaptive audio.
 * Audio: Web Audio square-wave ostinato (POKEY homage). Note rate + pitch
 * are driven directly by the Euclidean distance between the two players.
 * Visuals: all players share one hue-cycling color; trail segments keep
 * the hue they were laid down with (persistent rainbow); player heads are
 * the live tip of the line; a white ring marks the chaser (classic mode).
 * Input: keyboard (P1 WASD, P2 arrows), tap-to-select menus, and a
 * floating virtual touch joystick for P1 (spec section 9.1).
 * Phase 2: catch-moment effects (flash / rings / particle rays),
 * power-ups (dash / freeze / ghost), and game modes (classic / koth /
 * infection) selectable from the menu.
 */
(function () {
  'use strict';
  const { Game, State, SPEEDS } = window.GameCore;
  const { computeAIDirection, PRESETS } = window.GameAI;

  const canvas = document.getElementById('arena');
  const ctx = canvas.getContext('2d');

  // ---------- settings (start-screen selectable) ----------
  // opponent: 'cpu' (vs computer) | 'local' (two players, one keyboard) | 'online'
  const settings = { opponent: 'cpu', difficulty: 'medium', speed: 'normal', gameMode: 'classic' };
  window.__settings = settings; // verification hook

  // Infection is a 4-player vs-computer mode; otherwise the opponent setting rules.
  function isAI() { return settings.gameMode === 'infection' || settings.opponent === 'cpu'; }
  function isOnline() { return settings.gameMode !== 'infection' && settings.opponent === 'online'; }
  const NET = window.Net || null;
  function netRole() { return NET && NET.isConnected() ? NET.role : null; }
  function amHost() { return isOnline() && netRole() === 'host'; }
  function amGuest() { return isOnline() && netRole() === 'guest'; }

  function makeGame() {
    return new Game({ width: canvas.width, height: canvas.height, mode: settings.gameMode });
  }
  let game = makeGame();
  window.__game = game; // exposed for automated verification

  // ---------- networking state (Phase 3) ----------
  const SNAP_INTERVAL = 1 / 30;   // host broadcast / guest input rate (s)
  let netSendClock = 0;           // throttle accumulator
  let guestInput = [0, 0];        // host: latest direction received from the guest
  let seenEventKey = null;        // guest: dedupe one-shot effects across snapshots
  let netMsg = '';                // status line shown in the online menu panel

  /** Rebuild the Game when the selected mode differs (fresh 0:0 match). */
  function syncMode() {
    if (game.mode === settings.gameMode) return;
    game = makeGame();
    window.__game = game;
    effects = [];
    seenEvent = null;
    seenEventKey = null;
    prevState = game.state;
  }
  window.__setMode = function (m) { // verification hook
    if (m !== 'classic' && m !== 'koth' && m !== 'infection') return;
    settings.gameMode = m;
    if (m === 'infection' && settings.opponent !== 'local') settings.opponent = 'cpu'; // infection: vs-computer only
    syncMode();
  };

  function p2Name() { return isAI() ? 'המחשב' : 'שחקן 2'; }
  function playerName(i) {
    if (game.players.length > 2) return i === 0 ? 'שחקן 1' : `מחשב ${i + 1}`;
    return i === 0 ? 'שחקן 1' : p2Name();
  }
  function applySpeed() { game.cfg.speed = SPEEDS[settings.speed]; }

  let aiTimer = 0;

  // ---------- networking wiring (Phase 3) ----------
  const NET_STATUS_TEXT = {
    idle: '', hosting: 'יוצר חדר…', waiting: 'ממתין לשחקן 2…',
    connecting: 'מתחבר…', connected: 'מחובר ✓', closed: 'החיבור נותק',
  };

  function onNetStatus(s, err) {
    netMsg = s === 'error' ? `שגיאה: ${err || 'נכשל'}` : (NET_STATUS_TEXT[s] || '');
  }

  function onNetConnected() {
    netMsg = NET_STATUS_TEXT.connected;
    // Guest mirrors the host's mode/state via snapshots; start from a clean game.
    if (NET.role === 'guest') { effects = []; seenEvent = null; seenEventKey = null; }
  }

  function onNetClosed() {
    netMsg = NET_STATUS_TEXT.closed;
    guestInput = [0, 0];
    // If a networked match was in progress, fall back to the menu.
    if (game.state !== State.READY) { game.resetMatch(); }
  }

  function onNetData(d) {
    if (!d || typeof d !== 'object') return;
    if (NET.role === 'host') {
      if (d.t === 'in' && Array.isArray(d.d)) guestInput = [d.d[0] || 0, d.d[1] || 0];
    } else { // guest receives authoritative snapshots
      if (d.t === 's' && d.snap) {
        if (settings.gameMode !== d.snap.mode) {
          settings.gameMode = d.snap.mode; // adopt host's mode, rebuild mirror
          game = makeGame();
          window.__game = game;
          effects = []; seenEvent = null; seenEventKey = null;
        }
        game.applySnapshot(d.snap);
      }
    }
  }

  if (NET) {
    NET.onStatus = onNetStatus;
    NET.onConnected = onNetConnected;
    NET.onClosed = onNetClosed;
    NET.onData = onNetData;
  }

  function hostGame() {
    if (!NET) { netMsg = 'אונליין לא זמין'; return; }
    const code = NET.host();
    netMsg = code ? `קוד החדר: ${code}` : netMsg;
  }
  function joinGame() {
    if (!NET) { netMsg = 'אונליין לא זמין'; return; }
    const code = window.prompt('הזן קוד חדר (5 תווים):', '');
    if (code) NET.join(code);
  }
  function leaveOnline() { if (NET) NET.close(); netMsg = ''; }

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
    if (amGuest()) return; // online: the host drives round flow
    if (isOnline() && !NET.isConnected()) { // need a partner before starting
      netMsg = 'התחברו תחילה (אירוח או הצטרפות)';
      return;
    }
    if (game.state === State.READY) syncMode();
    if (game.state === State.READY || game.state === State.ROUND_OVER) { applySpeed(); game.startRound(); }
    else if (game.state === State.MATCH_OVER) { game.resetMatch(); }
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); advanceState(); return; }
    if (e.code === 'Escape') { if (!amGuest()) game.resetMatch(); return; } // back to menu anytime
    if (e.code === 'KeyM') { audio.muted = !audio.muted; return; }
    if (game.state === State.READY && !isOnline() && (e.code === 'Digit1' || e.code === 'Digit2')) {
      settings.opponent = (e.code === 'Digit1' || settings.gameMode === 'infection') ? 'cpu' : 'local';
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

  // ---------- event effects (catch / infect / pickup) ----------
  let effects = [];   // {kind: 'boom'|'pop', x, y, t} — t is a local clock (s)
  let seenEvent = null;

  function spawnEffect(ev) {
    if (!ev) return;
    effects.push({ kind: ev.type === 'pickup' ? 'pop' : 'boom', x: ev.x, y: ev.y, t: 0 });
  }

  function drawEffects(dt) {
    for (const e of effects) e.t += dt;
    effects = effects.filter(e => e.t < (e.kind === 'boom' ? 1.0 : 0.45));
    for (const e of effects) {
      if (e.kind === 'boom') {
        // brief white screen flash
        if (e.t < 0.25) {
          ctx.fillStyle = `rgba(255,255,255,${(0.45 * (1 - e.t / 0.25)).toFixed(3)})`;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        // expanding glowing rings
        for (let r = 0; r < 3; r++) {
          const rt = (e.t - r * 0.08) / 0.9;
          if (rt <= 0 || rt >= 1) continue;
          ctx.save();
          ctx.globalAlpha = 1 - rt;
          ctx.strokeStyle = '#ffffff';
          ctx.shadowColor = colorAt(game.time);
          ctx.shadowBlur = 14;
          ctx.lineWidth = 3 - 2 * rt;
          ctx.beginPath();
          ctx.arc(e.x, e.y, 10 + rt * (90 + r * 30), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        // 16 particle rays at deterministic angles, slight per-index speed variation
        const pt = e.t / 0.8;
        if (pt < 1) {
          ctx.save();
          ctx.globalAlpha = 1 - pt;
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2;
            const sp = 150 + (i % 4) * 35;
            const px = e.x + Math.cos(a) * sp * e.t;
            const py = e.y + Math.sin(a) * sp * e.t;
            ctx.fillStyle = colorAt(game.time + i * 0.4);
            ctx.beginPath();
            ctx.arc(px, py, 2.5 * (1 - pt) + 0.5, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      } else { // pickup pop
        const rt = e.t / 0.45;
        ctx.save();
        ctx.globalAlpha = 1 - rt;
        ctx.strokeStyle = '#ffffff';
        ctx.shadowColor = colorAt(game.time);
        ctx.shadowBlur = 10;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.x, e.y, 6 + rt * 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // ---------- rendering ----------
  /** Hue at a given game time (seconds). 40°/s → full cycle every 9s. */
  function hueAt(t) { return (t * 40) % 360; }
  function colorAt(t) { return `hsl(${hueAt(t)}, 100%, 55%)`; }

  const RING_COLORS = { chaser: '#ffffff', infected: '#ff5555', safe: '#66ff99' };

  /** ring: null | 'chaser' | 'infected' | 'safe' */
  function drawPlayer(p, ring) {
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
    if (p.fx && p.fx.ghost > 0) return; // ghosting: no head, no live tip
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
    if (ring) {
      const rc = RING_COLORS[ring] || '#ffffff';
      ctx.shadowColor = rc;
      ctx.strokeStyle = rc;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, game.cfg.trailWidth / 2 + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function ringFor(i) {
    if (game.mode === 'infection') return game.infected[i] ? 'infected' : 'safe';
    if (game.mode === 'koth') return null; // no roles on the hill
    return i === game.chaserIndex ? 'chaser' : null;
  }

  const POWERUP_STYLE = {
    dash:   { color: '#ffd633', glyph: '⚡' },
    freeze: { color: '#44ddff', glyph: '❄' },
    ghost:  { color: '#bb66ff', glyph: '👻' },
  };

  function drawPowerups() {
    for (const pu of game.powerups) {
      const s = POWERUP_STYLE[pu.type];
      const r = game.cfg.powerupRadius + 2;
      ctx.save();
      ctx.translate(pu.x, pu.y);
      ctx.rotate(game.time * 2); // rotating glowing diamond
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 14;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.beginPath();
      ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 8;
      ctx.fillStyle = s.color;
      ctx.font = '11px "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.glyph, pu.x, pu.y + 1);
      ctx.restore();
    }
  }

  function drawZone() {
    if (game.mode !== 'koth' || !game.zone) return;
    const z = game.zone, R = game.cfg.kothZoneRadius;
    const pulse = 1 + 0.05 * Math.sin(game.time * 4);
    ctx.save();
    ctx.shadowColor = colorAt(game.time);
    ctx.shadowBlur = 18;
    ctx.strokeStyle = colorAt(game.time);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(z.x, z.y, R * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = '#ffffff';
    ctx.fill();
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
    ctx.font = '15px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.direction = 'rtl';
    ctx.fillText(label, cx, y + h / 2 + 1);
    ctx.restore();
    buttons.push({ x, y, w, h, fn });
  }

  /** A row of mutually exclusive options, drawn right-to-left. */
  function drawChoiceRow(rowLabel, options, selectedKey, y, onPick, btnW) {
    centerText(rowLabel, y - 7, 13, '#888888'); // label above the row
    const w = btnW || 92, h = 30, gap = 10;
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
    centerText('תופסת ארקייד', 70, 38);
    ctx.restore();
    centerText('הרודף (טבעת לבנה) מנסה לתפוס את הבורח לפני שנגמר הזמן.', 106, 15);
    centerText('תפיסה = נקודה לרודף · נגמר הזמן = נקודה לבורח · ראשון ל־3 מנצח.', 128, 15);
    centerText('השובלים צבעוניים בלבד — מותר לחצות אותם. הסאונד מאיץ כשהמרחק מתקצר!', 150, 15);

    drawChoiceRow('סוג משחק', [
      { key: 'classic', label: 'קלאסי' },
      { key: 'koth', label: 'מלך הגבעה' },
      { key: 'infection', label: 'הדבקה' },
    ], settings.gameMode, 188, (k) => {
      settings.gameMode = k;
      if (k === 'infection' && settings.opponent !== 'local') {
        if (isOnline()) leaveOnline();
        settings.opponent = 'cpu'; // infection: vs-computer only
      }
      syncMode();
    }, 104);

    if (settings.gameMode !== 'infection') {
      drawChoiceRow('מצב משחק', [
        { key: 'cpu', label: 'נגד המחשב' },
        { key: 'local', label: 'שני שחקנים' },
        { key: 'online', label: 'אונליין' },
      ], settings.opponent, 240, (k) => {
        if (k !== 'online' && isOnline()) leaveOnline();
        settings.opponent = k;
      }, 92);
    }

    if (isAI()) {
      drawChoiceRow('רמת קושי', [
        { key: 'easy', label: 'קל' },
        { key: 'medium', label: 'בינוני' },
        { key: 'hard', label: 'קשה' },
      ], settings.difficulty, 292, (k) => { settings.difficulty = k; });
    } else if (isOnline()) {
      drawOnlinePanel(292);
    }

    drawChoiceRow('מהירות', [
      { key: 'slow', label: 'איטי' },
      { key: 'normal', label: 'רגיל' },
      { key: 'fast', label: 'מהיר' },
    ], settings.speed, 344, (k) => { settings.speed = k; });

    // start button
    ctx.save();
    ctx.shadowColor = colorAt(game.time);
    ctx.shadowBlur = 16;
    drawButton('התחל משחק', canvas.width / 2, 398, 180, 44, true, advanceState);
    ctx.restore();

    centerText('בונוסים: ⚡ האצה · ❄ הקפאת יריב · 👻 היעלמות', 470, 14, '#aaaaaa');
    centerText(isOnline()
      ? 'אונליין — שלטו ב־W,A,S,D או מגע · המארח לוחץ רווח להתחלה · M להשתקה'
      : isAI()
        ? 'שחקן 1 — W,A,S,D או מגע · רווח להתחלה · M להשתקה'
        : 'שחקן 1 — W,A,S,D · שחקן 2 — חצים · רווח להתחלה · M להשתקה',
      494, 13, '#888888');
  }

  /** Online (Phase 3) sub-panel: host / join actions, room code, status. */
  function drawOnlinePanel(y) {
    const st = NET ? NET.status : 'idle';
    const connected = NET && NET.isConnected();
    let line;
    if (!NET) line = 'אונליין אינו זמין בדפדפן זה';
    else if (connected) line = NET.role === 'host' ? 'שחקן 2 מחובר ✓ — לחצו "התחל משחק"' : 'מחובר ✓ — ממתין למארח';
    else if ((st === 'hosting' || st === 'waiting') && NET.code) line = `קוד החדר: ${NET.code} · ${NET_STATUS_TEXT[st]}`;
    else line = netMsg || 'שחקו מול חבר דרך האינטרנט';
    centerText(line, y - 6, 14, connected ? '#88ffbb' : (st === 'error' ? '#ff8888' : '#aaaaaa'));
    if (!NET) return;
    if (connected) {
      drawButton('התנתק', canvas.width / 2, y + 6, 130, 30, false, leaveOnline);
    } else if (st === 'hosting' || st === 'waiting' || st === 'connecting') {
      drawButton('ביטול', canvas.width / 2, y + 6, 130, 30, false, leaveOnline);
    } else {
      const w = 120, h = 30, gap = 12, total = 2 * w + gap;
      let cx = canvas.width / 2 + total / 2 - w / 2; // rightmost first (RTL)
      drawButton('אירוח', cx, y + 6, w, h, true, hostGame); cx -= w + gap;
      drawButton('הצטרפות', cx, y + 6, w, h, false, joinGame);
    }
  }

  /** Guest's pre-game screen while the host is still in the menu. */
  function drawGuestWaiting() {
    buttons = [];
    ctx.save();
    ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 18;
    centerText('תופסת ארקייד', 150, 38);
    ctx.restore();
    centerText('מחוברים לחדר ' + (NET && NET.code ? NET.code : ''), 220, 18, '#88ffbb');
    const dots = '.'.repeat(1 + (Math.floor(game.time * 2) % 3));
    centerText('ממתין שהמארח יתחיל את המשחק' + dots, 260, 18);
    centerText('שלטו בעזרת W,A,S,D או מגע', 300, 14, '#888888');
    drawButton('התנתק', canvas.width / 2, 340, 130, 32, false, leaveOnline);
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

  function drawHud() {
    ctx.font = '16px "Helvetica Neue", Arial, sans-serif';
    ctx.fillStyle = '#ffffff';
    if (game.mode === 'koth') {
      const win = game.cfg.kothWinSeconds;
      ctx.textAlign = 'left';
      ctx.fillText(`P1 ${Math.floor(game.zoneScore[0])}/${win} · ${game.scores[0]}`, 14, 24);
      ctx.textAlign = 'right';
      ctx.fillText(`${game.scores[1]} · ${Math.floor(game.zoneScore[1])}/${win} P2`, canvas.width - 14, 24);
    } else if (game.mode === 'infection') {
      ctx.textAlign = 'left';
      ctx.fillText(game.scores.map((s, i) => `P${i + 1} ${s}`).join(' · '), 14, 24);
      const healthy = game.infected.filter(v => !v).length;
      ctx.save();
      ctx.textAlign = 'right';
      ctx.direction = 'rtl';
      ctx.fillText(`בריאים: ${healthy}`, canvas.width - 14, 24);
      ctx.restore();
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(`P1 ${game.scores[0]}`, 14, 24);
      ctx.textAlign = 'right';
      ctx.fillText(`${game.scores[1]} P2`, canvas.width - 14, 24);
    }
  }

  function countdownLabel() {
    if (game.mode === 'koth') return 'שלטו באזור!';
    if (game.mode === 'infection') return `${playerName(game.chaserIndex)} מתחיל נגוע — ברחו!`;
    const chaserName = playerName(game.chaserIndex);
    const runnerName = playerName(1 - game.chaserIndex);
    return `${chaserName} רודף את ${runnerName}`;
  }

  function draw(frameDt) {
    const dt = frameDt || 0;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const { closeness } = game.audioParams();
    ctx.strokeStyle = `rgba(255,255,255,${0.25 + 0.6 * closeness})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

    if (game.state !== State.READY) {
      drawZone();
      drawPowerups();
      game.players.forEach((p, i) => drawPlayer(p, ringFor(i)));
    }

    drawHud();

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
      if (amGuest()) drawGuestWaiting(); else drawMenu();
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
      ctx.fillText(countdownLabel(), 0, 0);
      ctx.restore();
      if (game.mode !== 'koth') {
        game.players.forEach((p, i) => {
          const infectionMode = game.mode === 'infection';
          const marked = infectionMode ? game.infected[i] : i === game.chaserIndex;
          const bob = Math.sin(game.time * 5 + i) * 4;
          ctx.save();
          ctx.shadowColor = marked ? '#ff4444' : '#44ff88';
          ctx.shadowBlur = 12;
          ctx.fillStyle = marked ? '#ff8888' : '#88ffbb';
          ctx.font = '15px "Helvetica Neue", Arial, sans-serif';
          ctx.textAlign = 'center';
          ctx.direction = 'rtl';
          ctx.fillText(infectionMode ? (marked ? 'נגוע' : 'בריא') : (marked ? 'רודף' : 'בורח'),
            p.x, p.y - 18 + bob);
          ctx.restore();
        });
      }
    } else if (game.state === State.ROUND_OVER || game.state === State.MATCH_OVER) {
      buttons = [];
      const r = game.lastRoundResult;
      const who = playerName(r.winnerIndex);
      let headline;
      if (game.state === State.MATCH_OVER) {
        headline = `${who} ניצח את המשחק!`;
      } else if (r.reason === 'survivor') {
        headline = `${who} שרד אחרון!`;
      } else {
        const why = r.reason === 'catch' ? 'תפיסה!'
          : r.reason === 'zone' ? 'שליטה בגבעה!'
          : 'הזמן נגמר';
        headline = `${who} לקח את הסיבוב — ${why}`;
      }
      centerText(headline, canvas.height / 2 - 30, 26);
      if (amGuest()) {
        // online guest: the host controls round flow
        const dots = '.'.repeat(1 + (Math.floor(game.time * 2) % 3));
        centerText('ממתין למארח' + dots, canvas.height / 2 + 40, 16, '#aaaaaa');
      } else if (game.state === State.MATCH_OVER) {
        drawButton('משחק חדש', canvas.width / 2 - 100, canvas.height / 2 + 14, 160, 40, true,
          () => { applySpeed(); game.resetMatch(); game.startRound(); });
        drawButton('מסך הבית', canvas.width / 2 + 100, canvas.height / 2 + 14, 160, 40, false,
          () => game.resetMatch());
        centerText('רווח להמשך · Esc למסך הבית', canvas.height / 2 + 84, 14, '#888888');
      } else {
        drawButton('לסיבוב הבא', canvas.width / 2 - 100, canvas.height / 2 + 14, 160, 40, true,
          () => { applySpeed(); game.startRound(); });
        drawButton('מסך הבית', canvas.width / 2 + 100, canvas.height / 2 + 14, 160, 40, false,
          () => game.resetMatch());
        centerText('רווח להמשך · Esc למסך הבית', canvas.height / 2 + 84, 14, '#888888');
      }
    }

    drawEffects(dt);
  }
  window.__draw = draw; // verification/debug hook
  window.__buttons = buttons; // refreshed below each frame

  // ---------- AI drivers per mode ----------
  /** Nearest player on the opposite infection side; null when none. */
  function infectionTarget(i) {
    const me = game.players[i];
    const amInfected = game.infected[i];
    let best = -1, bestD = Infinity;
    for (let j = 0; j < game.players.length; j++) {
      if (j === i || game.infected[j] === amInfected) continue;
      const d = Math.hypot(game.players[j].x - me.x, game.players[j].y - me.y);
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best < 0) return null;
    return { foeIndex: best, role: amInfected ? 'chase' : 'flee' };
  }

  function driveAI(dt) {
    aiTimer -= dt;
    if (aiTimer > 0) return;
    const preset = PRESETS[settings.difficulty];
    aiTimer = preset.interval;
    if (game.mode === 'infection') {
      // players 1..3 are AI: infected chase the nearest healthy player,
      // healthy AIs flee the nearest infected one
      for (let i = 1; i < game.players.length; i++) {
        const t = infectionTarget(i);
        if (!t) continue;
        const [ax, ay] = computeAIDirection(game, i, preset.ai, null, t);
        game.players[i].setDirection(ax, ay);
      }
    } else if (game.mode === 'koth') {
      // simple seek toward the zone center, with slight jitter
      if (!game.zone) return;
      const p = game.players[1], z = game.zone;
      p.setDirection(z.x - p.x + (Math.random() - 0.5) * 40,
                     z.y - p.y + (Math.random() - 0.5) * 40);
    } else {
      const [ax, ay] = computeAIDirection(game, 1, preset.ai);
      game.players[1].setDirection(ax, ay);
    }
  }

  /** Read the local player's intended direction (joystick > keys). */
  function localInput() {
    if (joy) {
      const dx = joy.x - joy.ax, dy = joy.y - joy.ay;
      if (Math.hypot(dx, dy) > 12) return [dx, dy];
      return [0, 0];
    }
    return dirFor(P1);
  }

  /** Guest: spawn a catch/pickup effect once per host event (deduped by id). */
  function handleGuestEvent() {
    const ev = game.lastEvent;
    if (!ev) return;
    const key = ev.type + '@' + (ev.time != null ? ev.time.toFixed(3) : '');
    if (key !== seenEventKey) { seenEventKey = key; spawnEffect(ev); }
  }

  // ---------- main loop ----------
  let last = performance.now();
  let prevState = game.state;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    if (amGuest()) {
      // Thin client: never steps the sim — it only sends input and renders
      // the authoritative snapshots that arrive over the data channel.
      let gx = 0, gy = 0;
      if (game.state === State.PLAYING) { const [a, b] = localInput(); gx = a; gy = b; }
      netSendClock += dt;
      if (netSendClock >= SNAP_INTERVAL) { netSendClock = 0; NET.send({ t: 'in', d: [gx, gy] }); }
      handleGuestEvent();
      if ((game.state === State.ROUND_OVER || game.state === State.MATCH_OVER) && prevState === State.PLAYING) {
        audio.catchJingle();
      }
      prevState = game.state;
      audio.schedule();
      draw(dt);
      window.__buttons = buttons;
      requestAnimationFrame(frame);
      return;
    }

    if (game.state === State.PLAYING) {
      const [d1x, d1y] = localInput();
      game.players[0].setDirection(d1x, d1y);
      if (amHost()) {
        game.players[1].setDirection(guestInput[0], guestInput[1]); // remote player
      } else if (isAI()) {
        driveAI(dt);
      } else {
        const [d2x, d2y] = dirFor(P2);
        game.players[1].setDirection(d2x, d2y);
      }
    }
    game.step(dt);
    if (game.lastEvent && game.lastEvent !== seenEvent) {
      seenEvent = game.lastEvent;
      spawnEffect(game.lastEvent);
    }
    if ((game.state === State.ROUND_OVER || game.state === State.MATCH_OVER) && prevState === State.PLAYING) {
      audio.catchJingle();
    }
    prevState = game.state;
    // Host: broadcast authoritative state to the guest (throttled), in every
    // game state so the guest mirrors the menu, countdown, play, and results.
    if (amHost()) {
      netSendClock += dt;
      if (netSendClock >= SNAP_INTERVAL) { netSendClock = 0; NET.send({ t: 's', snap: game.snapshot() }); }
    }
    audio.schedule();
    draw(dt);
    window.__buttons = buttons; // verification hook (current hit targets)
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
