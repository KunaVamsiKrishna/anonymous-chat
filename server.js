const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(__dirname));

// File to store persistent data
const DATA_FILE = path.join(__dirname, 'chat_data.json');

// Store rooms and users
let rooms = new Map();
const users = new Map();
const roomTimers = new Map();

// ADDED: Load rooms from file on startup
function loadRoomsFromFile() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            data.rooms.forEach(roomData => {
                rooms.set(roomData.id, {
                    name: roomData.name,
                    password: roomData.password,
                    owner: roomData.owner,
                    messages: roomData.messages || [],
                    users: new Set(),
                    lastActivity: Date.now()
                });
            });
            console.log(`📂 Loaded ${data.rooms.length} rooms from storage`);
        }
    } catch (error) {
        console.error('❌ Error loading rooms:', error);
        initializeDefaultRoom();
    }
    
    // Ensure public room exists
    if (!rooms.has('public')) {
        initializeDefaultRoom();
    }
}

// ADDED: Save rooms to file
function saveRoomsToFile() {
    try {
        const roomsData = Array.from(rooms.entries()).map(([id, room]) => ({
            id: id,
            name: room.name,
            password: room.password,
            owner: room.owner,
            messages: room.messages,
            lastActivity: room.lastActivity
        }));
        
        const data = { rooms: roomsData };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log(`💾 Saved ${roomsData.length} rooms to storage`);
    } catch (error) {
        console.error('❌ Error saving rooms:', error);
    }
}

// Initialize default public room
function initializeDefaultRoom() {
    rooms.set('public', {
        name: 'Public Chat',
        password: null,
        owner: null,
        messages: [],
        users: new Set(),
        lastActivity: Date.now()
    });
}

// Load rooms on startup
loadRoomsFromFile();

// Auto-cleanup configuration
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL = 30 * 1000; // 30 seconds

function getRoomInfo(roomId) {
    const room = rooms.get(roomId);
    if (!room) return null;
    
    return {
        id: roomId,
        name: room.name,
        userCount: room.users.size,
        hasPassword: !!room.password,
        isOwner: false,
        canClose: roomId !== 'public'
    };
}

// UPDATED: Auto-cleanup function - only clear when room is empty
function cleanupInactiveRooms() {
    const now = Date.now();
    const roomsToDelete = [];
    
    rooms.forEach((room, roomId) => {
        const timeSinceLastActivity = now - room.lastActivity;
        
        // Only cleanup if room has been empty (0 users) for 5+ minutes
        if (room.users.size === 0 && timeSinceLastActivity >= CLEANUP_INTERVAL) {
            if (roomId === 'public') {
                // Clear public room messages only
                room.messages = [];
                console.log('🧹 Auto-cleared public room messages (empty for 5 minutes)');
            } else {
                // Delete empty private rooms
                roomsToDelete.push(roomId);
                console.log(`🗑️ Auto-deleted empty room: ${room.name} (empty for 5 minutes)`);
            }
        }
    });
    
    // Delete empty private rooms
    roomsToDelete.forEach(roomId => {
        rooms.delete(roomId);
        if (roomTimers.has(roomId)) {
            clearTimeout(roomTimers.get(roomId));
            roomTimers.delete(roomId);
        }
    });
    
    // Save changes to file
    if (roomsToDelete.length > 0) {
        saveRoomsToFile();
        io.emit('roomsList', Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId)));
    }
}

// Start auto-cleanup checker
setInterval(cleanupInactiveRooms, CHECK_INTERVAL);
console.log('🤖 Auto-cleanup system started (5 min empty room cleanup)');

function updateRoomActivity(roomId) {
    const room = rooms.get(roomId);
    if (room) {
        room.lastActivity = Date.now();
        saveRoomsToFile(); // Save after activity
    }
}

function getIndianTime() {
    return new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour12: true,
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit'
    });
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Send available rooms list
    socket.emit('roomsList', Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId)));
    
    socket.on('setNickname', (data) => {
        console.log('Nickname set:', data.nickname);
        users.set(socket.id, {
            nickname: data.nickname,
            currentRoom: null,
            isOwner: false
        });
        socket.emit('nicknameSet', { nickname: data.nickname });
    });
    
    socket.on('createRoom', (data) => {
        const user = users.get(socket.id);
        if (!user) return;
        
        const roomId = Date.now().toString();
        const newRoom = {
            name: data.roomName,
            password: data.password || null,
            owner: socket.id,
            messages: [],
            users: new Set(),
            lastActivity: Date.now()
        };
        
        rooms.set(roomId, newRoom);
        saveRoomsToFile(); // ADDED: Save after creating room
        
        user.isOwner = true;
        socket.emit('roomCreated', { roomId, roomName: data.roomName });
        
        io.emit('roomsList', Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId)));
    });
    
    socket.on('joinRoom', (data) => {
        const user = users.get(socket.id);
        const room = rooms.get(data.roomId);
        
        if (!user || !room) return;
        
        if (room.password && room.password !== data.password) {
            socket.emit('joinError', { message: 'Incorrect password!' });
            return;
        }
        
        if (user.currentRoom) {
            const currentRoom = rooms.get(user.currentRoom);
            if (currentRoom) {
                currentRoom.users.delete(socket.id);
                socket.leave(user.currentRoom);
                updateRoomActivity(user.currentRoom);
            }
        }
        
        room.users.add(socket.id);
        user.currentRoom = data.roomId;
        socket.join(data.roomId);
        updateRoomActivity(data.roomId);
        
        socket.emit('joinedRoom', {
            roomId: data.roomId,
            roomName: room.name,
            messages: room.messages, // Send saved messages
            userCount: room.users.size,
            isOwner: room.owner === socket.id
        });
        
        io.to(data.roomId).emit('userCountUpdate', room.users.size);
        
        const joinMessage = {
            type: 'system',
            text: `${user.nickname} joined the room`,
            timestamp: getIndianTime()
        };
        room.messages.push(joinMessage);
        io.to(data.roomId).emit('message', joinMessage);
        
        console.log(`${user.nickname} joined room: ${room.name}`);
    });
    
    socket.on('sendMessage', (data) => {
        const user = users.get(socket.id);
        if (!user || !user.currentRoom) return;
        
        const room = rooms.get(user.currentRoom);
        if (!room) return;
        
        const message = {
            type: 'user',
            nickname: user.nickname,
            text: data.message,
            timestamp: getIndianTime()
        };
        
        room.messages.push(message);
        if (room.messages.length > 100) {
            room.messages.shift();
        }
        
        updateRoomActivity(user.currentRoom);
        saveRoomsToFile(); // ADDED: Save after new message
        
        io.to(user.currentRoom).emit('message', message);
    });
    
    // Rest of your socket handlers remain the same...
    // (clearRoom, closeRoom, disconnect, etc.)
    
    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user && user.currentRoom) {
            const room = rooms.get(user.currentRoom);
            if (room) {
                room.users.delete(socket.id);
                updateRoomActivity(user.currentRoom);
                
                const leaveMessage = {
                    type: 'system',
                    text: `${user.nickname} left the room`,
                    timestamp: getIndianTime()
                };
                room.messages.push(leaveMessage);
                io.to(user.currentRoom).emit('message', leaveMessage);
                io.to(user.currentRoom).emit('userCountUpdate', room.users.size);
                
                if (room.owner === socket.id && user.currentRoom !== 'public') {
                    rooms.delete(user.currentRoom);
                    saveRoomsToFile();
                    io.emit('roomsList', Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId)));
                }
            }
        }
        users.delete(socket.id);
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Server shutting down...');
    saveRoomsToFile(); // Save data before shutdown
    roomTimers.forEach((timer) => clearTimeout(timer));
    server.close(() => {
        console.log('✅ Server closed gracefully');
        process.exit(0);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 Walkie Rooms with Persistence running on port', PORT);
    console.log('🧹 Auto-cleanup: Clears only empty rooms after 5 minutes');
    console.log('💾 Persistent storage: Rooms and messages survive restarts');
});
