const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const webpush = require('web-push');
const util = require('util');
const https = require('https');
const { spawn } = require('child_process');

require('dotenv').config();
let ffmpegPath = './ffmpeg' || path.join(__dirname, 'ffmpeg'); 

if (process.platform === 'win32') {
    ffmpegPath = require('ffmpeg-static');
} 


process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR (Server stays alive):', err);
});

function safeLog(type, args) {
    try {
        const time = new Date(Date.now() + 18000000).toISOString();
        const msg = (type === 'ERR' ? '[ERROR] ' : '') + time + ' ' + util.format(...args) + '\n';
        
        // Пишем в консоль (хостинг должен это сохранять в свои логи)
        process.stdout.write(msg);

        // Пытаемся писать в файл, но если не выйдет - не падаем
        try {
            fs.appendFileSync(path.join(__dirname, 'server.log'), msg);
        } catch (e) {
            // Игнорируем ошибку записи в файл
        }
    } catch (criticalError) {
        // Если даже это упало, просто молчим
    }
}

console.log = function(...args) { safeLog('INFO', args); };
console.error = function(...args) { safeLog('ERR', args); };


const publicVapidKey = 'BKqo5382Bum34XP61OtXZZzcUDyYIZblUFOwZDYhlMe2wVTTM74UOHIM_gaBfVmCYpQKrh58dINlVdCfIN5xdcE';

const privateVapidKey = process.env.pvk;
webpush.setVapidDetails('mailto:admin@ecodom.asia', publicVapidKey, privateVapidKey);


const PORT = 8767;


const app = express();
const userStates = new Map(); // Для хранения состояний ввода (например, ввод нового пароля)

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));



const activeHlsProcesses = {};


const streamsPath = path.join(__dirname, 'streams');

if (!fs.existsSync(streamsPath)) {
    try { fs.mkdirSync(streamsPath, { recursive: true }); } catch (e) {}
}

app.use('/streams', (req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.use('/streams', express.static(streamsPath));



app.post('/api/hls/start', async (req, res) => {
    const { id } = req.body;
    
    // Путь к ffmpeg (используем тот, что определили в начале файла)
    // Если переменная не определена глобально, раскомментируйте строку ниже:
    // const ffmpegBinary = process.platform === 'win32' ? require('ffmpeg-static') : path.join(__dirname, 'ffmpeg');
    const ffmpegBinary = ffmpegPath; // Берем из глобальной переменной

    if (!fs.existsSync(ffmpegBinary)) {
        return res.status(500).json({ error: 'FFmpeg binary missing' });
    }

    const cams = await readCSV('ip_cameras');
    const cam = cams.find(c => c.id === id);
    if (!cam) return res.status(404).json({ error: 'Cam not found' });

    // Папка для конкретной камеры
    const camDir = path.join(streamsPath, id);
    
    // Чистим и создаем папку заново
    try {
        if (fs.existsSync(camDir)) fs.rmSync(camDir, { recursive: true, force: true });
        fs.mkdirSync(camDir, { recursive: true });
        fs.chmodSync(camDir, 0o777); // Даем права на запись
    } catch (e) {
        console.error('Ошибка папки:', e.message);
    }
    
    const playlistFile = path.join(camDir, 'index.m3u8');

    // Убиваем старый процесс
    if (activeHlsProcesses[id]) {
        try { activeHlsProcesses[id].kill(); } catch(e){}
    }

    console.log(`🎬 HLS START: ${cam.name}`);

    // Формируем аргументы
    let inputArgs = [];
    
    // Флаг rtsp_transport нужен ТОЛЬКО для rtsp ссылок
    if (cam.rtsp_full.trim().startsWith('rtsp://')) {
        inputArgs.push('-rtsp_transport', 'tcp');
    }

    const args = [
        '-y',
        '-fflags', 'nobuffer',
        ...inputArgs,
        '-i', cam.rtsp_full,
        '-c:v', 'copy', // Копируем видео как есть (быстро)
        '-c:a', 'aac',  // Звук кодируем в AAC
        '-f', 'hls',
        '-hls_time', '2',      // Куски по 2 секунды
        '-hls_list_size', '5', // Хранить 5 кусков
        '-hls_flags', 'delete_segments',
        playlistFile
    ];

    try {
        const proc = spawn(ffmpegBinary, args);
        activeHlsProcesses[id] = proc;

        proc.stderr.on('data', (data) => {
            const msg = data.toString();
            // Показываем только фатальные ошибки
            if (msg.includes('Error') || msg.includes('refused') || msg.includes('404')) {
                console.error(`[FFmpeg ${id}]: ${msg}`);
            }
        });

        proc.on('close', (code) => {
            console.log(`🛑 Стрим ${id} остановлен. Код: ${code}`);
            delete activeHlsProcesses[id];
        });

    } catch (e) {
        console.error('Spawn Error:', e);
        return res.status(500).json({ error: 'Spawn failed' });
    }

    // Возвращаем ссылку
    res.json({ success: true, url: `/streams/${id}/index.m3u8` });
});


app.post('/api/hls/stop', (req, res) => {
    const { id } = req.body;
    const proc = activeHlsProcesses[id];
    if (proc) {
        proc.kill();
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});


app.get('/api/fix-video', (req, res) => {
    const inputPath = path.join(__dirname, 'offline.mp4');
    const outputPath = path.join(__dirname, 'offline_fixed.mp4');

    if (!fs.existsSync(inputPath)) return res.status(404).send('Исходный файл offline.mp4 не найден');
    if (!ffmpegPath) return res.status(500).send('FFmpeg не настроен');

    console.log('🔄 Начинаем перекодирование видео...');

    // Аргументы: вход -> видео H.264 -> аудио AAC -> оптимизация для веба -> выход
    const args = [
        '-y',
        '-i', inputPath,
        '-c:v', 'libx264',      // Самый стандартный видео кодек
        '-preset', 'fast',      // Быстрое кодирование
        '-c:a', 'aac',          // Самый стандартный аудио кодек
        '-movflags', '+faststart', // ВАЖНО: Позволяет видео играть сразу, не скачиваясь целиком
        outputPath
    ];

    const proc = spawn(ffmpegPath, args);

    proc.stderr.on('data', (d) => console.log(`[Convert]: ${d}`)); // Логи процесса

    proc.on('close', (code) => {
        if (code === 0) {
            console.log('✅ Конвертация успешна! Создан offline_fixed.mp4');
            try { fs.chmodSync(outputPath, 0o644); } catch(e) {} 

            res.send('<h1>Успех!</h1><p>Видео перекодировано. Теперь обновите страницу с плеером.</p>');
        } else {
            console.error('Ошибка конвертации, код:', code);
            res.status(500).send('Ошибка конвертации. Смотрите логи.');
        }
    });
});


app.get('/api/video/offline', (req, res) => {
    // 1. Определяем, какой файл отдавать
    const fixedPath = path.join(__dirname, 'offline_fixed.mp4');
    const originalPath = path.join(__dirname, 'offline.mp4');
    
    // Выбираем существующий файл (приоритет у исправленного)
    const fileToSend = fs.existsSync(fixedPath) ? fixedPath : 
                       (fs.existsSync(originalPath) ? originalPath : null);

    if (!fileToSend) {
        console.error('❌ Оффлайн видео не найдено на сервере');
        return res.status(404).send('Video file not found');
    }

    // 2. Отдаем файл средствами Express (он сам сделает Range и Headers)
    res.sendFile(fileToSend, {
        headers: {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes'
        }
    }, (err) => {
        if (err) {
            // Если клиент прервал загрузку (закрыл видео) - это не ошибка сервера
            if (err.code !== 'ECONNABORTED' && err.syscall !== 'write') {
                console.error('Ошибка отправки видео:', err);
            }
        }
    });
});



// 2. Обновленный маршрут раздачи (отдает ИСПРАВЛЕННЫЙ файл)
app.get('/offline.mp4', (req, res) => {
    // Сначала ищем исправленную версию
    let videoPath = path.join(__dirname, 'offline_fixed.mp4');
    
    // Если её нет, берем оригинал
    if (!fs.existsSync(videoPath)) {
        videoPath = path.join(__dirname, 'offline.mp4');
    }

    if (!fs.existsSync(videoPath)) return res.status(404).send('File not found');

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const head = { 'Content-Type': 'video/mp4' };

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoPath, { start, end });
        
        res.writeHead(206, { 
            ...head,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize
        });
        file.pipe(res);
    } else {
        res.writeHead(200, { ...head, 'Content-Length': fileSize });
        fs.createReadStream(videoPath).pipe(res);
    }
});



var admin = require("firebase-admin");
var serviceAccount = require("./ecodom-asia-firebase-adminsdk-fbsvc-df3cbf6d46.json");


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


// 1. Маршрут для сохранения токена от Android приложения
app.post('/api/fcm/subscribe', async (req, res) => {
    try {
        

        const { rpi_id, fcm_token } = req.body;
        
        if (!rpi_id || !fcm_token) {
            return res.status(400).json({ error: "Missing rpi_id or fcm_token" });
        }

        // Читаем текущие токены
        const allTokens = await readCSV('fcm_tokens');
        
        // Проверяем, есть ли уже такой токен для этого rpi_id
        const exists = allTokens.find(t => t.rpi_id === rpi_id && t.token === fcm_token);

        if (!exists) {
            await writeCSV('fcm_tokens', {
                rpi_id: rpi_id,
                token: fcm_token,
                updated_at: new Date(Date.now()+18000000).toISOString()
            });
            console.log(`✅ FCM Token сохранен для ${rpi_id}`);
        } else {
            // (Опционально) Можно обновить updated_at, если нужно чистить старые
            console.log(`ℹ️ FCM Token уже существует для ${rpi_id}`);
        }
        
        res.json({ success: true });
    } catch (e) {
        console.error('FCM Subscribe Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// 2. Функция массовой отправки уведомлений
async function sendFcmNotification(rpi_id, title, body) {
    try {
        const allTokens = await readCSV('fcm_tokens');
        // Находим все токены, привязанные к этому RPi
        const userTokens = allTokens.filter(t => t.rpi_id === rpi_id);

        if (userTokens.length === 0) return;

        console.log(`📤 Отправка FCM пуша для ${rpi_id} на ${userTokens.length} устройств`);
        for (const record of userTokens) {
            const message = {
                notification: {
                    title: title,
                    body: body
                },
                token: record.token
            };

            admin.messaging().send(message)
                .then((response) => {
                })
                .catch((error) => {
                    console.error('Ошибка отправки на токен:', record.token, error.code);
                    if (error.code === 'messaging/registration-token-not-registered') {
                        console.log('Токен невалиден, нужно удалить из базы');
                    }
                });
        }
    } catch (e) {
        console.error('FCM Send Error:', e);
    }
}

app.delete('/api/fcm/subscribe', async (req, res) => {
    try {
        const { rpi_id, fcm_token } = req.body;
        
        const tokens = await readCSV('fcm_tokens');
        // Оставляем только те токены, которые НЕ совпадают с удаляемым
        const newTokens = tokens.filter(t => !(t.rpi_id === rpi_id && t.token === fcm_token));
        
        if (tokens.length !== newTokens.length) {
            // Перезаписываем файл
            const headers = Object.keys(tokens[0] || { rpi_id: '', token: '', updated_at: '' });
            const csv = [headers.join(','), ...newTokens.map(r => headers.map(h => r[h]||'').join(','))].join('\n');
            await fsp.writeFile(CSV_FILES.fcm_tokens, csv + '\n');
        }
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});



const CSV_FILES = {
    users: 'users.csv',
    devices: 'devices.csv',
    tg: 'tg.csv',
    sensor_data: 'sensor_data.csv',
    rpi: 'rpi.csv',
    subs: 'subs.csv',
    ip_cameras: 'ip_cameras.csv',
    fcm_tokens: 'fcm_tokens.csv'
};


async function readCSV(fileType) {
    const filename = CSV_FILES[fileType];
    try {
        await fsp.access(filename);
        const content = await fsp.readFile(filename, 'utf8');
        const lines = content.trim().split('\n'); 
        if (lines.length <= 1) return [];
        const headers = lines[0].split(',').map(h => h.trim());
        return lines.slice(1).filter(line => line.trim()).map(line => {
            const values = line.split(',');
            const obj = {};
            headers.forEach((header, index) => obj[header] = values[index] ? values[index].trim() : '');
            return obj;
        });
    } catch (error) { return []; }
}

async function writeCSV(fileType, data) {
    const filename = CSV_FILES[fileType];
    try {
        const allData = await readCSV(fileType);
        allData.push(data);
        const headers = allData.length > 0 ? Object.keys(allData[0]) : Object.keys(data);
        const csvContent = [headers.join(','), ...allData.map(row => headers.map(header => row[header] || '').join(','))].join('\n');
        await fsp.writeFile(filename, csvContent + '\n');
        return true;
    } catch (error) { return false; }
}

async function updateCSV(fileType, predicate, updates) {
    const filename = CSV_FILES[fileType];
    try {
        const allData = await readCSV(fileType);
        let updated = false;
        const newData = allData.map(row => {
            if (predicate(row)) {
                updated = true;
                return { ...row, ...updates };
            }
            return row;
        });
        
        if (updated) {
            const headers = Object.keys(newData[0]);
            const csv = [headers.join(',')];
            newData.forEach(row => csv.push(headers.map(header => row[header] || '').join(',')));
            await fsp.writeFile(filename, csv.join('\n') + '\n');
            return true;
        }
        return false;
    } catch (e) { return false; }
}

async function initCsvFile() {
    const createFile = async (key, headers) => {
        try { await fsp.access(CSV_FILES[key]); } catch {
            const w = createCsvWriter({ path: CSV_FILES[key], header: headers });
            await w.writeRecords([]);
            console.log(`✅ Created ${CSV_FILES[key]}`);
        }
    };

    await createFile('users', [
        { id: 'rpi_id', title: 'rpi_id' }, { id: 'password', title: 'password' },
        { id: 'last_seen', title: 'last_seen' }, { id: 'global_ip', title: 'global_ip' },
        { id: 'co2_alert', title: 'co2_alert' }, { id: 'pir_alert', title: 'pir_alert' },
        { id: 'power_alert', title: 'power_alert' }, { id: 'away_mode', title: 'away_mode' }
    ]);

    await createFile('devices', [
        { id: 'rpi_id', title: 'rpi_id' }, { id: 'token', title: 'token' },
        { id: 'os', title: 'os' }, { id: 'last_ip', title: 'last_ip' },
        { id: 'last_seen', title: 'last_seen' }, { id: 'seconds', title: 'seconds' },
        { id: 'has_flash', title: 'has_flash' }, { id: 'video_count', title: 'video_count' },
        { id: 'battery_level', title: 'battery_level' }, { id: 'is_charging', title: 'is_charging' },
        { id: 'pending_command', title: 'pending_command' }, { id: 'pending_value', title: 'pending_value' }
    ]);

    await createFile('sensor_data', 
        ['rpi_id', 'temp', 'humidity', 'co_ppm', 'solar_voltage', 'wind_voltage', 'battery_level', 'motion', 'timestamp'].map(id => ({id, title: id}))
    );

    await createFile('rpi', [
        { id: 'rpi_id', title: 'rpi_id' }, { id: 'wifi_ssid', title: 'wifi_ssid' }, { id: 'wifi_password', title: 'wifi_password' }
    ]);

    await createFile('tg', [
        { id: 'rpi_id', title: 'rpi_id' }, { id: 'username', title: 'username' },
        { id: 'chat_id', title: 'chat_id' }, { id: 'last_seen', title: 'last_seen' },
        { id: 'lang', title: 'lang' }
    ]);
    
    await createFile('ip_cameras', [
        { id: 'id', title: 'id' },
        { id: 'rpi_id', title: 'rpi_id' }, // Привязка к пользователю
        { id: 'name', title: 'name' },
        { id: 'rtsp_full', title: 'rtsp_full' } // Итоговая ссылка
    ]);

    await createFile('fcm_tokens', [
        { id: 'rpi_id', title: 'rpi_id' },
        { id: 'token', title: 'token' },
        { id: 'updated_at', title: 'updated_at' }
    ]);

    
    try { await fsp.access(CSV_FILES.subs); } catch {
        // Храним endpoint и ключи отдельно
        const w = createCsvWriter({ path: CSV_FILES.subs, header: [
            {id: 'rpi_id', title: 'rpi_id'},
            {id: 'endpoint', title: 'endpoint'},
            {id: 'p256dh', title: 'p256dh'},
            {id: 'auth', title: 'auth'}
        ]});
        await w.writeRecords([]);
    }

}



// Получить список камер пользователя
app.get('/api/ip-cameras', async (req, res) => {
    const { rpi_id } = req.query;
    if (!rpi_id) return res.status(400).json({ error: 'Missing rpi_id' });
    
    const cams = await readCSV('ip_cameras');
    const userCams = cams.filter(c => c.rpi_id === rpi_id);
    res.json(userCams);
});

// Добавить камеру
app.post('/api/ip-cameras', async (req, res) => {
    try {
        const { rpi_id, name, rtsp_full } = req.body;
        
        if (!rpi_id || !name || !rtsp_full) {
            return res.status(400).json({ error: 'Missing fields' });
        }

        await writeCSV('ip_cameras', {
            id: uuidv4(),
            name,
            rpi_id,
            rtsp_full: rtsp_full,
        });
        
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Удалить камеру
app.delete('/api/ip-cameras/:id', async (req, res) => {
    const { id } = req.params;
    const cams = await readCSV('ip_cameras');
    const newCams = cams.filter(c => c.id !== id);
    
    if (cams.length !== newCams.length) {
        // Перезапись файла (упрощенно)
        const headers = Object.keys(cams[0]);
        const csv = [headers.join(','), ...newCams.map(r => headers.map(h => r[h]||'').join(','))].join('\n');
        await fsp.writeFile(CSV_FILES.ip_cameras, csv + '\n');
    }
    res.json({ success: true });
});

// Записать видео с камеры на сервер
app.post('/api/ip-camera/record', async (req, res) => {
    const { id, seconds } = req.body;
    
    if (!ffmpegPath) return res.status(500).json({ error: 'FFmpeg not configured' });
    
    const cams = await readCSV('ip_cameras');
    const cam = cams.find(c => c.id === id);
    if (!cam) return res.status(404).json({ error: 'Камера не найдена' });

    // 2. Папка и Файл
    const folder = path.join(__dirname, 'users_videos', id);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

    const filename = `${id}_${new Date(Date.now() + 18000000).toISOString().replace(/[:.]/g, '-')}.mp4`;
    const filepath = path.join(folder, filename);
    const duration = String(seconds || 10); // По умолчанию 10 сек

    console.log(`🎥 Запуск записи RTSP: ${cam.name} на ${duration} сек`);

    // 3. Запуск FFmpeg
    // Добавляем -v error чтобы видеть если что-то не так в логах
    const recorder = spawn(ffmpegPath, [
        '-y', 
        '-i', cam.rtsp_full,
        '-t', duration,
        '-c', 'copy', // Копирование потока (очень быстро)
        '-v', 'error', // Логировать только ошибки
        filepath
    ]);

    // Читаем ошибки, если запись не идет
    recorder.stderr.on('data', (data) => {
        console.error(`[FFmpeg Rec Error] ${data.toString()}`);
    });

    recorder.on('close', (code, signal) => {
        console.log(`✅ Запись завершена для ${cam.name}. Код: ${code}, Сигнал: ${signal}`);
    });


    res.json({ success: true, message: 'Recording started' });
});

const alertCooldowns = new Map();
function canSendAlert(rpi_id, type) {
    const key = `${rpi_id}_${type}`;
    const lastTime = alertCooldowns.get(key) || 0;
    const now = Date.now();
    // Разрешаем отправку раз в 60 секунд
    if (now - lastTime > 60000) {
        alertCooldowns.set(key, now);
        return true;
    }
    return false;
}


app.get('/api/generate-vapid', (req, res) => {
    const webpush = require('web-push');
    const keys = webpush.generateVAPIDKeys();
    res.json(keys);
});


app.get('/api/push/key', (req, res) => res.json({ publicKey: publicVapidKey  }));


app.post('/api/subscribe', async (req, res) => {
    try {
        const { rpi_id, subscription } = req.body;
        
        console.log('--- ПОПЫТКА ПОДПИСКИ ---');
        console.log('RPI ID:', rpi_id);
        
        if (!rpi_id) {
            console.error('Ошибка: Нет rpi_id');
            return res.status(400).json({ error: "Missing rpi_id" });
        }
        
        if (!subscription || !subscription.endpoint) {
            console.error('Ошибка: Невалидная подписка', subscription);
            return res.status(400).json({ error: "Invalid subscription" });
        }

        // Пытаемся записать
        const success = await writeCSV('subs', {
            rpi_id: rpi_id,
            endpoint: subscription.endpoint,
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth
        });

        if (success) {
            console.log('✅ Подписка успешно сохранена в subs.csv');
            res.json({ success: true });
        } else {
            console.error('❌ Ошибка функции writeCSV');
            res.status(500).json({ error: "Failed to write to file" });
        }
    } catch (e) {
        console.error('Критическая ошибка подписки:', e);
        res.status(500).json({ error: e.message });
    }
});

// Функция отправки уведомления пользователю
async function sendPushNotification(rpi_id, title, body) {
    const subs = await readCSV('subs');
    const userSubs = subs.filter(s => s.rpi_id === rpi_id);
    
    for (const sub of userSubs) {
        const pushConfig = {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth }
        };
        try {
            await webpush.sendNotification(pushConfig, JSON.stringify({ title, body }));
        } catch (e) {
            console.error('Push error, deleting sub:', e.statusCode);
            // Если подписка мертва (410), по-хорошему надо удалять из CSV, но пока пропустим
        }
    }
}







// 1. Авторизация
app.post('/api/login', async (req, res) => {
    try {
        const { rpi_id, password } = req.body;
        const users = await readCSV('users');
        const user = users.find(u => u.rpi_id === rpi_id);

        if (!user) return res.status(404).json({ error: "Device not registered" });
        if (user.password === password) {
            const token = crypto.randomBytes(32).toString('hex');
            const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            await updateCSV('users', u => u.rpi_id === rpi_id, { 
                global_ip: ip,
                last_seen: new Date(Date.now() + 18000000).toISOString()
            });
            console.log('вход успешен для', req.body.rpi_id, 'с IP', req.connection.remoteAddress || ip || req.headers['x-forwarded-for']|| req.headers['x-real-ip']);
            return res.json({ status: "success", token, rpi_id });
        }
        // console.log('вход неудачен для', rpi_id);
        console.log('вход неудачен для', req.body.rpi_id, 'с IP', req.connection.remoteAddress || ip || req.headers['x-forwarded-for']|| req.headers['x-real-ip']);
        res.status(401).json({ error: "Invalid credentials" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Регистрация/Heartbeat устройства + Command Queue
app.post('/devices', async (req, res) => {
    try {
        if (!req.body.deviceToken) return res.status(400).json({ error: 'Missing deviceToken' });
        if (!req.body.rpi_id) return res.status(400).json({ error: 'Missing rpiId' });
        // console.log(`Heartbeat from device ${req.body.deviceToken} (RPI: ${req.body.rpi_id})`);
        const devices = await readCSV('devices');
        const existingDevice = devices.find(u => u.token === req.body.deviceToken);
        
        const updateData = {
            last_seen: new Date(Date.now() + 18000000).toISOString(),
            last_ip: req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
            os: req.body.os || 'Unknown',
            battery_level: req.body.battery_level,
            is_charging: req.body.is_charging,
            has_flash: req.body.has_flash            
            // video_count: req.body.video_count ? String(req.body.video_count) : '0'
        };

        let responseCommand = null;
        
        
        if (existingDevice) {
            if (existingDevice.pending_command && existingDevice.pending_command !== '') {
                responseCommand = {
                    command: existingDevice.pending_command,
                    value: existingDevice.pending_value
                };
                updateData.pending_command = '';
                updateData.pending_value = '';
            }
            await updateCSV('devices', d => d.token === req.body.deviceToken, updateData);
            res.json({ ...existingDevice, ...updateData, server_command: responseCommand });
        } else {
            const newDevice = {
                rpi_id: req.body.rpi_id || 'unknown',
                token: req.body.deviceToken,
                ...updateData,
                seconds: '10',
                has_flash: req.body.has_flash || 'false',
                video_count: '0',
                pending_command: '',
                pending_value: ''
            };
            await writeCSV('devices', newDevice);
            res.json(newDevice);
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Отправка команды (из веба)
app.post('/api/device/command', async (req, res) => {
    try {
        const { device_id, command, value } = req.body;
        const success = await updateCSV('devices', d => d.token === device_id, {
            pending_command: command,
            pending_value: String(value)
        });
        if (success) res.json({ success: true });
        else res.status(404).json({ error: "Device not found" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Сенсоры + Away Mode
app.post('/api/sensor_data', async (req, res) => {
    try {
        const rpi_id = req.body.rpi_id || req.query.rpi_id;
        if (!rpi_id) return res.status(400).json({ error: 'Missing rpi_id' });
        
        const sensorRecord = {
            id: uuidv4(),
            rpi_id: rpi_id,
            temp: parseFloat(req.body.temp) || 0,
            humidity: parseFloat(req.body.humidity) || 0,
            co_ppm: parseFloat(req.body.co_ppm) || 0,
            solar_voltage: parseFloat(req.body.solar_voltage || 0),
            wind_voltage: parseFloat(req.body.wind_voltage || 0),
            battery_level: parseFloat(req.body.battery_level || 0),
            motion: req.body.motion === 'true' || req.body.motion === true ? 'true' : 'false',
            timestamp: new Date(Date.now() + 18000000).toISOString()
        };
        await writeCSV('sensor_data', sensorRecord);

        // Away Mode Logic
        const users = await readCSV('users');
        const user = users.find(u => u.rpi_id === rpi_id);
        if (user) {
            // 1. AWAY MODE + MOTION
            if (user.away_mode === 'true') {
                // Если есть движение
                if (sensorRecord.motion === 'true') {
                    if (canSendAlert(rpi_id, 'away_motion')) {
                        await sendPushNotification(rpi_id, '🚨 ТРЕВОГА!', 'Обнаружено движение в режиме "Уход"!');
                    }
                    let title = '🚨 ТРЕВОГА!';
                    let msg = 'Обнаружено движение в режиме "Уход".';
                    // (Ваш старый код записи камер)
                    const devices = await readCSV('devices');
                    // ... логика записи камер ...
                    const now = new Date(Date.now() + 18000000);
                    const onlineDevices = devices.filter(d => { 
                    if (d.rpi_id !== rpi_id) return false;
                    const diffSec = (now - new Date(d.last_seen)) / 1000;
                    return diffSec < 30; });

                    if (onlineDevices.length > 0) {
                        for (const dev of onlineDevices) {
                            await updateCSV('devices', d => d.token === dev.token, {
                                pending_command: 'record',
                                pending_value: dev.seconds || '10'
                            });
                        }
                    }
                    const ipCams = await readCSV('ip_cameras');
                    // Фильтруем камеры пользователя
                    const myIpCams = ipCams.filter(c => c.rpi_id === rpi_id);
                    
                    myIpCams.forEach(cam => {
                        console.log(`Авто-запись RTSP: ${cam.name}`);
                        // Генерируем имя файла
                        const folder = path.join(__dirname, 'users_videos', cam.id);
                        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
                        const filename = `${cam.id}_AUTO_${Date.now()}.mp4`;
                        const filepath = path.join(folder, filename);
                        
                        // Запускаем запись на 15 секунд
                        spawn(ffmpegPath, ['-y', '-i', cam.rtsp_full, '-t', '15', '-c', 'copy', filepath]);
                    });
                    sendFcmNotification(rpi_id, title, msg);

                }
            } else {
                // Если режим дома, но включен PIR ALERT
                if (user.pir_alert === 'true' && sensorRecord.motion === 'true') {
                    if (canSendAlert(rpi_id, 'pir')) {
                        await sendPushNotification(rpi_id, 'Motion Detected', 'Замечено движение.');
                    }
                    const title = '👀 Движение обнаружено';
                    const msg = 'Замечено движение.';
                    sendFcmNotification(rpi_id, title, msg);

                }
            }

            // 2. CO2 Alert
            if (user.co2_alert === 'true' && sensorRecord.co_ppm > 1000) {
                if (canSendAlert(rpi_id, 'co2')) {
                    await sendPushNotification(rpi_id, 'High CO2 Warning', `Уровень CO2 высок: ${sensorRecord.co_ppm} ppm`);
                }
                const title = '⚠️ Высокий CO2';
                const msg = `Уровень газа критический: ${sensorRecord.co_ppm} ppm`;
                sendFcmNotification(rpi_id, title, msg);

            }

            // 3. Power Alert (например, низкий заряд батареи станции)
            if (user.power_alert === 'true' && sensorRecord.battery_level < 20) {
                if (canSendAlert(rpi_id, 'power')) {
                    await sendPushNotification(rpi_id, 'Low Battery', `Заряд станции критический: ${sensorRecord.battery_level}%`);
                }
                const title = '🔋 Батарея разряжена';
                const msg = `Заряд критически низкий: ${sensorRecord.battery_level}`;
                sendFcmNotification(rpi_id, title, msg);
            }
        }
        // console.log(`Sensor data received from RPI: ${rpi_id}`);
        res.json({ status: "success" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// WiFi (API for web)
app.get('/api/wifi', async (req, res) => {
    const { rpi_id } = req.query;
    const data = await readCSV('rpi');
    const config = data.find(r => r.rpi_id === rpi_id);
    res.json(config || {});
});


app.post('/api/wifi', async (req, res) => {
    const { rpi_id, wifi_ssid } = req.body;
    let { wifi_password } = req.body;
    // Формируем объект обновления (обновляем только то, что пришло, или всё сразу)
    const updateData = { rpi_id };
    if (wifi_ssid !== undefined) updateData.wifi_ssid = wifi_ssid;
    if (wifi_password !== undefined) updateData.wifi_password = wifi_password;

    const success = await updateCSV('rpi', r => r.rpi_id === rpi_id, updateData);
    
    if (!success) {
        // Если записи нет, создаем новую со всеми полями
        await writeCSV('rpi', { 
            rpi_id, 
            wifi_ssid: wifi_ssid || '', 
            wifi_password: wifi_password || ''
        });
    }
    res.json({ success: true });
});

// Настройки пользователя (для веба)
app.get('/api/user/settings', async (req, res) => {
    const { rpi_id } = req.query;
    const users = await readCSV('users');
    const user = users.find(u => u.rpi_id === rpi_id);
    if(user) res.json({ 
        away_mode: user.away_mode==='true', co2_alert: user.co2_alert==='true', 
        pir_alert: user.pir_alert==='true', power_alert: user.power_alert==='true' 
    });
    else res.status(404).json({});
});

app.post('/api/user/settings', async (req, res) => {
    const { rpi_id, setting, value } = req.body;
    await updateCSV('users', u => u.rpi_id === rpi_id, { [setting]: String(value) });
    res.json({ success: true });
});

// Список устройств
app.get('/api/devices', async (req, res) => {
    const { rpi_id } = req.query;
    const devices = await readCSV('devices');
    const userDevices = devices.filter(d => d.rpi_id === rpi_id);
    // const now = new Date();
    const now = new Date(Date.now() + 18000000); 
    
    const processed = userDevices.map(d => {
        // Теперь сравниваем два сдвинутых времени
        const lastSeenDate = new Date(d.last_seen);
        const diff = (now - lastSeenDate) / 1000; // Разница в секундах
        // Добавляем проверку Math.abs на случай рассинхрона, 
        // но главное - проверка diff < 5 секунд (чуть увеличил для надежности)
        const isOnline = diff >= 0 && diff <= 5; 
           return {
            ...d,
            is_online: isOnline,
            last_seen_seconds: Math.floor(diff)
        };
    });
    
    
    
    res.json({ devices: processed, stats: { total: processed.length, online: processed.filter(d=>d.is_online).length, offline: processed.filter(d=>!d.is_online).length } });
});

// Удаление устройства
app.delete('/api/devices/:token', async (req, res) => {
    const devices = await readCSV('devices');
    const newDevices = devices.filter(d => d.token !== req.params.token);
    const headers = Object.keys(devices[0] || {});
    if(headers.length > 0) {
        const csv = [headers.join(','), ...newDevices.map(r => headers.map(h => r[h]||'').join(','))].join('\n');
        await fsp.writeFile(CSV_FILES.devices, csv + '\n');
    }
    const folder = path.join(__dirname, 'users_videos', req.params.token);
    try { await fsp.rm(folder, { recursive: true }); } catch {}
    res.json({ success: true });
});

// Latest Sensors
app.get('/api/latest_sensor_data', async (req, res) => {
    const data = await readCSV('sensor_data');
    const latest = data.filter(d => d.rpi_id === req.query.rpi_id).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp))[0];
    res.json(latest || {});
});

// History
app.get('/api/history', async (req, res) => {
    const { rpi_id, sensor, days } = req.query;
    const data = await readCSV('sensor_data');
    const th = new Date(Date.now() - days*86400000);
    const flt = data.filter(d => d.rpi_id === rpi_id && new Date(d.timestamp) >= th).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
    res.json({ labels: flt.map(d=>new Date(d.timestamp).toLocaleString('ru-RU')), values: flt.map(d=>parseFloat(d[sensor])||0) });
});

// Upload Video
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'users_videos', req.headers['devicetoken']);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ts = new Date(Date.now() + 18000000).toISOString().replace(/[:.]/g, '-');
        cb(null, `${req.headers['devicetoken']}_${ts}.webm`);
    }
});

const upload = multer({ storage, limits: { fileSize: 100*1024*1024 } });

app.post('/upload', upload.single('video'), async (req, res) => {
    const token = req.headers['devicetoken'];
    const devices = await readCSV('devices');
    const dev = devices.find(d => d.token === token);
    if(dev) {
        dev.video_count = String(Number(dev.video_count||0)+1);
        await updateCSV('devices', d => d.token === token, { video_count: dev.video_count });
        console.log(`Видео получено от устройства ${token}, общее количество видео: ${dev.video_count}`);
        res.json({ success: true });
    } else res.status(404).json({});
});

// Serve Videos
app.use('/users_videos', express.static(path.join(__dirname, 'users_videos')));

app.get('/api/device/videos/:token', async (req, res) => {
    const folder = path.join(__dirname, 'users_videos', req.params.token);
    try {
        const files = await fsp.readdir(folder);
        const videos = await Promise.all(files.filter(f => f.endsWith('.webm') || f.endsWith('mp4')).map(async f => {
            const s = await fsp.stat(path.join(folder, f));
            return { name: f, date: s.mtime, size: s.size };
        }));
        res.json(videos.sort((a,b)=>new Date(b.date)-new Date(a.date)));
    } catch { res.json([]); }
});
app.get('/api/video/:token/:file', (req, res) => {
    const p = path.join(__dirname, 'users_videos', req.params.token, req.params.file);
    if(req.query.download) res.download(p);
    else res.sendFile(p);
});

app.post('/api/change_password', async (req, res) => {
    try {
        const { rpi_id, old_password, new_password } = req.body;
        const users = await readCSV('users');
        const user = users.find(u => u.rpi_id === rpi_id);
        if (!user || user.password !== old_password) return res.status(401).json({ error: "Wrong password" });
        await updateCSV('users', u => u.rpi_id === rpi_id, { password: new_password });
        console.log('Пароль изменен для юзера', rpi_id, 'на пароль:', new_password, 'ip:', req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress);
        res.json({ status: "success" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

async function startServer() {


    try {
        const csvPromise = initCsvFile();
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 3000));
        
        await Promise.race([csvPromise, timeoutPromise]);
    } catch (e) {
        console.error(' Ошибка CSV (не критично):', e.message);
    }

    try {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(` HTTP Server running on port ${PORT}`);
        });
    } catch (e) {
        console.error(' Ошибка при вызове app.listen:', e);
    }

}


startServer();



// Маршрут для приема пинга от RPi
app.post('/api/heartbeat', async (req, res) => {
    const { rpi_id } = req.body;
    // Обновляем last_seen в users.csv для этого rpi_id
    // Теперь мы точно знаем, что RPi имеет интернет
    res.json({ status: 'ok' });
});






// const ctrl = new AbortController();
// setTimeout(() => ctrl.abort(), 10_000);
// fetch('/api/sensor_data?rpi_id=RP001', {
//   method: 'POST',
//   headers: { 'Content-Type': 'application/json' },
//   body: JSON.stringify({ 
//   temp: 20,
//   humidity: 41,
//   co_ppm: 3.1,
//   solar_voltage: 3.3,
//   wind_voltage: 3.4,
//   battery_level: 3.5,
//   motion: true
// }) // температура в теле
//   ,signal: ctrl.signal
// })
//   .then(r => r.ok ? r.json() : r.text().then(t => { throw new Error(`HTTP ${r.status}: ${t}`); }))
//   .then(data => console.log('Ответ:', data))
//   .catch(err => console.error('Ошибка:', err));

