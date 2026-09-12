// ============================================================================
// Battle Arena — client game logic
// Handles: UI/screen management, input (keyboard/mouse/touch), the render
// loop, camera fitting, entity interpolation, particle/shake/damage-number
// effects, HUD updates and audio cue triggering. The server is authoritative
// for all game facts; this file only ever *displays* what it is told and
// *requests* actions (move/aim/attack) — it never decides outcomes.
// ============================================================================

const C = window.BA_CONST;

// ----------------------------------------------------------------------------
// Persistent settings (localStorage)
// ----------------------------------------------------------------------------
const settings = {
  name: localStorage.getItem('ba_name') || '',
  color: localStorage.getItem('ba_color') || C.PLAYER_COLORS[0],
  volume: parseFloat(localStorage.getItem('ba_volume') ?? '0.7'),
  sfx: localStorage.getItem('ba_sfx') !== '0',
  shake: localStorage.getItem('ba_shake') !== '0',
  music: localStorage.getItem('ba_music') !== '0',
};

function saveSettings() {
  localStorage.setItem('ba_name', settings.name);
  localStorage.setItem('ba_color', settings.color);
  localStorage.setItem('ba_volume', String(settings.volume));
  localStorage.setItem('ba_sfx', settings.sfx ? '1' : '0');
  localStorage.setItem('ba_shake', settings.shake ? '1' : '0');
  localStorage.setItem('ba_music', settings.music ? '1' : '0');
}

// ----------------------------------------------------------------------------
// DOM references
// ----------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const screens = {
  menu: $('screen-menu'),
  multiplayer: $('screen-multiplayer'),
  armory: $('screen-armory'),
  lobby: $('screen-lobby'),
  game: $('screen-game'),
  end: $('screen-end'),
};

// ----------------------------------------------------------------------------
// Persistent career stats (per-browser, local only — no server accounts)
// ----------------------------------------------------------------------------
const stats = JSON.parse(localStorage.getItem('ba_stats') || 'null') || {
  gamesPlayed: 0, wins: 0, totalKills: 0, bestScore: 0,
};

function saveStats() { localStorage.setItem('ba_stats', JSON.stringify(stats)); }

function renderStats() {
  const el = $('menu-stats');
  if (stats.gamesPlayed === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `
    <span>Games: <b>${stats.gamesPlayed}</b></span>
    <span>Wins: <b>${stats.wins}</b></span>
    <span>Kills: <b>${stats.totalKills}</b></span>
    <span>Best Score: <b>${stats.bestScore}</b></span>
  `;
}
renderStats();

// ----------------------------------------------------------------------------
// Progression: credits, owned/equipped weapon, character upgrades
// (per-browser, local only). Purchases only ever change *which id/level* is
// stored here — the server independently looks up real stats from its own
// copy of the same catalog (public/shared/constants.js), so this state is
// never trusted for anything that affects fairness.
// ----------------------------------------------------------------------------
const progression = Object.assign({
  credits: 0,
  ownedWeapons: [C.DEFAULT_WEAPON_ID],
  equippedWeapon: C.DEFAULT_WEAPON_ID,
  upgrades: { health: 0, speed: 0, cooldown: 0, meleeDamage: 0 },
}, JSON.parse(localStorage.getItem('ba_progression') || 'null') || {});

function saveProgression() { localStorage.setItem('ba_progression', JSON.stringify(progression)); }

function currentLoadout() {
  return { weaponId: progression.equippedWeapon, upgrades: progression.upgrades };
}

function buyWeapon(id) {
  const weapon = C.WEAPON_CATALOG[id];
  if (!weapon || progression.ownedWeapons.includes(id) || progression.credits < weapon.cost) return false;
  progression.credits -= weapon.cost;
  progression.ownedWeapons.push(id);
  progression.equippedWeapon = id;
  saveProgression();
  return true;
}

function equipWeapon(id) {
  if (!progression.ownedWeapons.includes(id)) return false;
  progression.equippedWeapon = id;
  saveProgression();
  return true;
}

function buyUpgrade(id) {
  const def = C.UPGRADE_DEFS[id];
  const level = progression.upgrades[id] || 0;
  if (!def || level >= def.maxLevel) return false;
  const cost = C.upgradeCost(def, level);
  if (progression.credits < cost) return false;
  progression.credits -= cost;
  progression.upgrades[id] = level + 1;
  saveProgression();
  return true;
}

function renderArmory() {
  $('armory-credits-value').textContent = progression.credits;

  const weaponsEl = $('armory-weapons');
  weaponsEl.innerHTML = '';
  const weapons = Object.values(C.WEAPON_CATALOG).sort((a, b) => a.order - b.order);
  weapons.forEach((w) => {
    const owned = progression.ownedWeapons.includes(w.id);
    const equipped = progression.equippedWeapon === w.id;
    const card = document.createElement('div');
    card.className = 'weapon-card' + (equipped ? ' equipped' : '');
    const pelletsNote = w.pellets > 1 ? ` × ${w.pellets}` : '';
    card.innerHTML = `
      <div class="weapon-card-icon" style="color:${w.color}">${w.icon}</div>
      <div class="weapon-card-name">${w.name}</div>
      <div class="weapon-card-stats">DMG ${w.damage}${pelletsNote} · CD ${(w.cooldownMs / 1000).toFixed(2)}s · RNG ${w.range}</div>
      <div class="weapon-card-desc">${w.desc}</div>
    `;
    const btn = document.createElement('button');
    if (equipped) {
      btn.className = 'weapon-card-btn equipped-tag';
      btn.textContent = 'Equipped';
      btn.disabled = true;
    } else if (owned) {
      btn.className = 'weapon-card-btn equip';
      btn.textContent = 'Equip';
      btn.addEventListener('click', () => { AUDIO.click(); equipWeapon(w.id); renderArmory(); });
    } else {
      btn.className = 'weapon-card-btn buy';
      btn.textContent = `Buy — ${w.cost}`;
      btn.disabled = progression.credits < w.cost;
      btn.addEventListener('click', () => {
        if (buyWeapon(w.id)) { AUDIO.powerup('damage'); renderArmory(); } else { AUDIO.click(); }
      });
    }
    card.appendChild(btn);
    weaponsEl.appendChild(card);
  });

  const upgradesEl = $('armory-upgrades');
  upgradesEl.innerHTML = '';
  const upgrades = Object.values(C.UPGRADE_DEFS).sort((a, b) => a.order - b.order);
  upgrades.forEach((def) => {
    const level = progression.upgrades[def.id] || 0;
    const maxed = level >= def.maxLevel;
    const row = document.createElement('div');
    row.className = 'upgrade-row';
    const dots = Array.from({ length: def.maxLevel }, (_, i) =>
      `<span class="upgrade-dot${i < level ? ' filled' : ''}"></span>`).join('');
    row.innerHTML = `
      <div class="upgrade-row-info">
        <div class="upgrade-row-name">${def.name}</div>
        <div class="upgrade-row-desc">${def.desc}</div>
      </div>
      <div class="upgrade-dots">${dots}</div>
    `;
    const btn = document.createElement('button');
    if (maxed) {
      btn.className = 'upgrade-row-btn maxed';
      btn.textContent = 'MAXED';
      btn.disabled = true;
    } else {
      const cost = C.upgradeCost(def, level);
      btn.className = 'upgrade-row-btn';
      btn.textContent = `Buy — ${cost}`;
      btn.disabled = progression.credits < cost;
      btn.addEventListener('click', () => {
        if (buyUpgrade(def.id)) { AUDIO.powerup('health'); renderArmory(); } else { AUDIO.click(); }
      });
    }
    row.appendChild(btn);
    upgradesEl.appendChild(row);
  });
}

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[name].classList.add('active');
  if (name === 'game') {
    requestAnimationFrame(resizeCanvas);
  }
}

function showToast(msg, duration = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), duration);
}

// ----------------------------------------------------------------------------
// Menu setup: name field, color swatches, modals
// ----------------------------------------------------------------------------
$('input-name').value = settings.name;
$('input-name').addEventListener('input', (e) => { settings.name = e.target.value; saveSettings(); });

const swatchWrap = $('color-swatches');
C.PLAYER_COLORS.forEach((color) => {
  const el = document.createElement('div');
  el.className = 'color-swatch';
  el.style.background = color;
  el.style.color = color;
  if (color === settings.color) el.classList.add('selected');
  el.addEventListener('click', () => {
    settings.color = color;
    saveSettings();
    document.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
    el.classList.add('selected');
  });
  swatchWrap.appendChild(el);
});

function currentName() {
  const n = $('input-name').value.trim();
  return n.length ? n : `Player${Math.floor(Math.random() * 9000 + 1000)}`;
}

// Modals
function wireModal(modalId, openBtnId) {
  const modal = $(modalId);
  if (openBtnId) $(openBtnId).addEventListener('click', () => modal.classList.remove('hidden'));
  modal.querySelectorAll('.modal-close').forEach((btn) => btn.addEventListener('click', () => modal.classList.add('hidden')));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
}
wireModal('modal-instructions', 'btn-instructions');
wireModal('modal-settings', 'btn-settings');

$('setting-volume').value = Math.round(settings.volume * 100);
$('setting-sfx').checked = settings.sfx;
$('setting-shake').checked = settings.shake;
$('setting-volume').addEventListener('input', (e) => {
  settings.volume = e.target.value / 100;
  AUDIO.setVolume(settings.volume);
  saveSettings();
});
$('setting-sfx').addEventListener('change', (e) => { settings.sfx = e.target.checked; AUDIO.setEnabled(settings.sfx); saveSettings(); });
$('setting-shake').addEventListener('change', (e) => { settings.shake = e.target.checked; saveSettings(); });
$('setting-music').checked = settings.music;
$('setting-music').addEventListener('change', (e) => { settings.music = e.target.checked; AUDIO.setMusicEnabled(settings.music); saveSettings(); });
AUDIO.setVolume(settings.volume);
AUDIO.setEnabled(settings.sfx);
AUDIO.setMusicEnabled(settings.music);

// Any click anywhere resumes the (possibly suspended) audio context.
document.addEventListener('pointerdown', () => AUDIO.resume(), { once: false });

// ----------------------------------------------------------------------------
// Main menu → multiplayer panel → lobby wiring
// ----------------------------------------------------------------------------
$('btn-quickplay').addEventListener('click', () => {
  AUDIO.click();
  NET.quickPlay(currentName(), settings.color, currentLoadout());
});

$('btn-multiplayer').addEventListener('click', () => { AUDIO.click(); showScreen('multiplayer'); });
$('btn-mp-back').addEventListener('click', () => { AUDIO.click(); showScreen('menu'); });

$('btn-armory').addEventListener('click', () => { AUDIO.click(); renderArmory(); showScreen('armory'); });
$('btn-armory-back').addEventListener('click', () => { AUDIO.click(); showScreen('menu'); });

$('btn-create-room').addEventListener('click', () => {
  AUDIO.click();
  NET.createRoom(currentName(), settings.color, currentLoadout());
});

$('btn-join-room').addEventListener('click', () => {
  AUDIO.click();
  const code = $('input-code').value.trim().toUpperCase();
  $('mp-error').textContent = '';
  if (code.length !== 4) { $('mp-error').textContent = 'Enter a 4-letter room code.'; return; }
  NET.joinRoom(code, currentName(), settings.color, currentLoadout());
});
$('input-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
$('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join-room').click(); });

let isHost = false;
let myId = null;
let roomCode = null;
let lastLobbyData = null;

$('btn-ready').addEventListener('click', () => { AUDIO.click(); NET.toggleReady(); });
$('btn-start-game').addEventListener('click', () => { AUDIO.click(); NET.startGame(); });
$('btn-lobby-leave').addEventListener('click', () => {
  AUDIO.click();
  NET.leaveRoom();
  showScreen('menu');
});
$('btn-copy-code').addEventListener('click', async () => {
  if (!roomCode) return;
  try {
    await navigator.clipboard.writeText(roomCode);
  } catch (e) {
    // Clipboard API unavailable (older browser / insecure context) — ignore.
  }
  showToast('Room code copied!');
});
$('btn-add-bot').addEventListener('click', () => { AUDIO.click(); NET.addBot(); });
$('btn-remove-bot').addEventListener('click', () => { AUDIO.click(); NET.removeBot(); });

function renderLobby(data) {
  lastLobbyData = data;
  roomCode = data.code;
  $('lobby-room-code').textContent = data.code;
  $('lobby-count').textContent = data.players.length;
  $('lobby-max').textContent = data.maxPlayers;

  const list = $('lobby-player-list');
  list.innerHTML = '';
  let me = null;
  data.players.forEach((p) => {
    if (p.id === myId) me = p;
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    dot.style.color = p.color;
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name + (p.id === myId ? ' (you)' : '');
    li.appendChild(dot);
    li.appendChild(name);
    if (p.isHost) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = '★ HOST';
      li.appendChild(tag);
    }
    if (p.isBot) {
      const botTag = document.createElement('span');
      botTag.className = 'bot-tag';
      botTag.textContent = 'BOT';
      li.appendChild(botTag);
    }
    const weapon = C.WEAPON_CATALOG[p.weaponId];
    if (weapon) {
      const weaponTag = document.createElement('span');
      weaponTag.className = 'weapon-tag';
      weaponTag.textContent = weapon.icon + ' ' + weapon.name;
      li.appendChild(weaponTag);
    }
    const readyTag = document.createElement('span');
    readyTag.className = p.ready ? 'ready-tag' : 'notready-tag';
    readyTag.textContent = p.ready ? 'READY' : 'not ready';
    li.appendChild(readyTag);
    list.appendChild(li);
  });

  isHost = !!(me && me.isHost);
  $('btn-ready').textContent = (me && me.ready) ? 'Not Ready' : 'Ready Up';
  $('btn-start-game').disabled = !isHost;
  $('lobby-hint').textContent = isHost
    ? 'You are the host — start whenever you\'re ready.'
    : 'Waiting for host to start the match…';

  $('bot-controls').classList.toggle('hidden', !isHost);
  $('btn-add-bot').disabled = !isHost || data.players.length >= data.maxPlayers;
  $('btn-remove-bot').disabled = !isHost || !data.players.some((p) => p.isBot);

  showScreen('lobby');
}

NET.on('roomJoined', (data) => {
  myId = data.selfId;
  roomCode = data.code;
  $('mp-error').textContent = '';
});
NET.on('joinError', (data) => { $('mp-error').textContent = data.message; showToast(data.message); });
NET.on('lobbyUpdate', renderLobby);

// ----------------------------------------------------------------------------
// Connection resilience — a dropped socket (mobile network hiccup, server
// restart, etc.) is common enough to design for explicitly rather than
// leaving the player staring at a frozen screen with no explanation.
// Socket.IO's client retries automatically; we just need to reflect that
// state and, once actually reconnected, restart cleanly at the main menu
// (the old room/player no longer exists server-side under the new socket id).
// ----------------------------------------------------------------------------
let hasConnectedOnce = false;
NET.on('connect', () => {
  $('connection-overlay').classList.add('hidden');
  if (hasConnectedOnce) {
    myId = null;
    roomCode = null;
    latestState = null;
    renderPlayers.clear();
    showToast('Reconnected — rejoin to keep playing', 3200);
    showScreen('menu');
  }
  hasConnectedOnce = true;
});
NET.on('disconnect', () => {
  $('connection-overlay').classList.remove('hidden');
});

// ----------------------------------------------------------------------------
// Canvas / camera
// ----------------------------------------------------------------------------
const canvas = $('gameCanvas');
const ctx = canvas.getContext('2d');
const camera = { scale: 1, offsetX: 0, offsetY: 0 };
const minimapCanvas = $('minimap');
const minimapCtx = minimapCanvas.getContext('2d');

function resizeCanvas() {
  const container = $('game-container');
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth, h = container.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  camera.scale = Math.min(w / C.ARENA_WIDTH, h / C.ARENA_HEIGHT);
  camera.offsetX = (w - C.ARENA_WIDTH * camera.scale) / 2;
  camera.offsetY = (h - C.ARENA_HEIGHT * camera.scale) / 2;
  camera.viewW = w; camera.viewH = h;
}
window.addEventListener('resize', resizeCanvas);

function worldToScreen(x, y) {
  return [camera.offsetX + x * camera.scale, camera.offsetY + y * camera.scale];
}
function screenToWorld(x, y) {
  return [(x - camera.offsetX) / camera.scale, (y - camera.offsetY) / camera.scale];
}

// ----------------------------------------------------------------------------
// Input: keyboard, mouse, touch joystick, touch aim, attack button
// ----------------------------------------------------------------------------
const keys = { up: false, down: false, left: false, right: false };
const inputState = { moveX: 0, moveY: 0, angle: 0, attack: false, melee: false };
let myWorldPos = { x: C.ARENA_WIDTH / 2, y: C.ARENA_HEIGHT / 2 };

function updateMoveVector() {
  let mx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  let my = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  const mag = Math.hypot(mx, my);
  if (mag > 0) { mx /= mag; my /= mag; }
  inputState.moveX = mx;
  inputState.moveY = my;
}

window.addEventListener('keydown', (e) => {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': keys.up = true; break;
    case 'KeyS': case 'ArrowDown': keys.down = true; break;
    case 'KeyA': case 'ArrowLeft': keys.left = true; break;
    case 'KeyD': case 'ArrowRight': keys.right = true; break;
    case 'Space': inputState.melee = true; e.preventDefault(); return;
    default: return;
  }
  updateMoveVector();
});
window.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': keys.up = false; break;
    case 'KeyS': case 'ArrowDown': keys.down = false; break;
    case 'KeyA': case 'ArrowLeft': keys.left = false; break;
    case 'KeyD': case 'ArrowRight': keys.right = false; break;
    case 'Space': inputState.melee = false; e.preventDefault(); return;
    default: return;
  }
  updateMoveVector();
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const [wx, wy] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  inputState.angle = Math.atan2(wy - myWorldPos.y, wx - myWorldPos.x);
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) inputState.attack = true;
  if (e.button === 2) inputState.melee = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) inputState.attack = false;
  if (e.button === 2) inputState.melee = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// --- Mobile joystick ---
const joystickZone = $('joystick-zone');
const joystickBase = $('joystick-base');
const joystickStick = $('joystick-stick');
let joystickTouchId = null;
const JOY_RADIUS = 50;

function joystickStart(id, clientX, clientY) {
  joystickTouchId = id;
  const rect = joystickZone.getBoundingClientRect();
  let x = clientX - rect.left, y = clientY - rect.top;
  x = Math.min(Math.max(x, JOY_RADIUS), rect.width - JOY_RADIUS);
  y = Math.min(Math.max(y, JOY_RADIUS), rect.height - JOY_RADIUS);
  joystickBase.style.display = 'block';
  joystickBase.style.left = `${x - 50}px`;
  joystickBase.style.top = `${y - 50}px`;
  joystickBase.dataset.cx = x;
  joystickBase.dataset.cy = y;
}
function joystickMove(clientX, clientY) {
  const rect = joystickZone.getBoundingClientRect();
  const cx = parseFloat(joystickBase.dataset.cx), cy = parseFloat(joystickBase.dataset.cy);
  let dx = (clientX - rect.left) - cx;
  let dy = (clientY - rect.top) - cy;
  const dist = Math.hypot(dx, dy);
  const maxDist = JOY_RADIUS;
  if (dist > maxDist) { dx = (dx / dist) * maxDist; dy = (dy / dist) * maxDist; }
  joystickStick.style.left = `${27 + dx}px`;
  joystickStick.style.top = `${27 + dy}px`;
  inputState.moveX = clamp(dx / maxDist, -1, 1);
  inputState.moveY = clamp(dy / maxDist, -1, 1);
}
function joystickEnd() {
  joystickTouchId = null;
  joystickBase.style.display = 'none';
  joystickStick.style.left = '27px';
  joystickStick.style.top = '27px';
  inputState.moveX = 0;
  inputState.moveY = 0;
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

joystickZone.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.changedTouches[0];
  joystickStart(t.identifier, t.clientX, t.clientY);
}, { passive: false });
joystickZone.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joystickTouchId) joystickMove(t.clientX, t.clientY);
  }
}, { passive: false });
joystickZone.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) if (t.identifier === joystickTouchId) joystickEnd();
});
joystickZone.addEventListener('touchcancel', joystickEnd);

// --- Mobile aim (drag anywhere on the right side to aim toward that point) ---
const aimZone = $('aim-zone');
let aimTouchId = null;
function handleAimTouch(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const [wx, wy] = screenToWorld(clientX - rect.left, clientY - rect.top);
  inputState.angle = Math.atan2(wy - myWorldPos.y, wx - myWorldPos.x);
}
aimZone.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.changedTouches[0];
  aimTouchId = t.identifier;
  handleAimTouch(t.clientX, t.clientY);
}, { passive: false });
aimZone.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) if (t.identifier === aimTouchId) handleAimTouch(t.clientX, t.clientY);
}, { passive: false });
aimZone.addEventListener('touchend', (e) => { for (const t of e.changedTouches) if (t.identifier === aimTouchId) aimTouchId = null; });

// --- Mobile attack / melee buttons ---
const attackBtn = $('btn-attack-mobile');
attackBtn.addEventListener('touchstart', (e) => { e.preventDefault(); inputState.attack = true; }, { passive: false });
attackBtn.addEventListener('touchend', (e) => { e.preventDefault(); inputState.attack = false; }, { passive: false });
attackBtn.addEventListener('touchcancel', () => { inputState.attack = false; });

const meleeBtn = $('btn-melee-mobile');
meleeBtn.addEventListener('touchstart', (e) => { e.preventDefault(); inputState.melee = true; }, { passive: false });
meleeBtn.addEventListener('touchend', (e) => { e.preventDefault(); inputState.melee = false; }, { passive: false });
meleeBtn.addEventListener('touchcancel', () => { inputState.melee = false; });

// Send input to the server at a fixed rate, decoupled from render rate.
let inputSeq = 0;
setInterval(() => {
  if (screens.game.classList.contains('active')) {
    NET.sendInput({ seq: inputSeq++, moveX: inputState.moveX, moveY: inputState.moveY, angle: inputState.angle, attack: inputState.attack, melee: inputState.melee });
  }
}, 1000 / 30);

// ----------------------------------------------------------------------------
// Game state, interpolation, effects
// ----------------------------------------------------------------------------
let latestState = null;
const renderPlayers = new Map(); // id -> { x,y,angle, targetX,targetY,targetAngle, ...meta }
let particles = [];
let floatingTexts = [];
let slashArcs = [];
const projectileTrails = new Map(); // projectile id -> previous {x,y}, for drawing motion trails
let shakeMag = 0;
let roundActive = false;
let countdownInterval = null;
let hitStopUntil = 0; // brief near-freeze on a satisfying kill, for extra punch

function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

function spawnParticles(x, y, color, count, opts = {}) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (opts.speed || 120) * (0.4 + Math.random() * 0.8);
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0,
      maxLife: (opts.life || 0.5) * (0.7 + Math.random() * 0.6),
      color,
      size: (opts.size || 3) * (0.6 + Math.random() * 0.8),
    });
  }
}

function spawnDamageNumber(x, y, amount, color) {
  floatingTexts.push({ x, y, vy: -50, text: `-${amount}`, life: 0, maxLife: 0.9, color });
}

function triggerShake(amount) {
  if (!settings.shake) return;
  shakeMag = Math.min(shakeMag + amount, 30);
}

// --- Network → visual/audio event handlers ---
NET.on('gameState', (data) => {
  latestState = data;
  updateHud(data);
});

NET.on('hitEvent', (e) => {
  const isMeTarget = e.targetId === myId;
  const isMeAttacker = e.attackerId === myId;
  spawnDamageNumber(e.x, e.y, e.damage, isMeTarget ? '#ff5050' : '#ffe066');
  spawnParticles(e.x, e.y, isMeTarget ? '#ff5050' : '#ffd93d', 10, { speed: 160, life: 0.4, size: 3 });
  if (isMeTarget) {
    triggerShake(9);
    flashHit();
    AUDIO.ownHit();
  } else if (isMeAttacker) {
    triggerShake(3);
    AUDIO.hit();
  }
});

NET.on('deathEvent', (e) => {
  const p = renderPlayers.get(e.victimId);
  const color = p ? p.color : '#ffffff';
  spawnParticles(e.x, e.y, color, 28, { speed: 220, life: 0.8, size: 4 });
  addKillFeed(e);
  if (e.victimId === myId) {
    AUDIO.death();
    triggerShake(14);
  }
  if (e.killerId === myId && e.killerId !== e.victimId) {
    // Extra juice for landing a kill: brief freeze-frame + gold flash + burst.
    hitStopUntil = performance.now() + 130;
    flashKill();
    triggerShake(6);
    spawnParticles(e.x, e.y, '#ffd93d', 14, { speed: 140, life: 0.5, size: 3 });
  }
});

NET.on('respawnEvent', (e) => {
  const rp = renderPlayers.get(e.playerId);
  if (rp) { rp.x = e.x; rp.y = e.y; rp.targetX = e.x; rp.targetY = e.y; }
});

NET.on('powerupCollected', (e) => {
  AUDIO.powerup(e.type);
  if (e.playerId === myId) showToast(`${powerupLabel(e.type)} activated!`, 1400);
});

NET.on('meleeEvent', (e) => {
  spawnParticles(e.x, e.y, '#ffd93d', e.hit ? 6 : 3, { speed: 90, life: 0.25, size: 2.5 });
  const attacker = renderPlayers.get(e.playerId);
  if (attacker) {
    slashArcs.push({
      x: attacker.x, y: attacker.y, angle: attacker.angle,
      color: attacker.color, hit: e.hit, life: 0, maxLife: 0.18,
    });
  }
  if (e.playerId === myId) AUDIO.meleeSwing();
});

NET.on('killstreakEvent', (e) => {
  if (e.playerId === myId) {
    showAnnouncer(e.label.toUpperCase());
    AUDIO.killstreak();
  }
});

NET.on('countdownStart', (data) => {
  showScreen('game');
  renderPlayers.clear();
  particles = []; floatingTexts = []; slashArcs = []; shakeMag = 0;
  projectileTrails.clear();
  $('kill-feed').innerHTML = '';
  $('round-label').textContent = `Round ${data.roundNumber}`;
  $('countdown-round').textContent = data.roundNumber;
  const overlay = $('countdown-overlay');
  overlay.classList.remove('hidden');
  let lastShown = null;
  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, data.endsAt - Date.now());
    const secs = Math.ceil(remaining / 1000);
    if (secs !== lastShown) {
      lastShown = secs;
      $('countdown-number').textContent = secs > 0 ? secs : 'FIGHT!';
      if (secs > 0) AUDIO.roundStartBeep(); else AUDIO.roundGo();
    }
    if (remaining <= 0) clearInterval(countdownInterval);
  }, 80);
});

NET.on('roundStart', () => {
  $('countdown-overlay').classList.add('hidden');
  roundActive = true;
  AUDIO.startAmbient();
});

NET.on('roundEnded', (data) => {
  roundActive = false;
  AUDIO.stopAmbient();
  AUDIO.victory();

  const mine = data.rankings.find((r) => r.id === myId);
  if (mine) {
    stats.gamesPlayed += 1;
    stats.totalKills += mine.kills;
    stats.bestScore = Math.max(stats.bestScore, mine.score);
    if (data.winnerId === myId) {
      stats.wins += 1;
      progression.credits += C.WIN_CREDIT_REWARD;
      saveProgression();
      showToast(`Victory! +${C.WIN_CREDIT_REWARD} credits`, 3000);
    }
    saveStats();
    renderStats();
  }
  const list = $('end-rankings');
  list.innerHTML = '';
  data.rankings.forEach((r) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.style.background = r.color; dot.style.color = r.color;
    const name = document.createElement('span');
    name.className = 'r-name';
    name.textContent = r.name + (r.id === myId ? ' (you)' : '');
    const score = document.createElement('span');
    score.className = 'r-score';
    score.textContent = `${r.score} pts`;
    li.appendChild(dot); li.appendChild(name); li.appendChild(score);
    list.appendChild(li);
  });
  const winner = data.rankings.find((r) => r.id === data.winnerId);
  $('winner-name').textContent = winner ? winner.name : '—';

  const amHost = lastLobbyData && lastLobbyData.players.some((p) => p.id === myId && p.isHost);
  $('btn-play-again').disabled = !amHost;
  $('btn-return-lobby').disabled = !amHost;
  $('end-hint').textContent = amHost ? '' : 'Waiting for the host to choose…';

  showScreen('end');
});

$('btn-play-again').addEventListener('click', () => { AUDIO.click(); NET.playAgain(); });
$('btn-return-lobby').addEventListener('click', () => { AUDIO.click(); NET.returnToLobby(); });

function flashHit() {
  const el = $('hit-flash');
  el.style.opacity = '1';
  requestAnimationFrame(() => { el.style.opacity = '0'; });
}

function flashKill() {
  const el = $('kill-flash');
  el.style.opacity = '1';
  requestAnimationFrame(() => { el.style.opacity = '0'; });
}

function showAnnouncer(text) {
  const el = $('announcer');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth; // force reflow so the animation restarts on repeated streaks
  el.classList.add('show');
}

function addKillFeed(e) {
  const feed = $('kill-feed');
  const item = document.createElement('div');
  item.className = 'kill-feed-item';
  item.textContent = e.killerId
    ? `${e.killerName} eliminated ${e.victimName}`
    : `${e.victimName} was eliminated`;
  feed.appendChild(item);
  setTimeout(() => item.remove(), 4700);
  while (feed.children.length > 5) feed.removeChild(feed.firstChild);
}

function powerupLabel(type) {
  return { speed: 'Speed Boost', health: 'Health Restore', shield: 'Shield', rapid: 'Rapid Attack', damage: 'Damage Boost' }[type] || type;
}
function powerupIcon(type) {
  return { speed: '⚡', health: '✚', shield: '🛡', rapid: '🔥', damage: '💥' }[type] || '?';
}

// ----------------------------------------------------------------------------
// HUD updates (DOM), driven by each incoming gameState snapshot
// ----------------------------------------------------------------------------
function updateHud(data) {
  const me = data.players.find((p) => p.id === myId);
  if (me) {
    const maxHealth = me.maxHealth || C.MAX_HEALTH;
    const pct = clamp(me.health / maxHealth, 0, 1) * 100;
    const fill = $('health-bar-fill');
    fill.style.width = `${pct}%`;
    fill.classList.toggle('low', pct <= 30);
    fill.classList.toggle('mid', pct > 30 && pct <= 60);
    $('health-text').textContent = `${Math.ceil(me.health)}/${maxHealth}`;
    $('hud-score').textContent = me.score;
    $('low-health-vignette').classList.toggle('active', me.alive && pct <= 25);

    const weapon = C.WEAPON_CATALOG[me.weaponId];
    $('hud-weapon').textContent = weapon ? `${weapon.icon} ${weapon.name}` : '';

    const chips = $('powerup-status');
    chips.innerHTML = '';
    Object.entries(me.effects).forEach(([type, active]) => {
      if (!active) return;
      const chip = document.createElement('div');
      chip.className = 'powerup-chip';
      chip.style.color = C.POWERUP_COLORS[type];
      chip.textContent = powerupIcon(type);
      chips.appendChild(chip);
    });
  }

  const alive = data.players.filter((p) => p.alive).length;
  $('hud-alive').textContent = alive;
  $('hud-total').textContent = data.players.length;

  const mins = Math.floor(data.timeRemaining / 60000);
  const secs = Math.floor((data.timeRemaining % 60000) / 1000);
  $('round-timer').textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  $('round-label').textContent = `Round ${data.roundNumber}`;

  const ranked = [...data.players].sort((a, b) => b.score - a.score);
  const lbList = $('leaderboard-list');
  lbList.innerHTML = '';
  ranked.slice(0, 8).forEach((p) => {
    const li = document.createElement('li');
    if (p.id === myId) li.classList.add('me');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'lb-name';
    nameSpan.textContent = p.name;
    const scoreSpan = document.createElement('span');
    scoreSpan.textContent = p.score;
    li.appendChild(nameSpan);
    li.appendChild(scoreSpan);
    lbList.appendChild(li);
  });
}

// ----------------------------------------------------------------------------
// Render loop
// ----------------------------------------------------------------------------
let lastFrameTime = performance.now();

function updateInterpolation(dt) {
  if (!latestState) return;
  const seen = new Set();
  for (const p of latestState.players) {
    seen.add(p.id);
    let rp = renderPlayers.get(p.id);
    if (!rp) {
      rp = { x: p.x, y: p.y, angle: p.angle, ...p };
      renderPlayers.set(p.id, rp);
    }
    rp.targetX = p.x; rp.targetY = p.y; rp.targetAngle = p.angle;
    Object.assign(rp, p, { x: rp.x, y: rp.y, angle: rp.angle });
    const smoothing = 1 - Math.pow(0.0005, dt);
    rp.x += (rp.targetX - rp.x) * smoothing;
    rp.y += (rp.targetY - rp.y) * smoothing;
    rp.angle = lerpAngle(rp.angle, rp.targetAngle, smoothing);
    if (p.id === myId) myWorldPos = { x: rp.x, y: rp.y };
  }
  for (const id of Array.from(renderPlayers.keys())) if (!seen.has(id)) renderPlayers.delete(id);
}

function updateEffects(dt) {
  particles = particles.filter((pt) => {
    pt.life += dt;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.vx *= 0.94; pt.vy *= 0.94;
    return pt.life < pt.maxLife;
  });
  floatingTexts = floatingTexts.filter((t) => {
    t.life += dt;
    t.y += t.vy * dt;
    t.vy *= 0.96;
    return t.life < t.maxLife;
  });
  slashArcs = slashArcs.filter((s) => {
    s.life += dt;
    return s.life < s.maxLife;
  });
  shakeMag *= Math.max(0, 1 - dt * 6);
  if (shakeMag < 0.05) shakeMag = 0;
}

function drawArena() {
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, camera.viewW, camera.viewH);

  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.scale, camera.scale);

  // Floor
  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, C.ARENA_WIDTH, C.ARENA_HEIGHT);

  // Floor grid
  ctx.strokeStyle = 'rgba(62,242,255,0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= C.ARENA_WIDTH; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, C.ARENA_HEIGHT); ctx.stroke();
  }
  for (let y = 0; y <= C.ARENA_HEIGHT; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(C.ARENA_WIDTH, y); ctx.stroke();
  }

  // Outer walls
  ctx.strokeStyle = '#3ef2ff';
  ctx.lineWidth = C.WALL_THICKNESS;
  ctx.shadowColor = '#3ef2ff';
  ctx.shadowBlur = 18;
  ctx.strokeRect(C.WALL_THICKNESS / 2, C.WALL_THICKNESS / 2, C.ARENA_WIDTH - C.WALL_THICKNESS, C.ARENA_HEIGHT - C.WALL_THICKNESS);
  ctx.shadowBlur = 0;

  // Obstacles
  for (const rect of C.OBSTACLES) {
    const x = rect.x - rect.w / 2, y = rect.y - rect.h / 2;
    ctx.fillStyle = '#141d33';
    ctx.strokeStyle = '#c77dff';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#c77dff';
    ctx.shadowBlur = 10;
    ctx.fillRect(x, y, rect.w, rect.h);
    ctx.strokeRect(x, y, rect.w, rect.h);
    ctx.shadowBlur = 0;
  }

  // Spawn point markers — purely decorative, hints at where players enter
  ctx.strokeStyle = 'rgba(62,242,255,0.18)';
  ctx.lineWidth = 2;
  for (const sp of C.SPAWN_POINTS) {
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 26, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function drawPowerups(t) {
  if (!latestState) return;
  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.scale, camera.scale);
  for (const pu of latestState.powerups) {
    const bob = Math.sin(t / 300 + pu.id) * 5;
    const color = C.POWERUP_COLORS[pu.type];
    ctx.save();
    ctx.translate(pu.x, pu.y + bob);
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;
    ctx.fillStyle = 'rgba(10,14,24,0.85)';
    ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.font = '18px "Segoe UI Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(powerupIcon(pu.type), 0, 1);
    ctx.restore();
  }
  ctx.restore();
}

function drawProjectiles() {
  if (!latestState) return;
  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.scale, camera.scale);

  const seenIds = new Set();
  for (const proj of latestState.projectiles) {
    seenIds.add(proj.id);
    const owner = renderPlayers.get(proj.ownerId);
    const color = owner ? owner.color : '#3ef2ff';

    const prev = projectileTrails.get(proj.id);
    if (prev) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = C.PROJECTILE_RADIUS;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(proj.x, proj.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    projectileTrails.set(proj.id, { x: proj.x, y: proj.y });

    ctx.save();
    ctx.translate(proj.x, proj.y);
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(0, 0, C.PROJECTILE_RADIUS, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // Drop trail memory for projectiles that no longer exist (hit something / expired).
  for (const id of Array.from(projectileTrails.keys())) {
    if (!seenIds.has(id)) projectileTrails.delete(id);
  }

  ctx.restore();
}

function drawSlashArcs() {
  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.scale, camera.scale);
  for (const s of slashArcs) {
    const alpha = 1 - s.life / s.maxLife;
    ctx.globalAlpha = Math.max(alpha, 0) * 0.8;
    ctx.strokeStyle = s.hit ? '#ffffff' : s.color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(s.x, s.y, C.MELEE_RANGE * 0.8, s.angle - C.MELEE_ARC / 2, s.angle + C.MELEE_ARC / 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawPlayers(t) {
  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.scale, camera.scale);

  for (const p of renderPlayers.values()) {
    if (!p.alive) continue;
    const isMe = p.id === myId;
    const flicker = p.invuln ? (Math.floor(t / 90) % 2 === 0) : true;
    if (!flicker) continue;

    ctx.save();
    ctx.translate(p.x, p.y);

    // Shield ring
    if (p.effects && p.effects.shield) {
      ctx.strokeStyle = C.POWERUP_COLORS.shield;
      ctx.lineWidth = 3;
      ctx.shadowColor = C.POWERUP_COLORS.shield;
      ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(0, 0, C.PLAYER_RADIUS + 8, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
    }
    // Speed sparkle trail (cosmetic only)
    if (p.effects && p.effects.speed && Math.random() < 0.6) {
      spawnParticles(p.x, p.y, C.POWERUP_COLORS.speed, 1, { speed: 20, life: 0.3, size: 2 });
    }

    // "You" indicator ring
    if (isMe) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, C.PLAYER_RADIUS + 5, 0, Math.PI * 2); ctx.stroke();
    }

    // Body
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 16;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(0, 0, C.PLAYER_RADIUS, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(0, 0, C.PLAYER_RADIUS, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(0, 0, C.PLAYER_RADIUS - 4, 0, Math.PI * 2); ctx.fill();

    // Aim direction indicator
    ctx.rotate(p.angle);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(C.PLAYER_RADIUS + 2, 0);
    ctx.lineTo(C.PLAYER_RADIUS - 6, -6);
    ctx.lineTo(C.PLAYER_RADIUS - 6, 6);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    // Name + mini health bar (not rotated)
    ctx.save();
    ctx.translate(p.x, p.y - C.PLAYER_RADIUS - 16);
    ctx.font = '12px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = isMe ? '#ffd93d' : '#eaf0ff';
    ctx.fillText(p.isBot ? `${p.name} [BOT]` : p.name, 0, -6);
    const barW = 40;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(-barW / 2, 0, barW, 5);
    const pct = clamp(p.health / (p.maxHealth || C.MAX_HEALTH), 0, 1);
    ctx.fillStyle = pct > 0.6 ? '#3dff88' : pct > 0.3 ? '#ffd93d' : '#ff4d4d';
    ctx.fillRect(-barW / 2, 0, barW * pct, 5);
    ctx.restore();
  }

  ctx.restore();
}

function drawAimGuide() {
  if (!roundActive) return;
  const me = renderPlayers.get(myId);
  if (!me || !me.alive) return;
  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.scale, camera.scale);

  const angle = inputState.angle;
  const startDist = C.PLAYER_RADIUS + 10;
  const endDist = startDist + 60;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 7]);
  ctx.beginPath();
  ctx.moveTo(me.x + Math.cos(angle) * startDist, me.y + Math.sin(angle) * startDist);
  ctx.lineTo(me.x + Math.cos(angle) * endDist, me.y + Math.sin(angle) * endDist);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawParticlesAndText() {
  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.scale, camera.scale);

  for (const pt of particles) {
    const alpha = 1 - pt.life / pt.maxLife;
    ctx.globalAlpha = Math.max(alpha, 0);
    ctx.fillStyle = pt.color;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  for (const t of floatingTexts) {
    const alpha = 1 - t.life / t.maxLife;
    ctx.globalAlpha = Math.max(alpha, 0);
    ctx.fillStyle = t.color;
    ctx.font = 'bold 15px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;

  ctx.restore();
}

function drawMinimap() {
  const w = minimapCanvas.width, h = minimapCanvas.height;
  const sx = w / C.ARENA_WIDTH, sy = h / C.ARENA_HEIGHT;
  minimapCtx.clearRect(0, 0, w, h);
  minimapCtx.fillStyle = 'rgba(10,14,24,0.4)';
  minimapCtx.fillRect(0, 0, w, h);

  minimapCtx.fillStyle = 'rgba(199,125,255,0.5)';
  for (const rect of C.OBSTACLES) {
    minimapCtx.fillRect((rect.x - rect.w / 2) * sx, (rect.y - rect.h / 2) * sy, rect.w * sx, rect.h * sy);
  }

  if (latestState) {
    for (const pu of latestState.powerups) {
      minimapCtx.fillStyle = C.POWERUP_COLORS[pu.type] || '#fff';
      minimapCtx.beginPath();
      minimapCtx.arc(pu.x * sx, pu.y * sy, 2.5, 0, Math.PI * 2);
      minimapCtx.fill();
    }
    for (const p of latestState.players) {
      if (!p.alive) continue;
      minimapCtx.fillStyle = p.color;
      minimapCtx.beginPath();
      minimapCtx.arc(p.x * sx, p.y * sy, p.id === myId ? 4 : 3, 0, Math.PI * 2);
      minimapCtx.fill();
      if (p.id === myId) {
        minimapCtx.strokeStyle = '#ffffff';
        minimapCtx.lineWidth = 1;
        minimapCtx.stroke();
      }
    }
  }
}

function renderFrame(now) {
  let dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;
  if (now < hitStopUntil) dt *= 0.06; // brief freeze-frame punch on a kill

  if (screens.game.classList.contains('active')) {
    updateInterpolation(dt);
    updateEffects(dt);

    ctx.save();
    if (shakeMag > 0) {
      ctx.translate((Math.random() - 0.5) * shakeMag, (Math.random() - 0.5) * shakeMag);
    }
    drawArena();
    drawPowerups(now);
    drawProjectiles();
    drawPlayers(now);
    drawSlashArcs();
    drawAimGuide();
    drawParticlesAndText();
    ctx.restore();

    drawMinimap();
  }

  requestAnimationFrame(renderFrame);
}
requestAnimationFrame(renderFrame);

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
NET.connect();
resizeCanvas();
showScreen('menu');
