/**
 * arcade-tag — Phase 3 networking: 2-player online tag over WebRTC.
 * Thin wrapper around PeerJS (free public cloud broker, no API key).
 *
 * Model: host-authoritative. The host runs the authoritative GameCore
 * simulation and broadcasts compact snapshots; the guest sends only its
 * input direction and renders what it receives. One reliable DataConnection
 * carries both control messages and ~30 Hz state snapshots.
 *
 * Room codes: a short human-shareable code (e.g. "K7P2Q") is namespaced
 * into a PeerJS id ("arctag-K7P2Q") so two strangers' rooms never collide
 * on the shared public broker.
 */
(function () {
  'use strict';

  const PREFIX = 'arctag-';
  // Code alphabet without easily-confused glyphs (no O/0, I/1, etc.).
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function makeCode(n) {
    let s = '';
    for (let i = 0; i < (n || 5); i++) {
      s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return s;
  }

  const Net = {
    peer: null,
    conn: null,
    role: null,        // 'host' | 'guest' | null
    code: null,        // shareable room code (host) / joined code (guest)
    status: 'idle',    // idle | hosting | waiting | connecting | connected | error | closed
    error: null,
    // callbacks (assigned by game.js)
    onData: null,      // (obj) => void
    onConnected: null, // () => void
    onClosed: null,    // () => void
    onStatus: null,    // (status) => void

    _available() { return typeof window !== 'undefined' && typeof window.Peer === 'function'; },

    _set(s, err) {
      this.status = s;
      this.error = err || null;
      if (this.onStatus) this.onStatus(s, err);
    },

    /** Create a room and wait for a guest. Returns the shareable code (or null). */
    host() {
      if (!this._available()) { this._set('error', 'PeerJS not loaded'); return null; }
      this.close();
      this._intentional = false;
      this.role = 'host';
      this.code = makeCode(5);
      this._set('hosting');
      try {
        this.peer = new window.Peer(PREFIX + this.code, { debug: 1 });
      } catch (e) { this._set('error', String(e)); return null; }

      this.peer.on('open', () => { this._set('waiting'); });
      this.peer.on('connection', (conn) => {
        // first guest wins; ignore additional connection attempts
        if (this.conn && this.conn.open) { try { conn.close(); } catch (e) {} return; }
        this.conn = conn;
        this._wireConn(conn);
      });
      this.peer.on('error', (e) => this._handlePeerError(e));
      return this.code;
    },

    /** Join an existing room by code. */
    join(rawCode) {
      if (!this._available()) { this._set('error', 'PeerJS not loaded'); return; }
      const code = String(rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code) { this._set('error', 'empty code'); return; }
      this.close();
      this._intentional = false;
      this.role = 'guest';
      this.code = code;
      this._set('connecting');
      try {
        this.peer = new window.Peer({ debug: 1 }); // random id for the guest
      } catch (e) { this._set('error', String(e)); return; }

      this.peer.on('open', () => {
        const conn = this.peer.connect(PREFIX + code, { reliable: true });
        this.conn = conn;
        this._wireConn(conn);
      });
      this.peer.on('error', (e) => this._handlePeerError(e));
    },

    _wireConn(conn) {
      conn.on('open', () => {
        this._set('connected');
        if (this.onConnected) this.onConnected();
      });
      conn.on('data', (d) => { if (this.onData) this.onData(d); });
      conn.on('close', () => {
        this.conn = null;
        const intentional = !!this._intentional;
        if (intentional) this._set('closed');
        else if (this.role === 'host') this._set('waiting'); // keep the room open for a reconnect
        else this._set('closed');
        if (this.onClosed) this.onClosed(intentional);
      });
      conn.on('error', (e) => this._set('error', String(e && e.message || e)));
    },

    /** Guest: re-open a data channel to the same host using the existing peer
     *  (no full teardown). Returns true if a reconnect attempt was started. */
    reconnect() {
      if (this._intentional || this.role !== 'guest' || !this.code) return false;
      if (!this.peer || this.peer.destroyed) return false;
      if (this.conn && this.conn.open) return false;
      try {
        const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
        this.conn = conn;
        this._wireConn(conn);
        this._set('connecting');
        return true;
      } catch (e) { this._set('error', String(e)); return false; }
    },

    _handlePeerError(e) {
      const t = e && e.type ? e.type : 'error';
      // 'peer-unavailable' → the code is wrong or the host left
      const msg = t === 'peer-unavailable' ? 'room not found' : (e && e.message) || t;
      this._set('error', msg);
    },

    /** Send an object to the peer (no-op if not connected). */
    send(obj) {
      if (this.conn && this.conn.open) {
        try { this.conn.send(obj); } catch (e) { /* dropped frame; non-fatal */ }
      }
    },

    isConnected() { return !!(this.conn && this.conn.open); },

    close() {
      this._intentional = true;
      try { if (this.conn) this.conn.close(); } catch (e) {}
      try { if (this.peer) this.peer.destroy(); } catch (e) {}
      this.conn = null;
      this.peer = null;
      this.error = null;
      if (this.status !== 'idle') this._set('idle');
    },
  };

  window.Net = Net;
})();
