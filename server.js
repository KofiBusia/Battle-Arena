// ============================================================================
// Battle Arena — authoritative game server
// Node + Express (static hosting) + Socket.IO (realtime transport)
//
// The server is the single source of truth for anything that affects fairness:
// position, health, damage, cooldowns, scores, power-up pickups and round
// state. Clients only ever send *intent* ("I am holding W and aiming here"),
// never facts ("I am at x,y" or "I hit you"). This file is organized as:
//   1. Setup (express + socket.io)
//   2. Room management (create/join/quickplay/leave)
//   3. Per-room simulation (the fixed-timestep game loop)
//   4. Socket event wiring
// ============================================================================

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const C = require('./public/shared/constants.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----------------------------------------------------------------------------
// Utility helpers
// ----------------------------------------------------------------------------

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function dist2(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  return dx * dx + dy * dy;
}

/** Circle vs. axis-aligned rect (rect given as center x/y + w/h). */
function circleRectCollide(cx, cy, r, rect) {
  const halfW = rect.w / 2, halfH = rect.h / 2;
  const closestX = clamp(cx, rect.x - halfW, rect.x + halfW);
  const closestY = clamp(cy, rect.y - halfH, rect.y + halfH);
  const dx = cx - closestX, dy = cy - closestY;
  return (dx * dx + dy * dy) < r * r;
}

function isBlocked(x, y, radius) {
  if (x - radius < C.WALL_THICKNESS || x + radius > C.ARENA_WIDTH - C.WALL_THICKNESS) return true;
  if (y - radius < C.WALL_THICKNESS || y + radius > C.ARENA_HEIGHT - C.WALL_THICKNESS) return true;
  for (const rect of C.OBSTACLES) {
    if (circleRectCollide(x, y, radius, rect)) return true;
  }
  return false;
}

function randomSpawnPoint() {
  return C.SPAWN_POINTS[Math.floor(Math.random() * C.SPAWN_POINTS.length)];
}

function randomPowerupType() {
  const types = Object.values(C.POWERUP_TYPES);
  return types[Math.floor(Math.random() * types.length)];
}

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 (ambiguous)
function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Player';
  const trimmed = name.trim().slice(0, 16);
  return trimmed.length ? trimmed.replace(/[<>]/g, '') : 'Player';
}

function pickColor(room) {
  const used = new Set(Array.from(room.players.values()).map(p => p.color));
  const free = C.PLAYER_COLORS.find(c => !used.has(c));
  return free || C.PLAYER_COLORS[Math.floor(Math.random() * C.PLAYER_COLORS.length)];
}

// ----------------------------------------------------------------------------
// Room management
// ----------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();

function createRoom(code, isPublic) {
  const room = {
    code,
    isPublic: !!isPublic,
    players: new Map(), // socketId (or "bot-*") -> player
    projectiles: [],
    powerups: [],
    nextProjectileId: 1,
    nextPowerupId: 1,
    nextBotId: 0,
    lastPowerupSpawn: 0,
    state: 'lobby', // lobby | countdown | playing | ended
    countdownEndsAt: 0,
    roundEndsAt: 0,
    roundNumber: 0,
    hostId: null,
    interval: null,
    lastTick: Date.now(),
  };
  room.interval = setInterval(() => tickRoom(room), C.TICK_MS);
  rooms.set(code, room);
  return room;
}

function getOrCreatePublicRoom() {
  for (const room of rooms.values()) {
    if (room.isPublic && room.players.size < C.MAX_PLAYERS_PER_ROOM && room.state === 'lobby') {
      return room;
    }
  }
  return createRoom(generateRoomCode(), true);
}

function destroyRoomIfEmpty(room) {
  if (room.players.size === 0) {
    clearInterval(room.interval);
    rooms.delete(room.code);
  }
}

/**
 * Turn a client-claimed weapon id + upgrade levels into real stats, using
 * only the server's own catalog/tables (constants.js). The client can send
 * whatever it wants here — unknown weapon ids fall back to the default, and
 * upgrade levels are clamped to their defined max — so this can never be
 * used to smuggle arbitrary numeric stats onto a player.
 */
function computeLoadout(rawWeaponId, rawUpgrades) {
  const weaponId = C.sanitizeWeaponId(rawWeaponId);
  const weapon = C.WEAPON_CATALOG[weaponId];
  const upgrades = C.sanitizeUpgrades(rawUpgrades);
  const cooldownMultiplier = Math.max(0.5, 1 - upgrades.cooldown * C.UPGRADE_DEFS.cooldown.valuePerLevel);
  return {
    weaponId,
    weapon,
    upgrades,
    maxHealth: C.MAX_HEALTH + upgrades.health * C.UPGRADE_DEFS.health.valuePerLevel,
    speedMultiplier: 1 + upgrades.speed * C.UPGRADE_DEFS.speed.valuePerLevel,
    cooldownMultiplier,
    meleeDamage: C.MELEE_DAMAGE + upgrades.meleeDamage * C.UPGRADE_DEFS.meleeDamage.valuePerLevel,
  };
}

function makePlayer(id, name, color, isBot, rawWeaponId, rawUpgrades) {
  const spawn = randomSpawnPoint();
  const loadout = computeLoadout(rawWeaponId, rawUpgrades);
  return {
    id, name, color, isBot: !!isBot,
    x: spawn.x, y: spawn.y, angle: 0,
    weaponId: loadout.weaponId, weapon: loadout.weapon, upgrades: loadout.upgrades,
    maxHealth: loadout.maxHealth, speedMultiplier: loadout.speedMultiplier,
    cooldownMultiplier: loadout.cooldownMultiplier, meleeDamage: loadout.meleeDamage,
    health: loadout.maxHealth, alive: true,
    score: 0, kills: 0, deaths: 0, streak: 0,
    ready: false, isHost: false,
    input: { moveX: 0, moveY: 0, angle: 0, attack: false, melee: false },
    lastAttackTime: 0,
    lastMeleeTime: 0,
    invulnUntil: Date.now() + C.RESPAWN_INVULN_MS,
    respawnAt: 0,
    effects: { speed: 0, shield: 0, rapid: 0, damage: 0 },
  };
}

function countHumans(room) {
  let n = 0;
  for (const p of room.players.values()) if (!p.isBot) n++;
  return n;
}

function assignHost(room) {
  if (room.hostId && room.players.has(room.hostId) && !room.players.get(room.hostId).isBot) return;
  let first = null;
  for (const p of room.players.values()) {
    if (!p.isBot) { first = p; break; }
  }
  if (first) {
    room.hostId = first.id;
    for (const p of room.players.values()) p.isHost = (p.id === room.hostId);
  } else {
    room.hostId = null;
  }
}

function lobbyPayload(room) {
  return {
    code: room.code,
    isPublic: room.isPublic,
    maxPlayers: C.MAX_PLAYERS_PER_ROOM,
    state: room.state,
    roundNumber: room.roundNumber,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, color: p.color, ready: p.ready, isHost: p.isHost, isBot: p.isBot,
      weaponId: p.weaponId,
    })),
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobbyUpdate', lobbyPayload(room));
}

// ----------------------------------------------------------------------------
// Round lifecycle
// ----------------------------------------------------------------------------

function beginCountdown(room) {
  room.state = 'countdown';
  room.countdownEndsAt = Date.now() + C.COUNTDOWN_MS;
  room.projectiles = [];
  room.powerups = [];
  room.roundNumber += 1;
  for (const p of room.players.values()) {
    const spawn = randomSpawnPoint();
    p.x = spawn.x; p.y = spawn.y;
    p.health = p.maxHealth;
    p.alive = true;
    p.score = 0; p.kills = 0; p.deaths = 0; p.streak = 0;
    p.effects = { speed: 0, shield: 0, rapid: 0, damage: 0 };
    p.invulnUntil = room.countdownEndsAt + C.RESPAWN_INVULN_MS;
    p.lastAttackTime = 0;
    p.lastMeleeTime = 0;
  }
  io.to(room.code).emit('countdownStart', {
    endsAt: room.countdownEndsAt, roundNumber: room.roundNumber,
  });
}

function beginRound(room) {
  room.state = 'playing';
  room.roundEndsAt = Date.now() + C.ROUND_DURATION_MS;
  io.to(room.code).emit('roundStart', {
    endsAt: room.roundEndsAt, roundNumber: room.roundNumber,
  });
}

function endRound(room) {
  room.state = 'ended';
  const rankings = Array.from(room.players.values())
    .map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score, kills: p.kills, deaths: p.deaths }))
    .sort((a, b) => b.score - a.score || b.kills - a.kills);
  const winnerId = rankings.length ? rankings[0].id : null;
  io.to(room.code).emit('roundEnded', { rankings, winnerId, roundNumber: room.roundNumber });
}

// ----------------------------------------------------------------------------
// Simulation
// ----------------------------------------------------------------------------

function applyPowerup(player, type, now) {
  switch (type) {
    case C.POWERUP_TYPES.HEALTH:
      player.health = clamp(player.health + 40, 0, player.maxHealth);
      break;
    case C.POWERUP_TYPES.SPEED:
      player.effects.speed = now + C.POWERUP_EFFECT_DURATION_MS.speed;
      break;
    case C.POWERUP_TYPES.SHIELD:
      player.effects.shield = now + C.POWERUP_EFFECT_DURATION_MS.shield;
      break;
    case C.POWERUP_TYPES.RAPID:
      player.effects.rapid = now + C.POWERUP_EFFECT_DURATION_MS.rapid;
      break;
    case C.POWERUP_TYPES.DAMAGE:
      player.effects.damage = now + C.POWERUP_EFFECT_DURATION_MS.damage;
      break;
  }
}

function killPlayer(room, victim, killer, now, events) {
  victim.alive = false;
  victim.deaths += 1;
  victim.respawnAt = now + C.RESPAWN_DELAY_MS;
  victim.streak = 0;
  if (killer && killer.id !== victim.id) {
    killer.streak = (killer.streak || 0) + 1;
    const bonus = Math.min(killer.streak, C.MAX_KILLSTREAK_TIER);
    killer.score += bonus;
    killer.kills += 1;
    if (killer.streak >= 2) {
      const tier = Math.min(killer.streak, C.MAX_KILLSTREAK_TIER);
      events.killstreak.push({ playerId: killer.id, playerName: killer.name, streak: killer.streak, label: C.KILLSTREAK_LABELS[tier] });
    }
  }
  events.death.push({
    victimId: victim.id, victimName: victim.name,
    killerId: killer ? killer.id : null, killerName: killer ? killer.name : null,
    x: victim.x, y: victim.y,
  });
}

/** Shared damage pipeline for both projectile and melee hits. */
function applyDamage(room, attacker, target, rawDamage, now, events, hitX, hitY) {
  const shielded = target.effects.shield > now;
  const dmg = rawDamage * (shielded ? 0.5 : 1);
  target.health = clamp(target.health - dmg, 0, target.maxHealth);
  target.invulnUntil = now + C.HIT_INVULN_MS;
  events.hit.push({
    targetId: target.id, attackerId: attacker ? attacker.id : null,
    damage: Math.round(dmg), x: hitX, y: hitY, targetHpAfter: target.health,
  });
  if (target.health <= 0) killPlayer(room, target, attacker, now, events);
}

/**
 * Very small bot "AI": chase the nearest living opponent while keeping a
 * preferred engagement distance (moving in to a comfortable attack range,
 * backing off if the target gets too close, strafing when at range), retreat
 * more often at low health, and wander toward a random spawn point when no
 * target is visible. Writes directly into `bot.input`, which is then
 * consumed by the exact same movement/attack code path a human's socket
 * `input` event would populate — bots cannot cheat any harder than a client.
 */
function updateBotAI(room, now, players) {
  for (const bot of players) {
    if (!bot.isBot) continue;
    if (!bot.alive) { bot.input = { moveX: 0, moveY: 0, angle: bot.angle, attack: false, melee: false }; continue; }

    let target = null;
    let bestD2 = Infinity;
    for (const other of players) {
      if (other.id === bot.id || !other.alive) continue;
      const d2 = dist2(bot.x, bot.y, other.x, other.y);
      if (d2 < bestD2) { bestD2 = d2; target = other; }
    }

    let moveX = 0, moveY = 0, angle = bot.angle, attack = false, melee = false;

    if (target) {
      const dist = Math.sqrt(bestD2) || 1;
      const dx = (target.x - bot.x) / dist, dy = (target.y - bot.y) / dist;
      angle = Math.atan2(target.y - bot.y, target.x - bot.x);

      const idealRange = 240;
      if (Math.random() < 0.015) bot._strafeDir = -(bot._strafeDir || 1) || 1;
      const strafeDir = bot._strafeDir || 1;

      if (dist > idealRange + 50) { moveX = dx; moveY = dy; }
      else if (dist < idealRange - 70) { moveX = -dx; moveY = -dy; }
      else { moveX = -dy * strafeDir; moveY = dx * strafeDir; }

      if (bot.health < 32 && Math.random() < 0.5) { moveX = -moveX; moveY = -moveY; }

      attack = dist < C.PROJECTILE_RANGE * 0.85;
      melee = dist < C.MELEE_RANGE * 1.4;
    } else {
      if (!bot._wanderTarget || now > (bot._wanderUntil || 0)) {
        bot._wanderTarget = C.SPAWN_POINTS[Math.floor(Math.random() * C.SPAWN_POINTS.length)];
        bot._wanderUntil = now + 2500 + Math.random() * 2500;
      }
      const dx = bot._wanderTarget.x - bot.x, dy = bot._wanderTarget.y - bot.y;
      const dist = Math.hypot(dx, dy) || 1;
      moveX = dx / dist; moveY = dy / dist;
      angle = Math.atan2(dy, dx);
    }

    bot.input = { moveX, moveY, angle, attack, melee };
  }
}

function tickRoom(room) {
  const now = Date.now();
  const dt = Math.min((now - room.lastTick) / 1000, 0.1); // clamp to avoid huge steps after a stall
  room.lastTick = now;

  const events = { hit: [], death: [], respawn: [], powerup: [], melee: [], killstreak: [] };

  if (room.state === 'countdown' && now >= room.countdownEndsAt) {
    beginRound(room);
  } else if (room.state === 'playing' && now >= room.roundEndsAt) {
    endRound(room);
  }

  if (room.state === 'playing') {
    simulatePlaying(room, now, dt, events);
  }

  broadcastState(room, now, events);
}

function simulatePlaying(room, now, dt, events) {
  const players = Array.from(room.players.values());
  updateBotAI(room, now, players);

  // --- Movement ---
  for (const p of players) {
    if (!p.alive) {
      if (now >= p.respawnAt) {
        const spawn = randomSpawnPoint();
        p.x = spawn.x; p.y = spawn.y;
        p.health = p.maxHealth;
        p.alive = true;
        p.invulnUntil = now + C.RESPAWN_INVULN_MS;
        events.respawn.push({ playerId: p.id, x: p.x, y: p.y });
      }
      continue;
    }

    let { moveX, moveY, angle } = p.input;
    // Defensive normalization: never trust the client's magnitude.
    const mag = Math.hypot(moveX, moveY);
    if (mag > 1) { moveX /= mag; moveY /= mag; }
    if (!Number.isFinite(angle)) angle = 0;
    p.angle = angle;

    const speedBoost = p.effects.speed > now ? 1.6 : 1;
    const speed = C.BASE_SPEED * p.speedMultiplier * speedBoost;
    const dx = moveX * speed * dt;
    const dy = moveY * speed * dt;

    if (dx !== 0 && !isBlocked(p.x + dx, p.y, C.PLAYER_RADIUS)) p.x += dx;
    if (dy !== 0 && !isBlocked(p.x, p.y + dy, C.PLAYER_RADIUS)) p.y += dy;
    p.x = clamp(p.x, C.WALL_THICKNESS + C.PLAYER_RADIUS, C.ARENA_WIDTH - C.WALL_THICKNESS - C.PLAYER_RADIUS);
    p.y = clamp(p.y, C.WALL_THICKNESS + C.PLAYER_RADIUS, C.ARENA_HEIGHT - C.WALL_THICKNESS - C.PLAYER_RADIUS);

    // Attack (server enforces cooldown, damage and projectile stats — all
    // looked up from the player's *validated* weapon, never client-supplied).
    if (p.input.attack) {
      const weapon = p.weapon;
      const cooldown = weapon.cooldownMs * p.cooldownMultiplier * (p.effects.rapid > now ? 0.45 : 1);
      if (now - p.lastAttackTime >= cooldown) {
        p.lastAttackTime = now;
        const spawnDist = C.PLAYER_RADIUS + C.PROJECTILE_RADIUS + 4;
        const damage = weapon.damage * (p.effects.damage > now ? 1.6 : 1);
        const pellets = Math.max(1, weapon.pellets);
        for (let i = 0; i < pellets; i++) {
          const offset = pellets === 1 ? 0 : -weapon.spread / 2 + (weapon.spread * i) / (pellets - 1);
          const shotAngle = p.angle + offset;
          room.projectiles.push({
            id: room.nextProjectileId++,
            ownerId: p.id,
            x: p.x + Math.cos(shotAngle) * spawnDist,
            y: p.y + Math.sin(shotAngle) * spawnDist,
            vx: Math.cos(shotAngle) * weapon.projectileSpeed,
            vy: Math.sin(shotAngle) * weapon.projectileSpeed,
            speed: weapon.projectileSpeed,
            range: weapon.range,
            traveled: 0,
            damage,
          });
        }
      }
    }

    // Melee (server enforces cooldown, range and cone independently of the client).
    if (p.input.melee) {
      const meleeCooldown = C.MELEE_COOLDOWN_MS * p.cooldownMultiplier * (p.effects.rapid > now ? 0.6 : 1);
      if (now - p.lastMeleeTime >= meleeCooldown) {
        p.lastMeleeTime = now;
        let hitTarget = null;
        for (const target of players) {
          if (target.id === p.id || !target.alive || target.invulnUntil > now) continue;
          const dx = target.x - p.x, dy = target.y - p.y;
          const dist = Math.hypot(dx, dy);
          if (dist > C.MELEE_RANGE) continue;
          let diff = Math.atan2(dy, dx) - p.angle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          if (Math.abs(diff) > C.MELEE_ARC / 2) continue;
          hitTarget = target;
          break;
        }
        if (hitTarget) {
          const dmgBase = p.meleeDamage * (p.effects.damage > now ? 1.6 : 1);
          applyDamage(room, p, hitTarget, dmgBase, now, events, hitTarget.x, hitTarget.y);
        }
        events.melee.push({
          playerId: p.id, hit: !!hitTarget,
          x: p.x + Math.cos(p.angle) * C.MELEE_RANGE * 0.6,
          y: p.y + Math.sin(p.angle) * C.MELEE_RANGE * 0.6,
        });
      }
    }
  }

  // --- Soft player-vs-player separation (no walking through each other) ---
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      if (!a.alive || !b.alive) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      const minDist = C.PLAYER_RADIUS * 2;
      if (d < minDist) {
        const overlap = (minDist - d) / 2;
        const nx = dx / d, ny = dy / d;
        a.x -= nx * overlap; a.y -= ny * overlap;
        b.x += nx * overlap; b.y += ny * overlap;
      }
    }
  }

  // --- Projectiles ---
  const survivors = [];
  for (const proj of room.projectiles) {
    const step = proj.speed * dt;
    const nx = proj.x + proj.vx * dt;
    const ny = proj.y + proj.vy * dt;
    proj.traveled += step;

    if (proj.traveled > proj.range || isBlocked(nx, ny, C.PROJECTILE_RADIUS)) {
      continue; // absorbed by wall/obstacle or exceeded range
    }
    proj.x = nx; proj.y = ny;

    let consumed = false;
    for (const target of players) {
      if (target.id === proj.ownerId || !target.alive) continue;
      if (target.invulnUntil > now) continue;
      const rr = (C.PLAYER_RADIUS + C.PROJECTILE_RADIUS) ** 2;
      if (dist2(proj.x, proj.y, target.x, target.y) <= rr) {
        const attacker = room.players.get(proj.ownerId) || null;
        applyDamage(room, attacker, target, proj.damage, now, events, proj.x, proj.y);
        consumed = true;
        break;
      }
    }
    if (!consumed) survivors.push(proj);
  }
  room.projectiles = survivors;

  // --- Power-up spawning ---
  if (room.powerups.length < C.MAX_ACTIVE_POWERUPS &&
      now - room.lastPowerupSpawn > C.POWERUP_SPAWN_INTERVAL_MS) {
    const occupied = new Set(room.powerups.map(pu => `${pu.x},${pu.y}`));
    const free = C.POWERUP_SPAWN_POINTS.filter(sp => !occupied.has(`${sp.x},${sp.y}`));
    if (free.length) {
      const spot = free[Math.floor(Math.random() * free.length)];
      room.powerups.push({
        id: room.nextPowerupId++,
        type: randomPowerupType(),
        x: spot.x, y: spot.y,
      });
      room.lastPowerupSpawn = now;
    }
  }

  // --- Power-up pickup (server decides — client cannot claim a pickup) ---
  if (room.powerups.length) {
    const remaining = [];
    for (const pu of room.powerups) {
      let taken = false;
      for (const p of players) {
        if (!p.alive) continue;
        const rr = (C.PLAYER_RADIUS + 16) ** 2;
        if (dist2(p.x, p.y, pu.x, pu.y) <= rr) {
          applyPowerup(p, pu.type, now);
          events.powerup.push({ playerId: p.id, type: pu.type });
          taken = true;
          break;
        }
      }
      if (!taken) remaining.push(pu);
    }
    room.powerups = remaining;
  }
}

function broadcastState(room, now, events) {
  const payload = {
    state: room.state,
    roundNumber: room.roundNumber,
    timeRemaining: room.state === 'playing' ? Math.max(0, room.roundEndsAt - now) : 0,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, color: p.color, isBot: p.isBot, weaponId: p.weaponId,
      x: p.x, y: p.y, angle: p.angle,
      health: p.health, maxHealth: p.maxHealth, alive: p.alive,
      score: p.score, kills: p.kills, deaths: p.deaths, streak: p.streak,
      invuln: p.invulnUntil > now,
      effects: {
        speed: p.effects.speed > now,
        shield: p.effects.shield > now,
        rapid: p.effects.rapid > now,
        damage: p.effects.damage > now,
      },
    })),
    projectiles: room.projectiles.map(pr => ({ id: pr.id, x: pr.x, y: pr.y, ownerId: pr.ownerId })),
    powerups: room.powerups.map(pu => ({ id: pu.id, type: pu.type, x: pu.x, y: pu.y })),
  };
  io.to(room.code).emit('gameState', payload);

  for (const e of events.hit) io.to(room.code).emit('hitEvent', e);
  for (const e of events.death) io.to(room.code).emit('deathEvent', e);
  for (const e of events.respawn) io.to(room.code).emit('respawnEvent', e);
  for (const e of events.powerup) io.to(room.code).emit('powerupCollected', e);
  for (const e of events.melee) io.to(room.code).emit('meleeEvent', e);
  for (const e of events.killstreak) io.to(room.code).emit('killstreakEvent', e);
}

// ----------------------------------------------------------------------------
// Socket wiring
// ----------------------------------------------------------------------------

function joinRoomSocket(socket, room, name, color, loadout) {
  socket.join(room.code);
  socket.data.roomCode = room.code;
  const weaponId = loadout && loadout.weaponId;
  const upgrades = loadout && loadout.upgrades;
  const player = makePlayer(socket.id, sanitizeName(name), color || pickColor(room), false, weaponId, upgrades);
  room.players.set(socket.id, player);
  assignHost(room);
  socket.emit('roomJoined', {
    code: room.code, selfId: socket.id, isPublic: room.isPublic,
    maxPlayers: C.MAX_PLAYERS_PER_ROOM, arena: { width: C.ARENA_WIDTH, height: C.ARENA_HEIGHT },
  });
  broadcastLobby(room);
}

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null;
  if (!room) return;
  room.players.delete(socket.id);
  assignHost(room);
  if (countHumans(room) === 0) {
    room.players.clear(); // no humans left to watch them — drop any remaining bots too
    destroyRoomIfEmpty(room);
  } else {
    broadcastLobby(room);
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, color, loadout } = {}) => {
    if (socket.data.roomCode) leaveCurrentRoom(socket);
    const room = createRoom(generateRoomCode(), false);
    joinRoomSocket(socket, room, name, color, loadout);
  });

  socket.on('joinRoom', ({ code, name, color, loadout } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return socket.emit('joinError', { message: 'Room not found.' });
    if (room.players.size >= C.MAX_PLAYERS_PER_ROOM) return socket.emit('joinError', { message: 'Room is full.' });
    if (room.state !== 'lobby') return socket.emit('joinError', { message: 'Match already in progress.' });
    if (socket.data.roomCode) leaveCurrentRoom(socket);
    joinRoomSocket(socket, room, name, color, loadout);
  });

  socket.on('quickPlay', ({ name, color, loadout } = {}) => {
    if (socket.data.roomCode) leaveCurrentRoom(socket);
    const room = getOrCreatePublicRoom();
    joinRoomSocket(socket, room, name, color, loadout);
  });

  socket.on('toggleReady', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !p.ready;
    broadcastLobby(room);
  });

  socket.on('addBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.state !== 'lobby') return;
    if (room.players.size >= C.MAX_PLAYERS_PER_ROOM) return;
    const usedNames = new Set(Array.from(room.players.values()).map(p => p.name));
    const available = C.BOT_NAMES.filter(n => !usedNames.has(n));
    const name = available.length
      ? available[Math.floor(Math.random() * available.length)]
      : `Bot${Math.floor(Math.random() * 1000)}`;
    const id = `bot-${room.code}-${room.nextBotId++}`;
    const bot = makePlayer(id, name, pickColor(room), true);
    bot.ready = true;
    room.players.set(id, bot);
    broadcastLobby(room);
  });

  socket.on('removeBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.state !== 'lobby') return;
    let lastBotId = null;
    for (const [id, p] of room.players) if (p.isBot) lastBotId = id;
    if (lastBotId) {
      room.players.delete(lastBotId);
      broadcastLobby(room);
    }
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.state !== 'lobby') return;
    if (room.players.size < 1) return;
    beginCountdown(room);
  });

  socket.on('playAgain', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.state !== 'ended') return;
    beginCountdown(room);
  });

  socket.on('returnToLobby', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.state !== 'ended') return;
    room.state = 'lobby';
    for (const p of room.players.values()) p.ready = false;
    broadcastLobby(room);
  });

  socket.on('input', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p || !data) return;
    p.input.moveX = Number.isFinite(data.moveX) ? clamp(data.moveX, -1, 1) : 0;
    p.input.moveY = Number.isFinite(data.moveY) ? clamp(data.moveY, -1, 1) : 0;
    p.input.angle = Number.isFinite(data.angle) ? data.angle : p.input.angle;
    p.input.attack = !!data.attack;
    p.input.melee = !!data.melee;
  });

  socket.on('leaveRoom', () => leaveCurrentRoom(socket));

  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Battle Arena server running on http://localhost:${PORT}`);
});
