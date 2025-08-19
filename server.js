const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(__dirname));

// Store rooms and users
const rooms = new Map();
const users = new Map();
const roomTimers = new Map(); // Track inactivity timers

// Default public room
rooms.set('public', {
    name: 'Public Chat',
    password: null,
    owner: null,
    messages: [],
    users: new Set(),
    lastActivity: Date.now()
});

// Auto-cleanup configuration
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
const CHECK_INTERVAL = 30 * 1000; // Check every 30 seconds

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

// Auto-cleanup function
function cleanupInactiveRooms() {
    const now = Date.now();
    const roomsToDelete = [];
    
    rooms.forEach((room, roomId) => {
        const timeSinceLastActivity = now - room.lastActivity;
        
        if (timeSinceLastActivity >= CLEANUP_INTERVAL) {
            if (roomId === 'public') {
                // Clear public room messages if no users
                if (room.users.size === 0 && room.messages.length > 0) {
                    room.messages = [];
                    console.log('🧹 Auto-cleared public room messages (no users for 5 minutes)');
                }
            } else {
                // Delete private rooms if no users
                if (room.users.size === 0) {
                    roomsToDelete.push(roomId);
                    console.log(`🗑️ Auto-deleted empty room: ${room.name} (inactive for 5 minutes)`);
                }
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
    
    // Broadcast updated room list if rooms were deleted
    if (roomsToDelete.length > 0) {
        io.emit('roomsList', Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId)));
    }
}

// Start auto-cleanup checker
setInterval(cleanupInactiveRooms, CHECK_INTERVAL);
console.log('🤖 Auto-cleanup system started (5 min inactivity threshold)');

// Update room activity
function updateRoomActivity(roomId) {
    const room = rooms.get(roomId);
    if (room) {
        room.lastActivity = Date.now();
    }
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Send available rooms list
    socket.emit('roomsList', Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId)));
    
    // Handle user joining with nickname
    socket.on('setNickname', (data) => {
        console.log('Nickname set:', data.nickname);
        users.set(socket.id, {
            nickname: data.nickname,
            currentRoom: null,
            isOwner: false
        });
        socket.emit('nicknameSet', { nickname: data.nickname });
    });
    
    // Handle room creation
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
        socket.emit('roomCreated', { roomId, roomName: data.roomName });
        
        // Broadcast updated room list
        io.emit('roomsList', Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId)));
    });
    
    // Handle joining room
    socket.on('joinRoom', (data) => {
        const user = users.get(socket.id);
        const room = rooms.get(data.roomId);
        
        if (!user || !room) return;
        
        // Check password if required
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
                updateRoomActivity(user.currentRoom);
            }
        }
        
        // Join new room
        room.users.add(socket.id);
        user.currentRoom = data.roomId;
        socket.join(data.roomId);
        updateRoomActivity(data.roomId);
        
        // Send room info and messages
        socket.emit('joinedRoom', {
            roomId: data.roomId,
            roomName: room.name,
            messages: room.messages,
            userCount: room.users.size,
            isOwner: room.owner === socket.id
        });
        
        // Update user count for all users in room
        io.to(data.roomId).emit('userCountUpdate', room.users.size);
        
        // Notify room about new user
        const joinMessage = {
            type: 'system',
            text: `${user.nickname} joined the room`,
            timestamp: new Date().toLocaleTimeString()
        };
        io.to(data.roomId).emit('message', joinMessage);
        
        console.log(`${user.nickname} joined room: ${room.name}`);
    });
    
    // Handle sending message
    socket.on('sendMessage', (data) => {
        const user = users.get(socket.id);
        if (!user || !user.currentRoom) return;
        
        const room = rooms.get(user.currentRoom);
        if (!room) return;
        
        const message = {
            type: 'user',
            nickname: user.nickname,
            text: data.message,
            timestamp: new Date().toLocaleTimeString()
        };
        
        room.messages.push(message);
        if (room.messages.length > 100) {
            room.messages.shift();
        }
        
        // Update room activity when message is sent
        updateRoomActivity(user.currentRoom);
        
        io.to(user.currentRoom).emit('message', message);
    });
    
    // Handle clear room
    socket.on('clearRoom', () => {
        const user = users.get(socket.id);
        if (!user || !user.currentRoom) return;
        
        const room = rooms.get(user.currentRoom);
        if (!room || room.owner !== socket.id) return;
        
        room.messages = [];
        updateRoomActivity(user.currentRoom);
        io.to(user.currentRoom).emit('roomCleared');
        
        const clearMessage = {
            type: 'system',
            text: `Room cleared by ${user.nickname}`,
            timestamp: new Date().toLocaleTimeString()
        };
        io.to(user.currentRoom).emit('message', clearMessage);
    });
    
    // Handle close room from inside chat
    socket.on('closeRoom', () => {
        const user = users.get(socket.id);
        if (!user || !user.currentRoom) return;
        
        const room = rooms.get(user.currentRoom);
        if (!room || room.owner !== socket.id) return;
        
        // Can't close public room
        if (user.currentRoom === 'public') {
            socket.emit('closeError', { message: 'Cannot close public room!' });
            return;
        }
        
        const roomName = room.name;
        const roomId = user.currentRoom;
        
        // Notify all users in room
        const closeMessage = {
            type: 'system',
            text: `Room "${roomName}" has been closed by ${user.nickname}`,
            timestamp: new Date().toLocaleTimeString()
        };
        io.to(roomId).emit('message', closeMessage);
        
        // Disconnect all users from the room
        setTimeout(() => {
            io.to(roomId).emit('roomClosed', { message: `Room "${roomName}" has been closed` });
        }, 2000);
        
        // Remove room
        rooms.delete(roomId);
        if (roomTimers.has(roomId)) {
            clearTimeout(roomTimers.get(roomId));
            roomTimers.delete(roomId);
        }
        
        // Update all users about room list change
        io.emit('roomsList', Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId)));
        
        console.log(`Room ${roomName} closed by ${user.nickname}`);
    });
    
    // Handle close room from rooms list with password verification
    socket.on('closeRoomFromList', (data) => {
        const user = users.get(socket.id);
        if (!user) return;
        
        const room = rooms.get(data.roomId);
        if (!room) return;
        
        // Can't close public room
        if (data.roomId === 'public') {
            socket.emit('closeError', { message: 'Cannot close public room!' });
            return;
        }
        
        // Verify password for private rooms
        if (room.password && room.password !== data.password) {
            socket.emit('closeError', { message: 'Incorrect password!' });
            return;
        }
        
        const roomName = room.name;
        const roomId = data.roomId;
        
        // Notify all users in room if anyone is there
        if (room.users.size > 0) {
            const closeMessage = {
                type: 'system',
                text: `Room "${roomName}" has been closed by ${user.nickname}`,
                timestamp: new Date().toLocaleTimeString()
            };
            io.to(roomId).emit('message', closeMessage);
            
            // Disconnect all users from the room
            setTimeout(() => {
                io.to(roomId).emit('roomClosed', { message: `Room "${roomName}" has been closed` });
            }, 2000);
        }
        
        // Remove room
        rooms.delete(roomId);
        if (roomTimers.has(roomId)) {
            clearTimeout(roomTimers.get(roomId));
            roomTimers.delete(roomId);
        }
        
        // Update all users about room list change
        io.emit('roomsList', Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId)));
        
        // Confirm to user who closed it
        socket.emit('roomClosedSuccess', { message: `Room "${roomName}" has been closed successfully` });
        
        console.log(`Room ${roomName} closed from list by ${user.nickname}`);
    });
    
    // Handle disconnect
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
                    timestamp: new Date().toLocaleTimeString()
                };
                io.to(user.currentRoom).emit('message', leaveMessage);
                io.to(user.currentRoom).emit('userCountUpdate', room.users.size);
                
                // Delete room if owner left and it's not public
                if (room.owner === socket.id && user.currentRoom !== 'public') {
                    rooms.delete(user.currentRoom);
                    io.emit('roomsList', Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId)));
                }
                
                console.log(`${user.nickname} left room: ${room.name}`);
            }
        }
        users.delete(socket.id);
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Server shutting down...');
    // Clear all timers
    roomTimers.forEach((timer) => clearTimeout(timer));
    server.close(() => {
        console.log('✅ Server closed gracefully');
        process.exit(0);
    });
});

server.listen(3000, () => {
    console.log('🚀 Enhanced Chat App with Auto-Cleanup running on http://localhost:3000');
    console.log('🧹 Auto-cleanup: Clears inactive rooms/messages after 5 minutes');
});
