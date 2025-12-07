// server.js
// Usage: node server.js <PORT> <PEER_PORT (optional)>
// Example: node server.js 3001 3002
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const args = process.argv.slice(2);
const PORT = parseInt(args[0] || '3001', 10);
const PEER_PORT = args[1] ? parseInt(args[1], 10) : null;
const SERVER_ID = String(PORT);

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Games store
// gameId => { board: 3x3 array, nextTurn: 'X'|'O', status: 'waiting'|'playing'|'finished', players: {X: ws, O: ws} }
const games = new Map();

// track client -> meta
const clientMeta = new Map(); // ws => {gameId, symbol}

// store a peer socket (one connection to peer server)
let peerSocket = null;

// helpers
function createEmptyBoard() {
    return [
        ['', '', ''],
        ['', '', ''],
        ['', '', ''],
    ];
}
function checkWin(board) {
    const lines = [
        // rows
        [[0, 0], [0, 1], [0, 2]],
        [[1, 0], [1, 1], [1, 2]],
        [[2, 0], [2, 1], [2, 2]],
        // cols
        [[0, 0], [1, 0], [2, 0]],
        [[0, 1], [1, 1], [2, 1]],
        [[0, 2], [1, 2], [2, 2]],
        // diags
        [[0, 0], [1, 1], [2, 2]],
        [[0, 2], [1, 1], [2, 0]],
    ];
    for (const line of lines) {
        const [a, b, c] = line;
        const v = board[a[0]][a[1]];
        if (v && v === board[b[0]][b[1]] && v === board[c[0]][c[1]]) {
            return { winner: v, line };
        }
    }
    // check draw
    let filled = true;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (!board[r][c]) filled = false;
    if (filled) return { winner: null, draw: true };
    return null;
}

function broadcastToGame(gameId, msgObj) {
    const game = games.get(gameId);
    if (!game) return;
    for (const symbol of ['X', 'O']) {
        const ws = game.players[symbol];
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msgObj));
        }
    }
}

function sendToPeer(msgObj) {
    if (peerSocket && peerSocket.readyState === WebSocket.OPEN) {
        peerSocket.send(JSON.stringify(msgObj));
    }
}

// Apply a move if valid, return { ok:true, ... } or { ok:false, reason }
function applyMove(gameId, symbol, row, col, origin) {
    const game = games.get(gameId);
    if (!game) return { ok: false, reason: 'Game not found' };
    if (game.status !== 'playing') return { ok: false, reason: 'Game not in playing state' };
    if (game.nextTurn !== symbol) return { ok: false, reason: `Not ${symbol}'s turn` };
    if (row < 0 || row > 2 || col < 0 || col > 2) return { ok: false, reason: 'Invalid cell' };
    if (game.board[row][col]) return { ok: false, reason: 'Cell already occupied' };

    game.board[row][col] = symbol;
    // check win/draw
    const result = checkWin(game.board);
    console.log('game ', game);

    if (result) {
        if (result.draw) {
            game.status = 'finished';
            // broadcast draw
            broadcastToGame(gameId, { type: 'draw', board: game.board });
            // notify peer
            sendToPeer({ type: 'sync', origin: SERVER_ID, gameId, board: game.board, nextTurn: game.nextTurn, status: game.status, playersConnected: game.playersConnected });
            return { ok: true, draw: true };
        } else {
            game.status = 'finished';
            const winner = result.winner;
            broadcastToGame(gameId, { type: 'win', winner, board: game.board, winningLine: result.line });
            sendToPeer({ type: 'sync', origin: SERVER_ID, gameId, board: game.board, nextTurn: game.nextTurn, status: game.status, playersConnected: game.playersConnected });
            return { ok: true, winner };
        }
    } else {
        // switch turn
        game.nextTurn = (game.nextTurn === 'X') ? 'O' : 'X';
        broadcastToGame(gameId, { type: 'update', board: game.board, nextTurn: game.nextTurn, status: game.status });
        // send sync to peer
        sendToPeer({ type: 'sync', origin: SERVER_ID, gameId, board: game.board, nextTurn: game.nextTurn, status: game.status, playersConnected: game.playersConnected });
        return { ok: true };
    }

}

// On incoming ws connection
wss.on('connection', (ws, req) => {
    ws.isPeer = false; // flag if this connection is from peer server
    // allow a "peer" identification message to mark peer connection
    ws.on('message', (msgRaw) => {
        let msg;
        try { msg = JSON.parse(msgRaw); } catch (e) { ws.send(JSON.stringify({ type: 'error', message: 'bad json' })); return; }
        if (msg && msg.type === 'identify' && msg.role === 'peer' && msg.serverId) {
            ws.isPeer = true;
            ws.serverId = msg.serverId;
            peerSocket = ws; // accept peer incoming connection
            console.log(`[${SERVER_ID}] Accepted incoming peer connection from server ${msg.serverId}`);
            return;
        }
        // handle client messages
        if (msg.type === 'join') {
            // Find a game that is waiting for a second player
            let waitingGame = null;
            for (const [id, g] of games) {
                if (g.status === 'waiting') {
                    waitingGame = g;
                    gameId = id;
                    break;
                }
            }

            // If no waiting game, create a new one
            if (!waitingGame) {
                gameId = `room${games.size}`; // dynamic room ID
                const game = {
                    board: createEmptyBoard(),
                    nextTurn: 'X',
                    status: 'waiting',
                    players: { X: null, O: null },
                    playersConnected: { X: false, O: false }
                };
                games.set(gameId, game);
                waitingGame = game;
            }

            const game = waitingGame;

            // assign a symbol
            let symbol;

            if (!game.playersConnected['X']) symbol = 'X';
            else if (!game.playersConnected['O']) symbol = 'O';

            game.players[symbol] = ws;
            game.playersConnected[symbol] = true;

            clientMeta.set(ws, { gameId, symbol });
            if (game.playersConnected['X'] && game.playersConnected['O']) {
                game.status = 'playing';
            }
            ws.send(JSON.stringify({ type: 'joined', symbol, gameId }));
            // notify both players of current state
            broadcastToGame(gameId, { type: 'update', board: game.board, nextTurn: game.nextTurn, status: game.status, playersConnected: game.playersConnected });
            // also sync to peer that a game exists (so the peer has empty board too)
            sendToPeer({ type: 'sync', origin: SERVER_ID, gameId, board: game.board, nextTurn: game.nextTurn, status: game.status, playersConnected: game.playersConnected });
            return;
        }

        if (msg.type === 'move') {
            const meta = clientMeta.get(ws);
            if (!meta) {
                ws.send(JSON.stringify({ type: 'error', message: 'You must join first' }));
                return;
            }
            const { gameId, symbol } = meta;
            const { row, col } = msg;
            const res = applyMove(gameId, symbol, row, col, SERVER_ID);
            if (!res.ok) {
                ws.send(JSON.stringify({ type: 'error', message: res.reason }));
            } else {
                // move applied and broadcasted inside applyMove
            }
            return;
        }

        // Peer sync message could be received on client ws if another server connected to us - but we mark peer connections as identified.
        if (msg.type === 'sync') {
            console.log('###inside sync');

            // handle incoming sync from peer server
            if (msg.origin === SERVER_ID) return; // ignore own
            const { gameId, board, nextTurn, status, playersConnected } = msg;
            // Upsert local game state to match peer
            let game = games.get(gameId);
            if (!game) {
                game = {
                    board: board,
                    nextTurn: nextTurn,
                    status: status,
                    players: { X: null, O: null },
                    playersConnected
                };
                games.set(gameId, game);
            } else {
                // simple policy: accept peer state if it differs (we don't attempt conflict resolution for simultaneous moves)
                game.board = board;
                game.nextTurn = nextTurn;
                game.status = status;
                game.playersConnected = playersConnected;
            }
            console.log('###SYNC GAME ', game);

            // broadcast to any local clients
            broadcastToGame(gameId, { type: 'update', board: game.board, nextTurn: game.nextTurn, status: game.status });
            // if finished, send win/draw appropriate message to local players
            const check = checkWin(game.board);
            if (check) {
                if (check.draw) {
                    broadcastToGame(gameId, { type: 'draw', board: game.board });
                } else {
                    broadcastToGame(gameId, { type: 'win', winner: check.winner, board: game.board, winningLine: check.line });
                }
            }
            return;
        }

        // unknown message
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
    });

    ws.on('close', () => {
        console.log('###inside close');

        // cleanup clientMeta and game player slots
        const meta = clientMeta.get(ws);
        console.log('meta ', meta);

        if (meta) {
            const game = games.get(meta.gameId);
            console.log('game ', game);

            if (game) {
                if (game.players[meta.symbol] === ws) {
                    game.players[meta.symbol] = null;
                    game.playersConnected[meta.symbol] = false;
                }
                // if both players gone, remove game
                if (!game.playersConnected.X && !game.playersConnected.O) {
                    games.delete(meta.gameId);
                } else {
                    // else, set status to waiting
                    if (game.status !== 'finished') game.status = 'waiting';
                    broadcastToGame(meta.gameId, { type: 'update', board: game.board, nextTurn: game.nextTurn, status: game.status });
                    sendToPeer({ type: 'sync', origin: SERVER_ID, gameId, board: game.board, nextTurn: game.nextTurn, status: game.status, playersConnected: game.playersConnected });
                }
            }
            clientMeta.delete(ws);
        } else if (ws.isPeer) {
            console.log(`[${SERVER_ID}] Peer connection closed.`);
            if (peerSocket === ws) peerSocket = null;
        }
    });
});

// try to connect to peer (if provided)
function connectToPeer(peerPort) {
    if (!peerPort) return;
    const url = `ws://localhost:${peerPort}`;
    const attempt = () => {
        try {
            const sock = new WebSocket(url);
            sock.on('open', () => {
                console.log(`[${SERVER_ID}] Connected to peer at ${url}`);
                peerSocket = sock;
                // identify ourselves so incoming server marks it as peer
                sock.send(JSON.stringify({ type: 'identify', role: 'peer', serverId: SERVER_ID }));
            });
            sock.on('message', (raw) => {
                let msg;
                try { msg = JSON.parse(raw); } catch (e) { return; }
                if (msg.type === 'identify' && msg.role === 'peer') {
                    // other side may identify us — ignore
                    return;
                }
                if (msg.type === 'sync') {
                    // handle sync same as in server on message
                    if (msg.origin === SERVER_ID) return;
                    const { gameId, board, nextTurn, status, playersConnected } = msg;
                    let game = games.get(gameId);
                    if (!game) {
                        game = { board, nextTurn, status, players: { X: null, O: null }, playersConnected: { X: false, O: false } };
                        games.set(gameId, game);
                    } else {
                        game.board = board; game.nextTurn = nextTurn; game.status = status; game.playersConnected = playersConnected;
                    }
                    broadcastToGame(gameId, { type: 'update', board: game.board, nextTurn: game.nextTurn, status: game.status });
                    const check = checkWin(game.board);
                    if (check) {
                        if (check.draw) broadcastToGame(gameId, { type: 'draw', board: game.board });
                        else broadcastToGame(gameId, { type: 'win', winner: check.winner, board: game.board, winningLine: check.line });
                    }
                }
            });
            sock.on('close', () => {
                console.log(`[${SERVER_ID}] Peer connection to ${url} closed, retry in 1s`);
                if (peerSocket === sock) peerSocket = null;
                setTimeout(attempt, 1000);
            });
            sock.on('error', (e) => {
                console.log('###inside error ', e);
            });
        } catch (e) {
            setTimeout(attempt, 1000);
        }
    };
    attempt();
}

server.listen(PORT, () => {
    console.log(`[${SERVER_ID}] Server running on port ${PORT}`);
    if (PEER_PORT) {
        console.log(`[${SERVER_ID}] Will try to connect to peer at port ${PEER_PORT}`);
        connectToPeer(PEER_PORT);
    } else {
        console.log(`[${SERVER_ID}] No peer port supplied. You can still connect a peer server by starting another instance and passing this port as its peer.`);
    }
});
