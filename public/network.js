// ============================================================================
// Battle Arena — network layer
// Thin wrapper around the Socket.IO client. game.js never touches `socket`
// directly; it calls NET.<action>(...) to send things and NET.on(event, cb)
// to receive things. Keeping this isolated makes the transport swappable
// and keeps game.js focused on rendering/game logic.
// ============================================================================

const NET = (() => {
  let socket = null;
  const listeners = {};

  function connect() {
    if (socket) return socket;
    socket = io({ transports: ['websocket', 'polling'] });

    const forwarded = [
      'roomJoined', 'joinError', 'lobbyUpdate', 'countdownStart', 'roundStart',
      'gameState', 'hitEvent', 'deathEvent', 'respawnEvent', 'powerupCollected',
      'meleeEvent', 'killstreakEvent', 'firstBloodEvent', 'explosionEvent',
      'roundEnded', 'connect', 'disconnect', 'connect_error',
    ];
    forwarded.forEach((evt) => {
      socket.on(evt, (payload) => emit(evt, payload));
    });

    return socket;
  }

  function emit(evt, payload) {
    (listeners[evt] || []).forEach((cb) => cb(payload));
  }

  function on(evt, cb) {
    if (!listeners[evt]) listeners[evt] = [];
    listeners[evt].push(cb);
  }

  function off(evt, cb) {
    if (!listeners[evt]) return;
    listeners[evt] = listeners[evt].filter((fn) => fn !== cb);
  }

  // --- Outgoing actions ------------------------------------------------------
  function createRoom(name, color, loadout) { socket.emit('createRoom', { name, color, loadout }); }
  function joinRoom(code, name, color, loadout) { socket.emit('joinRoom', { code, name, color, loadout }); }
  function quickPlay(name, color, loadout) { socket.emit('quickPlay', { name, color, loadout }); }
  function toggleReady() { socket.emit('toggleReady'); }
  function addBot() { socket.emit('addBot'); }
  function removeBot() { socket.emit('removeBot'); }
  function startGame() { socket.emit('startGame'); }
  function playAgain() { socket.emit('playAgain'); }
  function returnToLobby() { socket.emit('returnToLobby'); }
  function leaveRoom() { socket.emit('leaveRoom'); }
  function sendInput(input) { if (socket && socket.connected) socket.emit('input', input); }

  function getId() { return socket ? socket.id : null; }

  return {
    connect, on, off, getId,
    createRoom, joinRoom, quickPlay, toggleReady, addBot, removeBot, startGame,
    playAgain, returnToLobby, leaveRoom, sendInput,
  };
})();
