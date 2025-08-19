const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(__dirname));

const DATA_FILE = path.join(__dirname, 'chat_data.json');
let rooms = new Map();
const users = new Map();

// Load rooms from storage
function loadRooms() {
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
            console.log(`📂 Loaded ${data.rooms.length} rooms`);
        }
    } catch (error) {
        console.error('❌ Error loading rooms:', error);
    }

    // Ensure public room exists
    if (!rooms.has('public')) {
        rooms.set('public', {
            name: 'Public Chat',
            password: null,
            owner: null,
            messages: [],
            users: new Set(),
            lastActivity: Date.now()
        });
    }
}

// Save rooms to storage
function saveRooms() {
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
    } catch (error) {
        console.error('❌ Error saving rooms:', error);
    }
}

loadRooms();

// Auto-cleanup empty rooms after 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    const roomsToDelete = [];
    
    rooms.forEach((room, roomId) => {
        if (roomId !== 'public' && room.users.size === 0) {
            const inactive = now - room.lastActivity;
            if (inactive >= CLEANUP_INTERVAL) {
                roomsToDelete.push(roomId);
                console.log(`🗑️ Auto-deleted room: ${room.name}`);
            }
        }
    });
    
    roomsToDelete.forEach(roomId => rooms.delete(roomId));
    if (roomsToDelete.length > 0) {
        saveRooms();
        io.emit('roomsList', getRoomsList());
    }
}, 30 * 1000);

// Get Indian time
function getIndianTime() {
    return new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour12: true,
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit'
    });
}

// Get rooms list
function getRoomsList() {
    return Array.from(rooms.entries()).map(([id, room]) => ({
        id: id,
        name: room.name,
        userCount: room.users.size,
        hasPassword: !!room.password,
        canClose: id !== 'public'
    }));
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    socket.emit('roomsList', getRoomsList());

    socket.on('setNickname', (data) => {
        const nickname = data.nickname.trim();
        if (nickname.length < 2) return;
        
        users.set(socket.id, {
            nickname: nickname,
            currentRoom: null,
            isOwner: false
        });
        
        socket.emit('nicknameSet', { nickname: nickname });
        console.log(`Nickname set: ${nickname}`);
    });

    socket.on('createRoom', (data) => {
        const user = users.get(socket.id);
        if (!user) return;

        const roomId = Date.now().toString();
        rooms.set(roomId, {
            name: data.roomName,
            password: data.password || null,
            owner: socket.id,
            messages: [],
            users: new Set(),
            lastActivity: Date.now()
        });

        user.isOwner = true;
        saveRooms();
        io.emit('roomsList', getRoomsList());
        
        console.log(`Room created: ${data.roomName} by ${user.nickname}`);
    });

    socket.on('joinRoom', (data) => {
        const user = users.get(socket.id);
        const room = rooms.get(data.roomId);
        
        if (!user || !room) return;

        // Check password
        if (room.password && room.password !== data.password) {
            socket.emit('joinError', { message: 'Incorrect password!' });
            return;
        }

        // Leave current room
        if (user.currentRoom) {
            const currentRoom = rooms.get(user.currentRoom);
            if (currentRoom) {
                currentRoom.users.delete(socket.id);
                socket.leave(user.currentRoom);
            }
        }

        // Join new room
        room.users.add(socket.id);
        user.currentRoom = data.roomId;
        socket.join(data.roomId);
        room.lastActivity = Date.now();

        socket.emit('joinedRoom', {
            roomId: data.roomId,
            roomName: room.name,
            messages: room.messages,
            userCount: room.users.size,
            isOwner: room.owner === socket.id
        });

        // Notify others
        const joinMessage = {
            id: Date.now().toString(),
            type: 'system',
            text: `${user.nickname} joined the room`,
            timestamp: getIndianTime()
        };
        
        room.messages.push(joinMessage);
        io.to(data.roomId).emit('message', joinMessage);
        io.to(data.roomId).emit('userCountUpdate', room.users.size);

        console.log(`${user.nickname} joined ${room.name}`);
    });

    socket.on('sendMessage', (data) => {
        const user = users.get(socket.id);
        if (!user || !user.currentRoom) return;

        const room = rooms.get(user.currentRoom);
        if (!room) return;

        const message = {
            id: Date.now().toString(),
            type: 'user',
            nickname: user.nickname,
            text: data.message,
            timestamp: getIndianTime()
        };

        room.messages.push(message);
        if (room.messages.length > 100) {
            room.messages.shift();
        }

        room.lastActivity = Date.now();
        saveRooms();
        
        io.to(user.currentRoom).emit('message', message);
    });

    // NEW: Clear chat (only room owner)
    socket.on('clearChat', (data) => {
        const user = users.get(socket.id);
        if (!user || !user.currentRoom) return;
        
        const room = rooms.get(user.currentRoom);
        if (!room) return;
        
        // Check if user is room owner
        if (room.owner !== socket.id) {
            socket.emit('error', { message: 'Only room creator can clear chat!' });
            return;
        }
        
        // Verify password for private rooms
        if (room.password && room.password !== data.password) {
            socket.emit('error', { message: 'Incorrect password!' });
            return;
        }
        
        // Clear messages
        room.messages = [];
        saveRooms();
        
        // Notify all users in room
        io.to(user.currentRoom).emit('chatCleared', { 
            message: `Chat cleared by ${user.nickname}` 
        });
        
        console.log(`Chat cleared in ${room.name} by ${user.nickname}`);
    });

    // NEW: Close room (only room owner)
    socket.on('closeRoom', (data) => {
        const user = users.get(socket.id);
        if (!user || !user.currentRoom) return;
        
        const room = rooms.get(user.currentRoom);
        if (!room) return;
        
        // Can't close public room
        if (user.currentRoom === 'public') {
            socket.emit('error', { message: 'Cannot close public room!' });
            return;
        }
        
        // Check if user is room owner
        if (room.owner !== socket.id) {
            socket.emit('error', { message: 'Only room creator can close the room!' });
            return;
        }
        
        // Verify password for private rooms
        if (room.password && room.password !== data.password) {
            socket.emit('error', { message: 'Incorrect password!' });
            return;
        }
        
        const roomName = room.name;
        
        // Notify all users in room before closing
        io.to(user.currentRoom).emit('roomClosing', { 
            message: `Room "${roomName}" is being closed by ${user.nickname}` 
        });
        
        // Remove room after a short delay
        setTimeout(() => {
            rooms.delete(user.currentRoom);
            saveRooms();
            io.emit('roomsList', getRoomsList());
            
            // Kick out all users from the room
            io.to(user.currentRoom).emit('roomClosed', { 
                message: `Room "${roomName}" has been closed` 
            });
        }, 2000);
        
        console.log(`Room ${roomName} closed by ${user.nickname}`);
    });

    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user && user.currentRoom) {
            const room = rooms.get(user.currentRoom);
            if (room) {
                room.users.delete(socket.id);
                room.lastActivity = Date.now();
                
                const leaveMessage = {
                    id: Date.now().toString(),
                    type: 'system',
                    text: `${user.nickname} left the room`,
                    timestamp: getIndianTime()
                };
                
                room.messages.push(leaveMessage);
                io.to(user.currentRoom).emit('message', leaveMessage);
                io.to(user.currentRoom).emit('userCountUpdate', room.users.size);
                
                // If owner leaves, delete the room (except public)
                if (room.owner === socket.id && user.currentRoom !== 'public') {
                    setTimeout(() => {
                        rooms.delete(user.currentRoom);
                        saveRooms();
                        io.emit('roomsList', getRoomsList());
                    }, 1000);
                }
            }
        }
        
        users.delete(socket.id);
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Walkie Rooms running on port ${PORT}`);
    console.log(`🇮🇳 Using Indian Standard Time`);
    console.log(`🧹 Auto-cleanup: 5 minutes for empty rooms`);
    console.log(`🔒 Owner controls: Close room & Clear chat with password`);
});
