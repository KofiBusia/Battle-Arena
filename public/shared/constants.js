// Shared constants used by both the server (Node require) and the client (<script> tag).
// Keeping these identical on both sides is what makes the server "authoritative" meaningful:
// the client predicts using the exact same numbers the server will validate against.
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod; // Node / server.js
  } else {
    root.BA_CONST = mod; // Browser global
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const ARENA_WIDTH = 1600;
  const ARENA_HEIGHT = 900;
  const WALL_THICKNESS = 24;

  // Rectangular obstacles inside the arena (world space). Used for both
  // collision resolution and rendering.
  const OBSTACLES = [
    { x: 760, y: 405, w: 80, h: 90 },              // center block
    { x: 260, y: 160, w: 36, h: 220 },
    { x: 1304, y: 160, w: 36, h: 220 },
    { x: 260, y: 520, w: 36, h: 220 },
    { x: 1304, y: 520, w: 36, h: 220 },
    { x: 700, y: 60, w: 200, h: 34 },
    { x: 700, y: 806, w: 200, h: 34 },
  ];

  const SPAWN_POINTS = [
    { x: 90, y: 90 }, { x: 1510, y: 90 },
    { x: 90, y: 810 }, { x: 1510, y: 810 },
    { x: 800, y: 90 }, { x: 800, y: 810 },
    { x: 90, y: 450 }, { x: 1510, y: 450 },
  ];

  const POWERUP_SPAWN_POINTS = [
    { x: 480, y: 260 }, { x: 1120, y: 260 },
    { x: 480, y: 640 }, { x: 1120, y: 640 },
    { x: 800, y: 450 }, { x: 800, y: 200 }, { x: 800, y: 700 },
  ];

  const PLAYER_RADIUS = 18;
  const PROJECTILE_RADIUS = 6;
  const PROJECTILE_SPEED = 640; // px/s
  const PROJECTILE_RANGE = 700; // px, despawn after traveling this far

  const BASE_SPEED = 230; // px/s
  const TICK_RATE = 30;
  const TICK_MS = 1000 / TICK_RATE;

  const MAX_HEALTH = 100;
  const BASE_DAMAGE = 14;
  const ATTACK_COOLDOWN_MS = 420;

  const HIT_INVULN_MS = 300;       // brief i-frames after being hit
  const RESPAWN_INVULN_MS = 2000;  // i-frames right after respawn
  const RESPAWN_DELAY_MS = 3000;

  const ROUND_DURATION_MS = 3 * 60 * 1000;
  const COUNTDOWN_MS = 3500;
  const MAX_PLAYERS_PER_ROOM = 8;

  const POWERUP_SPAWN_INTERVAL_MS = 9000;
  const MAX_ACTIVE_POWERUPS = 5;

  const POWERUP_TYPES = {
    SPEED: 'speed',
    HEALTH: 'health',
    SHIELD: 'shield',
    RAPID: 'rapid',
    DAMAGE: 'damage',
  };

  const POWERUP_EFFECT_DURATION_MS = {
    speed: 7000,
    shield: 6000,
    rapid: 7000,
    damage: 7000,
  };

  const POWERUP_COLORS = {
    speed: '#3ef2ff',
    health: '#3dff88',
    shield: '#ffd93d',
    rapid: '#ff6df0',
    damage: '#ff5050',
  };

  const PLAYER_COLORS = [
    '#ff4d6d', '#3ef2ff', '#ffd93d', '#3dff88',
    '#c77dff', '#ff9f45', '#5eead4', '#f472b6',
  ];

  // Close-range secondary attack: instant cone-hit, no projectile.
  const MELEE_RANGE = 60;
  const MELEE_DAMAGE = 24;
  const MELEE_COOLDOWN_MS = 650;
  const MELEE_ARC = Math.PI / 2; // total cone width (radians), centered on aim angle

  // Consecutive-kill callouts. Keyed by streak count (capped at the highest key).
  const KILLSTREAK_LABELS = {
    2: 'Double Kill',
    3: 'Triple Kill',
    4: 'Rampage',
    5: 'Unstoppable',
    6: 'Godlike',
  };
  const MAX_KILLSTREAK_TIER = 6;

  const BOT_NAMES = [
    'Razor', 'Viper', 'Nova', 'Ghost', 'Blitz', 'Cinder',
    'Vex', 'Talon', 'Rogue', 'Static', 'Havoc', 'Ember',
  ];

  // ----------------------------------------------------------------------
  // Progression: purchasable weapons and character upgrades.
  // These tables are the single source of truth for stats — the client
  // only ever sends a weapon *id* and upgrade *levels*; the server looks up
  // real numbers here rather than trusting anything numeric from the client.
  // Currency ("credits") is earned by winning rounds and spent here.
  // ----------------------------------------------------------------------
  const WIN_CREDIT_REWARD = 150;

  const WEAPON_CATALOG = {
    blaster: {
      id: 'blaster', name: 'Blaster', cost: 0, order: 0,
      damage: 14, cooldownMs: 420, projectileSpeed: 640, range: 700, pellets: 1, spread: 0,
      color: '#3ef2ff', icon: '●',
      desc: 'Reliable default sidearm. Balanced in every way.',
    },
    rapidfire: {
      id: 'rapidfire', name: 'Rapid Fire', cost: 250, order: 1,
      damage: 8, cooldownMs: 170, projectileSpeed: 700, range: 620, pellets: 1, spread: 0,
      color: '#ff6df0', icon: '◆',
      desc: 'Very fast trigger, lower damage per hit. Great for pressure.',
    },
    shotgun: {
      id: 'shotgun', name: 'Shotgun', cost: 300, order: 2,
      damage: 8, cooldownMs: 700, projectileSpeed: 560, range: 360, pellets: 4, spread: 0.32,
      color: '#ffd93d', icon: '▲',
      desc: 'Four-pellet close-range spread. Devastating up close.',
    },
    railgun: {
      id: 'railgun', name: 'Railgun', cost: 450, order: 3,
      damage: 40, cooldownMs: 1150, projectileSpeed: 950, range: 950, pellets: 1, spread: 0,
      color: '#ff5050', icon: '★',
      desc: 'Slow but hits like a truck at any range.',
    },
  };
  const DEFAULT_WEAPON_ID = 'blaster';

  const UPGRADE_DEFS = {
    health: {
      id: 'health', name: 'Vitality', order: 0,
      desc: '+15 Max HP per level', maxLevel: 3, baseCost: 150, growth: 1.6, valuePerLevel: 15,
    },
    speed: {
      id: 'speed', name: 'Agility', order: 1,
      desc: '+6% Move Speed per level', maxLevel: 3, baseCost: 150, growth: 1.6, valuePerLevel: 0.06,
    },
    cooldown: {
      id: 'cooldown', name: 'Reflexes', order: 2,
      desc: '-8% Attack Cooldown per level', maxLevel: 3, baseCost: 200, growth: 1.6, valuePerLevel: 0.08,
    },
    meleeDamage: {
      id: 'meleeDamage', name: 'Brawler', order: 3,
      desc: '+6 Melee Damage per level', maxLevel: 3, baseCost: 150, growth: 1.6, valuePerLevel: 6,
    },
  };

  /** Cost to buy the *next* level, given the level currently owned (0-based). */
  function upgradeCost(def, currentLevel) {
    return Math.round(def.baseCost * Math.pow(def.growth, currentLevel));
  }

  /** Clamp an arbitrary client-supplied upgrade levels object to valid, known bounds. */
  function sanitizeUpgrades(raw) {
    const out = {};
    for (const key of Object.keys(UPGRADE_DEFS)) {
      const def = UPGRADE_DEFS[key];
      const lvl = raw && Number.isFinite(raw[key]) ? Math.floor(raw[key]) : 0;
      out[key] = Math.max(0, Math.min(def.maxLevel, lvl));
    }
    return out;
  }

  /** Resolve a client-supplied weapon id to a known catalog entry (never trust unknown ids). */
  function sanitizeWeaponId(id) {
    return Object.prototype.hasOwnProperty.call(WEAPON_CATALOG, id) ? id : DEFAULT_WEAPON_ID;
  }

  return {
    ARENA_WIDTH, ARENA_HEIGHT, WALL_THICKNESS,
    OBSTACLES, SPAWN_POINTS, POWERUP_SPAWN_POINTS,
    PLAYER_RADIUS, PROJECTILE_RADIUS, PROJECTILE_SPEED, PROJECTILE_RANGE,
    BASE_SPEED, TICK_RATE, TICK_MS,
    MAX_HEALTH, BASE_DAMAGE, ATTACK_COOLDOWN_MS,
    HIT_INVULN_MS, RESPAWN_INVULN_MS, RESPAWN_DELAY_MS,
    ROUND_DURATION_MS, COUNTDOWN_MS, MAX_PLAYERS_PER_ROOM,
    POWERUP_SPAWN_INTERVAL_MS, MAX_ACTIVE_POWERUPS,
    POWERUP_TYPES, POWERUP_EFFECT_DURATION_MS, POWERUP_COLORS,
    PLAYER_COLORS,
    MELEE_RANGE, MELEE_DAMAGE, MELEE_COOLDOWN_MS, MELEE_ARC,
    KILLSTREAK_LABELS, MAX_KILLSTREAK_TIER, BOT_NAMES,
    WIN_CREDIT_REWARD, WEAPON_CATALOG, DEFAULT_WEAPON_ID, UPGRADE_DEFS,
    upgradeCost, sanitizeUpgrades, sanitizeWeaponId,
  };
});
