


const TelegramBot = require('node-telegram-bot-api');
// const TELEGRAM_BOT_TOKEN = process.env.tg 
const TELEGRAM_BOT_TOKEN = 'ничего'  // заглушка чтоб легче переключать, на рпи не нужен тг бот, так как он на сервере

let bot = null;
const activeMonitors = new Map();

if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== 'ничего') {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    console.log("🤖 Telegram Bot started");
} else {
    console.log("⚠️ Telegram Bot Token missing. Bot not started.");
}

async function getLang(chatId) {
    const tgUsers = await readCSV('tg');
    const user = tgUsers.find(u => u.chat_id === String(chatId));
    return user ? (user.lang || 'ru') : 'ru';
}

async function getUserRpi(chatId) {
    const tgUsers = await readCSV('tg');
    const user = tgUsers.find(u => u.chat_id === String(chatId));
    return user ? user.rpi_id : null;
}

// Помощник: Клавиатура меню
function getMainMenu(lang) {
    const d = DICTIONARY[lang];
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: d.btn_sensors, callback_data: 'menu_sensors' }, { text: d.btn_devices, callback_data: 'menu_devices' }],
                [{ text: d.btn_settings, callback_data: 'menu_settings' }, { text: d.btn_wifi, callback_data: 'menu_wifi' }],
                [{ text: d.btn_lang, callback_data: 'menu_lang' }]
            ]
        }
    };
}

if (bot) {
    // 1. Обработка /start с параметрами
    const deleteMsg = async (chatId, msgId) => {
        try { await bot.deleteMessage(chatId, msgId); } catch (e) {}
    };

    // Остановка автообновления для чата
    const stopMonitor = (chatId) => {
        if (activeMonitors.has(chatId)) {
            clearInterval(activeMonitors.get(chatId));
            activeMonitors.delete(chatId);
        }
    };
    bot.on('message', (msg) => {
        console.log('Сообщение от', msg.chat.id, ':', msg.text, 'username:', msg.from.username, 'first_name:', msg.from.first_name);
        

    });
    bot.onText(/\/start(.*)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const payload = match[1].trim(); // login_password_lang

        if (payload) {
            // Ожидаем формат: login_password_lang или login_password
            // Но payload приходит encoded.
            const decoded = decodeURIComponent(payload);
            const parts = decoded.split('_');
            const rpi_id = parts[0];
            const password = parts[1];
            const lang = parts[2] || 'ru';

            const users = await readCSV('users');
            const validUser = users.find(u => u.rpi_id === rpi_id && u.password === password);
            // console.log('Попытка входа в бота для', rpi_id, 'результат:', validUser ? 'успешно' : 'неудачно', 'chatId:', chatId, 'username:', msg.from.username);
            if (validUser) {
                // Сохраняем/Обновляем пользователя TG
                const tgUsers = await readCSV('tg');
                const existing = tgUsers.find(u => u.chat_id === String(chatId));
                
                if (existing) {
                    await updateCSV('tg', u => u.chat_id === String(chatId), { rpi_id, lang, last_seen: new Date(Date.now()+18000000).toISOString() });
                } else {
                    await writeCSV('tg', {
                        rpi_id, 
                        username: msg.from.username || 'anon',
                        chat_id: chatId, 
                        last_seen: new Date(Date.now()+18_000_000).toISOString(), 
                        lang
                    });
                }
                
                const d = DICTIONARY[lang];
                bot.sendMessage(chatId, `${d.auth_success}\nID: ${rpi_id}`, getMainMenu(lang));
            } else {
                bot.sendMessage(chatId, DICTIONARY['ru'].auth_fail);
            }
        } else {
            // Просто /start без параметров - проверяем регистрацию
            const rpi_id = await getUserRpi(chatId);
            const lang = await getLang(chatId);
            if (rpi_id) {
                bot.sendMessage(chatId, DICTIONARY[lang].welcome, getMainMenu(lang));
            } else {
                bot.sendMessage(chatId, "Please login via website first.");
            }
        }
    });

    // 2. Обработка Callback Query (Меню)
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;
        const rpi_id = await getUserRpi(chatId);
        let lang = await getLang(chatId);
        const d = DICTIONARY[lang];
        if (data === 'menu_main' || data === 'menu_settings' || data === 'menu_wifi') {
            stopMonitor(chatId);
        }

        if (!rpi_id && !data.startsWith('set_lang_')) {
            return bot.answerCallbackQuery(query.id, { text: "Auth required" });
        }

        if (data === 'menu_lang') {
            bot.editMessageText(d.lang_select, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🇷🇺 Русский", callback_data: 'set_lang_ru' }],
                        [{ text: "🇬🇧 English", callback_data: 'set_lang_en' }],
                        [{ text: "🇰🇿 Қазақша", callback_data: 'set_lang_kz' }],
                        [{ text: d.back, callback_data: 'menu_main' }]
                    ]
                }
            });
        }
        else if (data.startsWith('set_lang_')) {
            const newLang = data.split('_')[2];
            await updateCSV('tg', u => u.chat_id === String(chatId), { lang: newLang });
            lang = newLang; // update local
            const newD = DICTIONARY[newLang];
            bot.sendMessage(chatId, newD.welcome, getMainMenu(newLang));
        }

        else if (data === 'menu_main') {
            bot.editMessageText(d.menu_main, {
                chat_id: chatId, message_id: query.message.message_id,
                ...getMainMenu(lang)
            });
        }

        else if (data === 'menu_sensors') {
            stopMonitor(chatId);
            const updateSensorsMsg = async () => {
                const sensors = await readCSV('sensor_data');
                const latest = sensors.filter(s => s.rpi_id === rpi_id).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp))[0];
                
                let text = `<b>${d.current_data}</b>\n`;
                if (latest) {
                    text += `Temp: ${latest.temp}°C\nHum: ${latest.humidity}%\nCO: ${latest.co_ppm}ppm\nSolar: ${latest.solar_voltage}V\nWind: ${latest.wind_voltage}V\nBatt: ${latest.battery_level}%\nMotion: ${latest.motion}\nTime: ${new Date(latest.timestamp).toLocaleTimeString()}`;
                } else {
                    text += d.no_data;
                }
                // (Историю можно не обновлять так часто, сократим для краткости, оставим как было в прошлом коде)
                
                try {
                    await bot.editMessageText(text, {
                        chat_id: chatId, message_id: query.message.message_id,
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: d.back, callback_data: 'menu_main' }]] }
                    });
                } catch (e) {  }
            };

            // Запускаем сразу и ставим интервал 3 сек
            await updateSensorsMsg();
            const interval = setInterval(updateSensorsMsg, 3000);
            activeMonitors.set(chatId, interval);
        }

        else if (data === 'menu_devices') {



            stopMonitor(chatId);

            const updateDevicesMsg = async () => {
                const devices = await readCSV('devices');
                const userDevs = devices.filter(dev => dev.rpi_id === rpi_id);
                
                if (userDevs.length === 0) {
                    // Если пусто, не обновляем циклично, просто показываем
                    try {
                        await bot.editMessageText(d.no_data, {
                            chat_id: chatId, message_id: query.message.message_id,
                            reply_markup: { inline_keyboard: [[{ text: d.back, callback_data: 'menu_main' }]] }
                        });
                    } catch(e){}
                    return;
                }

                const kb = userDevs.map(dev => {
                    // Уменьшил таймаут до 20 сек для соответствия серверу
                    const isOnline = (new Date() - new Date(dev.last_seen)) < 20000; 
                    const status = isOnline ? `🟢 ${d.dev_online}` : `🔴 ${d.dev_offline}`;
                    return [{ text: `${dev.os || 'Dev'} (${dev.token.substr(0,4)}..) ${status}`, callback_data: `dev_view_${dev.token}` }];
                });
                kb.push([{ text: d.back, callback_data: 'menu_main' }]);

                try {
                    await bot.editMessageText(d.dev_list + ` (${new Date().toLocaleTimeString()})`, {
                        chat_id: chatId, message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: kb }
                    });
                } catch (e) {}
            };

            await updateDevicesMsg();
            const interval = setInterval(updateDevicesMsg, 4000); // Каждые 4 сек
            activeMonitors.set(chatId, interval);
        }

        // При клике на конкретное устройство - останавливаем обновление списка
        else if (data.startsWith('dev_view_')) {
            stopMonitor(chatId);
        }
        else if (data.startsWith('dev_view_')) {
            const token = data.split('_')[2];
            bot.editMessageText(`Device: ${token}`, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `📺 ${d.dev_videos}`, callback_data: `dev_vids_${token}` }],
                        [{ text: `🗑 ${d.dev_delete}`, callback_data: `dev_del_ask_${token}` }],
                        [{ text: d.back, callback_data: 'menu_devices' }]
                    ]
                }
            });
        }
        // Удаление устройства
        else if (data.startsWith('dev_del_ask_')) {
            const token = data.split('_')[3];
            bot.editMessageText(`${d.confirm_del} (${token})`, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ YES", callback_data: `dev_del_confirm_${token}` }],
                        [{ text: "❌ NO", callback_data: `dev_view_${token}` }]
                    ]
                }
            });
        }
        else if (data.startsWith('dev_del_confirm_')) {
            const token = data.split('_')[3];
            // Удаляем из CSV
            const devices = await readCSV('devices');
            const newDevs = devices.filter(dd => dd.token !== token);
            // Перезапись (упрощенно, создаем структуру заново если надо)
            if(newDevs.length > 0 || devices.length > 0) {
                 // Тут простой хак: если удалили всё, файл станет пустым кроме заголовка
                 const headers = Object.keys(devices[0] || {});
                 if(headers.length > 0) {
                     const csv = [headers.join(','), ...newDevs.map(r => headers.map(h => r[h]||'').join(','))].join('\n');
                     await fsp.writeFile(CSV_FILES.devices, csv + '\n');
                 }
            }
            // Удаляем папку
            const folder = path.join(__dirname, 'users_videos', token);
            try { await fsp.rm(folder, { recursive: true }); } catch {}
            
            bot.answerCallbackQuery(query.id, { text: "Deleted" });
            bot.sendMessage(chatId, "Device deleted", getMainMenu(lang));
        }

        // Видео список
        else if (data.startsWith('dev_vids_')) {

            const token = data.split('_')[2];
            const folder = path.join(__dirname, 'users_videos', token);
            let files = [];
            
            // Добавляем проверку существования папки
            if (fs.existsSync(folder)) {
                try { files = await fsp.readdir(folder); } catch {}
            }
            
            const videos = files.filter(f => f.endsWith('.webm'));

            if (videos.length === 0) {
                // Используем answerCallbackQuery вместо редактирования, чтобы не ломать меню
                return bot.answerCallbackQuery(query.id, { text: d.no_data, show_alert: true });
            }

            // Показываем последние 5
            const kb = videos.slice(-5).map(v => [{ text: v, callback_data: `vid_dl_${token}_${v}` }]);
            kb.push([{ text: d.back, callback_data: `dev_view_${token}` }]);

            bot.editMessageText(`${d.video_list} ${token}`, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: { inline_keyboard: kb }
            });
        }
        else if (data.startsWith('vid_dl_')) {
            const parts = data.split('_');
            const token = parts[2];
            const file = parts.slice(3).join('_'); // имя файла может содержать _
            const filePath = path.join(__dirname, 'users_videos', token, file);
            
            bot.sendVideo(chatId, filePath).catch(e => bot.sendMessage(chatId, "Error sending video"));
        }

        else if (data === 'menu_settings') {
            const users = await readCSV('users');
            const user = users.find(u => u.rpi_id === rpi_id);
            const tgRow = (await readCSV('tg')).find(t => t.chat_id === String(chatId));

            if (!user) return;

            const makeBtn = (txt, field) => {
                const state = user[field] === 'true' ? `✅ ${d.on}` : `❌ ${d.off}`;
                return { text: `${txt}: ${state}`, callback_data: `toggle_${field}` };
            };

            const kb = [
                [makeBtn("Away Mode", 'away_mode')],
                [makeBtn("CO2 Alert", 'co2_alert')],
                [makeBtn("PIR Alert", 'pir_alert')],
                [makeBtn("Power Alert", 'power_alert')],
                [{ text: `🔐 ${d.pass_change}`, callback_data: 'change_pass_start' }],
                [{ text: d.back, callback_data: 'menu_main' }]
            ];

            const text = `${d.settings_title}\n${d.tg_id} ${chatId}\nUsername: @${tgRow?.username || '-'}`;
            
            bot.editMessageText(text, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: { inline_keyboard: kb }
            });
        }
        // Тогглы настроек
        else if (data.startsWith('toggle_')) {
            const field = data.split('_').slice(1).join('_'); // away_mode, co2_alert etc
            const users = await readCSV('users');
            const user = users.find(u => u.rpi_id === rpi_id);
            
            const newVal = user[field] === 'true' ? 'false' : 'true';
            await updateCSV('users', u => u.rpi_id === rpi_id, { [field]: newVal });
            
            // Перерисовываем меню
            const updatedUser = { ...user, [field]: newVal };
            // (Дублируем логику отрисовки меню настроек)
            const makeBtn = (txt, f) => {
                const state = updatedUser[f] === 'true' ? `✅ ${d.on}` : `❌ ${d.off}`;
                return { text: `${txt}: ${state}`, callback_data: `toggle_${f}` };
            };
            const kb = [
                [makeBtn("Away Mode", 'away_mode')],
                [makeBtn("CO2 Alert", 'co2_alert')],
                [makeBtn("PIR Alert", 'pir_alert')],
                [makeBtn("Power Alert", 'power_alert')],
                [{ text: `🔐 ${d.pass_change}`, callback_data: 'change_pass_start' }],
                [{ text: d.back, callback_data: 'menu_main' }]
            ];
            
            // Чтобы не было ошибки "message not modified", ловим ошибку
            try {
                await bot.editMessageReplyMarkup({ inline_keyboard: kb }, { chat_id: chatId, message_id: query.message.message_id });
            } catch(e) {}
        }
        // Смена пароля
        else if (data === 'change_pass_start') {
            userStates.set(chatId, { state: 'waiting_new_pass', rpi_id });
            bot.sendMessage(chatId, d.pass_enter, { reply_markup: { force_reply: true } });
        }

        else if (data === 'menu_wifi') {
            const rpis = await readCSV('rpi');
            const conf = rpis.find(r => r.rpi_id === rpi_id);
            
            const w_ssid = conf ? conf.wifi_ssid : '-';
            const w_pass = conf ? conf.wifi_password : '-';
            // const a_ssid = conf ? (conf.ap_ssid || '-') : '-'; // AP
            // const a_pass = conf ? (conf.ap_password || '-') : '-'; // AP

            const text = `${d.wifi_title}\n\n📶 <b>WiFi Client:</b>\nSSID: ${w_ssid}\nPass: ${w_pass}\n`;
            
            bot.editMessageText(text, {
                chat_id: chatId, message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `✏ Изменить WiFi`, callback_data: 'wifi_change_start' }],
                        [{ text: d.back, callback_data: 'menu_main' }]
                    ]
                }
            });
        }

        else if (data === 'wifi_change_start') {
            userStates.set(chatId, { state: 'waiting_wifi_ssid', rpi_id });
            bot.sendMessage(chatId, d.wifi_enter_ssid, { reply_markup: { force_reply: true } });
        } 
        

        
    });

    // 3. Обработка текстовых сообщений (ввод паролей и т.д.)
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;
        const stateData = userStates.get(chatId);

        if (!stateData) return;

        const lang = await getLang(chatId);
        const d = DICTIONARY[lang];

        if (stateData.state === 'waiting_new_pass') {
            await updateCSV('users', u => u.rpi_id === stateData.rpi_id, { password: text });
            bot.sendMessage(chatId, d.pass_updated);
            userStates.delete(chatId);
        }
        else if (stateData.state === 'waiting_wifi_ssid') {
            userStates.set(chatId, { state: 'waiting_wifi_pass', rpi_id: stateData.rpi_id, temp_ssid: text });
            bot.sendMessage(chatId, d.wifi_enter_pass);
        }
        else if (stateData.state === 'waiting_wifi_pass') {
            const ssid = stateData.temp_ssid;
            const rpi_id = stateData.rpi_id;
            
            // Обновляем или создаем запись
            const exists = await updateCSV('rpi', r => r.rpi_id === rpi_id, { wifi_ssid: ssid, wifi_password: text });
            if (!exists) {
                await writeCSV('rpi', { rpi_id, wifi_ssid: ssid, wifi_password: text });
            }
            
            bot.sendMessage(chatId, d.wifi_updated);
            userStates.delete(chatId);
        }
    });
}



