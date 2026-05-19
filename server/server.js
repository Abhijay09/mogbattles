const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
const rooms = {}; // Structure: { 'CODE': { host: socket, peer: socket, hostNick: '', peerNick: '' } }

console.log("Signaling server running on port 8080");

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        const { type, room, nick } = data;

        switch (type) {
            case 'create':
                rooms[room] = { host: ws, hostNick: nick };
                ws.send(JSON.stringify({ type: 'created' }));
                break;

            case 'join':
                if (rooms[room]) {
                    rooms[room].peer = ws;
                    rooms[room].peerNick = nick;
                    // Tell both sides they are connected
                    rooms[room].host.send(JSON.stringify({ type: 'opponent-joined', nick: nick }));
                    ws.send(JSON.stringify({ type: 'joined', hostNick: rooms[room].hostNick }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
                }
                break;

            case 'offer':
            case 'answer':
            case 'ice':
                // Relay to the other person in the room
                const target = (rooms[room].host === ws) ? rooms[room].peer : rooms[room].host;
                if (target) {
                    target.send(JSON.stringify(data));
                }
                break;
                
            case 'data': // Tunneling app messages (scores, etc)
                const targetApp = (rooms[room].host === ws) ? rooms[room].peer : rooms[room].host;
                if (targetApp) {
                    targetApp.send(JSON.stringify({ type: 'data', payload: data.payload }));
                }
                break;
        }
    });

    ws.on('close', () => {
        // Cleanup logic would go here
    });
});
