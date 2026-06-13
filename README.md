# Arcade Tag (תופסת ארקייד)

**Play it live: https://tsemachh.github.io/arcade-tag/**

Phase 3 features: **online multiplayer** — pick "אונליין" (online), one
player hosts and shares a 5-character room code, the other joins by code, and
the two play real-time tag over WebRTC. Networking is host-authoritative
(the host runs the simulation and streams ~30 Hz state snapshots; the guest
sends only its input and renders the snapshots, reconstructing trails
locally). Transport is PeerJS on its free public broker — no server, no API
key, no build step. Works for Classic and King of the Hill; falls back
silently to offline play if the broker can't be reached.

Phase 2 features: three game modes — Classic (קלאסי), King of the Hill
(מלך הגבעה: hold the moving zone 15s), and Infection (הדבקה: 4 players,
one starts infected, last healthy player wins); power-ups (⚡ dash,
❄ freeze opponents, 👻 ghost — invisible, trail stops); and catch-moment
effects (flash, expanding rings, particle burst).

## Phase 1 MVP

Phase 1 MVP per the spec ("Start small"): local 2-player tag on one keyboard,
solid trails as lethal obstacles, and POKEY-style adaptive audio — a square-wave
ostinato whose tempo and pitch are driven directly by the Euclidean distance
between the players. No networking, no shaders, no middleware (those are Phase 2).

## Run

Open `index.html` in a browser. No build, no dependencies.

## Controls

The start screen has tappable settings: game mode (vs computer / two
players), AI difficulty (easy / medium / hard), and game speed (slow /
normal / fast), plus a start button. Keyboard still works: 1/2 toggle the
mode, Space starts, M mutes.

Player 1: W A S D, or touch — a floating virtual joystick anchors wherever
your finger lands (phones/tablets supported; the canvas scales to the
viewport). Player 2: arrow keys. Both players share one hue-cycling color
whose hues persist along the trail; heads are the live tip of the line and
the white ring marks the current chaser. Roles alternate each round.
First to 3 round wins takes the match; after a match you return to the menu.
The countdown shows an animated "who chases whom" label and role tags over
each dot; during play a prominent timer pulses red in the last 5 seconds.

## Rules

A round ends only two ways: the chaser touches the runner (chaser wins) or
the 30-second timer runs out (runner wins). Trails are decorative — players
may cross any trail, including their own. Walls contain players but are
never lethal.

## Files

`game-core.js` — engine-agnostic logic (players, catch/timeout rules, state
machine, distance→tempo/pitch mapping). Node-testable.
`ai.js` — AI opponent: steering behaviors (predictive pursuit/evasion) with
wall repulsion, tangential escape, and difficulty presets. Node-testable.
`game.js` — browser layer: canvas rendering, menu buttons, keyboard + touch
input, Web Audio, and the online host/guest game loop.
`net.js` — Phase 3 networking: PeerJS wrapper with short room codes,
host/join, and a single reliable data channel. Loads if PeerJS is present;
the game runs offline without it.
`test.js` — core + AI + preset + networking tests: `node test.js`
(137 assertions, incl. host→guest snapshot round-trips).

## Deploy

Static files only — no build step. Copy the folder to any static host
(GitHub Pages, Netlify, Cloudflare Pages) and serve `index.html`.
