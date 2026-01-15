
if (typeof window.ethereum !== 'undefined') {
    window.ethereum.autoRefreshOnNetworkChange = false;
}

window.API_BASE = '';

// Вспомогательная функция для безопасного обновления текста в DOM
function safeUpdate(id, value, transform = null) {
    const el = document.getElementById(id);
    if (el) {
        let displayValue = value;
        if (value === undefined || value === null) {
            displayValue = '--';
        } else if (typeof value === 'number') {
            displayValue = parseFloat(value.toFixed(2)).toString();
        } else if (transform) {
            displayValue = transform(displayValue); 
        }
        el.textContent = displayValue;
    }
}

document.addEventListener('DOMContentLoaded', function() {
    let historyChart = null;
    const langManager = window.languageManager;
    
    const PUBLIC_VAPID_KEY = 'BJ9I-5...'; 
    let overlayInterval = null;

    
    // Переменные доступа
    const authToken = localStorage.getItem('authToken') || '';
    const rpiId = localStorage.getItem('rpiId') || '';
    const isTempAccess = localStorage.getItem('tempAccess') === 'true';

    // Элементы DOM
    const camerasContainer = document.getElementById('camerasContainer');
    const overlay = document.getElementById('deviceOverlay');
    const demoWarning = document.getElementById('demoWarning');

    // Проверка авторизации
    if (demoWarning) {
        demoWarning.style.display = authToken ? 'none' : (isTempAccess ? 'block' : 'none');
    }
    
    if (!isTempAccess && !authToken && !rpiId) {
        window.location.href = 'login.html';
        return;
    }
    const settingsMap = {
        'awayScenario': 'away_mode',
        'coNotifications': 'co2_alert',
        'motionNotifications': 'pir_alert',
        'energyNotifications': 'power_alert'
    };

    // Загрузка состояния слайдеров с сервера
    async function loadUserSettings() {
        if (!rpiId || isTempAccess) return;

        try {
            const response = await fetch(`/api/user/settings?rpi_id=${encodeURIComponent(rpiId)}`);
            if (!response.ok) return;
            const settings = await response.json();

            // Устанавливаем состояния чекбоксов
            setSwitchState('awayScenario', settings.away_mode);
            setSwitchState('coNotifications', settings.co2_alert);
            setSwitchState('motionNotifications', settings.pir_alert);
            setSwitchState('energyNotifications', settings.power_alert);

        } catch (e) { 
            console.error('Settings load error:', e); 
        }
    }

    function setSwitchState(id, state) {
        const el = document.getElementById(id);
        if (el) el.checked = state;
    }

    // Инициализация слушателей изменений (отправка на сервер)
    function initSettingsListeners() {
        Object.keys(settingsMap).forEach(elementId => {
            const el = document.getElementById(elementId);
            if (el) {
                el.addEventListener('change', async (e) => {
                    if (isTempAccess) {
                        alert("В демо-режиме настройки не сохраняются");
                        e.target.checked = !e.target.checked; // Возврат
                        return;
                    }
                    try {
                        await fetch('/api/user/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                rpi_id: rpiId,
                                setting: settingsMap[elementId],
                                value: e.target.checked
                            })
                        });
                        console.log(`Setting ${settingsMap[elementId]} saved: ${e.target.checked}`);
                    } catch (err) {
                        console.error('Save setting error', err);
                        // Возвращаем переключатель назад при ошибке
                        e.target.checked = !e.target.checked; 
                    }
                });
            }
        });
    }


    // ==========================================
    // 2. ФУНКЦИИ УСТРОЙСТВ (СПИСОК)
    // ==========================================

    async function loadDevices() {
        if(!camerasContainer) return;
        
        try {
            // Загружаем телефоны и IP-камеры параллельно
            const [devRes, ipCamRes] = await Promise.all([
                fetch(`/api/devices?rpi_id=${encodeURIComponent(rpiId)}`),
                fetch(`/api/ip-cameras?rpi_id=${encodeURIComponent(rpiId)}`)
            ]);

            const devData = await devRes.json();
            const ipCams = await ipCamRes.json();

            // Обновляем статистику (только по телефонам, так как RTSP статус сложно чекать быстро)
            if(devData.stats) {
                safeUpdate('totalDevices', devData.stats.total + ipCams.length);
                safeUpdate('onlineDevices', devData.stats.online + ipCams.length); // Считаем IP камеры всегда онлайн
            }

            // Рендерим всё в одну кучу
            let html = '';
            
            // 1. Телефоны
            if (devData.devices) {
                html += devData.devices.map(d => createDeviceCardHTML(d, 'phone')).join('');
            }
            
            // 2. RTSP Камеры
            if (ipCams) {
                html += ipCams.map(c => createDeviceCardHTML(c, 'rtsp')).join('');
            }

            camerasContainer.innerHTML = html || '<div style="text-align:center; padding:20px;">Нет устройств</div>';

        } catch (error) {
            console.error(error);
        }
    }

    function createDeviceCardHTML(device, type) {
        if (type === 'phone') {
            const batteryLevel = parseInt(device.battery_level || 0);
            const isCharging = device.is_charging === 'true';
            const batteryClass = batteryLevel <= 20 ? 'bat-low' : (batteryLevel <= 50 ? 'bat-med' : 'bat-high');
            const lastSeenText = device.is_online ? 'Сейчас' : formatLastSeen(device.last_seen_seconds);
            const displayName = (device.os && device.os !== 'Unknown') ? device.os : `Камера ${device.token.substr(0,4)}...`;

            return `
            <div class="device-card ${device.is_online ? 'online' : 'offline'}">
                <div class="device-card-header">
                    <span class="device-name">${displayName}</span>
                    <span class="device-badge ${device.is_online ? 'badge-online' : 'badge-offline'}">
                        ${device.is_online ? 'ON' : 'OFF'}
                    </span>
                </div>
                <div class="device-card-body">
                    <div class="battery-container">
                        <div class="info-row"><small>Батарея: ${batteryLevel}%</small></div>
                        <div class="battery-track"><div class="battery-fill ${batteryClass}" style="width: ${batteryLevel}%"></div></div>
                    </div>
                    <div style="font-size: 0.8rem; text-align: right;">Активность: ${lastSeenText}</div>
                </div>
                <div class="device-card-footer">
                    <button class="btn btn-primary" onclick="window.openDeviceOverlay('${device.token}', 'phone')">Просмотр</button>
                    <button class="btn btn-danger" onclick="window.deleteDevice('${device.token}')">🗑️</button>
                </div>
            </div>`;
        } 
        else if (type === 'rtsp') {
            return `
            <div class="device-card online" style="border-left-color: #9C27B0;">
                <div class="device-card-header">
                    <span class="device-name">${device.name}</span>
                    <span class="device-badge badge-online">RTSP</span>
                </div>
                <div class="device-card-body">
                    <div class="info-row"><small style="color:var(--text-secondary)">${device.rtsp_full.substr(0, 25)}...</small></div>
                    <div style="font-size: 0.8rem; margin-top: 10px;">IP Камера (Всегда вкл)</div>
                </div>
                <div class="device-card-footer">
                    <button class="btn btn-primary" onclick="window.openDeviceOverlay('${device.id}', 'rtsp')">Просмотр</button>
                    <button class="btn btn-danger" onclick="window.deleteIpCam('${device.id}')">🗑️</button>
                </div>
            </div>`;
        }
    }


    function formatLastSeen(seconds) {
        if (!seconds && seconds !== 0) return 'Давно';
        if (seconds < 60) return `${seconds} сек. назад`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)} мин. назад`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч. назад`;
        return `${Math.floor(seconds / 86400)} дн. назад`;
    }

    
    let currentOverlayToken = null;

   

    let currentOverlayType = null; // 'phone' или 'rtsp'


    // 2. Обновите функцию sendDeviceAction
    window.sendDeviceAction = async function(action) {
        if (!currentOverlayToken) return;
        
        let value = 0;
        const seconds = document.getElementById('recordSeconds').value || 10;

         if (currentOverlayType === 'phone') {
             // Если команда record - берем секунды, если фонарик - переключаем (toggle)
             if (action === 'record') {
                 const input = document.getElementById('recordSeconds');
            value = input ? input.value : 10;
        } else if (action === 'flashlight') {
            value = 'toggle'; // Значение для переключения
        }

        try {
            const res = await fetch('/api/device/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: currentOverlayToken,
                    command: action,
                    value: value
                })
            });
            
            if (res.ok) {
                // Не показываем алерт на каждое нажатие фонарика, чтобы не бесило
                console.log('Команда отправлена:', action);
                // if (action !== 'flashlight') alert(`Команда "${action}" отправлена!`);
            } else {
                alert('Ошибка отправки');
            }
        } catch (e) { console.error(e); }
    } else if (currentOverlayType === 'rtsp') {
          if (action === 'record') {
                try {
                    await fetch('/api/ip-camera/record', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ id: currentOverlayToken, seconds: seconds })
                    });
                    console.log('Запись IP камеры началась');
                } catch(e) { alert('Ошибка'); }
            } else if (action === 'stop_record') {
                alert('Для IP камер стоп происходит автоматически по таймеру (ffmpeg kill не реализован в этой версии)');
            }
        }
    };


    async function loadOverlayVideos(token) {
        try {
            const vidResponse = await fetch(`/api/device/videos/${token}?rpi_id=${encodeURIComponent(rpiId)}`);
            const videos = await vidResponse.json();
            
            const listContainer = document.getElementById('overlayVideosList');
            if(videos.length === 0) {
                listContainer.innerHTML = '<p style="text-align:center; padding:10px;">Нет записей</p>';
            } else {
                listContainer.innerHTML = videos.map(video => `
                    <div class="video-item">
                        <div class="video-info">
                            <div>${video.name}</div>
                            <div class="video-meta">${formatFileSize(video.size)} • ${new Date(video.date).toLocaleString()}</div>
                        </div>
                        <div class="video-actions">
                            <button class="btn btn-primary" onclick="window.playOverlayVideo('${token}', '${video.name}')">▶</button>
                            <button class="btn btn-primary" onclick="window.downloadVideo('${token}', '${video.name}')">⬇</button>
                        </div>
                    </div>
                `).join('');
            }
        } catch(e) {
            document.getElementById('overlayVideosList').innerHTML = 'Ошибка загрузки видео';
        }
    }

    

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }


    async function loadIpCameras() {
        const listDiv = document.getElementById('ipCamList');
        if (!listDiv || !rpiId) return;

        try {
            const res = await fetch(`/api/ip-cameras?rpi_id=${encodeURIComponent(rpiId)}`);
            const cams = await res.json();

            if (cams.length === 0) {
                listDiv.innerHTML = '<p style="color:#666">Нет подключенных камер</p>';
                return;
            }

            listDiv.innerHTML = cams.map(cam => `
                   <div class="video-item" style="margin-bottom: 10px;">
                    <div class="video-info">
                        <strong>${cam.name}</strong><br>
                        <small title="${cam.rtsp_full}">${cam.rtsp_full.substr(0, 30)}...</small>
                    </div>
                    <div class="video-actions">
                        <!-- ВАЖНО: Теперь вызываем openDeviceOverlay с типом 'rtsp' -->
                        <button class="btn btn-success" style="background:var(--primary); color:white;" onclick="window.openDeviceOverlay('${cam.id}', 'rtsp')">▶ Play</button>
                        <button class="btn btn-danger" onclick="window.deleteIpCam('${cam.id}')">🗑</button>
                    </div>
                </div>
            `).join('');
        } catch (e) { console.error(e); }
    }



    let jsmpegPlayer = null;
    
    
    
    let hlsInstance = null;


    window.openDeviceOverlay = async function(id, type) {
        currentOverlayToken = id;
        currentOverlayType = type;
        
        const overlay = document.getElementById('deviceOverlay');
        const playerContainer = document.getElementById('overlayPlayerContainer');
        const controlsPanel = document.getElementById('overlayControlsPanel');
        const detailsEl = document.getElementById('overlayDetails');
        
        // 1. Показываем оверлей
        overlay.style.display = 'block';
        document.body.style.overflow = 'hidden';
        
        // 2. Сброс всего
        if (overlayInterval) clearInterval(overlayInterval);
        
        // Возвращаем чистый видео-тег перед началом (на случай если он был удален)
        playerContainer.innerHTML = '<video id="overlayVideo" style="width:100%; max-height:60vh; background:#000;" controls playsinline muted></video>';
        const videoEl = document.getElementById('overlayVideo');
        
        playerContainer.style.display = 'none';

        if (type === 'rtsp') {
            document.getElementById('overlayTitle').textContent = "IP Камера";
            detailsEl.innerHTML = '<div style="text-align:center">📡 Подключение...</div>';
            
            playerContainer.style.display = 'block';
            if (controlsPanel) controlsPanel.style.display = 'block';
            if (document.getElementById('overlayFlashBtn')) document.getElementById('overlayFlashBtn').style.display = 'none';

            const showOfflineVideo = () => {
                console.log("⚠️ Включаем заглушку (Пересоздание плеера)");
                
                // 1. Уничтожаем HLS
                if (hlsInstance) {
                    hlsInstance.destroy();
                    hlsInstance = null;
                }

                // Добавляем ?t=... для сброса кэша
                const videoUrl = '/api/video/offline?t=' + Date.now();
                
                playerContainer.innerHTML = `
                    <video id="overlayVideo" 
                           src="${videoUrl}" 
                           style="width:100%; max-height:60vh; background:#000;" 
                           controls 
                           playsinline 
                           muted 
                           autoplay 
                           loop>
                    </video>
                    <div style="text-align:center; padding:10px; color:white;">
                        <button class="btn btn-primary" onclick="document.getElementById('overlayVideo').play()">▶ Запустить видео</button>
                    </div>
                `;
                
                detailsEl.innerHTML = `
                    <div class="detail-item" style="color:red"><strong>Статус</strong> Нет сигнала</div>
                    <div class="detail-item">Порт 554 закрыт или камера недоступна</div>
                `;
            };

            try {
                const res = await fetch('/api/hls/start', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ id: id })
                });
                const data = await res.json();

                if (data.success) {
                    if (Hls.isSupported()) {
                        hlsInstance = new Hls({
                            manifestLoadingTimeOut: 4000, 
                            manifestLoadingMaxRetry: 2,
                            manifestLoadingRetryDelay: 500
                        });
                        
                        hlsInstance.loadSource(data.url);
                        hlsInstance.attachMedia(videoEl);
                        
                        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                            detailsEl.innerHTML = '<div style="color:#4CAF50">🟢 Онлайн</div>';
                            if(watchdogTimer) clearTimeout(watchdogTimer); // Видео пошло, таймер не нуже
                            videoEl.play().catch(e => console.log("Autoplay blocked"));
                        });

                        hlsInstance.on(Hls.Events.ERROR, function (event, data) {
                            if (data.fatal) {
                                console.log("❌ Ошибка HLS:", data.type);
                                showOfflineVideo();
                            }
                        });
                        
                        setTimeout(() => {
                            const currentVid = document.getElementById('overlayVideo');
                            if (currentVid && (currentVid.paused || currentVid.currentTime < 0.1)) {
                                showOfflineVideo();
                            }
                        }, 20000);

                    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
                        // Safari
                        videoEl.src = data.url;
                        videoEl.play();
                    }
                } else {
                    showOfflineVideo();
                }
            } catch (e) {
                console.error(e);
                showOfflineVideo();
            }
            
            if(typeof loadOverlayVideos === 'function') loadOverlayVideos(id, 'rtsp');
        } 
        
        else {
            document.getElementById('overlayTitle').textContent = `ID: ${id}`;
            playerContainer.style.display = 'none';
            
            const updateOverlayData = async () => {
                if (overlay.style.display === 'none') return;
                try {
                    const rpiId = localStorage.getItem('rpiId');
                    const devResponse = await fetch(`/api/devices?rpi_id=${encodeURIComponent(rpiId)}`);
                    const devData = await devResponse.json();
                    const device = devData.devices.find(d => d.token === id);
                    if (device) {
                        // ... обновление интерфейса ...
                         document.getElementById('overlayDetails').innerHTML = `
                            <div class="detail-item"><strong>ОС</strong> ${device.os || 'N/A'}</div>
                            <div class="detail-item"><strong>Токен</strong> ${device.token}</div>
                            <div class="detail-item"><strong>Статус</strong> ${device.is_online ? '🟢 Онлайн' : '🔴 Офлайн'}</div>
                            <div class="detail-item"><strong>Батарея</strong> ${device.battery_level}%</div>
                        `;
                    }
                } catch(e){}
            };
            await updateOverlayData();
            overlayInterval = setInterval(updateOverlayData, 2000);
            if(typeof loadOverlayVideos === 'function') loadOverlayVideos(id, 'phone');
        }
    };
    
    

    window.closeDeviceOverlay = function() {
        const overlay = document.getElementById('deviceOverlay');
        const videoEl = document.getElementById('overlayVideo');
        
        overlay.style.display = 'none';
        document.body.style.overflow = '';
        
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();

        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }
        
        if (overlayInterval) {
            clearInterval(overlayInterval);
            overlayInterval = null;
        }
        const pc = document.getElementById('overlayPlayerContainer');
        if(pc) pc.innerHTML = ''; // Чистим плеер

        currentOverlayToken = null;
    };



    
    
    
    
    
    // Обработчик формы
    const camForm = document.getElementById('ipCamForm');
    if (camForm) {
        camForm.addEventListener('submit', async (e) => {
            e.preventDefault(); // Предотвращаем перезагрузку
             if (isTempAccess) return alert('Демо режим');

            const body = {
                rpi_id: rpiId,
                name: document.getElementById('camName').value,
                rtsp_full: document.getElementById('camLink').value // Берем готовую ссылку
            };

            try {
                await fetch('/api/ip-cameras', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                camForm.reset();
                loadIpCameras();
                console.log('Камера добавлена');
            } catch (e) { alert('Ошибка'); }
        });
    }

    // Удаление (сделать глобальным, чтобы вызывать из HTML)
    window.deleteIpCam = async (id) => {
        if (!confirm('Удалить камеру?')) return;
        try {
            await fetch(`/api/ip-cameras/${id}`, { method: 'DELETE' });
            loadIpCameras();
        } catch (e) { alert('Ошибка'); }
    };




// Привязка кнопки
const enableFCMBtn = document.getElementById('enableFCM');
if (enableFCMBtn) {
    enableFCMBtn.addEventListener('click', async () => {
        if (!('serviceWorker' in navigator)) return alert('Нет поддержки SW');

        try {
            enableFCMBtn.disabled = true;
            enableFCMBtn.textContent = "Настройка...";
            
            // 1. Получаем ключ
            const response = await fetch('/api/push/key');
            if (!response.ok) throw new Error('Не удалось получить ключ с сервера');
            const data = await response.json();
            
            // Проверка ключа
            if (!data.publicKey || data.publicKey.length < 10) {
                throw new Error('Некорректный VAPID ключ на сервере');
            }
            
            const applicationServerKey = urlBase64ToUint8Array(data.publicKey);

            // 2. Удаляем старые регистрации (чтобы исправить ошибку)
            const oldRegs = await navigator.serviceWorker.getRegistrations();
            for (let reg of oldRegs) {
                await reg.unregister();
            }

            // 3. Регистрируем заново
            const register = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
            await navigator.serviceWorker.ready; // Ждем активации

            // 4. Подписываемся
            console.log('Subscribing with key:', data.publicKey);
            const subscription = await register.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });

            // 5. Отправляем на сервер
            await fetch('/api/subscribe', {
                method: 'POST',
                body: JSON.stringify({
                    rpi_id: localStorage.getItem('rpiId'),
                    subscription: subscription
                }),
                headers: { 'Content-Type': 'application/json' }
            });

            alert('Уведомления успешно включены!');
            enableFCMBtn.textContent = "Уведомления активны ✅";

        } catch (e) {
            console.error("Push Error:", e);
            alert('Ошибка подписки: ' + e.message + '\nПроверьте VAPID ключи в app.js!');
            enableFCMBtn.disabled = false;
            enableFCMBtn.textContent = "Попробовать снова";
        }
    });
}









    window.playOverlayVideo = async function(token, filename) {
        const playerContainer = document.getElementById('overlayPlayerContainer');
        const videoEl = document.getElementById('overlayVideo');
        
        try {
            const response = await fetch(`/api/video/${token}/${filename}`, {
                headers: { 'authtoken': authToken }
            });
            if (!response.ok) throw new Error('Ошибка загрузки файла');
            
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            
            videoEl.src = url;
            playerContainer.style.display = 'block';
            videoEl.play();
            
            playerContainer.scrollIntoView({ behavior: 'smooth' });
            videoEl.onended = () => URL.revokeObjectURL(url);
            
        } catch (e) {
            alert('Не удалось воспроизвести видео');
        }
    };

    // В index.js

    window.closeOverlayVideo = function() {
        const playerContainer = document.getElementById('overlayPlayerContainer');
        const videoEl = document.getElementById('overlayVideo');

        // 1. Безопасно останавливаем обычное видео (если элемент есть)
        if (videoEl) {
            videoEl.pause();
            videoEl.src = "";
        }

        // 2. Безопасно останавливаем RTSP плеер (JSMpeg)
        // Проверяем, существует ли переменная jsmpegPlayer и не null ли она
        if (typeof jsmpegPlayer !== 'undefined' && jsmpegPlayer) {
            try {
                jsmpegPlayer.destroy();
            } catch (e) {
                console.log("Ошибка при остановке JSMpeg:", e);
            }
            jsmpegPlayer = null;
        }

        // 3. Скрываем контейнер
        if (playerContainer) {
            playerContainer.style.display = 'none';
            // Очищаем содержимое (убираем canvas, восстанавливаем video тег для следующего раза)
            // Это важно, чтобы при следующем открытии телефона там снова был тег video
            playerContainer.innerHTML = '<video id="overlayVideo" controls playsinline style="width:100%; max-height:60vh;"></video>';
        }
    };

    window.downloadVideo = async function(token, filename) {
        try {
            const response = await fetch(`/api/video/${token}/${filename}?download=1`, {
                headers: { 'authtoken': authToken }
            });
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
        } catch (e) {
            alert('Ошибка скачивания');
        }
    };

    window.deleteDevice = async function(token) {
        if(!confirm(`Удалить устройство ${token}? Все данные будут потеряны.`)) return;
        try {
            await fetch(`/api/devices/${token}?rpi_id=${encodeURIComponent(rpiId)}`, { method: 'DELETE' });
            loadDevices(); // Обновляем список
        } catch(e) {
            alert('Ошибка удаления');
        }
    };

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // ==========================================
    // 4. ОБЩАЯ ЛОГИКА (Сенсоры, История, Вкладки)
    // ==========================================
   

    async function loadNetworkSettings() {
        if (!rpiId) return;
        try {
            const res = await fetch(`/api/wifi?rpi_id=${rpiId}`);
            if (res.ok) {
                const data = await res.json();
                if (document.getElementById('wifiSSID')) document.getElementById('wifiSSID').value = data.wifi_ssid || '';
                if (document.getElementById('wifiPass')) document.getElementById('wifiPass').value = data.wifi_password || '';
                // if (document.getElementById('apSSID')) document.getElementById('apSSID').value = data.ap_ssid || '';
                // if (document.getElementById('apPass')) document.getElementById('apPass').value = data.ap_password || '';
            }
        } catch (e) { console.error(e); }
    }

    // 2. Обработчик формы
    const netForm = document.getElementById('networkForm');
    if (netForm) {
        netForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (isTempAccess) { alert('Демо режим'); return; }
            
            const wifi_ssid = document.getElementById('wifiSSID').value;
            const wifi_password = document.getElementById('wifiPass').value;
            // const ap_ssid = document.getElementById('apSSID').value;
            // const ap_password = document.getElementById('apPass').value;

            try {
                const res = await fetch('/api/wifi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        rpi_id: rpiId, 
                        wifi_ssid, wifi_password
                        // ap_ssid, ap_password
                    })
                });
                if (res.ok) alert('Настройки сети сохранены');
                else alert('Ошибка сохранения');
            } catch (e) { alert('Ошибка сети'); }
        });
    }


    
    
    
    // Обновление ссылки на Telegram
    function updateTelegramLink() {
        const telegramBtn = document.getElementById('telegramButton');
        if (telegramBtn) {
            if (isTempAccess) {
                telegramBtn.href = "https://t.me/DataCybSec_bot?start";
            } else {
                const login = localStorage.getItem('rpiId');
                const password = localStorage.getItem('tg_password');
                if (login && password) {
                    telegramBtn.href = `https://t.me/DataCybSec_bot?start=${encodeURIComponent(login + '_' + password)}`;
                } else {
                    telegramBtn.href = "https://t.me/DataCybSec_bot?start";
                }
            }
        }
    }
    updateTelegramLink();

    // Загрузка сенсоров
    async function loadLatestSensorData() {
        if (!rpiId) return;
        try {
            const response = await fetch(`/api/latest_sensor_data?rpi_id=${rpiId}`);
            if (!response.ok) return;
            const data = await response.json();
            
            safeUpdate('temp-value', data.temp || 'N/A');
            safeUpdate('humidity-value', data.humidity || 'N/A');
            safeUpdate('co-value', data.co_ppm || 'N/A');
            safeUpdate('solar-value', data.solar_voltage || 'N/A');
            safeUpdate('wind-value', data.wind_voltage || 'N/A');
            safeUpdate('battery-value', data.battery_level || 'N/A');
            safeUpdate('motion-value', String(data.motion).toLowerCase() === 'true' ? 'Есть' : 'Нет');
            // console.log('motion:', data.motion, typeof data.motion, !!data.motion);

            const statusText = document.getElementById('statusText');
            const statusIcon = document.getElementById('statusIcon');
            if(statusText && data.timestamp) {
                const diff = Date.now() - new Date(data.timestamp).getTime();
                // 5 минут таймаут для статуса RPi
                const isOnline = diff < 5 * 60 * 1000;
                statusText.textContent = isOnline ? 'Онлайн' : 'Оффлайн';
                statusIcon.style.color = isOnline ? 'var(--primary)' : 'var(--danger)';
            }
        } catch (e) { console.error(e); }
    }

    // Загрузка истории (График)
    async function loadHistory() {
        const ctx = document.getElementById('historyChart')?.getContext('2d');
        const sensor = document.getElementById('historySensor').value;
        const days = document.getElementById('historyRange').value;
        
        if (!ctx) return;
        if (historyChart) historyChart.destroy();

        try {
            const res = await fetch(`/api/history?sensor=${sensor}&days=${days}&rpi_id=${rpiId}`);
            const data = await res.json();
            
            historyChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: data.labels || [],
                    datasets: [{
                        label: sensor,
                        data: data.values || [],
                        borderColor: '#4CAF50',
                        backgroundColor: 'rgba(76, 175, 80, 0.1)',
                        fill: true,
                        tension: 0.3
                    }]
                },
                options: { responsive: true, maintainAspectRatio: false }
            });
        } catch(e) { console.error(e); }
    }

    // Логика вкладок
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
            btn.classList.add('active');
            const tabId = btn.dataset.tab;
            document.getElementById(tabId).classList.add('active');
            
            // Загрузка данных при переключении
            if (tabId === 'dashboard') {
                loadLatestSensorData();
                loadDevices();
            }
            if (tabId === 'history') loadHistory();
            if (btn.dataset.tab === 'settings') {loadNetworkSettings(); loadIpCameras();}
        });
    });

    document.getElementById('refreshDevicesBtn')?.addEventListener('click', loadDevices);
    
    // Переключатель темы
    document.getElementById('themeToggle')?.addEventListener('click', () => {
        const newTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    });

    // Логаут
    document.getElementById('logoutBtn')?.addEventListener('click', () => {
        localStorage.removeItem('authToken');
        localStorage.removeItem('rpiId');
        localStorage.removeItem('tempAccess');
        localStorage.removeItem('tg_password');
        window.location.href = 'login.html';
    });
    
    // События графиков
    document.getElementById('historySensor')?.addEventListener('change', loadHistory);
    document.getElementById('historyRange')?.addEventListener('change', loadHistory);

    // Смена пароля
    const passForm = document.getElementById('changePasswordForm');
    if (passForm) {
        passForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const currentPassword = document.getElementById('currentPassword').value;
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;

            if (newPassword !== confirmPassword) {
                alert("Новые пароли не совпадают");
                return;
            }

            try {
                const res = await fetch('/api/change_password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rpi_id: rpiId, old_password: currentPassword, new_password: newPassword })
                });
                if (res.ok) {
                    // alert("Пароль успешно изменен");
                    passForm.reset();
                    // Обновляем для телеграма
                    localStorage.setItem('tg_password', newPassword);
                    updateTelegramLink();
                } else {
                    alert("Ошибка: неверный текущий пароль");
                }
            } catch (e) { alert("Ошибка сети"); }
        });
    }

    
    
    // Загрузка темы
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    
    // Загрузка настроек
    loadUserSettings();     
    initSettingsListeners(); 
    
    // Эмуляция клика по активной вкладке для старта
    const activeTabBtn = document.querySelector('.tab-btn.active');
    if(activeTabBtn) activeTabBtn.click();
    else loadLatestSensorData();

    // Автообновление (каждые 5 сек)
    setInterval(() => {
        // Обновляем только если вкладка Dashboard активна
        const activeTab = document.querySelector('.tab-content.active')?.id;
        if (activeTab === 'dashboard') {
            loadLatestSensorData();
            loadDevices();
        } 
    }, 5000);
});
