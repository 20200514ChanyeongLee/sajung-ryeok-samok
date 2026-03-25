import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const PORT = process.env.PORT || 3000;

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const NEUTRAL = 3;
const SIZE = 9;

const gravityLabels = {
  up: "상",
  down: "하",
  left: "좌",
  right: "우",
  none: "무",
};

const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

io.on("connection", (socket) => {
  socket.on("create_room", ({ nickname }) => {
    try {
      const safeNickname = sanitizeNickname(nickname);
      leavePreviousRoomIfNeeded(socket);

      const roomCode = generateRoomCode();
      const room = createRoom(roomCode);

      console.log("CREATE ROOM", roomCode, [...rooms.keys()]);

      room.players.black = {
        socketId: socket.id,
        nickname: safeNickname,
      };

      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.player = BLACK;

      emitRoomJoined(socket, roomCode, BLACK, safeNickname, room);
      broadcastRoomState(roomCode);
    } catch (err) {
      emitError(socket, err.message);
    }
  });

  socket.on("join_room", ({ roomCode, nickname }) => {
    try {
      const safeNickname = sanitizeNickname(nickname);
      const code = String(roomCode || "").trim().toUpperCase();
      if (!code) throw new Error("방 코드를 입력하세요.");

      leavePreviousRoomIfNeeded(socket);

      const room = rooms.get(code);
      console.log("JOIN TRY", code, [...rooms.keys()]);

      if (!room) throw new Error("존재하지 않는 방입니다.");
      if (room.players.white) throw new Error("방이 가득 찼습니다.");

      room.players.white = {
        socketId: socket.id,
        nickname: safeNickname,
      };

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.player = WHITE;

      emitRoomJoined(socket, code, WHITE, safeNickname, room);
      broadcastRoomState(code);
    } catch (err) {
      emitError(socket, err.message);
    }
  });

socket.on("player_action", ({ roomCode, action }) => {
  try {
    const room = getRoomOrThrow(roomCode);
    const player = socket.data.player;
    if (!player) throw new Error("플레이어가 아닙니다.");
    if (!isSocketPlayerInRoom(socket, room, player)) throw new Error("권한이 없습니다.");

    // Undo/Redo 요청자가 새 행동을 시작하면 기존 요청 자동 취소
    if (room.pendingRequest && room.pendingRequest.from === player) {
      room.game.log.push(
        `${playerName(player)}이 새 행동을 진행하여 ${room.pendingRequest.requestType.toUpperCase()} 요청이 자동 취소됨`
      );
      clearPendingRequest(room, roomCode);
    }

    applyPlayerAction(room, player, action);
    broadcastRoomState(roomCode);
  } catch (err) {
    emitError(socket, err.message);
  }
});

  socket.on("request_action", ({ roomCode, requestType }) => {
    try {
      const room = getRoomOrThrow(roomCode);
      const player = socket.data.player;
      if (!player) throw new Error("플레이어가 아닙니다.");
      if (!isSocketPlayerInRoom(socket, room, player)) throw new Error("권한이 없습니다.");
      if (room.pendingRequest) throw new Error("이미 처리 중인 요청이 있습니다.");
      if (connectedPlayers(room) < 2) throw new Error("상대 플레이어가 아직 없습니다.");

      if (requestType === "undo" && room.game.history.length === 0) {
        throw new Error("Undo할 기록이 없습니다.");
      }
      if (requestType === "redo" && room.game.future.length === 0) {
        throw new Error("Redo할 기록이 없습니다.");
      }
      if (requestType !== "undo" && requestType !== "redo") {
        throw new Error("유효하지 않은 요청입니다.");
      }

      const from = player;
      const to = player === BLACK ? WHITE : BLACK;
      const toPlayer = getPlayerRecord(room, to);
      const fromPlayer = getPlayerRecord(room, from);

      if (!toPlayer) throw new Error("상대 플레이어가 없습니다.");

      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      room.pendingRequest = {
        requestId,
        requestType,
        from,
        to,
        fromNickname: fromPlayer.nickname,
      };

      io.to(toPlayer.socketId).emit("request_received", room.pendingRequest);
    } catch (err) {
      emitError(socket, err.message);
    }
  });

  socket.on("respond_request", ({ roomCode, requestId, approved }) => {
    try {
      const room = getRoomOrThrow(roomCode);
      const pending = room.pendingRequest;
      if (!pending) throw new Error("대기 중인 요청이 없습니다.");
      if (pending.requestId !== requestId) throw new Error("유효하지 않은 요청입니다.");

      const responder = socket.data.player;
      if (responder !== pending.to) throw new Error("응답 권한이 없습니다.");

      if (approved) {
        if (pending.requestType === "undo") {
          performUndo(room.game);
          room.game.log.push("상호 동의로 Undo 실행");
        } else {
          performRedo(room.game);
          room.game.log.push("상호 동의로 Redo 실행");
        }
      } else {
        room.game.log.push(
          `${playerName(pending.to)}이 ${pending.requestType.toUpperCase()} 요청을 거절함`
        );
      }

      clearPendingRequest(room, roomCode);
      broadcastRoomState(roomCode);
    } catch (err) {
      emitError(socket, err.message);
    }
  });

  socket.on("new_game", ({ roomCode }) => {
    try {
      const room = getRoomOrThrow(roomCode);
      room.game = createInitialGameState();
      room.pendingRequest = null;
      io.to(roomCode).emit("request_cleared");
      broadcastRoomState(roomCode);
    } catch (err) {
      emitError(socket, err.message);
    }
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    const player = socket.data.player;
    if (!roomCode || !player) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    if (player === BLACK) room.players.black = null;
    if (player === WHITE) room.players.white = null;

    room.pendingRequest = null;
    io.to(roomCode).emit("request_cleared");
    broadcastRoomState(roomCode);

    if (!room.players.black && !room.players.white) {
      rooms.delete(roomCode);
    }
  });
});

function createRoom(roomCode) {
  const room = {
    roomCode,
    players: {
      black: null,
      white: null,
    },
    game: createInitialGameState(),
    pendingRequest: null,
  };
  rooms.set(roomCode, room);
  return room;
}

function createInitialGameState() {
  return {
    board: createEmptyBoard(),
    currentPlayer: BLACK,
    phase: "place",
    lastGravity: {
      [BLACK]: null,
      [WHITE]: null,
    },
    placedPosition: null,
    movedPosition: null,
    selectableNeutralCells: [],
    winner: null,
    moveNumber: 1,
    log: ["새 게임을 시작했습니다."],
    history: [],
    future: [],
  };
}

function createEmptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
}

function cloneBoard(board) {
  return board.map((row) => [...row]);
}

function snapshotGame(game) {
  return {
    board: cloneBoard(game.board),
    currentPlayer: game.currentPlayer,
    phase: game.phase,
    lastGravity: { ...game.lastGravity },
    placedPosition: game.placedPosition ? { ...game.placedPosition } : null,
    movedPosition: game.movedPosition ? { ...game.movedPosition } : null,
    selectableNeutralCells: game.selectableNeutralCells.map((p) => ({ ...p })),
    winner: game.winner,
    moveNumber: game.moveNumber,
    log: [...game.log],
  };
}

function restoreGame(game, snapshot) {
  game.board = cloneBoard(snapshot.board);
  game.currentPlayer = snapshot.currentPlayer;
  game.phase = snapshot.phase;
  game.lastGravity = { ...snapshot.lastGravity };
  game.placedPosition = snapshot.placedPosition ? { ...snapshot.placedPosition } : null;
  game.movedPosition = snapshot.movedPosition ? { ...snapshot.movedPosition } : null;
  game.selectableNeutralCells = snapshot.selectableNeutralCells.map((p) => ({ ...p }));
  game.winner = snapshot.winner;
  game.moveNumber = snapshot.moveNumber;
  game.log = [...snapshot.log];
}

function saveHistory(game) {
  game.history.push(snapshotGame(game));
  game.future = [];
}

function performUndo(game) {
  if (game.history.length === 0) throw new Error("Undo할 기록이 없습니다.");
  game.future.push(snapshotGame(game));
  const snapshot = game.history.pop();
  restoreGame(game, snapshot);
}

function performRedo(game) {
  if (game.future.length === 0) throw new Error("Redo할 기록이 없습니다.");
  game.history.push(snapshotGame(game));
  const snapshot = game.future.pop();
  restoreGame(game, snapshot);
}

function applyPlayerAction(room, player, action) {
  const game = room.game;

  if (game.phase === "gameover") throw new Error("이미 종료된 게임입니다.");
  if (game.currentPlayer !== player) throw new Error("지금은 당신의 턴이 아닙니다.");
  if (!action || typeof action !== "object") throw new Error("유효하지 않은 행동입니다.");

  if (action.type === "place") {
    handlePlace(game, action.r, action.c, player);
    return;
  }

  if (action.type === "gravity") {
    handleGravity(game, action.direction, player);
    return;
  }

  if (action.type === "neutral") {
    handleNeutral(game, action.r, action.c, player);
    return;
  }

  throw new Error("알 수 없는 행동입니다.");
}

function handlePlace(game, r, c, player) {
  if (game.phase !== "place") throw new Error("지금은 돌을 둘 단계가 아닙니다.");
  if (!isInside(r, c)) throw new Error("유효하지 않은 좌표입니다.");
  if (game.board[r][c] !== EMPTY) throw new Error("빈 칸에만 둘 수 있습니다.");

  saveHistory(game);
  game.board[r][c] = player;
  game.placedPosition = { r, c };
  game.movedPosition = { r, c };
  game.phase = "gravity";
  game.log.push(`${game.moveNumber}. ${playerName(player)}: (${r + 1}, ${c + 1})에 돌 배치`);
}

function handleGravity(game, direction, player) {
  if (game.phase !== "gravity") throw new Error("지금은 중력 단계가 아닙니다.");
  if (!gravityLabels[direction]) throw new Error("유효하지 않은 중력 방향입니다.");
  if (game.lastGravity[player] === direction) {
    throw new Error("같은 방향을 연속으로 사용할 수 없습니다.");
  }

  saveHistory(game);

  const start = { ...game.placedPosition };
  const result = applyGravity(game.board, direction, start);
  game.board = result.board;
  game.movedPosition = result.trackedPosition;
  game.lastGravity[player] = direction;
  game.log.push(`   └ 중력 적용: ${gravityLabels[direction]}`);

  if (direction === "none") {
    finishTurn(game, `중력 '${gravityLabels[direction]}'로 턴 종료`);
    return;
  }

  const pathCells = getPathBetweenExclusive(start, result.trackedPosition);
  const allCandidateCells = [{ ...start }, ...pathCells];
  const validNeutralCells = allCandidateCells.filter(
    (pos) => game.board[pos.r][pos.c] === EMPTY
  );
  game.selectableNeutralCells = validNeutralCells;

  if (validNeutralCells.length === 0) {
    game.log.push("   └ 중립 돌을 배치할 수 없어 즉시 패배합니다.");
    game.phase = "gameover";
    const winner = player === BLACK ? WHITE : BLACK;
    game.winner = `${playerName(winner)} (상대가 중립 돌을 배치할 수 없음)`;
    return;
  }

  game.phase = "neutral";
}

function handleNeutral(game, r, c) {
  if (game.phase !== "neutral") throw new Error("지금은 중립 돌 단계가 아닙니다.");
  if (!isInside(r, c)) throw new Error("유효하지 않은 좌표입니다.");

  const ok = game.selectableNeutralCells.some((pos) => pos.r === r && pos.c === c);
  if (!ok) throw new Error("중립 돌을 둘 수 없는 칸입니다.");
  if (game.board[r][c] !== EMPTY) throw new Error("빈 칸에만 중립 돌을 둘 수 있습니다.");

  saveHistory(game);
  game.board[r][c] = NEUTRAL;
  game.log.push(`   └ 중립 돌 배치: (${r + 1}, ${c + 1})`);
  finishTurn(game, "중립 돌 배치 완료");
}

function finishTurn(game, reason) {
  game.phase = "place";
  game.selectableNeutralCells = [];
  game.log.push(`   └ 턴 종료: ${reason}`);

  const win = evaluateWinner(game.board, game.currentPlayer);
  if (win) {
    game.phase = "gameover";
    game.winner = `${playerName(game.currentPlayer)} (${win})`;
    return;
  }

  const nextPlayer = game.currentPlayer === BLACK ? WHITE : BLACK;
  if (!boardHasEmptyCell(game.board)) {
    game.phase = "gameover";
    game.winner = `${playerName(game.currentPlayer)} (상대가 더 이상 돌을 둘 수 없음)`;
    return;
  }

  game.currentPlayer = nextPlayer;
  game.placedPosition = null;
  game.movedPosition = null;
  game.moveNumber += 1;
}

function applyGravity(board, direction, trackedPosition) {
  if (direction === "none") {
    return {
      board: cloneBoard(board),
      trackedPosition: { ...trackedPosition },
    };
  }

  const newBoard = createEmptyBoard();

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === NEUTRAL) newBoard[r][c] = NEUTRAL;
    }
  }

  let newTracked = { ...trackedPosition };

  if (direction === "left" || direction === "right") {
    for (let r = 0; r < SIZE; r++) {
      const blockers = [-1];
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c] === NEUTRAL) blockers.push(c);
      }
      blockers.push(SIZE);

      for (let b = 0; b < blockers.length - 1; b++) {
        const left = blockers[b] + 1;
        const right = blockers[b + 1] - 1;
        if (left > right) continue;

        const stones = [];
        for (let c = left; c <= right; c++) {
          if (board[r][c] === BLACK || board[r][c] === WHITE) {
            stones.push({ value: board[r][c], oldR: r, oldC: c });
          }
        }

        if (direction === "left") {
          stones.forEach((stone, idx) => {
            const nc = left + idx;
            newBoard[r][nc] = stone.value;
            if (stone.oldR === trackedPosition.r && stone.oldC === trackedPosition.c) {
              newTracked = { r, c: nc };
            }
          });
        } else {
          stones
            .slice()
            .reverse()
            .forEach((stone, idx) => {
              const nc = right - idx;
              newBoard[r][nc] = stone.value;
              if (stone.oldR === trackedPosition.r && stone.oldC === trackedPosition.c) {
                newTracked = { r, c: nc };
              }
            });
        }
      }
    }
  } else {
    for (let c = 0; c < SIZE; c++) {
      const blockers = [-1];
      for (let r = 0; r < SIZE; r++) {
        if (board[r][c] === NEUTRAL) blockers.push(r);
      }
      blockers.push(SIZE);

      for (let b = 0; b < blockers.length - 1; b++) {
        const top = blockers[b] + 1;
        const bottom = blockers[b + 1] - 1;
        if (top > bottom) continue;

        const stones = [];
        for (let r = top; r <= bottom; r++) {
          if (board[r][c] === BLACK || board[r][c] === WHITE) {
            stones.push({ value: board[r][c], oldR: r, oldC: c });
          }
        }

        if (direction === "up") {
          stones.forEach((stone, idx) => {
            const nr = top + idx;
            newBoard[nr][c] = stone.value;
            if (stone.oldR === trackedPosition.r && stone.oldC === trackedPosition.c) {
              newTracked = { r: nr, c };
            }
          });
        } else {
          stones
            .slice()
            .reverse()
            .forEach((stone, idx) => {
              const nr = bottom - idx;
              newBoard[nr][c] = stone.value;
              if (stone.oldR === trackedPosition.r && stone.oldC === trackedPosition.c) {
                newTracked = { r: nr, c };
              }
            });
        }
      }
    }
  }

  return { board: newBoard, trackedPosition: newTracked };
}

function getPathBetweenExclusive(start, end) {
  const cells = [];
  if (start.r === end.r && start.c === end.c) return cells;

  if (start.r === end.r) {
    const step = start.c < end.c ? 1 : -1;
    for (let c = start.c + step; c !== end.c; c += step) {
      cells.push({ r: start.r, c });
    }
  } else if (start.c === end.c) {
    const step = start.r < end.r ? 1 : -1;
    for (let r = start.r + step; r !== end.r; r += step) {
      cells.push({ r, c: start.c });
    }
  }

  return cells;
}

function evaluateWinner(board, currentPlayer) {
  if (hasExactFour(board, currentPlayer)) {
    return `${playerName(currentPlayer)} 돌 정확히 4개 연결`;
  }
  if (hasExactFour(board, NEUTRAL)) {
    return "중립 돌 정확히 4개 연결";
  }
  return null;
}

function hasExactFour(board, target) {
  const dirs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== target) continue;

      for (const [dr, dc] of dirs) {
        const prevR = r - dr;
        const prevC = c - dc;
        if (isInside(prevR, prevC) && board[prevR][prevC] === target) continue;

        let length = 0;
        let nr = r;
        let nc = c;

        while (isInside(nr, nc) && board[nr][nc] === target) {
          length++;
          nr += dr;
          nc += dc;
        }

        if (length === 4) return true;
      }
    }
  }

  return false;
}

function boardHasEmptyCell(board) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === EMPTY) return true;
    }
  }
  return false;
}

function isInside(r, c) {
  return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

function playerName(player) {
  return player === BLACK ? "흑" : "백";
}

function sanitizeNickname(nickname) {
  const value = String(nickname || "").trim();
  if (!value) throw new Error("닉네임을 입력하세요.");
  return value.slice(0, 20);
}

function generateRoomCode() {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function getRoomOrThrow(roomCode) {
  const code = String(roomCode || "").trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  return room;
}

function getPlayerRecord(room, player) {
  return player === BLACK ? room.players.black : room.players.white;
}

function connectedPlayers(room) {
  return [room.players.black, room.players.white].filter(Boolean).length;
}

function isSocketPlayerInRoom(socket, room, player) {
  const record = getPlayerRecord(room, player);
  return !!record && record.socketId === socket.id;
}

function emitRoomJoined(socket, roomCode, player, nickname, room) {
  socket.emit("room_joined", {
    roomCode,
    player,
    nickname,
    connectedPlayers: connectedPlayers(room),
    game: room.game,
  });
}

function broadcastRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit("room_state", {
    connectedPlayers: connectedPlayers(room),
    game: room.game,
  });
}

function clearPendingRequest(room, roomCode) {
  room.pendingRequest = null;
  io.to(roomCode).emit("request_cleared");
}

function emitError(socket, message) {
  socket.emit("error_message", { message });
}

function leavePreviousRoomIfNeeded(socket) {
  const prevRoomCode = socket.data.roomCode;
  const prevPlayer = socket.data.player;
  if (!prevRoomCode || !prevPlayer) return;

  const prevRoom = rooms.get(prevRoomCode);
  if (!prevRoom) return;

  if (prevPlayer === BLACK) prevRoom.players.black = null;
  if (prevPlayer === WHITE) prevRoom.players.white = null;

  prevRoom.pendingRequest = null;
  socket.leave(prevRoomCode);
  io.to(prevRoomCode).emit("request_cleared");
  broadcastRoomState(prevRoomCode);

  if (!prevRoom.players.black && !prevRoom.players.white) {
    rooms.delete(prevRoomCode);
  }

  socket.data.roomCode = null;
  socket.data.player = null;
}

