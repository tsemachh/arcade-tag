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
  const settings = { opponent: 'cpu', difficulty: 'medium', speed: 'normal', gameMode: 'classic', radar: true, theme: 'boulder', tiltSens: 'med' };
  try { const sv = localStorage.getItem('arcadeTagTheme'); if (sv) settings.theme = sv; } catch (e) {}
  try { const rv = localStorage.getItem('arcadeTagRadar'); if (rv !== null) settings.radar = rv === '1'; } catch (e) {}
  // Restore the player's last choices so the menu opens where they left off.
  (function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('arcadeTagSettings') || '{}');
      const pick = (v, set, cur) => (set.indexOf(v) >= 0 ? v : cur);
      settings.opponent = pick(s.opponent, ['cpu', 'local', 'online'], settings.opponent);
      settings.gameMode = pick(s.gameMode, ['classic', 'koth', 'infection'], settings.gameMode);
      settings.difficulty = pick(s.difficulty, ['easy', 'medium', 'hard'], settings.difficulty);
      settings.speed = pick(s.speed, ['slow', 'normal', 'fast'], settings.speed);
      settings.tiltSens = pick(s.tiltSens, ['low', 'med', 'high'], settings.tiltSens);
    } catch (e) {}
  })();
  function saveSettings() {
    try {
      localStorage.setItem('arcadeTagSettings', JSON.stringify({
        opponent: settings.opponent, gameMode: settings.gameMode,
        difficulty: settings.difficulty, speed: settings.speed, tiltSens: settings.tiltSens,
      }));
    } catch (e) {}
  }
  window.__settings = settings; // verification hook

  // ---------- tilt steering (opt-in mobile gyroscope control) ----------
  // The game is "always moving, you only steer", so the phone's tilt maps
  // straight to a heading. Opt-in (the joystick stays the default), with a
  // neutral pose captured on enable / at each round start, a deadzone so small
  // wobble keeps you going straight, and screen-orientation-aware axis remap so
  // it works the same in portrait or landscape.
  const isTouch = (('ontouchstart' in window) || (navigator.maxTouchPoints > 0));
  const tilt = { active: false, have: false, baseB: 0, baseG: 0, sx: 0, sy: 0 };
  const TILT_DEAD = { low: 9, med: 5.5, high: 3 }; // degrees of tilt before it registers
  function tiltSupported() { return typeof window.DeviceOrientationEvent !== 'undefined'; }
  function screenAngle() {
    try { if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle; } catch (e) {}
    if (typeof window.orientation === 'number') return (window.orientation + 360) % 360;
    return 0;
  }
  function onTilt(e) {
    if (e.beta == null || e.gamma == null) return;
    if (!tilt.have) { tilt.baseB = e.beta; tilt.baseG = e.gamma; tilt.have = true; }
    const dB = e.beta - tilt.baseB, dG = e.gamma - tilt.baseG;
    let x, y;
    switch (screenAngle()) {            // remap device axes into screen space
      case 90:  x = dB;  y = -dG; break;
      case 180: x = -dG; y = -dB; break;
      case 270: x = -dB; y = dG;  break;
      default:  x = dG;  y = dB;          // 0 / portrait
    }
    tilt.sx += (x - tilt.sx) * 0.35;    // light smoothing to tame jitter
    tilt.sy += (y - tilt.sy) * 0.35;
  }
  function enableTilt() {
    if (!tiltSupported()) return;
    const start = () => {
      window.addEventListener('deviceorientation', onTilt);
      tilt.active = true; tilt.have = false; tilt.sx = tilt.sy = 0;
      try { document.documentElement.classList.add('tilt'); } catch (e) {} // suppress the rotate overlay while tilting
    };
    const DO = window.DeviceOrientationEvent;
    if (typeof DO.requestPermission === 'function') {     // iOS 13+ needs a gesture-driven prompt
      DO.requestPermission().then((s) => { if (s === 'granted') start(); }).catch(() => {});
    } else { start(); }                                    // Android / others: just listen
  }
  function disableTilt() { window.removeEventListener('deviceorientation', onTilt); tilt.active = false; try { document.documentElement.classList.remove('tilt'); } catch (e) {} }
  function recalibrateTilt() { if (tilt.active) { tilt.have = false; tilt.sx = tilt.sy = 0; } }
  function cycleSens() { const o = ['low', 'med', 'high']; settings.tiltSens = o[(o.indexOf(settings.tiltSens) + 1) % o.length]; saveSettings(); }
  function sensKey() { return 'sens' + settings.tiltSens.charAt(0).toUpperCase() + settings.tiltSens.slice(1); }
  window.__tilt = tilt; // verification hook

  // ---------- fullscreen (hide the mobile browser URL bar) ----------
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function fsSupported() { const el = document.documentElement; return !!(el.requestFullscreen || el.webkitRequestFullscreen); }
  function toggleFullscreen() {
    const el = document.documentElement;
    try {
      if (fsElement()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
      else { (el.requestFullscreen || el.webkitRequestFullscreen).call(el); }
    } catch (e) {}
  }
  const RADAR_FOG = 16; // trail points hidden at each head while radar is on

  // onboarding: show the how-to overlay once for first-time visitors
  let showHelp = false;
  try { showHelp = !localStorage.getItem('arcadeTagSeen'); } catch (e) {}
  function dismissHelp() { showHelp = false; try { localStorage.setItem('arcadeTagSeen', '1'); } catch (e) {} }
  let showThemes = false; // music picker overlay

  // ---------- i18n ----------
  const STR = {
    he: {
      title: 'תופסת ארקייד',
      rules1: 'הרודף (טבעת לבנה) מנסה לתפוס את הבורח לפני שנגמר הזמן.',
      rules2: 'תפיסה = נקודה לרודף · נגמר הזמן = נקודה לבורח · ראשון ל־3 מנצח.',
      rules3: 'השובלים צבעוניים בלבד — מותר לחצות אותם. הסאונד מאיץ כשהמרחק מתקצר!',
      mClassic1: 'קלאסי — הרודף (טבעת לבנה) רודף אחרי הבורח.',
      mClassic2: 'תפסו לפני שייגמר הזמן, או שִׂרדו כדי לנקד. ראשון ל־3 מנצח.',
      mKoth1: 'מלך הגבעה — שלטו באזור הזוהר הנע.',
      mKoth2: 'הישארו בתוכו 15 שניות מצטברות כדי לזכות בסיבוב.',
      mInf1: 'הדבקה — 4 שחקנים, אחד מתחיל נגוע; מגע מדביק.',
      mInf2: 'התרחקו מהנגועים — השחקן הבריא האחרון מנצח.',
      rowGameType: 'סוג משחק',
      modeClassic: 'קלאסי',
      modeKoth: 'מלך הגבעה',
      modeInfection: 'הדבקה',
      rowOpponent: 'מצב משחק',
      oppCpu: 'נגד המחשב',
      oppLocal: 'שני שחקנים',
      oppOnline: 'אונליין',
      rowDifficulty: 'רמת קושי',
      diffEasy: 'קל',
      diffMedium: 'בינוני',
      diffHard: 'קשה',
      rowSpeed: 'מהירות',
      speedSlow: 'איטי',
      speedNormal: 'רגיל',
      speedFast: 'מהיר',
      startGame: 'התחל משחק',
      powerups: 'בונוסים: ⚡ האצה · ❄ הקפאה · 👻 היעלמות · ↔ תופס רחב · ▽ התכווצות',
      radarLabel: 'מכ״ם קולי',
      radarHint: 'מכ״ם קולי פעיל — אתרו את היריב לפי הצליל',
      hintOnline: 'אונליין — חצים / W,A,S,D / מגע · המארח לוחץ רווח להתחלה · M להשתקה',
      hintAI: 'שחקן 1 — חצים / W,A,S,D / מגע · רווח להתחלה · M להשתקה',
      hintLocal: 'שחקן 1 — W,A,S,D · שחקן 2 — חצים · רווח להתחלה · M להשתקה',
      onlineUnavailableBrowser: 'אונליין אינו זמין בדפדפן זה',
      hostConnectedStart: 'שחקן 2 מחובר ✓ — לחצו "התחל משחק"',
      guestConnectedWaiting: 'מחובר ✓ — ממתין למארח',
      playFriend: 'שחקו מול חבר דרך האינטרנט',
      onlineWifiTip: 'טיפ: בינתיים עובד הכי טוב באותו Wi-Fi',
      btnCopyLink: '🔗 העתק קישור הזמנה',
      linkCopied: 'הקישור הועתק ✓ — שלחו אותו לחבר',
      btnHost: 'אירוח',
      btnJoin: 'הצטרפות',
      btnDisconnect: 'התנתק',
      btnCancel: 'ביטול',
      btnNewMatch: 'משחק חדש',
      btnHome: 'מסך הבית',
      btnNextRound: 'לסיבוב הבא',
      continueEsc: 'רווח להמשך · Esc למסך הבית',
      waitingHost: 'ממתין למארח',
      kothGo: 'שלטו באזור!',
      computer: 'המחשב',
      player1: 'שחקן 1',
      player2: 'שחקן 2',
      cpuN: (n) => `מחשב ${n}`,
      roleInfected: 'נגוע',
      roleHealthy: 'בריא',
      roleChaser: 'רודף',
      roleRunner: 'בורח',
      healthy: (n) => `בריאים: ${n}`,
      netHosting: 'יוצר חדר…',
      netWaiting: 'ממתין לשחקן 2…',
      netConnecting: 'מתחבר…',
      netConnected: 'מחובר ✓',
      netClosed: 'החיבור נותק',
      reconnecting: 'מתחבר מחדש…',
      reconnectFailed: 'החיבור אבד',
      errPrefix: (e) => `שגיאה: ${e}`,
      errFailed: 'נכשל',
      onlineUnavailable: 'אונליין לא זמין',
      roomCode: (c) => `קוד החדר: ${c}`,
      roomCodeStatus: (c, s) => `קוד החדר: ${c} · ${s}`,
      promptCode: 'הזן קוד חדר (5 תווים):',
      connectFirst: 'התחברו תחילה (אירוח או הצטרפות)',
      connectedRoom: (c) => `מחוברים לחדר ${c}`,
      waitHostStart: 'ממתין שהמארח יתחיל את המשחק',
      guestGo: 'או לחצו רווח כדי להתחיל',
      moveControls: 'שלטו בעזרת חצים, W,A,S,D או מגע',
      helpTitle: 'איך משחקים',
      help1: 'הרודף (טבעת לבנה) מנסה לתפוס את הבורח לפני שייגמר הזמן.',
      help2: 'אתם תמיד בתנועה — אפשר רק לכוון, אי אפשר לעצור. הקירות מקפיצים אתכם.',
      help3: 'אספו בונוסים: ⚡ האצה · ❄ הקפאה · 👻 היעלמות · ↔ תופס רחב. השובלים לקישוט.',
      help4: 'תנועה: חצים / W,A,S,D / מגע · ב־2 שחקנים: P2 בחצים · רווח: התחלה',
      gotIt: 'הבנתי',
      musicTitle: 'מוזיקה',
      closeBtn: 'סיום',
      tilt: 'הטיה', sensLow: 'רגישות: נמוכה', sensMed: 'רגישות: בינונית', sensHigh: 'רגישות: גבוהה',
      chasesRunner: (chaser, runner) => `${chaser} רודף את ${runner}`,
      startsInfected: (name) => `${name} מתחיל נגוע — ברחו!`,
      wonMatch: (who) => `${who} ניצח את המשחק!`,
      survivedLast: (who) => `${who} שרד אחרון!`,
      reasonCatch: 'תפיסה!',
      reasonZone: 'שליטה בגבעה!',
      reasonTimeout: 'הזמן נגמר',
      tookRound: (who, why) => `${who} לקח את הסיבוב — ${why}`,
    },
    en: {
      title: 'Arcade Tag',
      rules1: 'The chaser (white ring) tries to catch the runner before time runs out.',
      rules2: 'Catch = chaser point · Timeout = runner point · First to 3 wins.',
      rules3: 'Trails are decorative — you may cross them. The sound speeds up as you close in!',
      mClassic1: 'Classic — the chaser (white ring) hunts the runner.',
      mClassic2: 'Tag before the timer runs out, or survive to score. First to 3 wins.',
      mKoth1: 'King of the Hill — control the moving glowing zone.',
      mKoth2: 'Stay inside it for 15 seconds total to win the round.',
      mInf1: 'Infection — 4 players, one starts infected; a touch spreads it.',
      mInf2: 'Avoid the infected — the last healthy player wins.',
      rowGameType: 'Game type',
      modeClassic: 'Classic',
      modeKoth: 'King of the Hill',
      modeInfection: 'Infection',
      rowOpponent: 'Opponent',
      oppCpu: 'vs Computer',
      oppLocal: '2 Players',
      oppOnline: 'Online',
      rowDifficulty: 'Difficulty',
      diffEasy: 'Easy',
      diffMedium: 'Medium',
      diffHard: 'Hard',
      rowSpeed: 'Speed',
      speedSlow: 'Slow',
      speedNormal: 'Normal',
      speedFast: 'Fast',
      startGame: 'Start game',
      powerups: 'Power-ups: ⚡ dash · ❄ freeze · 👻 ghost · ↔ wide · ▽ shrink',
      radarLabel: 'Sound Radar',
      radarHint: 'Sound Radar on — find your opponent by ear',
      hintOnline: 'Online — arrows / W,A,S,D / touch · host presses Space to start · M to mute',
      hintAI: 'Player 1 — arrows / W,A,S,D / touch · Space to start · M to mute',
      hintLocal: 'Player 1 — W,A,S,D · Player 2 — arrows · Space to start · M to mute',
      onlineUnavailableBrowser: 'Online is unavailable in this browser',
      hostConnectedStart: 'Player 2 connected ✓ — press "Start game"',
      guestConnectedWaiting: 'Connected ✓ — waiting for host',
      playFriend: 'Play a friend over the internet',
      onlineWifiTip: 'Tip: best on the same Wi-Fi for now',
      btnCopyLink: '🔗 Copy invite link',
      linkCopied: 'Invite link copied ✓ — send it to a friend',
      btnHost: 'Host',
      btnJoin: 'Join',
      btnDisconnect: 'Disconnect',
      btnCancel: 'Cancel',
      btnNewMatch: 'New match',
      btnHome: 'Home',
      btnNextRound: 'Next round',
      continueEsc: 'Space to continue · Esc for home',
      waitingHost: 'Waiting for host',
      kothGo: 'Control the zone!',
      computer: 'Computer',
      player1: 'Player 1',
      player2: 'Player 2',
      cpuN: (n) => `CPU ${n}`,
      roleInfected: 'Infected',
      roleHealthy: 'Healthy',
      roleChaser: 'Chaser',
      roleRunner: 'Runner',
      healthy: (n) => `Healthy: ${n}`,
      netHosting: 'Creating room…',
      netWaiting: 'Waiting for player 2…',
      netConnecting: 'Connecting…',
      netConnected: 'Connected ✓',
      netClosed: 'Disconnected',
      reconnecting: 'Reconnecting…',
      reconnectFailed: 'Connection lost',
      errPrefix: (e) => `Error: ${e}`,
      errFailed: 'failed',
      onlineUnavailable: 'Online unavailable',
      roomCode: (c) => `Room code: ${c}`,
      roomCodeStatus: (c, s) => `Room code: ${c} · ${s}`,
      promptCode: 'Enter room code (5 chars):',
      connectFirst: 'Connect first (Host or Join)',
      connectedRoom: (c) => `Connected to room ${c}`,
      waitHostStart: 'Waiting for the host to start',
      guestGo: 'or press Space to start',
      moveControls: 'Move with arrows, W,A,S,D, or touch',
      helpTitle: 'How to play',
      help1: 'The chaser (white ring) tries to tag the runner before time runs out.',
      help2: "You're always moving — steer, you can't stop. Walls bounce you back.",
      help3: 'Grab power-ups: ⚡ dash · ❄ freeze · 👻 ghost · ↔ wide. Trails are decoration.',
      help4: 'Move: arrows / W,A,S,D / touch · local 2P: P2 uses arrows · Space: start',
      gotIt: 'Got it',
      musicTitle: 'Music',
      closeBtn: 'Done',
      tilt: 'Tilt', sensLow: 'Sens: Low', sensMed: 'Sens: Med', sensHigh: 'Sens: High',
      chasesRunner: (chaser, runner) => `${chaser} chases ${runner}`,
      startsInfected: (name) => `${name} starts infected — run!`,
      wonMatch: (who) => `${who} won the match!`,
      survivedLast: (who) => `${who} survived last!`,
      reasonCatch: 'Caught!',
      reasonZone: 'Held the hill!',
      reasonTimeout: 'Time up',
      tookRound: (who, why) => `${who} took the round — ${why}`,
    },
  };
  let lang = localStorage.getItem('arcadeTagLang');
  if (lang !== 'he' && lang !== 'en') lang = (navigator.language || '').toLowerCase().startsWith('he') ? 'he' : 'en';
  function t(key, ...args) { const v = (STR[lang] && STR[lang][key]) ?? (STR.en[key]); return typeof v === 'function' ? v(...args) : v; }
  function dir() { return lang === 'he' ? 'rtl' : 'ltr'; }
  function setLang(l) { lang = l; try { localStorage.setItem('arcadeTagLang', l); } catch (e) {} }
  window.__t = t;
  window.__setLang = setLang;
  window.__lang = () => lang;

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
  let lastSnapMs = 0;             // guest: time the last snapshot landed (for extrapolation)
  const EXTRAP_CAP = 0.18;        // max seconds of guest-side dead-reckoning

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

  function p2Name() { return isAI() ? t('computer') : t('player2'); }
  function playerName(i) {
    if (game.players.length > 2) return i === 0 ? t('player1') : t('cpuN', i + 1);
    return i === 0 ? t('player1') : p2Name();
  }
  function applySpeed() { game.cfg.speed = SPEEDS[settings.speed]; }

  let aiTimer = 0;

  // ---------- networking wiring (Phase 3) ----------
  const NET_STATUS_KEYS = {
    idle: '', hosting: 'netHosting', waiting: 'netWaiting',
    connecting: 'netConnecting', connected: 'netConnected', closed: 'netClosed',
  };

  function onNetStatus(s, err) {
    netMsg = s === 'error' ? t('errPrefix', err || t('errFailed')) : (NET_STATUS_KEYS[s] ? t(NET_STATUS_KEYS[s]) : '');
  }

  let reconnectTimer = null, reconnectTries = 0;
  function clearReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectTries = 0;
  }
  /** Guest: keep trying to reopen the channel to the same host (bounded). */
  function scheduleReconnect() {
    if (reconnectTries >= 4) { netMsg = t('reconnectFailed'); return; }
    reconnectTries++;
    netMsg = t('reconnecting') + ' (' + reconnectTries + '/4)';
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!NET || NET.isConnected()) return; // recovered (or gone) — onNetConnected clears us
      NET.reconnect();
      scheduleReconnect(); // queue the next attempt; cancelled once connected
    }, 1600);
  }

  function onNetConnected() {
    clearReconnect();
    netMsg = t('netConnected');
    // Guest mirrors the host's mode/state via snapshots; start from a clean game.
    if (NET.role === 'guest') { effects = []; seenEvent = null; seenEventKey = null; }
  }

  function onNetClosed(intentional) {
    guestInput = [0, 0];
    // If a networked match was in progress, fall back to the menu.
    if (game.state !== State.READY) { game.resetMatch(); }
    if (!intentional && NET.role === 'guest' && NET.code) {
      scheduleReconnect(); // transient drop — try to come back automatically
    } else {
      netMsg = t('netClosed');
      clearReconnect();
    }
  }

  function onNetData(d) {
    if (!d || typeof d !== 'object') return;
    if (NET.role === 'host') {
      if (d.t === 'in' && Array.isArray(d.d)) guestInput = [d.d[0] || 0, d.d[1] || 0];
      else if (d.t === 'go') advanceState(); // guest pressed Space → start / next round / rematch
    } else { // guest receives authoritative snapshots
      if (d.t === 's' && d.snap) {
        if (settings.gameMode !== d.snap.mode) {
          settings.gameMode = d.snap.mode; // adopt host's mode, rebuild mirror
          game = makeGame();
          window.__game = game;
          effects = []; seenEvent = null; seenEventKey = null;
        }
        game.applySnapshot(d.snap);
        lastSnapMs = performance.now(); // mark authoritative time for extrapolation
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
    if (!NET) { netMsg = t('onlineUnavailable'); return; }
    const code = NET.host();
    netMsg = code ? t('roomCode', code) : netMsg;
  }
  function joinGame() {
    if (!NET) { netMsg = t('onlineUnavailable'); return; }
    const code = window.prompt(t('promptCode'), '');
    if (code) NET.join(code);
  }
  function leaveOnline() { if (NET) NET.close(); netMsg = ''; }

  /** Shareable invite URL that pre-fills the room code (?join=CODE). */
  function inviteLink() {
    const code = NET && NET.code ? NET.code : '';
    return location.origin + location.pathname + '?join=' + code;
  }
  function copyInvite() {
    const url = inviteLink();
    const ok = () => { netMsg = t('linkCopied'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(ok, () => { netMsg = url; });
      } else { window.prompt(t('btnCopyLink'), url); } // fallback: show it to copy by hand
    } catch (e) { window.prompt(t('btnCopyLink'), url); }
  }

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

  /** Player 1's direction. Single-player (vs CPU / online) accepts BOTH the
   *  arrow keys and W,A,S,D — arrows are the more intuitive default for one
   *  player. Local two-player keeps P1 on W,A,S,D so P2 owns the arrows. */
  function p1Dir() {
    if (settings.opponent === 'local' && settings.gameMode !== 'infection') return dirFor(P1);
    let dx = 0, dy = 0;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) dx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) dx += 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) dy -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) dy += 1;
    return [dx, dy];
  }

  function advanceState() {
    audio.ensureStarted();
    if (amGuest()) return; // online: the host drives round flow
    if (isOnline() && !NET.isConnected()) { // need a partner before starting
      netMsg = t('connectFirst');
      return;
    }
    if (game.state === State.READY) { syncMode(); saveSettings(); }
    if (game.state === State.READY || game.state === State.ROUND_OVER) { applySpeed(); game.startRound(); }
    else if (game.state === State.MATCH_OVER) { game.resetMatch(); }
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (showHelp) { dismissHelp(); return; }
      if (showThemes) { showThemes = false; return; }
      if (amGuest()) { NET.send({ t: 'go' }); return; } // ask the host to start / rematch
      advanceState(); return;
    }
    if (e.code === 'Escape') { if (showThemes) { showThemes = false; return; } if (!amGuest()) game.resetMatch(); return; } // back to menu anytime
    if (e.code === 'KeyM') { audio.muted = !audio.muted; return; }
    if (game.state === State.READY && !isOnline() && (e.code === 'Digit1' || e.code === 'Digit2')) {
      settings.opponent = (e.code === 'Digit1' || settings.gameMode === 'infection') ? 'cpu' : 'local';
      return;
    }
    if (e.code.indexOf('Arrow') === 0) e.preventDefault(); // arrows steer, not scroll
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
      if (b) { b.fn(); if (game.state === State.READY) saveSettings(); return; }
      // online guest: a tap on empty space asks the host to start / next / rematch
      // (mirrors the guest's Space key, so a phone player never needs a keyboard)
      if (amGuest()) { NET.send({ t: 'go' }); return; }
      // tap anywhere else still advances between rounds
      if (game.state === State.ROUND_OVER) { applySpeed(); game.startRound(); }
    }
  }
  window.__uiTap = uiTapAt; // verification hook

  canvas.addEventListener('click', (e) => {
    const [x, y] = canvasPos(e.clientX, e.clientY);
    uiTapAt(x, y);
  });

  // hover (desktop) — drives the game-type tooltip preview
  let cursor = null;
  canvas.addEventListener('mousemove', (e) => { cursor = canvasPos(e.clientX, e.clientY); });
  canvas.addEventListener('mouseleave', () => { cursor = null; });

  /** The two how-to-play lines for a game-type key. */
  function modeDescLines(k) {
    const p = k === 'koth' ? 'mKoth' : k === 'infection' ? 'mInf' : 'mClassic';
    return [t(p + '1'), t(p + '2')];
  }

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    const [x, y] = canvasPos(t.clientX, t.clientY);
    if (tryExit(x, y)) return;            // in-game ✕ → back to menu (touch has no Esc key)
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

  // ---------- adaptive audio: chiptune MIDI sequencer ----------
  // Each theme is a looping song of notes [time, dur, midi, voice] (voice
  // 0 = square lead, 1 = triangle bass, 2 = noise drum). Real timing from the
  // source MIDI; playback tempo scales with how close the players are — the sonar.
  const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const SONGS = window.GameSongs || {};
  const THEMES = {
    gyruss: SONGS.gyruss, pacman: SONGS.pacman,
    polepos: SONGS.polepos, mrdo: SONGS.mrdo, pooyan: SONGS.pooyan,
    montezuma: SONGS.montezuma, boulder: SONGS.boulder, vanguard: SONGS.vanguard,
  };

  const audio = {
    ctx: null, muted: false, master: null, noiseBuf: null,
    song: THEMES.boulder, clock: 0, cursor: 0, _last: 0, _pv: [],
    setTheme(name) { this.song = THEMES[name] || THEMES.boulder; this.clock = 0; this.cursor = 0; },
    ensureStarted() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createDynamicsCompressor(); // tame the polyphonic mix
      this.master.connect(this.ctx.destination);
      const sr = this.ctx.sampleRate, b = this.ctx.createBuffer(1, Math.floor(sr * 0.2), sr), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = b;
      this._last = this.ctx.currentTime;
    },
    tone(midi, when, type, peak, dur) {
      const osc = this.ctx.createOscillator(), gain = this.ctx.createGain();
      const d = Math.max(0.05, dur);
      osc.type = type; osc.frequency.value = midiHz(midi);
      gain.gain.setValueAtTime(0.0002, when);
      gain.gain.exponentialRampToValueAtTime(peak, when + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0006, when + d);
      osc.connect(gain).connect(this.master);
      osc.start(when); osc.stop(when + d + 0.03);
      return osc;
    },
    noiseHit(when) {
      const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf;
      const gain = this.ctx.createGain(), hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 1400;
      gain.gain.setValueAtTime(0.14, when);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.06);
      src.connect(hp).connect(gain).connect(this.master);
      src.start(when); src.stop(when + 0.08);
    },
    play(v, midi, when, dur, collect) {
      if (v === 2) { this.noiseHit(when); return; }
      const o = this.tone(midi, when, v === 1 ? 'triangle' : 'square', v === 1 ? 0.15 : 0.06, Math.min(dur, 0.5));
      if (collect && o) this._pv.push(o);
    },
    schedule() {
      if (!this.ctx || this.muted || game.state !== State.PLAYING) return;
      const s = this.song; if (!s || !s.n || !s.n.length) return;
      const { closeness } = game.audioParams();
      const tempo = 0.8 + closeness * 1.0; // 0.8×..1.8× — the sonar accelerates the tune
      const now = this.ctx.currentTime;
      let dt = now - this._last; this._last = now;
      if (!(dt > 0) || dt > 0.25) dt = 0.016;
      this.clock += dt * tempo;
      const L = s.loop || 1;
      if (this.clock >= L) { this.clock %= L; this.cursor = 0; }
      const ahead = this.clock + 0.12 * tempo + 0.03, N = s.n;
      while (this.cursor < N.length && N[this.cursor][0] <= ahead) {
        const e = N[this.cursor];
        this.play(e[3], e[2], now + Math.max(0, (e[0] - this.clock) / tempo), e[1] / tempo, false);
        this.cursor++;
      }
    },
    /** Audition the current theme (~3.6s, looping) at normal tempo. Cancels any
     *  in-flight preview so rapidly switching tunes doesn't stack up. */
    preview() {
      this.ensureStarted();
      if (!this.ctx || this.muted) return;
      const now = this.ctx.currentTime;
      for (const o of this._pv) { try { o.stop(now); } catch (e) {} }
      this._pv = [];
      const s = this.song; if (!s || !s.n) return;
      const DUR = 3.6, L = s.loop || 1;
      for (let base = 0; base < DUR; base += L) {
        for (const e of s.n) { const at = base + e[0]; if (at < DUR) this.play(e[3], e[2], now + 0.05 + at, e[1], true); }
      }
    },
    catchJingle() {
      if (!this.ctx || this.muted) return;
      const t = this.ctx.currentTime;
      [72, 76, 79].forEach((m, i) => this.tone(m, t + i * 0.09, 'square', 0.12, 0.12));
    },
  };

  const THEME_ORDER = ['gyruss', 'pacman', 'polepos', 'mrdo', 'pooyan', 'montezuma', 'boulder', 'vanguard'];
  const THEME_NAMES = {
    gyruss: 'Gyruss', pacman: 'Pac-Man', polepos: 'Pole Pos',
    mrdo: 'Mr Do', pooyan: 'Pooyan', montezuma: 'Montezuma', boulder: 'Boulder', vanguard: 'Vanguard',
  };
  if (THEME_ORDER.indexOf(settings.theme) < 0) settings.theme = 'boulder'; // drop removed/unknown themes
  audio.setTheme(settings.theme);
  function cycleTheme() {
    const i = THEME_ORDER.indexOf(settings.theme);
    settings.theme = THEME_ORDER[(i + 1) % THEME_ORDER.length];
    try { localStorage.setItem('arcadeTagTheme', settings.theme); } catch (e) {}
    audio.setTheme(settings.theme);
    audio.preview(); // audition the new theme right away (the tap is a user gesture)
  }
  window.__cycleTheme = cycleTheme; // verification hook

  // ---------- event effects (catch / infect / pickup) ----------
  let effects = [];   // {kind: 'boom'|'pop'|'score', x, y, t} — t is a local clock (s)
  let seenEvent = null;
  let shake = 0;      // screen-shake timer (s), triggered by impactful events

  /** Quick haptic pulse on phones (silently ignored where unsupported). */
  function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }

  function spawnEffect(ev) {
    if (!ev) return;
    const big = ev.type !== 'pickup';
    effects.push({ kind: big ? 'boom' : 'pop', x: ev.x, y: ev.y, t: 0 });
    // Impact feedback: a catch is the money moment — strongest shake + a double
    // haptic buzz. Other events get a lighter nudge so the catch still stands out.
    switch (ev.type) {
      case 'catch':
      case 'survivor': shake = Math.max(shake, 0.6); buzz([0, 30, 45, 80]); break;
      case 'infect':   shake = Math.max(shake, 0.4); buzz(25); break;
      case 'zone':     shake = Math.max(shake, 0.4); buzz([0, 25, 35, 55]); break;
      case 'pickup':   buzz(12); break;
      default:         if (big) shake = Math.max(shake, 0.3);
    }
  }

  /** Float a "+1" above whoever just won the round. */
  function spawnScorePop() {
    const r = game.lastRoundResult;
    if (!r) return;
    const p = game.players[r.winnerIndex];
    if (p) effects.push({ kind: 'score', x: p.x, y: p.y - 16, t: 0, text: '+1' });
  }

  function drawEffects(dt) {
    for (const e of effects) e.t += dt;
    effects = effects.filter(e => e.t < (e.kind === 'boom' ? 1.0 : e.kind === 'score' ? 0.9 : 0.45));
    for (const e of effects) {
      if (e.kind === 'score') {
        const rt = e.t / 0.9;
        ctx.save();
        ctx.globalAlpha = 1 - rt;
        ctx.shadowColor = colorAt(game.time); ctx.shadowBlur = 12;
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 26px "Helvetica Neue", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(e.text, e.x, e.y - rt * 34); // float upward as it fades
        ctx.restore();
        continue;
      }
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
  /** Decoy "spaghetti" laid at round start — drawn only in radar mode, where
   *  it camouflages the players' real trails so you can't just eyeball them. */
  function drawDecoys() {
    if (!settings.radar || !game.decoys || game.state === State.READY) return;
    ctx.lineWidth = game.cfg.trailWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const d of game.decoys) {
      const pts = d.pts;
      for (let i = 1; i < pts.length; i++) {
        ctx.strokeStyle = `hsl(${(d.hue + i * 7) % 360}, 100%, 55%)`;
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
    }
  }

  /** Latency smoothing (guest only): the authoritative snapshots arrive at
   *  ~30 Hz, so between them we dead-reckon each head forward by its velocity to
   *  render smoothly at 60 fps. The guest's OWN player (index 1) is predicted
   *  from live local input instead of the lagged snapshot heading, cutting its
   *  perceived input delay. Purely visual — authority/trails/catch are untouched. */
  function displayPos(p, i) {
    if (!amGuest() || game.state !== State.PLAYING) return [p.x, p.y];
    let dt = (performance.now() - lastSnapMs) / 1000;
    if (!(dt > 0)) return [p.x, p.y];
    dt = Math.min(dt, EXTRAP_CAP);
    let dx = p.dirX, dy = p.dirY;
    if (i === 1) { // my own player — predict from the input I'm holding right now
      const [ix, iy] = localInput();
      if (ix || iy) { const m = Math.hypot(ix, iy) || 1; dx = ix / m; dy = iy / m; }
    }
    const sp = game.cfg.speed * p.speedFactor(game.cfg);
    const r = game.cfg.playerRadius;
    const x = Math.max(r, Math.min(game.cfg.width - r, p.x + dx * sp * dt));
    const y = Math.max(r, Math.min(game.cfg.height - r, p.y + dy * sp * dt));
    return [x, y];
  }

  function drawPlayer(p, ring, idx) {
    const [hx, hy] = displayPos(p, idx);
    const color = colorAt(game.time);
    ctx.lineWidth = game.cfg.trailWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const t = p.trail;
    // Radar mode (during play): hide the head, ring and live tip, and fog the
    // most recent trail points — you hunt the opponent by sound + the spaghetti.
    const radarHide = settings.radar && game.state === State.PLAYING;
    const end = radarHide ? Math.max(1, t.length - RADAR_FOG) : t.length;
    for (let i = 1; i < end; i++) {
      ctx.strokeStyle = colorAt(t[i].t);
      ctx.beginPath();
      ctx.moveTo(t[i - 1].x, t[i - 1].y);
      ctx.lineTo(t[i].x, t[i].y);
      ctx.stroke();
    }
    if (radarHide) return; // nothing more to reveal in radar mode
    if (p.fx && p.fx.ghost > 0) return; // ghosting: no head, no live tip
    if (t.length) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(t[t.length - 1].x, t[t.length - 1].y);
      ctx.lineTo(hx, hy); // smoothed/predicted head position
      ctx.stroke();
    }
    // power-up size: ↔ wide swells the head/ring ~3×, ▽ shrink halves it
    const wf = (p.fx ? (p.fx.wide > 0 ? game.cfg.wideMult : 1) * (p.fx.shrink > 0 ? game.cfg.shrinkMult : 1) : 1);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 12 * wf;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(hx, hy, (game.cfg.trailWidth / 2 + 0.5) * wf, 0, Math.PI * 2);
    ctx.fill();
    if (ring) {
      const rc = RING_COLORS[ring] || '#ffffff';
      ctx.shadowColor = rc;
      ctx.strokeStyle = rc;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(hx, hy, (game.cfg.trailWidth / 2 + 5) * wf, 0, Math.PI * 2);
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
    wide:   { color: '#ff77aa', glyph: '↔' },
    shrink: { color: '#55ddbb', glyph: '▽' },
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
    ctx.direction = dir();
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
    ctx.direction = dir();
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
    // language toggle button — top-left corner (cx=46 means x=14..78)
    drawButton(lang === 'he' ? 'English' : 'עברית', 46, 12, 64, 24, false,
      () => setLang(lang === 'he' ? 'en' : 'he'));
    drawButton(t('radarLabel'), canvas.width - 80, 12, 130, 24, settings.radar,
      () => { settings.radar = !settings.radar; try { localStorage.setItem('arcadeTagRadar', settings.radar ? '1' : '0'); } catch (e) {} });
    drawButton('♪ ' + THEME_NAMES[settings.theme], canvas.width - 80, 44, 130, 24, showThemes, () => { showThemes = true; audio.ensureStarted(); });
    ctx.save();
    ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 18;
    centerText(t('title'), 70, 38);
    ctx.restore();
    // Game-type how-to: the two intro lines describe whichever mode the cursor
    // hovers (desktop preview) or, with no hover, the currently selected mode
    // (so it updates as you tap on mobile). Hit-rects mirror the row below.
    const GT = ['classic', 'koth', 'infection'], gw = 104, gh = 30, ggap = 10;
    const gtotal = GT.length * gw + (GT.length - 1) * ggap;
    let gcx = canvas.width / 2 + gtotal / 2 - gw / 2;
    let hoveredMode = null;
    for (const k of GT) {
      const rx = gcx - gw / 2;
      if (cursor && cursor[0] >= rx && cursor[0] <= rx + gw && cursor[1] >= 188 && cursor[1] <= 188 + gh) hoveredMode = k;
      gcx -= gw + ggap;
    }
    const dm = modeDescLines(hoveredMode || settings.gameMode);
    const dc = hoveredMode ? '#bfe3ff' : '#ffffff';
    centerText(dm[0], 106, 15, dc);
    centerText(dm[1], 128, 15, dc);
    centerText(t('rules3'), 150, 15);

    drawChoiceRow(t('rowGameType'), [
      { key: 'classic', label: t('modeClassic') },
      { key: 'koth', label: t('modeKoth') },
      { key: 'infection', label: t('modeInfection') },
    ], settings.gameMode, 188, (k) => {
      settings.gameMode = k;
      if (k === 'infection' && settings.opponent !== 'local') {
        if (isOnline()) leaveOnline();
        settings.opponent = 'cpu'; // infection: vs-computer only
      }
      syncMode();
    }, 104);

    if (settings.gameMode !== 'infection') {
      drawChoiceRow(t('rowOpponent'), [
        { key: 'cpu', label: t('oppCpu') },
        { key: 'local', label: t('oppLocal') },
        { key: 'online', label: t('oppOnline') },
      ], settings.opponent, 240, (k) => {
        if (k !== 'online' && isOnline()) leaveOnline();
        settings.opponent = k;
      }, 92);
    }

    if (isAI()) {
      drawChoiceRow(t('rowDifficulty'), [
        { key: 'easy', label: t('diffEasy') },
        { key: 'medium', label: t('diffMedium') },
        { key: 'hard', label: t('diffHard') },
      ], settings.difficulty, 292, (k) => { settings.difficulty = k; });
    } else if (isOnline()) {
      drawOnlinePanel(292);
    }

    drawChoiceRow(t('rowSpeed'), [
      { key: 'slow', label: t('speedSlow') },
      { key: 'normal', label: t('speedNormal') },
      { key: 'fast', label: t('speedFast') },
    ], settings.speed, 344, (k) => { settings.speed = k; });

    // start button
    ctx.save();
    ctx.shadowColor = colorAt(game.time);
    ctx.shadowBlur = 16;
    drawButton(t('startGame'), canvas.width / 2, 398, 180, 44, true, advanceState);
    ctx.restore();

    centerText(t('powerups'), 470, 14, '#aaaaaa');
    centerText(isOnline()
      ? t('hintOnline')
      : isAI()
        ? t('hintAI')
        : t('hintLocal'),
      494, 13, '#888888');
    drawButton('?', 30, 44, 32, 24, false, () => { showHelp = true; }); // reopen how-to
    // Fullscreen (hides the mobile URL bar) + opt-in tilt steering, lower-left.
    if (fsSupported()) drawButton(fsElement() ? '⛶ ✕' : '⛶', 30, 76, 32, 24, !!fsElement(), toggleFullscreen);
    if (isTouch && tiltSupported()) {
      drawButton('⌖ ' + t('tilt'), 102, 76, 104, 24, tilt.active, () => { tilt.active ? disableTilt() : enableTilt(); });
      if (tilt.active) drawButton(t(sensKey()), 102, 104, 104, 24, false, cycleSens);
    }
    // More games by Tsemach — cross-links to the sibling arcade games
    drawButton('↗ River Raid', canvas.width / 2 - 84, 502, 150, 18, false,
      () => { try { window.open('https://tsemachh.github.io/river-raid/', '_blank'); } catch (e) {} });
    drawButton('↗ Xonix', canvas.width / 2 + 78, 502, 110, 18, false,
      () => { try { window.open('https://tsemachh.github.io/xonix/', '_blank'); } catch (e) {} });
  }

  /** First-run (or '?'-triggered) how-to-play overlay drawn over the menu. */
  function drawHelpOverlay() {
    buttons = []; // the overlay captures all taps while it is open
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.save();
    ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 16;
    centerText(t('helpTitle'), 120, 34);
    ctx.restore();
    centerText(t('help1'), 188, 17);
    centerText(t('help2'), 220, 17);
    centerText(t('help3'), 256, 16, '#cccccc');
    centerText(t('help4'), 300, 15, '#999999');
    ctx.save();
    ctx.shadowColor = colorAt(game.time); ctx.shadowBlur = 16;
    drawButton(t('gotIt'), canvas.width / 2, 360, 160, 44, true, dismissHelp);
    ctx.restore();
  }

  /** Music picker overlay — a grid of all tunes; tap one to select + audition. */
  function drawThemeMenu() {
    buttons = []; // the overlay owns all taps while open
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.9)'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.restore();
    ctx.save(); ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 14; centerText('♪ ' + t('musicTitle'), 64, 30); ctx.restore();
    const cols = 3, w = 180, h = 34, gx = 16, gy = 12;
    const x0 = canvas.width / 2 - (cols * w + (cols - 1) * gx) / 2 + w / 2, y0 = 108;
    THEME_ORDER.forEach((k, idx) => {
      const cx = x0 + (idx % cols) * (w + gx), cy = y0 + Math.floor(idx / cols) * (h + gy);
      drawButton(THEME_NAMES[k], cx, cy, w, h, settings.theme === k, () => {
        settings.theme = k;
        try { localStorage.setItem('arcadeTagTheme', k); } catch (e) {}
        audio.setTheme(k); audio.preview(); // select + audition; overlay stays open to browse
      });
    });
    const closeY = y0 + Math.ceil(THEME_ORDER.length / cols) * (h + gy) + 16;
    ctx.save(); ctx.shadowColor = colorAt(game.time); ctx.shadowBlur = 12;
    drawButton(t('closeBtn'), canvas.width / 2, closeY, 150, 38, true, () => { showThemes = false; });
    ctx.restore();
  }

  /** Online (Phase 3) sub-panel: host / join actions, room code, status. */
  function drawOnlinePanel(y) {
    const st = NET ? NET.status : 'idle';
    const connected = NET && NET.isConnected();
    let line;
    if (!NET) line = t('onlineUnavailableBrowser');
    else if (connected) line = NET.role === 'host' ? t('hostConnectedStart') : t('guestConnectedWaiting');
    else if ((st === 'hosting' || st === 'waiting') && NET.code) line = t('roomCodeStatus', NET.code, t(NET_STATUS_KEYS[st]));
    else line = netMsg || t('onlineWifiTip');
    centerText(line, y - 6, 14, connected ? '#88ffbb' : (st === 'error' ? '#ff8888' : '#aaaaaa'));
    if (!NET) return;
    if (connected) {
      if (NET.role === 'host') {
        const w = 150, h = 30, gap = 12, total = 2 * w + gap;
        let cx = canvas.width / 2 + total / 2 - w / 2; // rightmost first (RTL)
        drawButton(t('btnCopyLink'), cx, y + 6, w, h, true, copyInvite); cx -= w + gap;
        drawButton(t('btnDisconnect'), cx, y + 6, w, h, false, leaveOnline);
      } else {
        drawButton(t('btnDisconnect'), canvas.width / 2, y + 6, 130, 30, false, leaveOnline);
      }
    } else if (st === 'hosting' || st === 'waiting') {
      // host is waiting for a guest — let them copy the invite link to share
      const w = 150, h = 30, gap = 12, total = 2 * w + gap;
      let cx = canvas.width / 2 + total / 2 - w / 2; // rightmost first (RTL)
      drawButton(t('btnCopyLink'), cx, y + 6, w, h, true, copyInvite); cx -= w + gap;
      drawButton(t('btnCancel'), cx, y + 6, w, h, false, leaveOnline);
    } else if (st === 'connecting') {
      drawButton(t('btnCancel'), canvas.width / 2, y + 6, 130, 30, false, leaveOnline);
    } else {
      const w = 120, h = 30, gap = 12, total = 2 * w + gap;
      let cx = canvas.width / 2 + total / 2 - w / 2; // rightmost first (RTL)
      drawButton(t('btnHost'), cx, y + 6, w, h, true, hostGame); cx -= w + gap;
      drawButton(t('btnJoin'), cx, y + 6, w, h, false, joinGame);
    }
  }

  /** Guest's pre-game screen while the host is still in the menu. */
  function drawGuestWaiting() {
    buttons = [];
    // language toggle button — top-left corner
    drawButton(lang === 'he' ? 'English' : 'עברית', 46, 12, 64, 24, false,
      () => setLang(lang === 'he' ? 'en' : 'he'));
    drawButton(t('radarLabel'), canvas.width - 80, 12, 130, 24, settings.radar,
      () => { settings.radar = !settings.radar; try { localStorage.setItem('arcadeTagRadar', settings.radar ? '1' : '0'); } catch (e) {} });
    drawButton('♪ ' + THEME_NAMES[settings.theme], canvas.width - 80, 44, 130, 24, showThemes, () => { showThemes = true; audio.ensureStarted(); });
    ctx.save();
    ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 18;
    centerText(t('title'), 150, 38);
    ctx.restore();
    centerText(t('connectedRoom', NET && NET.code ? NET.code : ''), 220, 18, '#88ffbb');
    const dots = '.'.repeat(1 + (Math.floor(game.time * 2) % 3));
    centerText(t('waitHostStart') + dots, 260, 18);
    centerText(t('guestGo'), 286, 14, '#88ccff');
    centerText(t('moveControls'), 312, 14, '#888888');
    drawButton(t('btnDisconnect'), canvas.width / 2, 348, 130, 32, false, leaveOnline);
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

  // In-game back-to-menu button — touch only (desktop uses Esc). Drawn top-left
  // during any non-menu state; its hit-rect is checked before the joystick.
  let exitBtn = null;
  function drawExitButton() {
    if (!isTouch || game.state === State.READY) { exitBtn = null; return; }
    const w = 30, h = 26, x = 8, y = 7;
    exitBtn = { x, y, w, h };
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeStyle = '#888888'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#dddddd';
    ctx.font = '15px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('✕', x + w / 2, y + h / 2 + 1);
    ctx.restore();
  }
  function tryExit(x, y) {
    if (!exitBtn) return false;
    if (x < exitBtn.x || x > exitBtn.x + exitBtn.w || y < exitBtn.y || y > exitBtn.y + exitBtn.h) return false;
    audio.ensureStarted();
    if (isOnline()) leaveOnline();
    game.resetMatch();
    return true;
  }

  function drawHud() {
    ctx.font = '16px "Helvetica Neue", Arial, sans-serif';
    ctx.fillStyle = '#ffffff';
    const lx = isTouch ? 46 : 14; // leave room for the ✕ button on touch
    if (game.mode === 'koth') {
      const win = game.cfg.kothWinSeconds;
      ctx.textAlign = 'left';
      ctx.fillText(`P1 ${Math.floor(game.zoneScore[0])}/${win} · ${game.scores[0]}`, lx, 24);
      ctx.textAlign = 'right';
      ctx.fillText(`${game.scores[1]} · ${Math.floor(game.zoneScore[1])}/${win} P2`, canvas.width - 14, 24);
    } else if (game.mode === 'infection') {
      ctx.textAlign = 'left';
      ctx.fillText(game.scores.map((s, i) => `P${i + 1} ${s}`).join(' · '), lx, 24);
      const healthy = game.infected.filter(v => !v).length;
      ctx.save();
      ctx.textAlign = 'right';
      ctx.direction = dir();
      ctx.fillText(t('healthy', healthy), canvas.width - 14, 24);
      ctx.restore();
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(`P1 ${game.scores[0]}`, lx, 24);
      ctx.textAlign = 'right';
      ctx.fillText(`${game.scores[1]} P2`, canvas.width - 14, 24);
    }
  }

  function countdownLabel() {
    if (game.mode === 'koth') return t('kothGo');
    if (game.mode === 'infection') return t('startsInfected', playerName(game.chaserIndex));
    const chaserName = playerName(game.chaserIndex);
    const runnerName = playerName(1 - game.chaserIndex);
    return t('chasesRunner', chaserName, runnerName);
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
      drawDecoys(); // camouflage behind the real trails (radar mode only)
      drawZone();
      drawPowerups();
      game.players.forEach((p, i) => drawPlayer(p, ringFor(i), i));
    }

    if (game.state !== State.READY) drawHud(); // menu keeps its corners clear for the language toggle
    drawExitButton(); // touch-only ✕ (no-op on desktop / in the menu)

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
      if (amGuest()) drawGuestWaiting();
      else { drawMenu(); if (showHelp) drawHelpOverlay(); }
      if (showThemes && !showHelp) drawThemeMenu();
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
      ctx.direction = dir();
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
          ctx.direction = dir();
          ctx.fillText(infectionMode ? (marked ? t('roleInfected') : t('roleHealthy')) : (marked ? t('roleChaser') : t('roleRunner')),
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
        headline = t('wonMatch', who);
      } else if (r.reason === 'survivor') {
        headline = t('survivedLast', who);
      } else {
        const why = r.reason === 'catch' ? t('reasonCatch')
          : r.reason === 'zone' ? t('reasonZone')
          : t('reasonTimeout');
        headline = t('tookRound', who, why);
      }
      centerText(headline, canvas.height / 2 - 30, 26);
      if (amGuest()) {
        // online guest: the host controls round flow
        const dots = '.'.repeat(1 + (Math.floor(game.time * 2) % 3));
        centerText(t('waitingHost') + dots, canvas.height / 2 + 40, 16, '#aaaaaa');
      } else if (game.state === State.MATCH_OVER) {
        drawButton(t('btnNewMatch'), canvas.width / 2 - 100, canvas.height / 2 + 14, 160, 40, true,
          () => { applySpeed(); game.resetMatch(); game.startRound(); });
        drawButton(t('btnHome'), canvas.width / 2 + 100, canvas.height / 2 + 14, 160, 40, false,
          () => game.resetMatch());
        centerText(t('continueEsc'), canvas.height / 2 + 84, 14, '#888888');
      } else {
        drawButton(t('btnNextRound'), canvas.width / 2 - 100, canvas.height / 2 + 14, 160, 40, true,
          () => { applySpeed(); game.startRound(); });
        drawButton(t('btnHome'), canvas.width / 2 + 100, canvas.height / 2 + 14, 160, 40, false,
          () => game.resetMatch());
        centerText(t('continueEsc'), canvas.height / 2 + 84, 14, '#888888');
      }
    }

    drawEffects(dt);

    // screen shake — nudge the whole canvas via a CSS transform (decays out)
    if (shake > 0) {
      shake = Math.max(0, shake - (frameDt || 0));
      const a = shake * 16;
      canvas.style.transform = `translate(${(Math.random() - 0.5) * a}px, ${(Math.random() - 0.5) * a}px)`;
    } else if (canvas.style.transform) {
      canvas.style.transform = '';
    }
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
    if (joy) {                                   // a finger on the joystick always wins
      const dx = joy.x - joy.ax, dy = joy.y - joy.ay;
      if (Math.hypot(dx, dy) > 12) return [dx, dy];
      return [0, 0];
    }
    if (tilt.active && tilt.have) {              // otherwise, tilt steering if enabled
      const dead = TILT_DEAD[settings.tiltSens] || 5.5;
      if (Math.hypot(tilt.sx, tilt.sy) > dead) return [tilt.sx, tilt.sy];
      return [0, 0];                             // near neutral → keep current heading
    }
    return p1Dir();
  }

  /** Guest: spawn a catch/pickup effect once per host event (deduped by id). */
  function handleGuestEvent() {
    const ev = game.lastEvent;
    if (!ev) return;
    const key = ev.type + '@' + (ev.time != null ? ev.time.toFixed(3) : '');
    if (key !== seenEventKey) { seenEventKey = key; spawnEffect(ev); }
  }

  // Deep-link: a shared ?join=CODE link auto-joins that room on load.
  (function initInviteLink() {
    if (!NET) return;
    let code = '';
    try { code = new URLSearchParams(location.search).get('join') || ''; } catch (e) {}
    code = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code) { settings.opponent = 'online'; NET.join(code); }
  })();

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
        audio.catchJingle(); spawnScorePop();
      }
      if (game.state === State.COUNTDOWN && prevState !== State.COUNTDOWN) recalibrateTilt();
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
      audio.catchJingle(); spawnScorePop();
    }
    if (game.state === State.COUNTDOWN && prevState !== State.COUNTDOWN) recalibrateTilt();
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
