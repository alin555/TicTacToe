// client.js
// Usage: node client.js <SERVER_WS_URL>
// Example: node client.js ws://localhost:3001
const WebSocket = require('ws');
const readline = require('readline');

const SERVER_URL = process.argv[2] || 'ws://localhost:3001';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let ws = null;
let mySymbol = null;
let currentBoard = null;
let currentGameId = null;
let nextTurn = null;
let status = 'waiting';

function drawBoard(board) {
    if (!board) board = [['', '', ''], ['', '', ''], ['', '', '']];
    const rows = board.map(r => r.map(c => c || ' ').join(' | '));
    console.log('\n  0   1   2');
    console.log('0 ' + rows[0]);
    console.log('  -----------');
    console.log('1 ' + rows[1]);
    console.log('  -----------');
    console.log('2 ' + rows[2]);
    console.log('');
}

function promptMove() {
    if (status !== 'playing') return;
    if (nextTurn !== mySymbol) {
        console.log(`Waiting for opponent. Next turn: ${nextTurn}`);
        return;
    }
    rl.question(`Your move (${mySymbol}) as "row,col": `, (ans) => {
        const parts = ans.split(',').map(s => s.trim());
        if (parts.length !== 2) {
            console.log('Invalid format. Use: row,col (e.g., 1,2)');
            return promptMove();
        }
        const row = parseInt(parts[0], 10);
        const col = parseInt(parts[1], 10);
        if (Number.isNaN(row) || Number.isNaN(col) || row < 0 || row > 2 || col < 0 || col > 2) {
            console.log('Invalid coordinates. rows and cols are 0-2.');
            return promptMove();
        }
        // send move
        const msg = { type: 'move', gameId: currentGameId, row, col };
        ws.send(JSON.stringify(msg));
        // don't prompt again immediately — will wait for update
    });
}

function connect() {
    ws = new WebSocket(SERVER_URL);

    ws.on('open', () => {
        console.log(`Connected to ${SERVER_URL}`);
        // auto-join default game 'room1'
        const joinMsg = { type: 'join' };
        ws.send(JSON.stringify(joinMsg));
    });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { console.log('Bad message from server'); return; }
        if (msg.type === 'joined') {
            mySymbol = msg.symbol;
            currentGameId = msg.gameId;
            console.log(`Joined game ${currentGameId} as ${mySymbol}`);
            return;
        }
        if (msg.type === 'update') {
            currentBoard = msg.board;
            nextTurn = msg.nextTurn;
            status = msg.status || 'playing';
            drawBoard(currentBoard);
            console.log(`Next turn: ${nextTurn} | Status: ${status}`);
            promptMove();
            return;
        }
        if (msg.type === 'error') {
            console.log('Error:', msg.message);
            promptMove();
            return;
        }
        if (msg.type === 'win') {
            drawBoard(msg.board);
            console.log(`Game over! Winner: ${msg.winner}`);
            process.exit(0);
            return;
        }
        if (msg.type === 'draw') {
            drawBoard(msg.board);
            console.log('Game over! Draw.');
            process.exit(0);
            return;
        }
    });

    ws.on('close', () => {
        console.log('Disconnected from server');
        process.exit(0);
    });

    ws.on('error', (e) => {
        console.error('Connection error', e.message);
        process.exit(1);
    });
}

connect();
