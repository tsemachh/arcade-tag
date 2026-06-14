# Arcade Tag (תופסת ארקייד)

**Play it live: https://tsemachh.github.io/arcade-tag/**

A minimalist arcade tag game in a single page — no build, no dependencies,
no server. Chase, survive, and (in radar mode) find your opponent by sound.
Bilingual (English / עברית, auto-detected), installable as an app, and
playable online against a friend over WebRTC.

## Play

Open the link above, or install it to your home screen (it's a PWA and runs
offline in single-player). Pick a game type, an opponent, and press **Start**.

### Controls

- **Player 1:** arrow keys, W/A/S/D, or touch (a floating joystick anchors
  wherever your finger lands). In local two-player, P1 is W/A/S/D and P2 is the
  arrow keys.
- **Space** start / next round · **Esc** back to menu · **M** mute · **?** how-to.

Actors are **always moving** — you steer, you can't stop, and walls bounce you.

## Game types

- **Classic** — the chaser (white ring) tags the runner before the timer; a
  catch is a point for the chaser, a timeout a point for the runner. First to 3.
- **King of the Hill** — hold the moving zone for 15 accumulated seconds.
- **Infection** — 4 players, one starts infected; the last healthy player wins.

Classic and King of the Hill are also playable **online** (2 players).

## Power-ups

⚡ **dash** (speed burst) · ❄ **freeze** (slow everyone else) ·
👻 **ghost** (invisible, no trail) · ↔ **wide** (triples the chaser's reach,
Arkanoid-style) · ▽ **shrink** (halves how close a chaser must get to tag you).

## Modes & extras

- **Sound Radar** — hides the heads and scatters decoy "spaghetti" so you hunt
  your opponent by the adaptive audio (tempo + pitch rise as you close in).
- **Music themes** — square-wave chiptunes: Invaders, Bach's *Toccata* (the tune
  Gyruss actually used, public domain), and two originals (Climber, Caper).
- **Online multiplayer** — host a room, share the **invite link** (one tap to
  join), and play over WebRTC (PeerJS, no server). Host-authoritative with
  client-side prediction so the guest feels responsive.

## Online (how it works)

Networking is **host-authoritative**: the host runs the authoritative
simulation and streams ~30 Hz state snapshots; the guest sends only its input
and renders the snapshots, reconstructing trails locally and dead-reckoning
heads between snapshots for smooth motion. Transport is PeerJS on its free
public broker — no server, no API key. Falls back silently to offline play if
the broker can't be reached.

## Run / hack locally

Open `index.html` in a browser. No build step. Logic tests:

```
node test.js     # 146 assertions: core rules, AI, power-ups, networking
```

## Files

- `index.html` — page shell, PWA manifest/SW hookup, social meta.
- `game-core.js` — engine-agnostic logic: players, catch/timeout rules, modes,
  power-ups, decoy generation, distance→audio mapping, and the host↔guest
  snapshot sync. Node-testable.
- `ai.js` — AI opponent: predictive pursuit/evasion with wall repulsion.
- `net.js` — PeerJS wrapper: short room codes, host/join, one reliable channel.
- `game.js` — browser layer: rendering, input (keyboard/touch), Web Audio with
  selectable themes, menus, i18n, online host/guest loop, effects.
- `manifest.webmanifest`, `sw.js`, `icon.svg` — installable PWA + offline shell.
- `test.js` — `node test.js`.

## Deploy

Static files only. Push to any static host (these are served from GitHub Pages).
CI (`.github/workflows/ci.yml`) runs the tests on every push.

## History

- **Phase 1** — local 2-player tag, lethal-trail-free rules, POKEY-style
  adaptive audio, AI opponent, touch controls.
- **Phase 2** — game modes (classic / KOTH / infection), power-ups, catch
  effects.
- **Phase 3** — online multiplayer (PeerJS, host-authoritative).
- **Phase 4** — feel pass (wall bounce, bolder trails, sound radar + decoys),
  more power-ups (wide, shrink), music themes, English/Hebrew i18n, PWA,
  invite links, latency smoothing, screen-shake/score juice, and onboarding.
