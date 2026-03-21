// ── skeleton-stream.js v2 ──────────────────────
// Supabase Realtime broadcast — skeleton streaming

const STREAM_FPS       = 10;
const STREAM_MIN_SCORE = 35;

let _ch          = null;   // single channel for both send & receive
let _roomId      = null;
let _interval    = null;
let _lastKps     = null;
let _lastScore   = 0;
let _active      = false;
let _onFrame     = null;   // callback for incoming frames

// ── CALL EVERY FRAME FROM TRACKER ─────────────
function streamBroadcast(kps, bodyScore) {
  if (!_active) return;
  _lastKps   = kps;
  _lastScore = bodyScore;
}

function _send() {
  if (!_active || !_ch || !_lastKps) return;
  if (_lastScore < STREAM_MIN_SCORE) return;

  const kps = _lastKps.map(k => ({
    x: Math.round(k.x),
    y: Math.round(k.y),
    s: +k.score.toFixed(2)
  }));

  _ch.send({
    type:    'broadcast',
    event:   'skeleton',
    payload: {
      uid:   (typeof currentUser !== 'undefined' && currentUser?.id)       || 'anon',
      name:  (typeof currentProfile !== 'undefined' && currentProfile?.username) || 'athlete',
      kps,
      score: _lastScore,
      t:     Date.now()
    }
  }).catch(() => {}); // ignore send errors silently
}

// ── JOIN ROOM (start sending + receiving) ──────
function joinStream(roomId, onFrameCallback) {
  if (_ch) leaveStream();

  _roomId   = roomId;
  _onFrame  = onFrameCallback;

  _ch = supa.channel('soma-room-' + roomId, {
    config: {
      broadcast: { ack: false, self: false }
    }
  });

  _ch.on('broadcast', { event: 'skeleton' }, ({ payload }) => {
    if (payload && _onFrame) _onFrame(payload);
  });

  _ch.subscribe(status => {
    console.log('[WatchRoom] channel status:', status);
    if (status === 'SUBSCRIBED') {
      _active   = true;
      _interval = setInterval(_send, 1000 / STREAM_FPS);
      console.log('[WatchRoom] joined room:', roomId);
    }
  });

  return _ch;
}

// ── LEAVE ROOM ────────────────────────────────
function leaveStream() {
  _active = false;
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_ch)       { _ch.unsubscribe(); _ch = null; }
  _roomId  = null;
  _onFrame = null;
  _lastKps = null;
}

// ── ROOM ID GENERATOR ─────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ── LEGACY COMPAT (called from tracker.js) ────
async function startStream(roomId) {
  joinStream(roomId, null); // tracker only sends, doesn't receive
  return _ch;
}
function stopStream() { leaveStream(); }
