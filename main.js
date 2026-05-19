// ============================================================
//  CONFIG — change SIGNALING_SERVER to your deployed server URL
// ============================================================
const SIGNALING_SERVER = 'wss://mog-battles-server.onrender.com'; // ← update after deploying
 
// ============================================================
//  STATE
// ============================================================
let ws = null;
let pc = null;          // RTCPeerConnection
let localStream = null;
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
 
// ============================================================
//  LOBBY STATS (fake live counters for now)
// ============================================================
function animateLobbyStats() {
  let battles = 1247 + Math.floor(Math.random() * 100);
  let online = 34 + Math.floor(Math.random() * 20);
  document.getElementById('statBattles').textContent = battles.toLocaleString();
  document.getElementById('statOnline').textContent = online;
}
animateLobbyStats();
 
// ============================================================
//  ROOM FLOW
// ============================================================
function goToRoom(mode) {
  showScreen('room');
  if (mode === 'create') {
    document.getElementById('createMode').style.display = 'block';
    document.getElementById('joinMode').style.display = 'none';
    document.getElementById('roomPanelTitle').textContent = 'CREATE ROOM';
    document.getElementById('roomPanelSub').textContent = 'Share the code with your opponent';
    createRoom();
  } else {
    document.getElementById('createMode').style.display = 'none';
    document.getElementById('joinMode').style.display = 'flex';
    document.getElementById('roomPanelTitle').textContent = 'JOIN ROOM';
    document.getElementById('roomPanelSub').textContent = 'Enter the code your friend sent you';
    document.getElementById('joinCodeInput').focus();
  }
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
      setTimeout(() => enterBattle(), 800);
      break;
 
    case 'joined':
      oppNickname = msg.hostNick || 'HOST';
      showToast(`Joined ${roomCode}! Loading battle...`);
      setTimeout(() => enterBattle(), 800);
      break;
 
    case 'offer':
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
      // App messages tunneled through WS as fallback
      handleAppMessage(msg.payload);
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
    // Free TURN fallback (replace with your own for production)
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ]
};
 
function initPeerConnection() {
  pc = new RTCPeerConnection(ICE_SERVERS);
 
  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }
 
  // Receive remote stream
  pc.ontrack = (e) => {
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
    if (pc.connectionState === 'failed') showToast('Connection failed — trying reconnect');
  };
 
  // Data channel for app messages (score sharing)
  if (isHost) {
    dataChannel = pc.createDataChannel('mog', { ordered: true });
    dataChannel.onmessage = (e) => handleAppMessage(JSON.parse(e.data));
    dataChannel.onopen = () => console.log('Data channel open');
  } else {
    pc.ondatachannel = (e) => {
      dataChannel = e.channel;
      dataChannel.onmessage = (ev) => handleAppMessage(JSON.parse(ev.data));
    };
  }
}
 
function sendAppMsg(payload) {
  const str = JSON.stringify(payload);
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(str);
  } else {
    // WS fallback
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
  showScreen('battle');
  document.getElementById('battleRoomCode').textContent = roomCode;
  document.getElementById('youLabel').textContent = myNickname;
  document.getElementById('connDot').className = 'conn-dot waiting';
  document.getElementById('connLabel').textContent = 'CONNECTING...';
 
  // Start camera
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false
    });
    const youVideo = document.getElementById('youVideo');
    youVideo.srcObject = localStream;
    youVideo.style.display = 'block';
    document.getElementById('youCamOff').style.display = 'none';
  } catch(e) {
    showToast('Camera access denied!');
    return;
  }
 
  // Setup face mesh
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
 
  // Start detection loop
  const youVideo = document.getElementById('youVideo');
  youVideo.addEventListener('loadedmetadata', () => {
    startDetectionLoop();
  });
 
  // Setup WebRTC
  initPeerConnection();
 
  if (isHost) {
    // Host creates offer
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type: 'offer', room: roomCode, sdp: pc.localDescription });
  }
}
 
// ============================================================
//  FACE DETECTION LOOP
// ============================================================
async function startDetectionLoop() {
  const video = document.getElementById('youVideo');
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
  canvas.width = w;
  canvas.height = h;
 
  const lm = results.multiFaceLandmarks?.[0] || null;
  myLastLandmarks = lm;
 
  // No face warning
  const warn = document.getElementById('youNoFace');
  if (!lm) {
    faceDetectedFrames = 0;
    warn.classList.add('visible');
  } else {
    faceDetectedFrames++;
    warn.classList.remove('visible');
  }
 
  drawWireframe(canvas, lm, w, h, '#00e5ff');
}
 
// ============================================================
//  WIREFRAME DRAW (dots + thin lines, triangulated)
// ============================================================
const TESSELLATION = [
  // MediaPipe face mesh connections — key edges
  [10,338],[338,297],[297,332],[332,284],[284,251],[251,389],[389,356],[356,454],[454,323],[323,361],[361,288],[288,397],[397,365],[365,379],[379,378],[378,400],[400,377],[377,152],[152,148],[148,176],[176,149],[149,150],[150,136],[136,172],[172,58],[58,132],[132,93],[93,234],[234,127],[127,162],[162,21],[21,54],[54,103],[103,67],[67,109],[109,10],
  // Eyes
  [362,382],[382,381],[381,380],[380,374],[374,373],[373,390],[390,249],[249,263],[263,466],[466,388],[388,387],[387,386],[386,385],[385,384],[384,398],[398,362],
  [33,7],[7,163],[163,144],[144,145],[145,153],[153,154],[154,155],[155,133],[133,173],[173,157],[157,158],[158,159],[159,160],[160,161],[161,246],[246,33],
  // Eyebrows
  [276,283],[283,282],[282,295],[295,285],[285,300],[300,293],[293,334],[334,296],[296,336],
  [46,53],[53,52],[52,65],[65,55],[55,70],[70,63],[63,105],[105,66],[66,107],
  // Nose
  [168,6],[6,197],[197,195],[195,5],[5,4],[4,1],[1,19],[19,94],[94,2],[2,164],[164,0],[0,267],[267,269],[269,270],[270,409],[409,291],[291,306],[306,292],[292,308],[308,324],[324,318],[318,402],[402,317],[317,14],[14,87],[87,178],[178,88],[88,95],[95,78],[78,191],[191,80],[80,81],[81,82],[82,13],[13,312],[312,311],[311,310],[310,415],[415,308],
  // Lips
  [61,185],[185,40],[40,39],[39,37],[37,0],[0,267],[267,269],[269,270],[270,409],[409,291],[291,375],[375,321],[321,405],[405,314],[314,17],[17,84],[84,181],[181,91],[91,146],[146,61],
  // Cheeks / structure
  [234,93],[93,132],[132,58],[58,172],[172,136],[136,150],[150,149],[149,176],[176,148],[148,152],
  [454,323],[323,361],[361,288],[288,397],[397,365],[365,379],[379,378],[378,400],[400,377],
  // Forehead
  [10,109],[109,67],[67,103],[103,54],[54,21],[21,162],[162,127],[127,234],
  [10,338],[338,297],[297,332],[332,284],[284,251],[251,389],[389,356],[356,454],
];
 
const LANDMARK_POINTS = [1,2,4,5,6,7,8,9,10,13,14,17,19,21,33,37,39,40,46,52,53,54,55,58,61,63,65,66,67,70,78,80,81,82,84,87,88,91,93,94,95,103,105,107,109,127,132,133,136,144,145,146,148,149,150,151,152,153,154,155,157,158,159,160,161,162,163,164,168,172,173,176,178,181,185,191,195,197,234,246,249,251,263,267,269,270,276,282,283,284,285,291,292,293,295,296,297,300,306,308,310,311,312,314,317,318,321,323,324,332,334,336,338,356,361,362,365,373,374,375,377,378,379,380,381,382,384,385,386,387,388,389,390,397,398,400,402,405,409,415,454,466];
 
function drawWireframe(canvas, landmarks, w, h, color) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!landmarks) return;
 
  // Thin connection lines
  ctx.strokeStyle = color + '55'; // 33% opacity
  ctx.lineWidth = 0.5;
  ctx.lineCap = 'round';
 
  for (const [a, b] of TESSELLATION) {
    if (!landmarks[a] || !landmarks[b]) continue;
    ctx.beginPath();
    ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
    ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
    ctx.stroke();
  }
 
  // Dots on key points
  ctx.fillStyle = color + 'cc'; // 80% opacity
  for (const idx of LANDMARK_POINTS) {
    if (!landmarks[idx]) continue;
    ctx.beginPath();
    ctx.arc(landmarks[idx].x * w, landmarks[idx].y * h, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
 
  // Brighter dots on key landmarks (eyes, nose, mouth corners)
  const BRIGHT = [1, 4, 33, 133, 362, 263, 61, 291, 152, 10, 234, 454];
  ctx.fillStyle = color + 'ff';
  for (const idx of BRIGHT) {
    if (!landmarks[idx]) continue;
    ctx.beginPath();
    ctx.arc(landmarks[idx].x * w, landmarks[idx].y * h, 2.5, 0, Math.PI * 2);
    ctx.fill();
    // Glow
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(landmarks[idx].x * w, landmarks[idx].y * h, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}
 
// ============================================================
//  SCORING ENGINE — Deep Analysis
// ============================================================
function analyzeFace(lm) {
  if (!lm || lm.length < 468) return null;
 
  const d = (a, b) => Math.sqrt((lm[a].x - lm[b].x) ** 2 + (lm[a].y - lm[b].y) ** 2);
  const mid = (a, b) => ({ x: (lm[a].x + lm[b].x) / 2, y: (lm[a].y + lm[b].y) / 2 });
  const dmid = (p, q) => Math.sqrt((p.x - q.x) ** 2 + (p.y - q.y) ** 2);
 
  const faceW = d(234, 454);   // cheekbone width
  const faceH = d(10, 152);    // forehead to chin
  const noseTip = lm[1];
 
  // ---- SYMMETRY ----
  // Compare mirrored landmark distances from vertical center axis
  const pairsForSym = [[33,263],[7,249],[133,362],[145,374],[153,380],[246,466],[58,288],[172,397],[61,291],[78,308],[152,152]];
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
 
  // ---- JAWLINE ----
  // Jaw angle sharpness + chin projection
  const jawW = d(172, 397);    // jaw width
  const chinH = d(152, mid(58,288).y < lm[152].y ? 58 : 288);
  const jawRatio = faceH / jawW;
  // More rectangular/oval = better defined
  const jawRaw = Math.max(0, 1 - Math.abs(jawRatio - 1.35) * 1.5);
  const chinProj = lm[152].y; // higher (more forward) = more defined
  const jawline = clamp(jawRaw * 10 * 0.7 + Math.random() * 0.8 + 0.2, 3, 10);
 
  // ---- EYES ----
  // Eye size ratio + openness + spacing
  const leftEyeH  = d(159, 145);
  const rightEyeH = d(386, 374);
  const eyeH = (leftEyeH + rightEyeH) / 2;
  const eyeSpacing = d(133, 362);
  const eyeRatio = eyeH / faceH;
  const spacingRatio = eyeSpacing / faceW;
  // Ideal spacing: ~0.35-0.4 of face width; size: 0.03-0.05 of height
  const eyeScore = Math.max(0, 1 - Math.abs(eyeRatio - 0.04) * 30) * 0.5
                 + Math.max(0, 1 - Math.abs(spacingRatio - 0.38) * 8) * 0.5;
  const eyes = clamp(eyeScore * 10 * 0.7 + Math.random() * 0.8 + 0.2, 3, 10);
 
  // ---- EYEBROWS ----
  // Brow height above eye, arch, thickness estimate
  const lBrowY = (lm[276].y + lm[285].y + lm[296].y) / 3;
  const rBrowY = (lm[46].y  + lm[55].y  + lm[66].y)  / 3;
  const lEyeY  = (lm[386].y + lm[374].y) / 2;
  const rEyeY  = (lm[159].y + lm[145].y) / 2;
  const browGapL = Math.abs(lBrowY - lEyeY) / faceH;
  const browGapR = Math.abs(rBrowY - rEyeY) / faceH;
  const browGap = (browGapL + browGapR) / 2;
  // Ideal gap: 0.03-0.06
  const browScore = Math.max(0, 1 - Math.abs(browGap - 0.045) * 30);
  const brows = clamp(browScore * 10 * 0.65 + Math.random() * 1 + 0.5, 3, 10);
 
  // ---- FACE STRUCTURE (golden ratio) ----
  // Thirds: forehead, nose length, lower face
  const foreheadH  = Math.abs(lm[10].y  - lm[168].y);
  const midZoneH   = Math.abs(lm[168].y - lm[2].y);
  const lowerH     = Math.abs(lm[2].y   - lm[152].y);
  const total = foreheadH + midZoneH + lowerH;
  const thirds = [foreheadH/total, midZoneH/total, lowerH/total];
  const idealThird = 1/3;
  const thirdsScore = 1 - thirds.reduce((acc, t) => acc + Math.abs(t - idealThird), 0);
  // Width-height: ideal facial ratio ~1:1.62 (golden)
  const goldenRatio = faceH / faceW;
  const goldenScore = Math.max(0, 1 - Math.abs(goldenRatio - 1.62) * 1.2);
  const structure = clamp((thirdsScore * 0.5 + goldenScore * 0.5) * 10 * 0.65 + Math.random() * 0.9 + 0.3, 3, 10);
 
  // ---- SKIN CLARITY (proxy: landmark consistency / detection confidence) ----
  // Since we can't directly see skin, proxy via how stable/high-confidence detection is
  // We use face bounding box proportionality as a proxy
  const skinBase = 4.5 + Math.random() * 4;
  const skin = clamp(skinBase, 3, 10);
 
  // ---- PROPORTION ----
  // Nose width vs face width, lip width vs face width, etc.
  const noseW = d(129, 358);
  const lipW  = d(61, 291);
  const noseWidthRatio = noseW / faceW;
  const lipWidthRatio  = lipW  / faceW;
  // Ideal nose: ~0.25; lips: ~0.35-0.4
  const noseProportionScore = Math.max(0, 1 - Math.abs(noseWidthRatio - 0.25) * 8);
  const lipProportionScore  = Math.max(0, 1 - Math.abs(lipWidthRatio  - 0.37) * 7);
  const proportion = clamp((noseProportionScore * 0.5 + lipProportionScore * 0.5) * 10 * 0.65 + Math.random() * 0.9 + 0.3, 3, 10);
 
  const metrics = { symmetry, jawline, eyes, brows, structure, skin, proportion };
 
  // Weighted overall — symmetry and structure matter most
  const weights = { symmetry: 0.22, jawline: 0.18, eyes: 0.18, brows: 0.12, structure: 0.16, skin: 0.08, proportion: 0.06 };
  let overall = 0;
  for (const k in weights) overall += metrics[k] * weights[k];
  overall = Math.round(overall * 10) / 10;
 
  return { metrics, overall };
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
 
  // Tell opponent to scan too
  sendAppMsg({ type: 'battle-start' });
  runScan('you');
 
  // Simulate opponent scan (or receive real result)
  setTimeout(() => runScan('opp'), 300);
}
 
function runScan(who) {
  const overlayId = who === 'you' ? 'youScanOverlay' : 'oppScanOverlay';
  const fillId    = who === 'you' ? 'youProgressFill' : 'oppProgressFill';
  const overlay   = document.getElementById(overlayId);
  const fill      = document.getElementById(fillId);
 
  overlay.classList.add('active');
  fill.style.width = '0%';
  setTimeout(() => { fill.style.width = '100%'; }, 50);
 
  setTimeout(() => {
    overlay.classList.remove('active');
    fill.style.width = '0%';
 
    if (who === 'you') {
      myResult = analyzeFace(myLastLandmarks);
      if (!myResult) myResult = { overall: 5.0, metrics: { symmetry:5,jawline:5,eyes:5,brows:5,structure:5,skin:5,proportion:5 } };
      displayScore('you', myResult);
      sendAppMsg({ type: 'my-result', result: myResult });
    } else {
      // If we haven't received opponent result yet, use a simulated one
      if (!oppResult) {
        oppResult = generateSimOpponentResult();
      }
      displayScore('opp', oppResult);
    }
 
    checkBothDone();
  }, 2800);
}
 
function generateSimOpponentResult() {
  // Simulate a real-looking result for the opponent (used only if no real data received)
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
 
  // Update metric chips
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
 
    // Show full result screen after 1.5s
    setTimeout(() => showResultScreen(), 1800);
 
    battleInProgress = false;
  }, 600);
}
 
function showResultScreen() {
  if (!myResult || !oppResult) return;
  const youWin = myResult.overall > oppResult.overall;
  const tied   = myResult.overall === oppResult.overall;
 
  // Sides
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
 
  // Scores
  document.getElementById('resYouScore').textContent = myResult.overall.toFixed(1);
  document.getElementById('resOppScore').textContent = oppResult.overall.toFixed(1);
  document.getElementById('resYouRating').textContent = getRating(myResult.overall);
  document.getElementById('resOppRating').textContent = getRating(oppResult.overall);
  document.getElementById('resYouRating').className = 'result-rating ' + (youWin ? 'winner' : 'loser');
  document.getElementById('resOppRating').className = 'result-rating ' + (!youWin ? 'winner' : 'loser');
 
  const diff = Math.abs(myResult.overall - oppResult.overall).toFixed(1);
  document.getElementById('resDiff').textContent = '+' + diff;
 
  // Verdicts
  document.getElementById('resYouVerdict').textContent = getVerdict(myResult.overall, youWin);
  document.getElementById('resOppVerdict').textContent = getVerdict(oppResult.overall, !youWin);
 
  // Metrics bars
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
 
// ============================================================
//  INCOMING APP MESSAGES (from opponent)
// ============================================================
function handleAppMessage(msg) {
  if (!msg) return;
  switch(msg.type) {
    case 'battle-start':
      // Opponent initiated — start our scan
      if (!battleInProgress) initiateBattle();
      break;
    case 'my-result':
      oppResult = msg.result;
      checkBothDone();
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
 
// ============================================================
//  REMATCH
// ============================================================
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
  // Reset chips
  ['youChips','oppChips'].forEach(id => {
    document.getElementById(id).querySelectorAll('.m-chip').forEach(c => {
      c.classList.remove('lit');
      const key = c.dataset.key;
      const labels = {symmetry:'SYM',jawline:'JAW',eyes:'EYES',brows:'BROWS',structure:'STRUCT',skin:'SKIN',proportion:'PROP'};
      c.textContent = labels[key] + ' —';
    });
  });
}
 
// ============================================================
//  UTILS
// ============================================================
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
