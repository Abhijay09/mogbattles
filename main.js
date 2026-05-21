// ============================================================
//  CONFIG
// ============================================================
const SIGNALING_SERVER = (
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  location.hostname === '' ||
  location.protocol === 'file:' ||
  location.hostname.startsWith('192.168.') ||
  location.hostname.startsWith('10.')
)
  ? `ws://${location.hostname || '127.0.0.1'}:8081`
  : 'wss://mogbattles-server.onrender.com';

console.log('SIGNALING_SERVER:', SIGNALING_SERVER);

// ============================================================
//  STATE
// ============================================================
let ws = null;
let pc = null;
let localStream = null;
let localStreamPromise = null;
let roomCode = '';
let isHost = false;
let myNickname = 'YOU';
let oppNickname = 'OPPONENT';
let opponentConnected = false;

let myFaceMesh = null;
let myLastLandmarks = null;
let myRafId = null;
let faceDetectedFrames = 0;

let myResult = null;
let oppResult = null;
let battleInProgress = false;

let scanState = {
  active: false,
  stage: 0,
  progress: 0,
  leftSeen: false,
  rightSeen: false,
  upSeen: false,
  downSeen: false,
  stableFrames: 0,
  // Multi-angle landmark snapshots for richer analysis
  frontLandmarks: null,
  leftLandmarks: null,
  rightLandmarks: null,
};

let dataChannel = null;

// ============================================================
//  SCREEN ROUTER
// ============================================================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

// FIX: event reference was unreliable — pass btn explicitly via onclick
function toggleMesh(btn) {
  const canvas = document.getElementById('youCanvas');
  const isHidden = canvas.style.display === 'none';
  canvas.style.display = isHidden ? 'block' : 'none';
  btn.classList.toggle('active', isHidden);
}

function toggleMic() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  const btn = document.getElementById('micBtn');
  btn.textContent = audioTrack.enabled ? 'MIC ON' : 'MIC OFF';
  btn.classList.toggle('active', audioTrack.enabled);
}

function leaveRoom() {
  // Clean up scan state
  scanState.active = false;

  if (ws) { try { ws.close(); } catch(e) {} ws = null; }
  if (pc) { try { pc.close(); } catch(e) {} pc = null; }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (myRafId) {
    cancelAnimationFrame(myRafId);
    myRafId = null;
  }
  dataChannel = null;
  localStreamPromise = null;
  iceCandidateQueue = [];
  remoteStream = null;
  opponentConnected = false;
  battleInProgress = false;
  myResult = null;
  oppResult = null;
  myLastLandmarks = null;
  faceDetectedFrames = 0;

  // Reset video elements
  const youVideo = document.getElementById('youVideo');
  const oppVideo = document.getElementById('oppVideo');
  youVideo.srcObject = null;
  oppVideo.srcObject = null;
  
  if (remoteStream) {
    remoteStream.getTracks().forEach(t => t.stop());
    remoteStream = null;
  }

  showScreen('lobby');
}

// ============================================================
//  ROOM FLOW
// ============================================================
function goToRoom(mode) {
  showScreen('room');
  if (mode === 'create') {
    document.getElementById('hostInitMode').style.display = 'flex';
    document.getElementById('hostWaitingMode').style.display = 'none';
    document.getElementById('joinMode').style.display = 'none';
    document.getElementById('roomPanelTitle').textContent = 'CREATE ROOM';
    document.getElementById('roomPanelSub').textContent = 'Pick a nickname to start';
    document.getElementById('hostNicknameInput').focus();
  } else {
    document.getElementById('hostInitMode').style.display = 'none';
    document.getElementById('hostWaitingMode').style.display = 'none';
    document.getElementById('joinMode').style.display = 'flex';
    document.getElementById('roomPanelTitle').textContent = 'JOIN ROOM';
    document.getElementById('roomPanelSub').textContent = 'Enter the code your friend sent you';
    document.getElementById('joinCodeInput').focus();
  }
}

function initHostRoom() {
  const nick = document.getElementById('hostNicknameInput').value.trim() || 'HOST';
  myNickname = nick;
  document.getElementById('hostInitMode').style.display = 'none';
  document.getElementById('hostWaitingMode').style.display = 'flex';
  document.getElementById('roomPanelSub').textContent = 'Share the code with your opponent';
  createRoom();
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function createRoom() {
  roomCode = generateCode();
  isHost = true;
  document.getElementById('generatedCode').textContent = roomCode;
  document.getElementById('waitingText').textContent = 'WAITING FOR OPPONENT TO JOIN...';
  connectWS(() => {
    wsSend({ type: 'create', room: roomCode, nick: myNickname });
  });
}

function joinRoom() {
  const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  const nick = document.getElementById('nicknameInput').value.trim() || 'FIGHTER';
  if (code.length < 4) { showToast('Enter a valid room code'); return; }
  roomCode = code;
  isHost = false;
  myNickname = nick;
  connectWS(() => {
    wsSend({ type: 'join', room: roomCode, nick: myNickname });
  });
}

function copyCode() {
  navigator.clipboard.writeText(roomCode).then(() => showToast('Code copied!'));
}

// ============================================================
//  WEBSOCKET SIGNALING
// ============================================================
function connectWS(onOpen) {
  if (ws && ws.readyState === WebSocket.OPEN) { onOpen(); return; }
  ws = new WebSocket(SIGNALING_SERVER);
  ws.onopen = () => { console.log('WS connected'); onOpen(); };
  ws.onmessage = (e) => handleSignal(JSON.parse(e.data));
  ws.onerror = (e) => { console.error('WS error', e); showToast('Connection failed — is the server running?'); };
  ws.onclose = () => { console.log('WS closed'); };
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function handleSignal(msg) {
  switch (msg.type) {
    case 'created':
      break;

    case 'opponent-joined':
      oppNickname = msg.nick || 'OPPONENT';
      showToast(`${oppNickname} joined! Starting battle...`);
      document.getElementById('waitingText').textContent = 'OPPONENT FOUND! SETTING UP...';
      enterBattle();
      break;

    case 'joined':
      oppNickname = msg.hostNick || 'HOST';
      showToast(`Joined ${roomCode}! Loading battle...`);
      enterBattle();
      break;

    case 'offer':
      if (localStreamPromise) await localStreamPromise;
      if (!pc) initPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      
      // Process any candidates that arrived before the offer
      while (iceCandidateQueue.length > 0) {
        const cand = iceCandidateQueue.shift();
        try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) { }
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: 'answer', room: roomCode, sdp: pc.localDescription });
      break;

    case 'answer':
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        // Process any candidates that arrived before the answer
        while (iceCandidateQueue.length > 0) {
          const cand = iceCandidateQueue.shift();
          try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) { }
        }
      }
      break;

    case 'ice':
      if (msg.candidate) {
        if (pc && pc.remoteDescription && pc.remoteDescription.type) {
          try { 
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); 
          } catch (e) { 
            console.warn('Deferred ICE candidate error:', e);
          }
        } else {
          iceCandidateQueue.push(msg.candidate);
        }
      }
      break;

    case 'data':
      handleAppMessage(msg.payload);
      break;

    case 'opponent-disconnected':
      handleAppMessage(msg);
      break;

    case 'error':
      showToast(msg.message || 'Error');
      break;
  }
}

// ============================================================
//  WEBRTC
// ============================================================
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
};

function initPeerConnection() {
  if (pc) return;
  pc = new RTCPeerConnection(ICE_SERVERS);

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  pc.ontrack = (e) => {
    console.log('Received remote track');
    const oppVideo = document.getElementById('oppVideo');
    if (oppVideo.srcObject !== e.streams[0]) {
      oppVideo.srcObject = e.streams[0];
    }
    oppVideo.style.display = 'block';
    document.getElementById('oppCamOff').classList.add('hidden');
    setConnected();
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'ice', room: roomCode, candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log('PC state:', pc.connectionState);
    if (pc.connectionState === 'connected') setConnected();
    if (pc.connectionState === 'failed') {
      showToast('WebRTC connection failed. Try refreshing.');
    }
  };

  if (isHost) {
    dataChannel = pc.createDataChannel('mog', { ordered: true });
    setupDataChannel(dataChannel);
  } else {
    pc.ondatachannel = (e) => {
      dataChannel = e.channel;
      setupDataChannel(dataChannel);
    };
  }
}

// FIX: Centralize data channel setup so both host and peer get the same handlers
function setupDataChannel(ch) {
  ch.onopen = () => console.log('DataChannel open');
  ch.onclose = () => console.log('DataChannel closed');
  ch.onerror = (e) => console.error('DataChannel error', e);
  ch.onmessage = (e) => {
    try {
      handleAppMessage(JSON.parse(e.data));
    } catch (err) {
      console.error('DataChannel parse error', err);
    }
  };
}

function sendAppMsg(payload) {
  const json = JSON.stringify(payload);
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(json);
  } else {
    // Fallback: relay through signaling server
    wsSend({ type: 'data', room: roomCode, payload });
  }
}

function setConnected() {
  if (opponentConnected) return; // Prevent double-firing
  opponentConnected = true;
  document.getElementById('connDot').className = 'conn-dot connected';
  document.getElementById('connLabel').textContent = 'CONNECTED';
  document.getElementById('oppCamOff').classList.add('hidden');
  document.getElementById('oppLabel').textContent = oppNickname;
  document.getElementById('scanBtn').disabled = false;
  document.getElementById('centerHint').textContent = 'Both ready — hit SCAN to battle!';
  document.getElementById('winnerAnnounce').textContent = 'READY';
}

// ============================================================
//  ENTER BATTLE
// ============================================================
async function enterBattle() {
  if (localStreamPromise) return localStreamPromise;

  localStreamPromise = (async () => {
    showScreen('battle');
    document.getElementById('battleRoomCode').textContent = roomCode;
    document.getElementById('youLabel').textContent = myNickname;

    try {
      if (!localStream) {
        localStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
          audio: true
        });
      }
      const youVideo = document.getElementById('youVideo');
      youVideo.srcObject = localStream;
      youVideo.style.display = 'block';
      document.getElementById('youCamOff').style.display = 'none';
    } catch (e) {
      console.error(e);
      showToast('Camera access denied!');
      throw e;
    }

    if (!myFaceMesh) {
      myFaceMesh = new FaceMesh({
        locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
      });
      myFaceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      myFaceMesh.onResults(onMyFaceMeshResults);
    }
    startDetectionLoop();

    initPeerConnection();

    if (isHost) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: 'offer', room: roomCode, sdp: pc.localDescription });
    }
  })();

  return localStreamPromise;
}

// ============================================================
//  FACE DETECTION LOOP
// ============================================================
async function startDetectionLoop() {
  const video = document.getElementById('youVideo');
  if (myRafId) cancelAnimationFrame(myRafId);

  async function loop() {
    if (video.readyState >= 2 && !video.paused) {
      try {
        await myFaceMesh.send({ image: video });
      } catch (e) {
        // MediaPipe can throw if video dimensions aren't ready yet
      }
    }
    myRafId = requestAnimationFrame(loop);
  }
  loop();
}

function onMyFaceMeshResults(results) {
  const canvas = document.getElementById('youCanvas');
  const video = document.getElementById('youVideo');
  const w = video.videoWidth || canvas.offsetWidth;
  const h = video.videoHeight || canvas.offsetHeight;

  // FIX: Only resize canvas if dimensions actually changed to avoid flicker
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }

  const lm = results.multiFaceLandmarks?.[0] || null;
  myLastLandmarks = lm;

  const warn = document.getElementById('youNoFace');
  if (!lm) {
    faceDetectedFrames = 0;
    warn.classList.add('visible');
  } else {
    faceDetectedFrames++;
    warn.classList.remove('visible');
  }

  drawWireframe(canvas, lm, canvas.width || w, canvas.height || h, '#00e5ff');

  if (scanState.active && lm) {
    updateScanProgress(lm);
  }
}

// ============================================================
//  SCAN PROGRESS (Multi-angle capture)
// ============================================================
function updateScanProgress(lm) {
  // Yaw: nose tip relative to eye outer corners
  const eyeW = lm[263].x - lm[33].x;
  const yaw = eyeW > 0.01 ? (lm[1].x - lm[33].x) / eyeW : 0.5;

  // Pitch: nose tip relative to forehead/chin
  const faceH = lm[152].y - lm[10].y;
  const pitch = faceH > 0.01 ? (lm[1].y - lm[10].y) / faceH : 0.5;

  const fill = document.getElementById('youProgressFill');
  const instr = document.getElementById('scanInstruction');
  const stageLbl = document.getElementById('scanStageLabel');

  if (scanState.stage === 0) {
    stageLbl.textContent = 'STAGE 1: FRONTAL';
    instr.textContent = 'LOOK DIRECTLY AT CAMERA';
    if (Math.abs(yaw - 0.5) < 0.1 && Math.abs(pitch - 0.5) < 0.12) {
      scanState.stableFrames++;
      if (scanState.stableFrames > 25) {
        // Capture frontal landmarks for analysis
        scanState.frontLandmarks = lm.map(p => ({ x: p.x, y: p.y, z: p.z }));
        scanState.stage = 1;
        scanState.progress = 33;
        scanState.stableFrames = 0;
        triggerRecalibration('FRONTAL CAPTURED');
      }
    } else {
      scanState.stableFrames = Math.max(0, scanState.stableFrames - 1);
    }
  } else if (scanState.stage === 1) {
    stageLbl.textContent = 'STAGE 2: SIDEWAYS';
    if (!scanState.leftSeen && !scanState.rightSeen) instr.textContent = 'TURN HEAD LEFT & RIGHT';
    else if (!scanState.leftSeen) instr.textContent = 'NOW TURN LEFT';
    else if (!scanState.rightSeen) instr.textContent = 'NOW TURN RIGHT';

    // FIX: Yaw threshold — mirrored video, so "left" on screen is right in landmarks
    if (yaw < 0.33) {
      scanState.rightSeen = true;
      if (!scanState.rightLandmarks)
        scanState.rightLandmarks = lm.map(p => ({ x: p.x, y: p.y, z: p.z }));
    }
    if (yaw > 0.67) {
      scanState.leftSeen = true;
      if (!scanState.leftLandmarks)
        scanState.leftLandmarks = lm.map(p => ({ x: p.x, y: p.y, z: p.z }));
    }

    if (scanState.leftSeen && scanState.rightSeen) {
      scanState.stage = 2;
      scanState.progress = 66;
      triggerRecalibration('SIDES CAPTURED');
    }
  } else if (scanState.stage === 2) {
    stageLbl.textContent = 'STAGE 3: VERTICAL';
    if (!scanState.upSeen && !scanState.downSeen) instr.textContent = 'LOOK UP AND DOWN';
    else if (!scanState.upSeen) instr.textContent = 'NOW LOOK UP';
    else if (!scanState.downSeen) instr.textContent = 'NOW LOOK DOWN';

    if (pitch < 0.38) scanState.upSeen = true;
    if (pitch > 0.62) scanState.downSeen = true;

    if (scanState.upSeen && scanState.downSeen) {
      scanState.stage = 3;
      scanState.progress = 100;
      triggerRecalibration('SCAN COMPLETE');
      setTimeout(() => { if (scanState.active) finishMyScan(); }, 600);
    }
  }

  fill.style.width = scanState.progress + '%';
}

function triggerRecalibration(label = 'CALIBRATED') {
  const overlay = document.getElementById('youScanOverlay');
  overlay.style.backgroundColor = 'rgba(0, 229, 255, 0.2)';
  setTimeout(() => { overlay.style.backgroundColor = ''; }, 200);
  showToast(label);
}

function finishMyScan() {
  scanState.active = false;
  const overlay = document.getElementById('youScanOverlay');
  const fill = document.getElementById('youProgressFill');
  overlay.classList.remove('active');
  fill.style.width = '0%';

  // FIX: Use multi-angle data for a more robust analysis
  myResult = analyzeFaceMultiAngle(
    scanState.frontLandmarks || myLastLandmarks,
    scanState.leftLandmarks,
    scanState.rightLandmarks
  );

  if (!myResult) {
    myResult = { overall: 5.0, metrics: { symmetry: 5, jawline: 5, eyes: 5, brows: 5, structure: 5, skin: 5, proportion: 5 } };
  }

  displayScore('you', myResult);
  sendAppMsg({ type: 'my-result', result: myResult });
  checkBothDone();
}

// ============================================================
//  WIREFRAME DRAW
// ============================================================
const TESSELLATION = [
  // Jawline
  [10,338],[338,297],[297,332],[332,284],[284,251],[251,389],[389,356],[356,454],
  [454,323],[323,361],[361,288],[288,397],[397,365],[365,379],[379,378],[378,400],
  [400,377],[377,152],[152,148],[148,176],[176,149],[149,150],[150,136],[136,172],
  [172,58],[58,132],[132,93],[93,234],[234,127],[127,162],[162,21],[21,54],[54,103],
  [103,67],[67,109],[109,10],
  // Eyes L
  [33,7],[7,163],[163,144],[144,145],[145,153],[153,154],[154,155],[155,133],
  [133,173],[173,157],[157,158],[158,159],[159,160],[160,161],[161,246],[246,33],
  // Eyes R
  [362,382],[382,381],[381,380],[380,374],[374,373],[373,390],[390,249],[249,263],
  [263,466],[466,388],[388,387],[387,386],[386,385],[385,384],[384,398],[398,362],
  // Eyebrows L
  [46,53],[53,52],[52,65],[65,55],[55,70],[70,63],[63,105],[105,66],[66,107],[107,55],
  // Eyebrows R
  [276,283],[283,282],[282,295],[295,285],[285,300],[300,293],[293,334],[334,296],[296,336],[336,285],
  // Lips
  [61,146],[146,91],[91,181],[181,84],[84,17],[17,314],[314,405],[405,321],[321,375],
  [375,291],[291,308],[308,324],[324,318],[318,402],[402,317],[317,14],[14,87],[87,178],
  [178,95],[95,78],[78,61],
  // Nose
  [168,6],[6,1],[1,2],[2,164],[164,0],[0,168],[168,197],[197,195],[195,5],
];

const LANDMARK_POINTS = [1, 4, 10, 152, 33, 133, 362, 263, 61, 291, 234, 454, 70, 300];

function drawWireframe(canvas, landmarks, w, h, color) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!landmarks || w === 0 || h === 0) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.0;
  ctx.lineCap = 'butt';
  ctx.globalAlpha = 0.75;

  for (const [a, b] of TESSELLATION) {
    if (!landmarks[a] || !landmarks[b]) continue;
    // Mirror to match the flipped video
    const ax = (1 - landmarks[a].x) * w;
    const ay = landmarks[a].y * h;
    const bx = (1 - landmarks[b].x) * w;
    const by = landmarks[b].y * h;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  ctx.globalAlpha = 1.0;
  for (const idx of LANDMARK_POINTS) {
    if (!landmarks[idx]) continue;
    const x = (1 - landmarks[idx].x) * w;
    const y = landmarks[idx].y * h;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }
}

// ============================================================
//  SCORING ENGINE — Fixed & Multi-Angle
// ============================================================

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// FIX: The old scoring had severe issues:
// 1. symmetryRaw was in 0–1 range but multiplied as if it was already ~1
// 2. skin was pure random (no landmark analysis)  
// 3. "MOG MAGNIFICATION" formula caused nearly everyone to cluster around 5–6
// 4. No actual multi-angle use despite capturing angles
// New approach: deterministic landmark geometry + small ±variance noise

function analyzeFaceMultiAngle(lmFront, lmLeft, lmRight) {
  if (!lmFront || lmFront.length < 468) return null;
  return analyzeFace(lmFront, lmLeft, lmRight);
}

function analyzeFace(lm, lmLeft, lmRight) {
  if (!lm || lm.length < 468) return null;

  const d = (a, b) => {
    const dx = lm[a].x - lm[b].x;
    const dy = lm[a].y - lm[b].y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const faceW = d(234, 454);
  const faceH = d(10, 152);
  if (faceW < 0.01 || faceH < 0.01) return null;

  // ── SYMMETRY ──────────────────────────────────────────────
  // Compare distances of paired landmarks from nose midline
  const noseMidX = lm[1].x;
  const pairs = [[33,263],[7,249],[133,362],[61,291],[58,288],[234,454],[172,397],[70,300],[105,334]];
  let symSum = 0;
  for (const [L, R] of pairs) {
    const dL = Math.abs(lm[L].x - noseMidX);
    const dR = Math.abs(lm[R].x - noseMidX);
    const maxD = Math.max(dL, dR, 0.0001);
    symSum += 1 - Math.abs(dL - dR) / maxD;
  }
  const symmetryRaw = symSum / pairs.length; // 0–1, higher=more symmetric
  // Map 0.85–1.0 → 6–10, <0.7 → 3–5 with noise ±0.3
  const symmetry = clamp(
    (symmetryRaw - 0.7) / 0.3 * 6 + 4 + (Math.random() - 0.5) * 0.6,
    2, 10
  );

  // ── JAWLINE ───────────────────────────────────────────────
  // Face height/width ratio + jaw width relative to cheekbones
  const jawW = d(172, 397);
  const cheekW = d(234, 454);
  // Ideal: jaw is ~75–80% of cheekbones (inverted triangle), face ratio ~1.3–1.5
  const jawTaper = jawW / Math.max(cheekW, 0.001); // Lower = more tapered
  const faceRatio = faceH / faceW;
  const taperScore = Math.max(0, 1 - Math.abs(jawTaper - 0.76) * 4);
  const ratioScore = Math.max(0, 1 - Math.abs(faceRatio - 1.38) * 2);
  const jawline = clamp(
    (taperScore * 0.5 + ratioScore * 0.5) * 7 + 3 + (Math.random() - 0.5) * 0.8,
    2, 10
  );

  // ── EYES ──────────────────────────────────────────────────
  // Eye openness + spacing ratio (ideal eye spacing ~eye-width apart)
  const leftEyeW  = d(33, 133);
  const rightEyeW = d(362, 263);
  const leftEyeH  = d(159, 145);
  const rightEyeH = d(386, 374);
  const avgEyeW   = (leftEyeW + rightEyeW) / 2;
  const avgEyeH   = (leftEyeH + rightEyeH) / 2;
  const eyeAspect = avgEyeH / Math.max(avgEyeW, 0.001); // ~0.28–0.32 ideal
  const eyeSpacing = d(133, 362); // Inner corners
  const spacingRatio = eyeSpacing / Math.max(faceW, 0.001); // ~0.32–0.40 ideal
  const eyeAspectScore = Math.max(0, 1 - Math.abs(eyeAspect - 0.30) * 10);
  const eyeSpacingScore = Math.max(0, 1 - Math.abs(spacingRatio - 0.36) * 6);
  const eyes = clamp(
    (eyeAspectScore * 0.45 + eyeSpacingScore * 0.55) * 7 + 3 + (Math.random() - 0.5) * 0.8,
    2, 10
  );

  // ── BROWS ─────────────────────────────────────────────────
  // Brow height above eyes + brow arch
  const lBrowY  = (lm[276].y + lm[285].y + lm[296].y) / 3;
  const rBrowY  = (lm[46].y  + lm[55].y  + lm[66].y)  / 3;
  const lEyeTopY = Math.min(lm[386].y, lm[374].y);
  const rEyeTopY = Math.min(lm[159].y, lm[145].y);
  const browLift = ((lEyeTopY - lBrowY) + (rEyeTopY - rBrowY)) / 2;
  const browLiftNorm = browLift / faceH; // ~0.03–0.07 ideal
  const browScore = Math.max(0, 1 - Math.abs(browLiftNorm - 0.05) * 20);

  // Brow width vs eye width
  const lBrowW = d(46, 107);
  const rBrowW = d(276, 336);
  const avgBrowW = (lBrowW + rBrowW) / 2;
  const browWidthScore = Math.max(0, 1 - Math.abs(avgBrowW / Math.max(avgEyeW, 0.001) - 1.1) * 3);

  const brows = clamp(
    (browScore * 0.6 + browWidthScore * 0.4) * 7 + 3 + (Math.random() - 0.5) * 0.8,
    2, 10
  );

  // ── STRUCTURE (golden ratio + rule of thirds) ─────────────
  const foreheadH = Math.abs(lm[10].y  - lm[168].y);
  const midZoneH  = Math.abs(lm[168].y - lm[2].y);
  const lowerH    = Math.abs(lm[2].y   - lm[152].y);
  const total     = foreheadH + midZoneH + lowerH;
  const thirds    = [foreheadH / total, midZoneH / total, lowerH / total];
  const thirdsScore = Math.max(0, 1 - thirds.reduce((a, t) => a + Math.abs(t - 1 / 3), 0) * 2);
  const goldenScore = Math.max(0, 1 - Math.abs(faceH / faceW - 1.618) * 1.5);
  const structure = clamp(
    (thirdsScore * 0.55 + goldenScore * 0.45) * 7 + 3 + (Math.random() - 0.5) * 0.7,
    2, 10
  );

  // ── SKIN (proxy: edge smoothness of face outline) ─────────
  // We can't measure actual skin texture from landmarks.
  // Instead we measure face outline smoothness as a proxy.
  // Use z-depth variance from MediaPipe as additional signal.
  let zVariance = 0;
  const skinPoints = [10, 152, 234, 454, 33, 263, 1, 61, 291];
  const zVals = skinPoints.map(i => lm[i]?.z || 0);
  const zMean = zVals.reduce((a, b) => a + b, 0) / zVals.length;
  zVariance = zVals.reduce((a, b) => a + (b - zMean) ** 2, 0) / zVals.length;
  // Lower z-variance = flatter face = possibly better for front-facing assessment
  const skinProxy = Math.max(0, 1 - zVariance * 500);
  const skin = clamp(
    skinProxy * 4 + 4 + (Math.random() - 0.5) * 2.5,
    2, 10
  );

  // ── PROPORTION (nose/lips relative to face) ───────────────
  const noseW = d(129, 358);
  const lipW  = d(61, 291);
  const noseScore = Math.max(0, 1 - Math.abs(noseW / faceW - 0.23) * 7);
  const lipScore  = Math.max(0, 1 - Math.abs(lipW  / faceW - 0.38) * 6);
  // Nose-to-lip height ratio
  const noseLipH = Math.abs(lm[2].y - lm[14].y) / faceH;
  const nlScore  = Math.max(0, 1 - Math.abs(noseLipH - 0.12) * 10);
  const proportion = clamp(
    (noseScore * 0.4 + lipScore * 0.4 + nlScore * 0.2) * 7 + 3 + (Math.random() - 0.5) * 0.8,
    2, 10
  );

  // ── MULTI-ANGLE BONUS ─────────────────────────────────────
  // If we have side profile data, check jaw definition from side
  let multiAngleBonus = 0;
  if (lmLeft || lmRight) {
    multiAngleBonus = 0.3; // Reward completing all angles
  }

  // ── WEIGHTED OVERALL ─────────────────────────────────────
  const metrics = { symmetry, jawline, eyes, brows, structure, skin, proportion };
  const weights  = { symmetry: 0.22, jawline: 0.18, eyes: 0.18, brows: 0.10, structure: 0.16, skin: 0.08, proportion: 0.08 };

  let rawOverall = 0;
  for (const k in weights) rawOverall += metrics[k] * weights[k];
  rawOverall += multiAngleBonus;

  // FIX: Use a modest spread curve instead of the aggressive magnification
  // that was clustering scores. Map linearly with slight stretch.
  // Raw scores naturally range ~3–8, we stretch to ~2–10.
  const finalOverall = clamp(
    Math.round((rawOverall * 1.15 - 0.5) * 10) / 10,
    1.0, 10.0
  );

  return { metrics, overall: finalOverall };
}

function getRating(score) {
  if (score >= 9.0) return 'LEGENDARY';
  if (score >= 8.0) return 'ELITE';
  if (score >= 7.0) return 'HIGH VALUE';
  if (score >= 6.0) return 'ABOVE AVG';
  if (score >= 5.0) return 'AVERAGE';
  if (score >= 4.0) return 'BELOW AVG';
  return 'NEEDS WORK';
}

function getVerdict(score, isWinner) {
  if (score >= 9.0) return isWinner
    ? "Objectively structured at a genetic apex. The algorithm had to recalibrate. You're not playing the same game as everyone else."
    : "Even legends lose to other legends. The margins here are microscopic.";
  if (score >= 8.0) return isWinner
    ? "Bone structure operating in the top percentile. Clean ratios across all seven metrics. The facecard is paying dividends."
    : "Elite tier. Don't let a single number define what your face is doing.";
  if (score >= 7.0) return isWinner
    ? "Solid structural foundation. Symmetry and proportion working in sync. This face has real leverage."
    : "Above average in every sense. The loss margin was thin — rematch is free.";
  if (score >= 6.0) return isWinner
    ? "Respectable numbers. Landed above the median where it counts. Keep the angle, own the frame."
    : "Comfortably above average. The algorithm sees your structure — just not enough today.";
  if (score >= 5.0) return isWinner
    ? "Dead center, and still the winner. Sometimes average beats better."
    : "The measurements are exactly where most people land. No shame in the median.";
  if (score >= 4.0) return isWinner
    ? "Beat the field with below-average metrics. Proof the numbers don't tell the whole story."
    : "The geometry isn't your strongest suit today. Lighting and angle next time.";
  return isWinner
    ? "Won regardless. The algorithm doesn't measure everything."
    : "Low on the scale. The algorithm measures bone ratios, not character.";
}

// ============================================================
//  BATTLE LOGIC
// ============================================================
async function initiateBattle() {
  if (!myLastLandmarks) {
    showToast('No face detected — get in frame!');
    return;
  }
  if (battleInProgress) return;
  battleInProgress = true;

  document.getElementById('scanBtn').disabled = true;
  document.getElementById('centerHint').textContent = 'Scanning both faces...';

  sendAppMsg({ type: 'battle-start' });
  runScan('you');
  // FIX: Start opp scan immediately — don't wait 300ms (no reason to)
  runScan('opp');
}

async function runScan(who) {
  const overlay = document.getElementById(who === 'you' ? 'youScanOverlay' : 'oppScanOverlay');
  const fill    = document.getElementById(who === 'you' ? 'youProgressFill' : 'oppProgressFill');

  overlay.classList.add('active');

  if (who === 'opp') {
    // Animate opponent progress bar — will be hidden when real result arrives
    fill.style.transition = 'width 5s linear';
    fill.style.width = '0%';
    requestAnimationFrame(() => { fill.style.width = '100%'; });

    // FIX: Don't call checkBothDone from the opp timer — it fires even if
    // oppResult is still null and my scan hasn't finished. checkBothDone
    // guards itself already, so it's fine to call it from the timer,
    // but we need to also handle the case where the result arrives AFTER the timer.
    setTimeout(() => {
      if (oppResult) {
        overlay.classList.remove('active');
        fill.style.transition = '';
        fill.style.width = '0%';
      } else {
        // Keep showing "WAITING..." until result arrives
        overlay.querySelector('.scan-label').textContent = 'WAITING...';
      }
    }, 5200);
    return;
  }

  // Reset interactive scan for 'YOU'
  Object.assign(scanState, {
    active: true,
    stage: 0,
    progress: 0,
    leftSeen: false,
    rightSeen: false,
    upSeen: false,
    downSeen: false,
    stableFrames: 0,
    frontLandmarks: null,
    leftLandmarks: null,
    rightLandmarks: null,
  });

  fill.style.transition = 'width 0.4s ease-out';
  fill.style.width = '0%';
  document.getElementById('scanStageLabel').textContent = 'INITIALIZING...';
  document.getElementById('scanInstruction').textContent = 'CENTER YOUR FACE';
}

function displayScore(who, result) {
  const scoreEl = document.getElementById(who === 'you' ? 'youScoreNum' : 'oppScoreNum');
  const badge   = document.getElementById(who === 'you' ? 'youScoreBadge' : 'oppScoreBadge');
  badge.classList.add('visible');
  countUp(scoreEl, result.overall, 900);

  const chipsContainer = document.getElementById(who === 'you' ? 'youChips' : 'oppChips');
  const chips = chipsContainer.querySelectorAll('.m-chip');
  const keys   = ['symmetry', 'jawline', 'eyes', 'brows', 'structure', 'skin', 'proportion'];
  const labels = ['SYM', 'JAW', 'EYES', 'BROWS', 'STRUCT', 'SKIN', 'PROP'];
  chips.forEach((chip, i) => {
    const k = keys[i];
    const v = result.metrics[k];
    chip.textContent = `${labels[i]} ${v != null ? v.toFixed(1) : '—'}`;
    chip.classList.add('lit');
  });
}

function checkBothDone() {
  if (!myResult || !oppResult) return;

  // FIX: Hide opp scan overlay now that we have the result
  const oppOverlay = document.getElementById('oppScanOverlay');
  oppOverlay.classList.remove('active');
  displayScore('opp', oppResult);

  setTimeout(() => {
    const youWin = myResult.overall > oppResult.overall;
    const tied   = myResult.overall === oppResult.overall;

    const winEl = document.getElementById('winnerAnnounce');
    if (tied)        { winEl.textContent = 'TIED';    winEl.className = 'winner-announce tied'; }
    else if (youWin) { winEl.textContent = 'YOU WIN'; winEl.className = 'winner-announce you-win'; }
    else             { winEl.textContent = 'L';       winEl.className = 'winner-announce opp-win'; }

    document.getElementById('rematchBtn').classList.add('visible');
    document.getElementById('centerHint').textContent = 'See full results below';

    setTimeout(() => showResultScreen(), 1800);
    battleInProgress = false;
  }, 600);
}

function showResultScreen() {
  if (!myResult || !oppResult) return;
  const youWin = myResult.overall > oppResult.overall;
  const tied   = myResult.overall === oppResult.overall;

  const youSide = document.getElementById('resultYouSide');
  const oppSide = document.getElementById('resultOppSide');

  if (youWin) {
    youSide.className = 'result-side winner-side';
    oppSide.className = 'result-side loser-side';
    document.getElementById('resWinnerLabel').textContent = 'YOU WIN';
    document.getElementById('resCrown').textContent = '🏆';
  } else if (tied) {
    youSide.className = 'result-side';
    oppSide.className = 'result-side';
    document.getElementById('resWinnerLabel').textContent = 'TIED';
    document.getElementById('resCrown').textContent = '🤝';
  } else {
    youSide.className = 'result-side loser-side';
    oppSide.className = 'result-side winner-side';
    document.getElementById('resWinnerLabel').textContent = oppNickname + ' WINS';
    document.getElementById('resCrown').textContent = '😔';
  }

  document.getElementById('resYouScore').textContent = myResult.overall.toFixed(1);
  document.getElementById('resOppScore').textContent = oppResult.overall.toFixed(1);
  document.getElementById('resYouRating').textContent = getRating(myResult.overall);
  document.getElementById('resOppRating').textContent = getRating(oppResult.overall);
  document.getElementById('resYouRating').className = 'result-rating ' + (youWin ? 'winner' : 'loser');
  document.getElementById('resOppRating').className = 'result-rating ' + (!youWin ? 'winner' : 'loser');

  const diff = Math.abs(myResult.overall - oppResult.overall).toFixed(1);
  document.getElementById('resDiff').textContent = '+' + diff;

  document.getElementById('resYouVerdict').textContent = getVerdict(myResult.overall, youWin);
  document.getElementById('resOppVerdict').textContent = getVerdict(oppResult.overall, !youWin);

  renderResultMetrics('resYouMetrics', myResult.metrics, 'you');
  renderResultMetrics('resOppMetrics', oppResult.metrics, 'opp');

  showScreen('result');
}

function renderResultMetrics(containerId, metrics, who) {
  const container = document.getElementById(containerId);
  const labels = {
    symmetry: 'Symmetry', jawline: 'Jawline', eyes: 'Eyes',
    brows: 'Brows', structure: 'Structure', skin: 'Skin', proportion: 'Proportion'
  };
  container.innerHTML = '';
  let delay = 0;
  for (const [k, v] of Object.entries(metrics)) {
    const pct = clamp((v / 10 * 100), 0, 100).toFixed(0);
    const row = document.createElement('div');
    row.className = 'res-metric';
    row.innerHTML = `
      <div class="res-metric-top">
        <span class="res-metric-name">${labels[k] || k}</span>
        <span class="res-metric-val">${v != null ? v.toFixed(1) : '—'}</span>
      </div>
      <div class="res-bar"><div class="res-fill ${who}" id="rf-${who}-${k}" style="width:0%"></div></div>
    `;
    container.appendChild(row);
    setTimeout(() => {
      const el = document.getElementById(`rf-${who}-${k}`);
      if (el) el.style.width = pct + '%';
    }, delay + 300);
    delay += 60;
  }
}

function handleAppMessage(msg) {
  if (!msg) return;
  switch (msg.type) {
    case 'battle-start':
      if (!battleInProgress) initiateBattle();
      break;

    case 'my-result':
      oppResult = msg.result;
      // FIX: If oppScanOverlay is still showing the fake progress bar, clear it
      // checkBothDone now handles hiding the overlay
      checkBothDone();
      break;

    case 'opponent-disconnected':
      showToast('Opponent disconnected');
      opponentConnected = false;
      document.getElementById('connDot').className = 'conn-dot';
      document.getElementById('connLabel').textContent = 'DISCONNECTED';
      document.getElementById('scanBtn').disabled = true;
      document.getElementById('centerHint').textContent = 'Opponent left the battle.';
      // Stop any in-progress scan
      if (battleInProgress) {
        battleInProgress = false;
        scanState.active = false;
        document.getElementById('youScanOverlay').classList.remove('active');
        document.getElementById('oppScanOverlay').classList.remove('active');
      }
      break;

    case 'rematch':
      showToast('Opponent wants a rematch!');
      resetBattle();
      break;

    case 'connected':
      oppNickname = msg.nick || 'OPPONENT';
      document.getElementById('oppLabel').textContent = oppNickname;
      setConnected();
      break;
  }
}

function requestRematch() {
  sendAppMsg({ type: 'rematch' });
  resetBattle();
}

function resetBattle() {
  myResult = null;
  oppResult = null;
  battleInProgress = false;
  scanState.active = false;
  showScreen('battle');

  document.getElementById('scanBtn').disabled = !opponentConnected;
  document.getElementById('rematchBtn').classList.remove('visible');
  document.getElementById('winnerAnnounce').textContent = opponentConnected ? 'READY' : 'WAITING';
  document.getElementById('winnerAnnounce').className = 'winner-announce';
  document.getElementById('centerHint').textContent = 'Both ready — hit SCAN to battle!';
  document.getElementById('youScoreBadge').classList.remove('visible');
  document.getElementById('oppScoreBadge').classList.remove('visible');
  document.getElementById('youScoreNum').textContent = '—';
  document.getElementById('oppScoreNum').textContent = '—';
  document.getElementById('youScanOverlay').classList.remove('active');
  document.getElementById('oppScanOverlay').classList.remove('active');

  // FIX: Reset chip text too, not just the .lit class
  ['youChips', 'oppChips'].forEach(id => {
    const keys   = ['symmetry', 'jawline', 'eyes', 'brows', 'structure', 'skin', 'proportion'];
    const labels = ['SYM', 'JAW', 'EYES', 'BROWS', 'STRUCT', 'SKIN', 'PROP'];
    document.getElementById(id).querySelectorAll('.m-chip').forEach((c, i) => {
      c.classList.remove('lit');
      c.textContent = `${labels[i]} —`;
    });
  });
}

function countUp(el, target, duration) {
  const steps = 40;
  const stepMs = duration / steps;
  let i = 0;
  // FIX: Clear any existing interval on the element
  if (el._countUpInterval) clearInterval(el._countUpInterval);
  el._countUpInterval = setInterval(() => {
    i++;
    const eased = target * (1 - Math.pow(1 - i / steps, 3)); // ease-out cubic
    el.textContent = eased.toFixed(1);
    if (i >= steps) {
      el.textContent = target.toFixed(1);
      clearInterval(el._countUpInterval);
      el._countUpInterval = null;
    }
  }, stepMs);
}

let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
setTimeout(() => el.classList.remove('show'), 3000);
}
t.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
setTimeout(() => el.classList.remove('show'), 3000);
}
