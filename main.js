// ============================================================
//  CONFIG — change SIGNALING_SERVER to your deployed server URL
// ============================================================
const SIGNALING_SERVER = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '' || location.protocol === 'file:' || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.')) 
  ? `ws://${location.hostname || '127.0.0.1'}:8081` 
  : 'wss://mog-battles-server.onrender.com';

console.log('SIGNALING_SERVER:', SIGNALING_SERVER);
 
// ============================================================
//  STATE
// ============================================================
let ws = null;
let pc = null;          // RTCPeerConnection
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
let countdownTimer = null;
 
let scanState = {
  active: false,
  stage: 0, // 0: Front, 1: Sideways, 2: Vertical
  progress: 0,
  leftSeen: false,
  rightSeen: false,
  upSeen: false,
  downSeen: false,
  stableFrames: 0
};

// For opponent canvas draw (received via data channel)
let dataChannel = null;
let oppCanvasLandmarks = null;
 
// ============================================================
//  SCREEN ROUTER
// ============================================================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

function toggleMesh() {
  const canvas = document.getElementById('youCanvas');
  const isHidden = canvas.style.display === 'none';
  canvas.style.display = isHidden ? 'block' : 'none';
  if (event && event.target) {
    event.target.classList.toggle('active', isHidden);
  }
}

function toggleMic() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    const btn = document.getElementById('micBtn');
    btn.textContent = audioTrack.enabled ? 'MIC ON' : 'MIC OFF';
    btn.classList.toggle('active', audioTrack.enabled);
  }
}
 
function leaveRoom() {
  if (ws) { ws.close(); ws = null; }
  if (pc) { pc.close(); pc = null; }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (myRafId) {
    cancelAnimationFrame(myRafId);
    myRafId = null;
  }
  localStreamPromise = null;
  opponentConnected = false;
  battleInProgress = false;
  myResult = null;
  oppResult = null;
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
  return Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
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
  switch(msg.type) {
 
    case 'created':
      // Host is waiting
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
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: 'answer', room: roomCode, sdp: pc.localDescription });
      break;
 
    case 'answer':
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      break;
 
    case 'ice':
      if (pc && msg.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch(e) {}
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
    { urls: 'stun:stun1.l.google.com:19302' }
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
    oppVideo.srcObject = e.streams[0];
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
  };
 
  if (isHost) {
    dataChannel = pc.createDataChannel('mog', { ordered: true });
    dataChannel.onmessage = (e) => handleAppMessage(JSON.parse(e.data));
  } else {
    pc.ondatachannel = (e) => {
      dataChannel = e.channel;
      dataChannel.onmessage = (ev) => handleAppMessage(JSON.parse(ev.data));
    };
  }
}
 
function sendAppMsg(payload) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(payload));
  } else {
    wsSend({ type: 'data', room: roomCode, payload });
  }
}
 
function setConnected() {
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
    } catch(e) {
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
      await myFaceMesh.send({ image: video });
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
  if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
 
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
 
  drawWireframe(canvas, lm, w, h, '#00e5ff');

  if (scanState.active && lm) {
    updateScanProgress(lm);
  }
}
 
function updateScanProgress(lm) {
  const d = (a, b) => Math.sqrt((lm[a].x - lm[b].x) ** 2 + (lm[a].y - lm[b].y) ** 2);
  
  // Simplified Yaw (Sideways) - Using nose tip relative to eye corners
  // landmarks: 1:nose, 33:L-eye-outer, 263:R-eye-outer
  const yaw = (lm[1].x - lm[33].x) / (lm[263].x - lm[33].x);
  
  // Simplified Pitch (Vertical) - Using nose tip relative to forehead and chin
  // landmarks: 1:nose, 10:forehead, 152:chin
  const pitch = (lm[1].y - lm[10].y) / (lm[152].y - lm[10].y);

  const fill = document.getElementById('youProgressFill');
  const instr = document.getElementById('scanInstruction');
  const stageLbl = document.getElementById('scanStageLabel');

  if (scanState.stage === 0) {
    stageLbl.textContent = 'STAGE 1: FRONTAL';
    instr.textContent = 'LOOK DIRECTLY AT CAMERA';
    // Center is approx yaw 0.5, pitch 0.5
    if (Math.abs(yaw - 0.5) < 0.1 && Math.abs(pitch - 0.5) < 0.1) {
      scanState.stableFrames++;
      if (scanState.stableFrames > 30) {
        scanState.stage = 1;
        scanState.progress = 33;
        scanState.stableFrames = 0;
      }
    } else {
      scanState.stableFrames = 0;
    }
  } else if (scanState.stage === 1) {
    stageLbl.textContent = 'STAGE 2: SIDEWAYS';
    if (!scanState.leftSeen && !scanState.rightSeen) instr.textContent = 'TURN HEAD LEFT AND RIGHT';
    else if (!scanState.leftSeen) instr.textContent = 'NOW TURN LEFT';
    else if (!scanState.rightSeen) instr.textContent = 'NOW TURN RIGHT';

    if (yaw < 0.35) scanState.leftSeen = true;
    if (yaw > 0.65) scanState.rightSeen = true;

    if (scanState.leftSeen && scanState.rightSeen) {
      triggerRecalibration();
      scanState.stage = 2;
      scanState.progress = 66;
    }
  } else if (scanState.stage === 2) {
    stageLbl.textContent = 'STAGE 3: VERTICAL';
    if (!scanState.upSeen && !scanState.downSeen) instr.textContent = 'LOOK UP AND DOWN';
    else if (!scanState.upSeen) instr.textContent = 'NOW LOOK UP';
    else if (!scanState.downSeen) instr.textContent = 'NOW LOOK DOWN';

    if (pitch < 0.4) scanState.upSeen = true;
    if (pitch > 0.6) scanState.downSeen = true;

    if (scanState.upSeen && scanState.downSeen) {
      triggerRecalibration();
      scanState.stage = 3;
      scanState.progress = 100;
      // Small delay before finishing to let the user see 100%
      setTimeout(() => { if (scanState.active) finishMyScan(); }, 500);
    }
  }

  fill.style.width = scanState.progress + '%';
}

function triggerRecalibration() {
  const overlay = document.getElementById('youScanOverlay');
  overlay.style.backgroundColor = 'rgba(0, 229, 255, 0.2)';
  setTimeout(() => {
    overlay.style.backgroundColor = 'rgba(8, 11, 15, 0.6)';
  }, 100);
  showToast('ANGLE CALIBRATED');
}

function finishMyScan() {
  scanState.active = false;
  const overlay = document.getElementById('youScanOverlay');
  const fill = document.getElementById('youProgressFill');
  overlay.classList.remove('active');
  fill.style.width = '0%';

  myResult = analyzeFace(myLastLandmarks);
  if (!myResult) myResult = { overall: 5.0, metrics: { symmetry:5,jawline:5,eyes:5,brows:5,structure:5,skin:5,proportion:5 } };
  
  // Real multi-angle accuracy bonus
  myResult.overall = Math.min(10, myResult.overall + 0.5); 
  
  displayScore('you', myResult);
  sendAppMsg({ type: 'my-result', result: myResult });
  checkBothDone();
}

// ============================================================
//  WIREFRAME DRAW (Simplified Aesthetic)
// ============================================================
const TESSELLATION = [
  // Jawline (Detailed)
  [10, 338], [338, 297], [297, 332], [332, 284], [284, 251], [251, 389], [389, 356], [356, 454], [454, 323], [323, 361], [361, 288], [288, 397], [397, 365], [365, 379], [379, 378], [378, 400], [400, 377], [377, 152], [152, 148], [148, 176], [176, 149], [149, 150], [150, 136], [136, 172], [172, 58], [58, 132], [132, 93], [93, 234], [234, 127], [127, 162], [162, 21], [21, 54], [54, 103], [103, 67], [67, 109], [109, 10],
  // Eyes (Left)
  [33, 7], [7, 163], [163, 144], [144, 145], [145, 153], [153, 154], [154, 155], [155, 133], [133, 173], [173, 157], [157, 158], [158, 159], [159, 160], [160, 161], [161, 246], [246, 33],
  // Eyes (Right)
  [362, 382], [382, 381], [381, 380], [380, 374], [374, 373], [373, 390], [390, 249], [249, 263], [263, 466], [466, 388], [388, 387], [387, 386], [386, 385], [385, 384], [384, 398], [398, 362],
  // Eyebrows (Left)
  [46, 53], [53, 52], [52, 65], [65, 55], [55, 70], [70, 63], [63, 105], [105, 66], [66, 107], [107, 55],
  // Eyebrows (Right)
  [276, 283], [283, 282], [282, 295], [295, 285], [285, 300], [300, 293], [293, 334], [334, 296], [296, 336], [336, 285],
  // Lips (Outer)
  [61, 146], [146, 91], [91, 181], [181, 84], [84, 17], [17, 314], [314, 405], [405, 321], [321, 375], [375, 291], [291, 308], [308, 324], [324, 318], [318, 402], [402, 317], [317, 14], [14, 87], [87, 178], [178, 95], [95, 78], [78, 61],
  // Nose
  [168, 6], [6, 1], [1, 2], [2, 164], [164, 0], [0, 168], [168, 197], [197, 195], [195, 5]
];
 
// Critical points for aesthetic marker
const LANDMARK_POINTS = [
  1, 4, 10, 152, // Center axis
  33, 133, 362, 263, // Eye corners
  61, 291, // Mouth corners
  234, 454, // Cheekbones
  70, 300 // Eyebrow peaks
];
 
function drawWireframe(canvas, landmarks, w, h, color) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!landmarks) return;
 
  // Sharper, higher contrast lines
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.0;
  ctx.lineCap = 'butt'; // Straighter, sharper ends
  ctx.globalAlpha = 0.8;
 
  for (const [a, b] of TESSELLATION) {
    if (!landmarks[a] || !landmarks[b]) continue;
    
    // Fix mirroring: If video is scaleX(-1), landmarks need to be flipped horizontally to match
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
 
  // Smaller, cleaner point markers
  for (const idx of LANDMARK_POINTS) {
    if (!landmarks[idx]) continue;
    const x = (1 - landmarks[idx].x) * w;
    const y = landmarks[idx].y * h;
 
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 1.2, 0, Math.PI * 2); 
    ctx.fill();
 
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.stroke();
  }
}
 
// ============================================================
//  SCORING ENGINE — Deep Analysis
// ============================================================
function analyzeFace(lm) {
  if (!lm || lm.length < 468) return null;
 
  const d = (a, b) => Math.sqrt((lm[a].x - lm[b].x) ** 2 + (lm[a].y - lm[b].y) ** 2);
  const mid = (a, b) => ({ x: (lm[a].x + lm[b].x) / 2, y: (lm[a].y + lm[b].y) / 2 });
 
  const faceW = d(234, 454);   
  const faceH = d(10, 152);    
  const noseTip = lm[1];
 
  const noseMidX = noseTip.x;
  let symSum = 0, symCount = 0;
  [[33,263],[7,249],[133,362],[61,291],[58,288],[234,454],[172,397]].forEach(([L,R]) => {
    const distL = Math.abs(lm[L].x - noseMidX);
    const distR = Math.abs(lm[R].x - noseMidX);
    const ratio = Math.min(distL, distR) / Math.max(distL, distR + 0.0001);
    symSum += ratio;
    symCount++;
  });
  const symmetryRaw = symSum / symCount;
  const symmetry = (symmetryRaw * 10) * 0.6 + Math.random() * 0.3 + 0.1;
 
  const jawW = d(172, 397);    
  const jawRatio = faceH / jawW;
  const jawRaw = Math.max(0, 1 - Math.abs(jawRatio - 1.35) * 1.5);
  const jawline = clamp(jawRaw * 10 * 0.7 + Math.random() * 0.8 + 0.2, 3, 10);
 
  const leftEyeH  = d(159, 145);
  const rightEyeH = d(386, 374);
  const eyeH = (leftEyeH + rightEyeH) / 2;
  const eyeSpacing = d(133, 362);
  const eyeRatio = eyeH / faceH;
  const spacingRatio = eyeSpacing / faceW;
  const eyeScore = Math.max(0, 1 - Math.abs(eyeRatio - 0.04) * 30) * 0.5
                 + Math.max(0, 1 - Math.abs(spacingRatio - 0.38) * 8) * 0.5;
  const eyes = clamp(eyeScore * 10 * 0.7 + Math.random() * 0.8 + 0.2, 3, 10);
 
  const lBrowY = (lm[276].y + lm[285].y + lm[296].y) / 3;
  const rBrowY = (lm[46].y  + lm[55].y  + lm[66].y)  / 3;
  const lEyeY  = (lm[386].y + lm[374].y) / 2;
  const rEyeY  = (lm[159].y + lm[145].y) / 2;
  const browGap = ((Math.abs(lBrowY - lEyeY) + Math.abs(rBrowY - rEyeY)) / 2) / faceH;
  const browScore = Math.max(0, 1 - Math.abs(browGap - 0.045) * 30);
  const brows = clamp(browScore * 10 * 0.65 + Math.random() * 1 + 0.5, 3, 10);
 
  const foreheadH  = Math.abs(lm[10].y  - lm[168].y);
  const midZoneH   = Math.abs(lm[168].y - lm[2].y);
  const lowerH     = Math.abs(lm[2].y   - lm[152].y);
  const total = foreheadH + midZoneH + lowerH;
  const thirdsScore = 1 - [foreheadH/total, midZoneH/total, lowerH/total].reduce((acc, t) => acc + Math.abs(t - 1/3), 0);
  const goldenScore = Math.max(0, 1 - Math.abs((faceH / faceW) - 1.62) * 1.2);
  const structure = clamp((thirdsScore * 0.5 + goldenScore * 0.5) * 10 * 0.65 + Math.random() * 0.9 + 0.3, 3, 10);
 
  const skin = clamp(4.5 + Math.random() * 4, 3, 10);
 
  const noseW = d(129, 358);
  const lipW  = d(61, 291);
  const proportion = clamp((Math.max(0, 1 - Math.abs(noseW / faceW - 0.25) * 8) * 0.5 + Math.max(0, 1 - Math.abs(lipW / faceW - 0.37) * 7) * 0.5) * 10 * 0.65 + Math.random() * 0.9 + 0.3, 3, 10);
 
  const metrics = { symmetry, jawline, eyes, brows, structure, skin, proportion };
  const weights = { symmetry: 0.22, jawline: 0.18, eyes: 0.18, brows: 0.12, structure: 0.16, skin: 0.08, proportion: 0.06 };
  let rawOverall = 0;
  for (const k in weights) rawOverall += metrics[k] * weights[k];

  // MOG MAGNIFICATION: Increases disparity in the "average" range.
  // We use a steep linear mapping centered around the average (4.6 raw)
  // Input 4.1 -> Output ~5.0
  // Input 5.1 -> Output ~8.2
  let magnified = (rawOverall - 4.6) * 3.2 + 6.5;
  
  // Final clamping to the 1.0 - 10.0 scale
  const finalOverall = Math.max(1, Math.min(10, magnified));

  return { metrics, overall: Math.round(finalOverall * 10) / 10 };
}
 
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
 
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
  if (score >= 9.0) return isWinner ? "Objectively structured at a genetic apex. The algorithm had to recalibrate. You're not playing the same game as everyone else." : "Even legends lose to other legends. The margins here are microscopic.";
  if (score >= 8.0) return isWinner ? "Bone structure operating in the top percentile. Clean ratios across all seven metrics. The facecard is paying dividends." : "Elite tier. Don't let a single number define what your face is doing.";
  if (score >= 7.0) return isWinner ? "Solid structural foundation. Symmetry and proportion working in sync. This face has real leverage." : "Above average in every sense. The loss margin was thin — rematch is free.";
  if (score >= 6.0) return isWinner ? "Respectable numbers. Landed above the median where it counts. Keep the angle, own the frame." : "Comfortably above average. The algorithm sees your structure — just not enough today.";
  if (score >= 5.0) return isWinner ? "Dead center, and still the winner. Sometimes average beats better." : "The measurements are exactly where most people land. No shame in the median.";
  if (score >= 4.0) return isWinner ? "Beat the field with below-average metrics. Proof the numbers don't tell the whole story." : "The geometry isn't your strongest suit today. Lighting and angle next time.";
  return isWinner ? "Won regardless. The algorithm doesn't measure everything." : "Low on the scale. The algorithm measures bone ratios, not character.";
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
  setTimeout(() => runScan('opp'), 300);
}
 
async function runScan(who) {
  const overlay   = document.getElementById(who === 'you' ? 'youScanOverlay' : 'oppScanOverlay');
  const fill      = document.getElementById(who === 'you' ? 'youProgressFill' : 'oppProgressFill');
 
  overlay.classList.add('active');
  
  if (who === 'opp') {
    fill.style.transition = 'width 4s linear';
    fill.style.width = '0%';
    setTimeout(() => { fill.style.width = '100%'; }, 50);
    setTimeout(() => {
      if (oppResult) {
        overlay.classList.remove('active');
        displayScore('opp', oppResult);
      } else {
        overlay.querySelector('.scan-label').textContent = 'WAITING...';
      }
      checkBothDone();
    }, 4500);
    return;
  }

  // Reset and activate interactive scan for 'YOU'
  scanState = {
    active: true,
    stage: 0,
    progress: 0,
    leftSeen: false,
    rightSeen: false,
    upSeen: false,
    downSeen: false,
    stableFrames: 0
  };
  
  fill.style.transition = 'width 0.5s ease-out';
  fill.style.width = '0%';
  document.getElementById('scanStageLabel').textContent = 'INITIALIZING...';
  document.getElementById('scanInstruction').textContent = 'CENTER YOUR FACE';
}
 
function generateSimOpponentResult() {
  const base = () => clamp(3.5 + Math.random() * 6, 3, 9.8);
  const m = { symmetry:base(), jawline:base(), eyes:base(), brows:base(), structure:base(), skin:base(), proportion:base() };
  const weights = { symmetry:0.22, jawline:0.18, eyes:0.18, brows:0.12, structure:0.16, skin:0.08, proportion:0.06 };
  let overall = 0;
  for (const k in weights) overall += m[k] * weights[k];
  return { metrics: m, overall: Math.round(overall*10)/10 };
}
 
function displayScore(who, result) {
  const scoreEl = document.getElementById(who === 'you' ? 'youScoreNum' : 'oppScoreNum');
  const badge   = document.getElementById(who === 'you' ? 'youScoreBadge' : 'oppScoreBadge');
  badge.classList.add('visible');
  countUp(scoreEl, result.overall, 800);
 
  const chipsContainer = document.getElementById(who === 'you' ? 'youChips' : 'oppChips');
  const chips = chipsContainer.querySelectorAll('.m-chip');
  const keys = ['symmetry','jawline','eyes','brows','structure','skin','proportion'];
  const labels = ['SYM','JAW','EYES','BROWS','STRUCT','SKIN','PROP'];
  chips.forEach((chip, i) => {
    const k = keys[i];
    const v = result.metrics[k];
    chip.textContent = `${labels[i]} ${v ? v.toFixed(1) : '—'}`;
    chip.classList.add('lit');
  });
}
 
function checkBothDone() {
  if (!myResult || !oppResult) return;
 
  setTimeout(() => {
    const youWin = myResult.overall > oppResult.overall;
    const tied   = myResult.overall === oppResult.overall;
 
    const winEl = document.getElementById('winnerAnnounce');
    if (tied)        { winEl.textContent = 'TIED'; winEl.className = 'winner-announce tied'; }
    else if (youWin) { winEl.textContent = 'YOU WIN'; winEl.className = 'winner-announce you-win'; }
    else             { winEl.textContent = 'L'; winEl.className = 'winner-announce opp-win'; }
 
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
  const labels = { symmetry:'Symmetry', jawline:'Jawline', eyes:'Eyes', brows:'Brows', structure:'Structure', skin:'Skin', proportion:'Proportion' };
  container.innerHTML = '';
  let delay = 0;
  for (const [k, v] of Object.entries(metrics)) {
    const pct = (v / 10 * 100).toFixed(0);
    const row = document.createElement('div');
    row.className = 'res-metric';
    row.innerHTML = `
      <div class="res-metric-top">
        <span class="res-metric-name">${labels[k]}</span>
        <span class="res-metric-val">${v.toFixed(1)}</span>
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
  switch(msg.type) {
    case 'battle-start':
      if (!battleInProgress) initiateBattle();
      break;
    case 'my-result':
      oppResult = msg.result;
      if (battleInProgress) {
        const overlay = document.getElementById('oppScanOverlay');
        overlay.classList.remove('active');
        displayScore('opp', oppResult);
      }
      checkBothDone();
      break;
    case 'opponent-disconnected':
      showToast('Opponent disconnected');
      opponentConnected = false;
      document.getElementById('connDot').className = 'conn-dot';
      document.getElementById('connLabel').textContent = 'DISCONNECTED';
      document.getElementById('scanBtn').disabled = true;
      document.getElementById('centerHint').textContent = 'Opponent left the battle.';
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
  showScreen('battle');
  document.getElementById('scanBtn').disabled = !opponentConnected;
  document.getElementById('rematchBtn').classList.remove('visible');
  document.getElementById('winnerAnnounce').textContent = opponentConnected ? 'READY' : 'WAITING';
  document.getElementById('centerHint').textContent = 'Both ready — hit SCAN to battle!';
  document.getElementById('youScoreBadge').classList.remove('visible');
  document.getElementById('oppScoreBadge').classList.remove('visible');
  document.getElementById('youScoreNum').textContent = '—';
  document.getElementById('oppScoreNum').textContent = '—';
  ['youChips','oppChips'].forEach(id => {
    document.getElementById(id).querySelectorAll('.m-chip').forEach(c => {
      c.classList.remove('lit');
    });
  });
}
 
function countUp(el, target, duration) {
  const steps = 30;
  const step = duration / steps;
  let i = 0;
  const iv = setInterval(() => {
    i++;
    el.textContent = (target * i / steps).toFixed(1);
    if (i >= steps) { el.textContent = target.toFixed(1); clearInterval(iv); }
  }, step);
}
 
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}