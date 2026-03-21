// ── skeleton-stream.js ──
// Broadcasts keypoints via Supabase Realtime
// Can be imported in any page that has supa + currentUser defined

const STREAM_FPS     = 10;   // send 10 frames/sec (not 30 — saves bandwidth)
const STREAM_MIN_SCORE = 40; // don't broadcast if body confidence < 40%

let _streamChannel   = null;
let _streamRoomId    = null;
let _streamInterval  = null;
let _lastKps         = null;
let _lastBodyScore   = 0;
let _streamActive    = false;

// ── BROADCAST ─────────────────────────────────
// Call this every frame from tracker/story loop
// kps: MoveNet keypoints array
// bodyScore: 0-100 from getBodyConfidence
function streamBroadcast(kps, bodyScore) {
  if (!_streamActive || !_streamChannel) return;
  _lastKps       = kps;
  _lastBodyScore = bodyScore;
}

// Internal sender — called on interval
function _sendFrame() {
  if (!_lastKps || !_streamChannel || !_streamActive) return;
  if (_lastBodyScore < STREAM_MIN_SCORE) return;

  // Compress: only send x, y, score — 2 decimal places
  const compressed = _lastKps.map(k => ({
    x: Math.round(k.x * 10) / 10,
    y: Math.round(k.y * 10) / 10,
    s: Math.round(k.score * 100) / 100
  }));

  _streamChannel.send({
    type: 'broadcast',
    event: 'skeleton',
    payload: {
      user_id:    (typeof currentUser !== 'undefined' && currentUser?.id) || 'anon',
      username:   (typeof currentProfile !== 'undefined' && currentProfile?.username) || 'athlete',
      keypoints:  compressed,
      body_score: _lastBodyScore,
      ts:         Date.now()
    }
  });
}

// ── START STREAM ──────────────────────────────
async function startStream(roomId) {
  if (_streamActive) stopStream();
  _streamRoomId = roomId;

  _streamChannel = supa.channel('room:' + roomId);

  _streamChannel.subscribe((status) => {
    console.log('Stream channel status:', status);
    if (status === 'SUBSCRIBED') {
      _streamActive   = true;
      _streamInterval = setInterval(_sendFrame, 1000 / STREAM_FPS);
      console.log('SOMA stream: broadcasting to room', roomId);
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      console.error('Stream channel error:', status);
    }
  });

  return _streamChannel;
}

// ── STOP STREAM ───────────────────────────────
function stopStream() {
  _streamActive = false;
  if (_streamInterval) { clearInterval(_streamInterval); _streamInterval = null; }
  if (_streamChannel)  { supa.removeChannel(_streamChannel); _streamChannel = null; }
  _streamRoomId = null;
  _lastKps      = null;
}

// ── RECEIVE ───────────────────────────────────
// Subscribe to a room and receive other people's skeletons
// onFrame(payload) called for each incoming frame
function subscribeToRoom(roomId, onFrame) {
  const ch = supa.channel('room:' + roomId);
  ch.on('broadcast', { event: 'skeleton' }, ({ payload }) => {
    if (payload) onFrame(payload);
  }).subscribe((status) => {
    console.log('Watch channel status:', status);
  });
  return ch; // caller should keep reference to unsubscribe
}

// ── ROOM HELPERS ──────────────────────────────
function generateRoomId() {
  // Short human-readable room code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

async function createRoom(name, type='watch') {
  const id = generateRoomId();
  // Try to insert — if rooms table doesn't exist or RLS blocks, still return id
  // so the Realtime channel still works (channels don't require DB rows)
  const { error } = await supa.from('rooms').insert({
    id, name: name || 'SOMA Room', type,
    created_by: null
  });
  if (error) console.warn('Room DB insert failed (non-critical):', error.message);
  return id;
}

async function roomExists(roomId) {
  // Always return true — Realtime channels work without a DB row
  // The DB check is optional for UI only
  try {
    const { data } = await supa.from('rooms').select('id').eq('id', roomId.toUpperCase()).single();
    return true; // Even if not found, allow joining — channel will just be empty
  } catch(e) {
    return true; // fail open
  }
}
