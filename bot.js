const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// Конфигурация
const TOKEN = "7304403573:AAGRFBdoiHF6Yy8_7JQ5R5ns5YpTF9xdHOs";
const SESSIONS_FILE = "/var/www/ecodom.asia/sessions.json";
const HEALTH_PORT = 3001;
const CSV_FILES = {
  users: 'users.csv',
  devices: 'devices.csv',
  sensor_data: 'sensor_data.csv'
};

const bot = new Telegraf(TOKEN);

// Health server для проверки состояния
const healthApp = express();
healthApp.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'telegram-bot', timestamp: new Date().toISOString() });
});

healthApp.listen(HEALTH_PORT, () => {
  console.log(`Bot health server running on port ${HEALTH_PORT}`);
});

// CSV хелперы (аналогичные app.js)
async function readCSV(file) {
  try {
    const content = await fs.readFile(CSV_FILES[file], 'utf8');
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',');
    
    return lines.slice(1).map(line => {
      const values = line.split(',');
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = values[index] || '';
      });
      return obj;
    });
  } catch (error) {
    console.error(`Error reading CSV ${file}:`, error);
    return [];
  }
}

async function updateCSV(file, predicate, updates) {
  try {
    const allData = await readCSV(file);
    const updated = allData.map(row => {
      if (predicate(row)) {
        return { ...row, ...updates };
      }
      return row;
    });
    
    const headers = Object.keys(updated[0] || {});
    const csv = [headers.join(',')];
    
    updated.forEach(row => {
      const values = headers.map(header => row[header] || '');
      csv.push(values.join(','));
    });
    
    await fs.writeFile(CSV_FILES[file], csv.join('\n'));
    return true;
  } catch (error) {
    console.error(`Error updating CSV ${file}:`, error);
    return false;
  }
}

// Функции для работы с сессиями
async function loadSessions() {
  try {
    await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true });
    
    try {
      await fs.access(SESSIONS_FILE);
    } catch {
      await fs.writeFile(SESSIONS_FILE, JSON.stringify({}));
      return {};
    }
    
    const content = await fs.readFile(SESSIONS_FILE, 'utf8');
    if (!content.trim()) {
      await fs.writeFile(SESSIONS_FILE, JSON.stringify({}));
      return {};
    }
    
    return JSON.parse(content);
  } catch (error) {
    console.error('Error loading sessions:', error);
    return {};
  }
}

async function saveSessions(sessions) {
  try {
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (error) {
    console.error('Error saving sessions:', error);
  }
}

// Обработчики команд (остальной код бота остается таким же)
bot.start(async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    
    if (args.length < 2) {
      await ctx.reply('Добро пожаловать! Зайдите на наш сайт ecodom.asia.');
      return;
    }

    const credentials = args[1];
    const [rpi_id, password] = credentials.split('_');

    if (!rpi_id || !password) {
      await ctx.reply('❌ Неверный формат ссылки. Используйте: /start RP-001_password');
      return;
    }

    const users = await readCSV('users');
    const user = users.find(u => u.rpi_id === rpi_id);

    if (!user) {
      await ctx.reply('❌ Неверный ID устройства или пароль.');
      return;
    }

    if (user.password !== password) {
      await ctx.reply('❌ Неверный ID устройства или пароль.');
      return;
    }

    const sessions = await loadSessions();
    const user_id = ctx.from.id.toString();

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('💡 Свет', 'toggle_light'),
        Markup.button.callback('🏠 Уход', 'toggle_away')
      ],
      [
        Markup.button.callback('🔑 Изменить пароль', 'change_password')
      ]
    ]);

    const sentMessage = await ctx.reply('🔍 Ожидаю данные с датчиков...', keyboard);

    sessions[user_id] = {
      chat_id: ctx.chat.id,
      message_id: sentMessage.message_id,
      rpi_id: rpi_id,
      password: password,
      state: null
    };

    await saveSessions(sessions);
    
  } catch (error) {
    console.error('Start command error:', error);
    await ctx.reply('❌ Внутренняя ошибка сервера.');
  }
});

// Обработка callback кнопок
bot.action(['toggle_light', 'toggle_away', 'change_password'], async (ctx) => {
  const sessions = await loadSessions();
  const user_id = ctx.from.id.toString();
  
  if (!sessions[user_id]) {
    await ctx.answerCbQuery('❌ Сессия устарела. Нажмите /start');
    return;
  }
  
  const session = sessions[user_id];
  const action = ctx.callbackQuery.data;

  if (action === 'change_password') {
    session.state = 'waiting_password';
    await saveSessions(sessions);
    await ctx.answerCbQuery();
    await ctx.reply('✏️ Введите новый пароль:');
    return;
  }

  if (action === 'toggle_light') {
    await ctx.answerCbQuery('💡 Команда "Свет" отправлена');
  } else if (action === 'toggle_away') {
    await ctx.answerCbQuery('🏠 Режим "Уход" переключен');
  }
});

// Обработка текстовых сообщений (смена пароля)
bot.on('text', async (ctx) => {
  const sessions = await loadSessions();
  const user_id = ctx.from.id.toString();
  
  if (!sessions[user_id]) return;
  
  const session = sessions[user_id];
  
  if (session.state === 'waiting_password') {
    const new_password = ctx.message.text;
    
    const success = await updateCSV('users',
      row => row.rpi_id === session.rpi_id,
      { password: new_password }
    );
    
    if (success) {
      session.password = new_password;
      session.state = null;
      await saveSessions(sessions);
      await ctx.reply('✅ Пароль успешно изменен!');
    } else {
      await ctx.reply('❌ Ошибка при смене пароля.');
    }
  }
});

// Фоновая задача для обновления данных сенсоров
async function sensorWatcher() {
  const lastValues = {};
  
  while (true) {
    try {
      const sessions = await loadSessions();
      
      for (const [user_id, sess] of Object.entries(sessions)) {
        const sensorData = await readCSV('sensor_data');
        const latestData = sensorData
          .filter(row => row.rpi_id === sess.rpi_id)
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
        
        if (latestData) {
          const { temp, humidity, co_ppm, motion } = latestData;
          const currentValues = `${temp}_${humidity}_${co_ppm}_${motion}`;
          
          if (lastValues[user_id] === currentValues) {
            continue;
          }
          
          lastValues[user_id] = currentValues;
          const now = new Date().toLocaleTimeString('ru-RU');
          
          const text = 
            `🌡 <b>${temp}</b>°C   💧 <b>${humidity}</b>%\n` +
            `🚨 CO: ${co_ppm} ppm   🔥 Движение: ${motion === 'true' ? 'есть' : 'нет'}\n` +
            `Обновлено: ${now}`;
          
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('💡 Свет', 'toggle_light'),
              Markup.button.callback('🏠 Уход', 'toggle_away')
            ],
            [
              Markup.button.callback('🔑 Изменить пароль', 'change_password')
            ]
          ]);
          
          try {
            await bot.telegram.editMessageText(
              sess.chat_id,
              sess.message_id,
              null,
              text,
              {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
              }
            );
          } catch (error) {
            if (error.description !== 'Bad Request: message is not modified') {
              console.error('Error editing message:', error);
            }
          }
        }
      }
    } catch (error) {
      console.error('Sensor watcher error:', error);
    }
    
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

// Запуск бота
async function startBot() {
  try {
    // Проверка подключения к CSV файлам
    const users = await readCSV('users');
    console.log('Database connection test successful');
    
    // Запуск фоновой задачи
    sensorWatcher();
    
    // Запуск бота
    await bot.launch();
    console.log('Telegram bot started successfully');
    
    // Graceful shutdown
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

startBot();