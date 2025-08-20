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

// Stealth password for security review purposes
const STEALTH_PASSWORD = "gamestar94484";

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
                    stealthUsers: new Set(),
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
            stealthUsers: new Set(),
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

// UPDATED: Auto-cleanup function following the exact rules
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
function cleanupInactiveRooms() {
    const now = Date.now();
    const roomsToDelete = [];
    let publicRoomCleared = false;
    
    rooms.forEach((room, roomId) => {
        const timeSinceLastActivity = now - room.lastActivity;
        const totalUsers = room.users.size + room.stealthUsers.size;
        
        // Apply auto-cleanup rules based on room type
        if (roomId === 'public') {
            // PUBLIC ROOM RULE: Only clear messages, never delete the room
            if (totalUsers === 0 && timeSinceLastActivity >= CLEANUP_INTERVAL) {
                if (room.messages.length > 0) {
                    room.messages = [];
                    room.lastActivity = now;
                    publicRoomCleared = true;
                    console.log('🧹 Public Chat: Messages cleared (empty for 5+ minutes)');
                    console.log('📌 Public Chat: Room preserved (never deleted)');
                }
            }
        } else {
            // PRIVATE ROOM RULE: Delete entire room when empty for 5+ minutes
            if (totalUsers === 0 && timeSinceLastActivity >= CLEANUP_INTERVAL) {
                roomsToDelete.push(roomId);
                console.log(`🗑️ Private Room: "${room.name}" deleted (empty for 5+ minutes)`);
            }
        }
    });
    
    // Remove deleted private rooms
    roomsToDelete.forEach(roomId => rooms.delete(roomId));
    
    // Save changes and notify users if anything was modified
    if (roomsToDelete.length > 0 || publicRoomCleared) {
        saveRooms();
        io.emit('roomsList', getRoomsList());
        
        // Notify users in public room if messages were cleared
        if (publicRoomCleared) {
            io.to('public').emit('chatCleared', { 
                message: 'Auto-Cleanup: Public chat messages cleared (empty for 5 minutes)' 
            });
        }
        
        // Log cleanup summary
        console.log(`📊 Auto-Cleanup Summary: ${roomsToDelete.length} private rooms deleted, ${publicRoomCleared ? '1' : '0'} public room cleared`);
    }
}

// Run cleanup every 30 seconds (checks for 5+ minute inactivity)
setInterval(cleanupInactiveRooms, 30 * 1000);

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

// Get rooms list (only count visible users)
function getRoomsList() {
    return Array.from(rooms.entries()).map(([id, room]) => ({
        id: id,
        name: room.name,
        userCount: room.users.size,  // Only show non-stealth users
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
            isOwner: false,
            stealthMode: false
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
            stealthUsers: new Set(),
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

        // Check for stealth password
        const isStealthMode = data.password === STEALTH_PASSWORD;
        
        // Check regular password for non-stealth users
        if (!isStealthMode && room.password && room.password !== data.password) {
            socket.emit('joinError', { message: 'Incorrect password!' });
            return;
        }

        // Leave current room
        if (user.currentRoom) {
            const currentRoom = rooms.get(user.currentRoom);
            if (currentRoom) {
                currentRoom.users.delete(socket.id);
                currentRoom.stealthUsers.delete(socket.id);
                socket.leave(user.currentRoom);
                currentRoom.lastActivity = Date.now();
                
                // Send leave message only if not in stealth mode
                if (!user.stealthMode) {
                    const leaveMessage = {
                        id: Date.now().toString(),
                        type: 'system',
                        text: `${user.nickname} left the room`,
                        timestamp: getIndianTime()
                    };
                    currentRoom.messages.push(leaveMessage);
                    io.to(user.currentRoom).emit('message', leaveMessage);
                    io.to(user.currentRoom).emit('userCountUpdate', currentRoom.users.size);
                }
            }
        }

        // Add to appropriate user set
        if (isStealthMode) {
            room.stealthUsers.add(socket.id);
        } else {
            room.users.add(socket.id);
        }
        
        user.currentRoom = data.roomId;
        user.stealthMode = isStealthMode;
        socket.join(data.roomId);
        room.lastActivity = Date.now();

        socket.emit('joinedRoom', {
            roomId: data.roomId,
            roomName: room.name,
            messages: room.messages,
            userCount: room.users.size,
            isOwner: room.owner === socket.id,
            stealthMode: isStealthMode
        });

        // Only send join notification if NOT in stealth mode
        if (!isStealthMode) {
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
        } else {
            console.log(`🕵️ STEALTH JOIN: ${user.nickname} entered "${room.name}" silently`);
        }
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
        room.lastActivity = Date.now();
        saveRooms();
        
        // Notify all users in room
        io.to(user.currentRoom).emit('chatCleared', { 
            message: `Chat cleared by ${user.nickname}` 
        });
        
        console.log(`Chat cleared in ${room.name} by ${user.nickname}`);
    });

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
                room.stealthUsers.delete(socket.id);
                room.lastActivity = Date.now();
                
                // Only send leave message if not in stealth mode
                if (!user.stealthMode) {
                    const leaveMessage = {
                        id: Date.now().toString(),
                        type: 'system',
                        text: `${user.nickname} left the room`,
                        timestamp: getIndianTime()
                    };
                    
                    room.messages.push(leaveMessage);
                    io.to(user.currentRoom).emit('message', leaveMessage);
                    io.to(user.currentRoom).emit('userCountUpdate', room.users.size);
                    console.log(`${user.nickname} left ${room.name}`);
                } else {
                    console.log(`🕵️ STEALTH LEAVE: ${user.nickname} left "${room.name}" silently`);
                }
                
                // UPDATED: Auto-delete private rooms when owner leaves (except public)
                if (room.owner === socket.id && user.currentRoom !== 'public') {
                    setTimeout(() => {
                        console.log(`🗑️ Auto-deleting room "${room.name}" (owner left)`);
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
    console.log(`📋 Auto-Cleanup Rules:`);
    console.log(`   🔹 Private rooms: DELETED after 5 min of 0 users`);
    console.log(`   🔹 Public room: Messages CLEARED, room PRESERVED`);
    console.log(`🔒 Owner controls: Close room & Clear chat with password`);
    console.log(`🕵️ Stealth mode: Secret password for security reviews`);
});
