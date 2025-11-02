const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
// тест фтп 3

const app = express();
const PORT = 8767;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});

// CSV файлы
const CSV_FILES = {
    users: 'users.csv',
    devices: 'devices.csv',
    rpi_ips: 'rpi_ips.csv',
    sensor_data: 'sensor_data.csv'
};

// Инициализация CSV файлов
async function initCSV() {
    console.log('Initializing CSV files...');
    
    const files = {
        'users.csv': 'rpi_id,password,created_at,last_ip,last_seen,is_rpi\n',
        'devices.csv': 'id,role,secret_token,last_ip,last_seen,camera_active,flashlight_active,co2_alert,pir_alert,power_alert,away_mode,rpi_id,is_online\n',
        'rpi_ips.csv': 'rpi_id,global_ip,last_updated,local_ip\n',
        'sensor_data.csv': 'id,rpi_id,temp,humidity,co_ppm,solar_voltage,wind_voltage,battery_level,motion,timestamp\n'
    };

    for (const [filename, header] of Object.entries(files)) {
        try {
            await fs.access(filename);
            console.log(`✓ ${filename} exists`);
        } catch {
            await fs.writeFile(filename, header);
            console.log(`✓ Created ${filename}`);
        } 

    }
}

// CSV хелперы
async function readCSV(fileType) {
    const filename = CSV_FILES[fileType];
    try {
        const content = await fs.readFile(filename, 'utf8');
        const lines = content.trim().split('\n');
        if (lines.length <= 1) return [];
        
        const headers = lines[0].split(',');
        
        return lines.slice(1).filter(line => line.trim()).map(line => {
            const values = line.split(',');
            const obj = {};
            headers.forEach((header, index) => {
                obj[header] = values[index] || '';
            });
            return obj;
        });
    } catch (error) {
        console.error(`Error reading ${filename}:`, error);
        return [];
    }
}



const createCsvWriter = require('csv-writer').createObjectCsvWriter;

async function writeCSV(fileType, data) {
    const filename = CSV_FILES[fileType];
    try {
        // Читаем текущее содержимое файла
        const content = await fs.readFile(filename, 'utf8');
        const lines = content.trim().split('\n');
        const headers = lines[0].split(',');
        
        // Формируем новую строку
        const newRow = headers.map(header => data[header] || '').join(',');
        
        // Добавляем новую строку в файл
        await fs.writeFile(filename, content + (content.endsWith('\n') ? '' : '\n') + newRow + '\n');
        
        console.log(`✓ Данные записаны в ${filename}`);
        return true;
    } catch (error) {
        console.error(`Ошибка записи в ${filename}:`, error);
        return false;
    }
}

async function updateCSV(fileType, predicate, updates) {
    const filename = CSV_FILES[fileType];
    const allData = await readCSV(fileType);
    let updated = false;
    
    const newData = allData.map(row => {
        if (predicate(row)) {
            updated = true;
            return { ...row, ...updates };
        }
        return row;
    });
    
    if (!updated && Object.keys(updates).length > 0) {
        // Если не нашли существующую запись, создаем новую
        newData.push(updates);
        updated = true;
    }
    
    if (updated && newData.length > 0) {
        const headers = Object.keys(newData[0]);
        const csv = [headers.join(',')];
        
        newData.forEach(row => {
            const values = headers.map(header => row[header] || '');
            csv.push(values.join(','));
        });
        
        try {
            await fs.writeFile(filename, csv.join('\n'));
            return true;
        } catch (error) {
            console.error(`Error updating ${filename}:`, error);
            return false;
        }
    }
    
    return false;
}

// ==================== API ENDPOINTS ==================== //

// 1. Аутентификация
app.post('/api/login', async (req, res) => {
    try {
        const { rpi_id, password } = req.body;
        console.log('Login attempt for:', rpi_id);

        if (!rpi_id || !password) {
            return res.status(400).json({ error: "Missing rpi_id or password" });
        }

        const users = await readCSV('users');
        const user = users.find(u => u.rpi_id === rpi_id);

        if (!user) {
            return res.status(404).json({ error: "Device not registered" });
        }

        if (user.password === password) {
            // Обновляем IP
            const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            await updateCSV('rpi_ips', 
                row => row.rpi_id === rpi_id,
                {
                    rpi_id: rpi_id,
                    global_ip: ip,
                    last_updated: new Date().toISOString(),
                    local_ip: req.body.local_ip || ''
                }
            );

            const token = crypto.randomBytes(32).toString('hex');
            return res.json({
                status: "success",
                token: token,
                rpi_id: rpi_id
            });
        }

        return res.status(401).json({ error: "Invalid credentials" });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 2. Данные сенсоров
// 2. Данные сенсоров
app.post('/api/sensor_data', async (req, res) => {
    try {
        const data = req.body;
        console.log('Получены данные сенсора:', data);
        
        const required = ['rpi_id', 'temp', 'humidity', 'co_ppm', 'motion'];
        const missingFields = required.filter(field => !(field in data));
        
        if (missingFields.length > 0) {
            console.log('Отсутствующие поля:', missingFields);
            return res.status(400).json({ 
                error: "Missing required fields",
                missing: missingFields 
            });
        }

        const sensorRecord = {
            id: uuidv4(),
            rpi_id: data.rpi_id,
            temp: parseFloat(data.temp),
            humidity: parseFloat(data.humidity),
            co_ppm: parseFloat(data.co_ppm),
            solar_voltage: parseFloat(data.solar_voltage || 0),
            wind_voltage: parseFloat(data.wind_voltage || 0),
            battery_level: parseFloat(data.battery_level || 0),
            motion: Boolean(data.motion),
            timestamp: new Date().toISOString()
        };

        console.log('Сохраняем запись:', sensorRecord);
        const success = await writeCSV('sensor_data', sensorRecord);
        
        if (success) {
            console.log('✓ Данные успешно сохранены');
            res.json({ status: "success", message: "Data saved successfully" });
        } else {
            console.log('✗ Ошибка сохранения в CSV');
            res.status(500).json({ error: "Failed to save sensor data" });
        }
    } catch (error) {
        console.error('Sensor data error:', error);
        res.status(500).json({ error: "Internal server error: " + error.message });
    }
});

// 3. Последние данные сенсоров
app.get('/api/latest_sensor_data', async (req, res) => {
    try {
        const { rpi_id } = req.query;
        if (!rpi_id) return res.status(400).json({ error: "Missing rpi_id" });

        const sensorData = await readCSV('sensor_data');
        const latest = sensorData
            .filter(row => row.rpi_id === rpi_id)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

        if (latest) {
            res.json({
                temp: latest.temp,
                humidity: latest.humidity,
                co_ppm: latest.co_ppm,
                solar_voltage: latest.solar_voltage || 0,
                wind_voltage: latest.wind_voltage || 0,
                battery_level: latest.battery_level || 0,
                motion: latest.motion === 'true'
            });
        } else {
            res.json({});
        }
    } catch (error) {
        console.error('Latest sensor error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. Смена пароля
app.post('/api/change_password', async (req, res) => {
    try {
        const { rpi_id, old_password, new_password } = req.body;
        
        if (!rpi_id || !old_password || !new_password) {
            return res.status(400).json({ error: "Missing parameters" });
        }

        const users = await readCSV('users');
        const user = users.find(u => u.rpi_id === rpi_id);

        if (!user) {
            return res.status(404).json({ error: "Device not found" });
        }

        if (user.password !== old_password) {
            return res.status(401).json({ error: "Current password is incorrect" });
        }

        const success = await updateCSV('users',
            row => row.rpi_id === rpi_id,
            { password: new_password }
        );

        if (success) {
            res.json({ status: "success" });
        } else {
            res.status(500).json({ error: "Failed to update password" });
        }
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 5. Управление устройствами
app.get('/api/devices', async (req, res) => {
    try {
        const { rpi_id } = req.query;
        if (!rpi_id) return res.status(400).json({ error: "Missing rpi_id" });

        const devices = await readCSV('devices');
        const filtered = devices.filter(d => 
            d.rpi_id === rpi_id && d.role !== 'pending'
        );

        const result = filtered.map(device => ({
            id: device.id,
            role: device.role,
            is_online: device.is_online === 'true',
            last_seen: device.last_seen,
            camera_active: device.camera_active === 'true',
            flashlight_active: device.flashlight_active === 'true'
        }));

        res.json(result);
    } catch (error) {
        console.error('Get devices error:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post('/api/devices', async (req, res) => {
    try {
        const { id, role = 'pending', rpi_id } = req.body;
        
        if (!id) return res.status(400).json({ error: "Missing device_id" });

        const secret_token = crypto.randomBytes(32).toString('hex');
        const devices = await readCSV('devices');
        
        const existing = devices.find(d => d.id === id);
        let success;

        if (existing) {
            success = await updateCSV('devices',
                row => row.id === id,
                { role, rpi_id, secret_token }
            );
        } else {
            success = await writeCSV('devices', {
                id,
                role,
                secret_token,
                last_ip: '',
                last_seen: new Date().toISOString(),
                camera_active: 'false',
                flashlight_active: 'false',
                co2_alert: 'false',
                pir_alert: 'false',
                power_alert: 'false',
                away_mode: 'false',
                rpi_id: rpi_id || '',
                is_online: 'false'
            });
        }

        if (success) {
            res.json({
                status: "success",
                device_id: id,
                secret_token
            });
        } else {
            res.status(500).json({ error: "Failed to add device" });
        }
    } catch (error) {
        console.error('Device registration error:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.delete('/api/device/:device_id', async (req, res) => {
    try {
        const { device_id } = req.params;
        const { token } = req.query;

        if (!token) return res.status(400).json({ error: "Missing token" });

        const devices = await readCSV('devices');
        const device = devices.find(d => d.id === device_id && d.secret_token === token);
        
        if (!device) {
            return res.status(403).json({ error: "Invalid token" });
        }

        const updatedDevices = devices.filter(d => d.id !== device_id);
        
        if (updatedDevices.length === 0) {
            // Если удалили все устройства, оставляем только заголовки
            await fs.writeFile(CSV_FILES.devices, 'id,role,secret_token,last_ip,last_seen,camera_active,flashlight_active,co2_alert,pir_alert,power_alert,away_mode,rpi_id,is_online\n');
        } else {
            const headers = Object.keys(updatedDevices[0]);
            const csv = [headers.join(',')];
            
            updatedDevices.forEach(row => {
                const values = headers.map(header => row[header] || '');
                csv.push(values.join(','));
            });
            
            await fs.writeFile(CSV_FILES.devices, csv.join('\n'));
        }

        res.json({ status: "success" });
    } catch (error) {
        console.error('Delete device error:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 6. Команды устройствам
app.post('/api/device/command', async (req, res) => {
    try {
        const { device_id, command, value, setting } = req.body;
        
        const devices = await readCSV('devices');
        const device = devices.find(d => d.id === device_id);
        
        if (!device) {
            return res.status(404).json({ error: "Device not found" });
        }

        let success = false;

        if (command === "flashlight") {
            success = await updateCSV('devices',
                row => row.id === device_id,
                { flashlight_active: value.toString() }
            );
        } else if (command === "camera") {
            success = await updateCSV('devices',
                row => row.id === device_id,
                { camera_active: value.toString() }
            );
        } else if (command === "update_notification" && setting) {
            if (['co2_alert', 'pir_alert', 'power_alert'].includes(setting)) {
                success = await updateCSV('devices',
                    row => row.id === device_id,
                    { [setting]: value.toString() }
                );
            } else {
                return res.status(400).json({ error: "Invalid setting" });
            }
        }

        if (success) {
            res.json({ status: "success" });
        } else {
            res.status(500).json({ error: "Failed to execute command" });
        }
    } catch (error) {
        console.error('Command error:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 7. История данных
app.get('/api/history', async (req, res) => {
    try {
        const { rpi_id, sensor, days = 1 } = req.query;
        if (!rpi_id) return res.status(400).json({ error: "Missing rpi_id" });

        const sensorData = await readCSV('sensor_data');
        const timeThreshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const filtered = sensorData.filter(row => 
            row.rpi_id === rpi_id && 
            new Date(row.timestamp) >= timeThreshold
        ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        const labels = filtered.map(row => 
            new Date(row.timestamp).toLocaleString('ru-RU')
        );
        const values = filtered.map(row => parseFloat(row[sensor]) || 0);

        res.json({ labels, values });
    } catch (error) {
        console.error('History error:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 8. Видео загрузка
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './video';
        // Создаем директорию если не существует
        fs.mkdir(uploadDir, { recursive: true }).then(() => {
            cb(null, uploadDir);
        }).catch(err => {
            cb(err, uploadDir);
        });
    },
    filename: (req, file, cb) => {
        cb(null, `rec_${Date.now()}.mp4`);
    }
});

const upload = multer({ storage });

app.post('/api/save_video', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.json({ success: false, error: 'No file uploaded' });
        }

        const hasVideo = req.body.hasVideo === 'true';
        const filename = req.file.filename;
        
        res.json({ 
            success: true, 
            filename: filename,
            message: 'Video saved successfully'
        });
    } catch (error) {
        console.error('Video save error:', error);
        res.json({ success: false, error: error.message });
    }
});

app.get('/video/:filename', (req, res) => {
    res.sendFile(path.join(__dirname, 'video', req.params.filename));
});

// 9. Статус устройства
app.get('/api/device/status', async (req, res) => {
    try {
        const { device_id, token } = req.query;
        if (!device_id || !token) {
            return res.status(400).json({ error: "Missing parameters" });
        }

        const devices = await readCSV('devices');
        const device = devices.find(d => d.id === device_id && d.secret_token === token);

        if (!device) {
            return res.status(404).json({ error: "Device not found" });
        }

        res.json({
            role: device.role,
            camera_active: device.camera_active === 'true',
            flashlight_active: device.flashlight_active === 'true'
        });
    } catch (error) {
        console.error('Status error:', error);
        res.status(500).json({ error: "Internal error" });
    }
});

// 10. Health check
app.get('/ping', (req, res) => {
    res.send('pong');
});

// Добавьте этот endpoint после существующих API endpoints
app.post('/api/register_device', async (req, res) => {
    try {
        const { deviceId, token } = req.body;
        
        if (!deviceId) {
            return res.status(400).json({ error: "Missing deviceId" });
        }

        const secret_token = crypto.randomBytes(32).toString('hex');
        const success = await updateCSV('devices',
            row => row.id === deviceId,
            {
                id: deviceId,
                role: 'pending',
                secret_token: secret_token,
                last_ip: req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
                last_seen: new Date().toISOString(),
                camera_active: 'false',
                flashlight_active: 'false',
                co2_alert: 'false',
                pir_alert: 'false',
                power_alert: 'false',
                away_mode: 'false',
                rpi_id: '',
                is_online: 'true'
            }
        );

        if (success) {
            res.json({
                status: "success",
                device_id: deviceId,
                secret_token: secret_token
            });
        } else {
            res.status(500).json({ error: "Failed to register device" });
        }
    } catch (error) {
        console.error('Device registration error:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});


// Запуск сервера
async function startServer() {
    try {
        await initCSV();
        
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 EcoDom Server started on port ${PORT}`);
            console.log(`📱 Login: http://localhost:${PORT}/login.html`);
            console.log(`🏠 Main: http://localhost:${PORT}/index.html`);
            console.log(`📊 API: http://localhost:${PORT}/api/`);
            console.log('\n✅ CSV database initialized and ready!');
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();