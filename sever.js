const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Cấu hình lưu trữ tệp tin tạm thời khi upload từ Web
const upload = multer({ dest: 'uploads/' });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// File lưu trữ danh sách token bot để khi tắt server không bị mất
const BOT_DATA_FILE = path.join(__dirname, 'bots_config.json');
let botTokens = [];
if (fs.existsSync(BOT_DATA_FILE)) {
    try { botTokens = JSON.parse(fs.readFileSync(BOT_DATA_FILE, 'utf8')); } catch(e) { botTokens = []; }
}

// Lưu trữ các thực thể bot đang hoạt động và danh sách chat
let activeClients = {}; 
let activeChats = {}; 

// Hàm khởi tạo và kết nối một tài khoản Bot mới
function startBot(token) {
    if (activeClients[token]) return; // Bot đã chạy rồi thì bỏ qua

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });

    client.once('ready', () => {
        console.log(`🤖 Bot connected: ${client.user.tag}`);
        activeClients[token] = client;
        io.emit('bot_status_update', { token, tag: client.user.tag, status: 'online' });
    });

    client.on('messageCreate', async (message) => {
        if (message.author.bot) return;

        // LỆNH LẤY ID: Khi gõ !id bot sẽ trả về ID cá nhân và ID kênh ngay lập tức
        if (message.content === '!id') {
            await message.reply(`🆔 **Thông tin ID của bạn:**\n- ID Tài khoản của bạn: \`${message.author.id}\`\n- ID Kênh chat này: \`${message.channelId}\``);
            return;
        }

        // Gom thông tin chat đẩy lên web dashboard
        const chatId = `${client.user.id}_${message.channelId}`;
        activeChats[chatId] = {
            id: chatId,
            channelId: message.channelId,
            botToken: token,
            botTag: client.user.tag,
            name: message.channel.name || message.author.username,
            lastMessage: message.content,
            avatar: message.author.displayAvatarURL({ extension: 'png' }),
            unread: true
        };

        io.emit('update_channels', Object.values(activeChats));
        io.emit('discord_message', {
            chatId: chatId,
            author: message.author.username,
            avatar: message.author.displayAvatarURL({ extension: 'png' }),
            content: message.content,
            timestamp: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
        });
    });

    client.login(token).catch(err => {
        console.error(`❌ Không thể login token: ${token.substring(0, 15)}... Lỗi:`, err.message);
        botTokens = botTokens.filter(t => t !== token);
        fs.writeFileSync(BOT_DATA_FILE, JSON.stringify(botTokens));
        io.emit('bot_status_update', { token, status: 'failed' });
    });
}

// Chạy toàn bộ các bot đã lưu từ trước khi khởi động server
botTokens.forEach(token => startBot(token));

// API nhận Token mới từ giao diện Web
app.post('/api/add-bot', (express.json()), (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token không hợp lệ' });
    
    if (!botTokens.includes(token)) {
        botTokens.push(token);
        fs.writeFileSync(BOT_DATA_FILE, JSON.stringify(botTokens));
    }
    startBot(token);
    res.json({ success: true });
});

// API nhận File/Ảnh từ Web gửi sang kênh Discord
app.post('/api/upload', upload.single('file'), async (req, res) => {
    const { chatId, message } = req.body;
    const file = req.file;

    if (!chatId || !activeChats[chatId]) return res.status(400).json({ error: 'Đoạn chat không hợp lệ' });
    const chatInfo = activeChats[chatId];
    const client = activeClients[chatInfo.botToken];

    if (!client) return res.status(500).json({ error: 'Bot điều hành chat này đang ngoại tuyến' });

    try {
        const channel = await client.channels.fetch(chatInfo.channelId);
        if (channel && channel.isTextBased()) {
            const sendOptions = {};
            if (message && message.trim() !== "") sendOptions.content = message;
            if (file) {
                sendOptions.files = [new AttachmentBuilder(file.path, { name: file.originalname })];
            }

            await channel.send(sendOptions);

            // Xóa file tạm sau khi đã gửi lên Discord xong
            if (file) fs.unlinkSync(file.path);

            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Không tìm thấy kênh' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Kết nối Socket Real-time cho giao diện
io.on('connection', (socket) => {
    socket.emit('update_channels', Object.values(activeChats));
    
    // Gửi danh sách các bot đang chạy cho client biết
    const botList = botTokens.map(t => ({ token: t, tag: activeClients[t]?.user?.tag || 'Đang kết nối...', status: activeClients[t] ? 'online' : 'offline' }));
    socket.emit('bot_list', botList);

    // Xử lý gửi tin nhắn chữ thuần túy từ web
    socket.on('web_reply', async (data) => {
        const chatInfo = activeChats[data.chatId];
        if (!chatInfo) return;
        const client = activeClients[chatInfo.botToken];
        if (!client) return;

        try {
            const channel = await client.channels.fetch(chatInfo.channelId);
            if (channel && channel.isTextBased()) {
                await channel.send(data.message);
                chatInfo.lastMessage = data.message;
                chatInfo.unread = false;
                io.emit('update_channels', Object.values(activeChats));
            }
        } catch (error) { console.error(error); }
    });

    socket.on('mark_as_read', (chatId) => {
        if (activeChats[chatId]) {
            activeChats[chatId].unread = false;
            io.emit('update_channels', Object.values(activeChats));
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🌐 Dashboard Đa Bot chạy tại: http://localhost:${PORT}`));

