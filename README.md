# Real-time Tic-Tac-Toe (Two Servers + CLI Clients)

## Overview
This project implements a real-time multiplayer Tic-Tac-Toe game where two CLI clients can connect to two independent backend servers. Game state is synchronized between the two servers in real time through server-to-server WebSocket messages (federation). No browser required.

## Architecture
- Two Node.js WebSocket servers (each can be started with a different port).
- Servers try to connect to each other and exchange `sync` messages to keep game state in sync.
- CLI WebSocket client to connect to either server, shows ASCII board and accepts `row,col` input.
- Communication protocol: JSON messages (`join`, `move`, `update`, `sync`, `win`, `draw`, `error`).

## Files
- `server.js` — Node.js WebSocket server and peer-sync logic.
- `client.js` — CLI WebSocket client.
- `package.json` — dependencies (`ws`, `uuid`).

## How to run
1. npm install
2. Start server A on port 3001 (peer 3002):

node server.js 3001 3002


Start server B on port 3002 (peer 3001):

node server.js 3002 3001


Open two terminals for clients:

node client.js ws://localhost:3001
node client.js ws://localhost:3002


Play! Moves are typed as row,col (both 0-indexed).

