// server/server.js
const WebSocket = require('ws');
const http = require('http');
const port = process.env.PORT || 8081;

// Create an HTTP server to handle Render's health checks
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Mog Battles Signaling Server is active');
});

const wss = new WebSocket.Server({ server }); 

console.log(`Mog Battles Signaling Server is running on port ${port}`);

// Ping-pong heartbeat to keep connection alive on Render
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    });
}, 30000);

wss.on('connection', (ws) => {
    console.log('New WebSocket client connected.');
...

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received message:', data.type, 'from room:', data.room);
            const { type, room, nick } = data;
            
            switch (type) {
                case 'create':
                    rooms[room] = { host: ws, peer: null, hostNick: nick };
                    ws.send(JSON.stringify({ type: 'created' }));
                    currentRoom = room;
                    console.log('Room created:', room);
                    break;
                case 'join':
                    if (rooms[room] && !rooms[room].peer) {
                        rooms[room].peer = ws;
                        rooms[room].peerNick = nick;
                        rooms[room].host.send(JSON.stringify({ type: 'opponent-joined', nick: nick }));
                        ws.send(JSON.stringify({ type: 'joined', hostNick: rooms[room].hostNick }));
                        currentRoom = room;
                        console.log('User joined room:', room);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Room full or not found' }));
                    }
                    break;
                case 'offer':
                case 'answer':
                case 'ice':
                case 'data':
                    if (rooms[room]) {
                        const target = (rooms[room].host === ws) ? rooms[room].peer : rooms[room].host;
                        if (target && target.readyState === WebSocket.OPEN) {
                            target.send(JSON.stringify(data));
                        }
                    }
                    break;
            }
        } catch (err) {
            console.error("Failed to process message:", err);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected.');
        if (currentRoom && rooms[currentRoom]) {
            const roomData = rooms[currentRoom];
            const otherPeer = (roomData.host === ws) ? roomData.peer : roomData.host;
            if (otherPeer && otherPeer.readyState === WebSocket.OPEN) {
                otherPeer.send(JSON.stringify({ type: 'opponent-disconnected' }));
            }
            delete rooms[currentRoom];
            console.log('Room deleted:', currentRoom);
        }
    });
});

server.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on port ${port}`);
});
