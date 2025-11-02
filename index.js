// Отключение конфликтующих расширений
if (typeof window.ethereum !== 'undefined') {
    window.ethereum.autoRefreshOnNetworkChange = false;
}

// Используем относительные пути для API
window.API_BASE = '';

const safeElement = (id) => {
  const el = document.getElementById(id);
  if (!el) console.error(`Element not found: ${id}`);
  return el;
};

function updateTelegramLink() {
    const telegramBtn = document.getElementById('telegramButton');
    if (!telegramBtn) return;
    
    const login = sessionStorage.getItem('tg_login');
    const password = sessionStorage.getItem('tg_password');
    
    if (login && password) {
        telegramBtn.href = `https://t.me/DataCybSec_bot?start=${encodeURIComponent(login + '_' + password)}`;
    } else {
        telegramBtn.style.display = 'none';
    }
    if (localStorage.getItem('tempAccess') === 'true') {
        telegramBtn.href = "https://t.me/DataCybSec_bot?start";
    }
}

// Основной код приложения
document.addEventListener('DOMContentLoaded', function() {
    let historyChart = null;
    let cameraUpdateIntervals = {};
    let socket = null;
    const camerasContainer = safeElement('camerasContainer');
    const lightingControls = safeElement('lightingControls');

    // Функция безопасного обновления UI
    function safeUpdate(id, value, transform = null) {
        const el = safeElement(id);
        if (el) {
            let displayValue = value;
            
            if (value === undefined || value === null) {
                displayValue = '--';
            } 
            // Форматирование чисел
            else if (typeof value === 'number') {
                // Округляем до 2 знаков и удаляем лишние нули
                displayValue = parseFloat(value.toFixed(2)).toString();
            }
            // Пользовательские преобразования
            else if (transform) {
                displayValue = transform(displayValue);
            }
            
            el.textContent = displayValue;
        }
    }

    // Проверка демо-режима
    const demoWarning = safeElement('demoWarning');
    if (demoWarning) {
        demoWarning.style.display = localStorage.getItem('authToken') 
            ? 'none' 
            : (localStorage.getItem('tempAccess') ? 'block' : 'none');
    }

    const authToken = localStorage.getItem('authToken') || '';
    const rpiId = localStorage.getItem('rpiId') || '';
    const isTempAccess = localStorage.getItem('tempAccess') === 'true';
    
    if (!rpiId || rpiId === 'unknown') {
        console.error('RPI ID not found. Redirecting to login...');
        window.location.href = 'login.html';
        return;
    }
    
    // Обновление карточек устройств
    async function updateDeviceCards() {
        if (!camerasContainer || !lightingControls) {
            console.error('Containers not found');
            return;
        }
        if (this.isUpdating) return;
        this.isUpdating = true;
        
        Object.values(cameraUpdateIntervals).forEach(clearInterval);
        cameraUpdateIntervals = {};
        
        // Полностью очистить контейнеры
        camerasContainer.innerHTML = '';
        lightingControls.innerHTML = '';

        try {
            const response = await fetch(`/api/devices?rpi_id=${rpiId}`, {
                headers: { 
                    'Authorization': `Bearer ${authToken}`
                }
            });

            if (!response.ok) throw new Error('Ошибка загрузки устройств');
            const devices = await response.json();
            
            // Собираем новые устройства
            const cameraCards = [];
            const lightCards = [];
            
            devices.forEach(device => {
                if (!device.id) return;
                
                if (device.role === 'camera') {
                    cameraCards.push(`
                        <div class="camera-feed" data-device-id="${device.id}">
                            <h2>Камера ${device.id}</h2>
                            <button class="btn-record" data-device-id="${device.id}">
                                Запись (60 сек)
                            </button>
                        </div>
                    `);
                } else if (device.role === 'flashlight') {
                    lightCards.push(`
                        <div class="control-card" data-device-id="${device.id}">
                            <h3>Свет ${device.id}</h3>
                            <button class="btn-flashlight ${device.flashlight_active ? 'active' : ''}" 
                                    data-device-id="${device.id}">
                                ${device.flashlight_active ? 'Выключить' : 'Включить'}
                            </button>
                        </div>
                    `);
                }
            });
            
            // Добавляем карточки в контейнеры
            camerasContainer.innerHTML = cameraCards.join('');
            lightingControls.innerHTML = lightCards.join('');
            
            // Добавить обработчики событий
            document.querySelectorAll('.btn-record').forEach(button => {
                button.addEventListener('click', function() {
                    const deviceId = this.dataset.deviceId;
                    sendDeviceCommand(deviceId, 'record_video', 60);
                });
            });
            
            document.querySelectorAll('.btn-flashlight').forEach(button => {
                button.addEventListener('click', function() {
                    const deviceId = this.dataset.deviceId;
                    const isActive = this.classList.contains('active');
                    sendDeviceCommand(deviceId, 'flashlight', !isActive);
                });
            });
        } catch (error) {
            console.error('Device cards error:', error);
        } finally {
            this.isUpdating = false;
        }
    }
    
    // Подключение WebSocket
    if (rpiId) {
        try {
            socket = io({
                transports: ['websocket', 'polling'],
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 3000
            });

            // После подключения присоединяемся к комнате
            socket.on('connect', () => {
                console.log('Socket connected');
                socket.emit('join', { rpi_id: rpiId });
            });
        } catch (error) {
            console.error('Socket connection error:', error);
        }
    }
    
    const activeTab = localStorage.getItem('activeTab');
    if (activeTab) {
        setTimeout(() => {
            document.querySelector(`.tab-btn[data-tab="${activeTab}"]`)?.click();
        }, 100);
    } else {
        setTimeout(() => {
            document.querySelector('.tab-btn[data-tab="dashboard"]')?.click();
        }, 100);
    }
    updateTelegramLink();
    
    // Обновление статуса RPi
    function updateRpiStatus(status, isError = false) {
        const statusIcon = safeElement('statusIcon');
        const statusText = safeElement('statusText');
        
        if (statusText) statusText.textContent = status;
        if (statusIcon) {
            statusIcon.style.color = isError ? 'var(--danger)' : 'var(--primary)';
            statusIcon.className = isError ? 'offline' : 'online';
        }
    }

    // Управление уведомлениями
    function updateNotificationSetting(setting, value) {
        if (!authToken) return;
        
        fetch(`/api/device/command`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                command: "update_notification",
                setting: setting,
                value: value,
                rpi_id: rpiId
            })
        })
        .catch(error => console.error('Notification update error:', error));
    }

    function setupNotificationHandlers() {
        const setupHandler = (id, settingName) => {
            const element = safeElement(id);
            if (element) {
                element.addEventListener('change', (e) => {
                    if (!localStorage.getItem('authToken')) {
                        alert('Для изменения настроек войдите в систему');
                        e.target.checked = !e.target.checked;
                        return;
                    }
                    updateNotificationSetting(settingName, e.target.checked);
                });
            }
        };

        setupHandler('coNotifications', 'co2_alert');
        setupHandler('motionNotifications', 'pir_alert');
        setupHandler('energyNotifications', 'power_alert');
    }

    // Отправка команд устройствам
    async function sendDeviceCommand(deviceId, command, value) {
        if (isTempAccess || !authToken) {
            console.log('Skipping command in demo mode');
            return false;
        }
        
        try {
            const response = await fetch(`/api/device/command`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({ 
                    device_id: deviceId,
                    command,
                    value,
                    rpi_id: rpiId
                })
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Command failed');
            }
            
            return true;
        } catch (error) {
            console.error('Command error:', error);
            return false;
        }
    }

    // Загрузка списка устройств для вкладки настроек
    async function loadDevicesList() {
        try {
            const tbody = document.querySelector('#devicesTable tbody');
            if (!tbody) return;
            
            const response = await fetch(`/api/devices?rpi_id=${rpiId}`, {
                headers: { 
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const devices = await response.json();
            
            tbody.innerHTML = devices.map(device => `
                <tr>
                    <td>${device.id}</td>
                    <td>${device.role}</td>
                    <td>${device.is_online ? 'Онлайн' : 'Оффлайн'}</td>
                    <td>${device.last_seen ? new Date(device.last_seen).toLocaleString() : 'Нет данных'}</td>
                    <td>
                        <button class="btn-delete" data-device-id="${device.id}">Удалить</button>
                    </td>
                </tr>
            `).join('');

            // Добавляем обработчики ПОСЛЕ вставки в DOM
            tbody.querySelectorAll('.btn-delete').forEach(button => {
                button.addEventListener('click', async function() {
                    const deviceId = this.dataset.deviceId;
                    if (!confirm(`Удалить устройство ${deviceId}?`)) return;
                    try {
                        const response = await fetch(`/api/device/${deviceId}`, {
                            method: 'DELETE',
                            headers: {
                                'Authorization': `Bearer ${authToken}`
                            }
                        });
                        
                        if (response.ok) {
                            loadDevicesList();
                        } else {
                            const errorData = await response.json();
                            alert(`Ошибка: ${errorData.error || 'Неизвестная ошибка'}`);
                        }
                    } catch (error) {
                        console.error('Delete error:', error);
                        alert('Ошибка сети');
                    }
                });
            });
            
        } catch (error) {
            console.error('Load devices error:', error);
            const tbody = document.querySelector('#devicesTable tbody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="5">Ошибка загрузки устройств</td></tr>';
        }
    }

    // Загрузка истории данных
    async function loadHistory() {
        const historyChartCtx = safeElement('historyChart')?.getContext('2d');
        const historySensor = safeElement('historySensor');
        const historyRange = safeElement('historyRange');
        
        if (!rpiId || !historyChartCtx || !historySensor || !historyRange) return;
        
        if (historyChart) {
            historyChart.destroy();
            historyChart = null;
        }
        
        const sensor = historySensor.value;
        const range = parseInt(historyRange.value);
        
        try {
            const response = await fetch(`/api/history?sensor=${sensor}&days=${range}&rpi_id=${rpiId}`);
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Ошибка ${response.status}: ${errorText || 'Неизвестная ошибка'}`);
            }
            
            const data = await response.json();
            
            if (!data.labels || !data.values) {
                throw new Error('Некорректный формат данных истории');
            }
            
            historyChart = new Chart(historyChartCtx, {
                type: 'line',
                data: {
                    labels: data.labels,
                    datasets: [{
                        label: historySensor.options[historySensor.selectedIndex].text,
                        data: data.values,
                        borderColor: '#4CAF50',
                        backgroundColor: 'rgba(76, 175, 80, 0.1)',
                        tension: 0.1,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: { y: { beginAtZero: false } }
                }
            });
            
        } catch (error) {
            console.error('History error:', error);
            const historyContainer = safeElement('historyContainer');
            if (historyContainer) {
                historyContainer.innerHTML = `<div class="error">${error.message}</div>`;
            }
        }
    }

    // Загрузка последних данных сенсоров
    async function loadLatestSensorData() {
        if (!rpiId) return;
        try {
            const response = await fetch(`/api/latest_sensor_data?rpi_id=${rpiId}`);
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Ошибка ${response.status}: ${errorText}`);
            }
            
            const data = await response.json();
            
            safeUpdate('temp-value', data.temp);
            safeUpdate('humidity-value', data.humidity);
            safeUpdate('co-value', data.co_ppm);
            safeUpdate('solar-value', data.solar_voltage);
            safeUpdate('wind-value', data.wind_voltage);
            safeUpdate('battery-value', data.battery_level);
            safeUpdate('motion-value', data.motion, val => val ? 'Обнаружено' : 'Нет');
            
            const batteryIcon = safeElement('battery-icon');
            if (batteryIcon && data.battery_level) {
                const level = Math.min(100, Math.max(0, Math.floor(data.battery_level)));
                batteryIcon.setAttribute('data-level', level);
            }
            
        } catch (error) {
            console.error('Ошибка загрузки данных:', error);
            safeUpdate('temp-value', '--');
            safeUpdate('humidity-value', '--');
            safeUpdate('co-value', '--');
            safeUpdate('solar-value', '--');
            safeUpdate('wind-value', '--');
            safeUpdate('battery-value', '--');
            safeUpdate('motion-value', '--');
        }
    }

    // Уведомления FCM
    function updateFCMButton() {
        const enableFCM = safeElement('enableFCM');
        if (!enableFCM) return;
        
        const permission = Notification.permission;
        
        if (permission === 'granted') {
            enableFCM.textContent = 'Уведомления разрешены';
            enableFCM.disabled = true;
        } else if (permission === 'denied') {
            enableFCM.textContent = 'Включите в настройках браузера';
            enableFCM.disabled = true;
        } else {
            enableFCM.textContent = 'Разрешить push-уведомления';
            enableFCM.disabled = false;
        }
    }

    // Инициализация темы
    const currentTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', currentTheme);
    const themeToggle = safeElement('themeToggle');
    if (themeToggle) {
        themeToggle.textContent = currentTheme === 'light' ? 'Темная тема' : 'Светлая тема';
    }

    // ========== ИНИЦИАЛИЗАЦИЯ ЭЛЕМЕНТОВ ========== //
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const logoutBtn = safeElement('logoutBtn');
    const changePasswordForm = safeElement('changePasswordForm');
    const historySensor = safeElement('historySensor');
    const historyRange = safeElement('historyRange');
    const awayScenarioSwitch = safeElement('awayScenario');
    const addDeviceBtn = safeElement('addDeviceBtn');
    const enableFCM = safeElement('enableFCM');
    const deviceIdInput = safeElement('deviceIdInput');
    const deviceRole = safeElement('deviceRole');
    const deviceTabs = document.querySelectorAll('#devices .tab');

    // ========== ОБРАБОТЧИКИ СОБЫТИЙ ========== //

    // Выход из системы
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            localStorage.removeItem('authToken');
            localStorage.removeItem('rpiId');
            localStorage.removeItem('tempAccess');
            sessionStorage.removeItem('tg_login');
            sessionStorage.removeItem('tg_password');
            window.location.href = 'login.html';
        });
    }

    // Переключение темы
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            
            document.documentElement.setAttribute('data-theme', newTheme);
            themeToggle.textContent = newTheme === 'light' ? 'Темная тема' : 'Светлая тема';
            localStorage.setItem('theme', newTheme);
        });
    }

    // Переключение вкладок
    if (tabBtns.length > 0) {
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                localStorage.setItem('activeTab', tab);

                Object.values(cameraUpdateIntervals).forEach(clearInterval);
                cameraUpdateIntervals = {};
                
                tabBtns.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                const tabElement = safeElement(tab);
                if (tabElement) tabElement.classList.add('active');
                
                if (tab === 'dashboard') {
                    setTimeout(() => {
                        loadLatestSensorData();
                    }, 100);
                } else if (tab === 'history') {
                    setTimeout(loadHistory, 300);
                } else if (tab === 'devices') {
                    setTimeout(() => {
                        updateDeviceCards();
                        loadDevicesList();
                    }, 100);
                }
            });
        });
    }

    // События подключения сокета
    if (socket) {
        socket.on('sensor_update', (data) => {
            safeUpdate('temp-value', data.temp);
            safeUpdate('humidity-value', data.humidity);
            safeUpdate('co-value', data.co_ppm);
            safeUpdate('solar-value', data.solar_voltage);
            safeUpdate('wind-value', data.wind_voltage);
            safeUpdate('battery-value', data.battery_level);
            safeUpdate('motion-value', data.motion, val => val ? 'Обнаружено' : 'Нет');
            
            const batteryIcon = safeElement('battery-icon');
            if (batteryIcon && data.battery_level) {
                const level = Math.min(100, Math.max(0, Math.floor(data.battery_level)));
                batteryIcon.setAttribute('data-level', level);
            }
        });

        socket.on('connect', () => {
            updateRpiStatus('Подключено к серверу');
            if (rpiId) socket.emit('join', { rpi_id: rpiId });
        });

        socket.on('disconnect', () => {
            updateRpiStatus('Отключено от сервера', true);
        });

        socket.on('connect_error', (error) => {
            console.error('Socket error:', error);
            updateRpiStatus('Ошибка подключения', true);
        });

        socket.on('device_update', (data) => {
            if (data.role === 'flashlight') {
                const button = document.querySelector(`.btn-flashlight[data-device-id="${data.id}"]`);
                if (button) {
                    button.classList.toggle('active', data.flashlight_active);
                    button.textContent = data.flashlight_active ? 'Выключить' : 'Включить';
                }
            }
        });
    }

    async function updateDevicesDashboard() {
        if (!rpiId) return;
        try {
            const container = safeElement('devicesContainer');
            if (!container) return;
            
            container.innerHTML = '';
            
            const response = await fetch(`/api/devices?rpi_id=${rpiId}`, {
                headers: { 
                    'Authorization': `Bearer ${authToken}`
                }
            });
            
            if (!response.ok) throw new Error('Ошибка загрузки устройств');
            const devices = await response.json();
            
            devices.forEach(device => {
                const card = document.createElement('div');
                card.className = 'device-card';
                card.innerHTML = `
                    <h3>${device.role === 'camera' ? 'Камера' : 'Свет'} ${device.id}</h3>
                    <div class="device-status">
                        <span>Статус: ${device.is_online ? 'Онлайн' : 'Оффлайн'}</span>
                        <span>Последняя активность: ${device.last_seen ? new Date(device.last_seen).toLocaleString() : 'Нет данных'}</span>
                    </div>
                    <div class="device-controls">
                        ${device.role === 'camera' ? `
                            <button class="btn-record" data-device-id="${device.id}">Запись</button>
                        ` : ''}
                        <label class="switch">
                            <input type="checkbox" ${device.role === 'camera' ? 
                                (device.camera_active ? 'checked' : '') : 
                                (device.flashlight_active ? 'checked' : '')} 
                                data-device-id="${device.id}" 
                                data-command="${device.role === 'camera' ? 'camera' : 'flashlight'}">
                            <span class="slider"></span>
                        </label>
                        <span>${device.role === 'camera' ? 'Трансляция' : 'Включить'}</span>
                    </div>
                `;
                container.appendChild(card);
            });
            
            container.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
                checkbox.addEventListener('change', function() {
                    const deviceId = this.dataset.deviceId;
                    const command = this.dataset.command;
                    sendDeviceCommand(deviceId, command, this.checked);
                });
            });
            
            container.querySelectorAll('.btn-record').forEach(button => {
                button.addEventListener('click', function() {
                    const deviceId = this.dataset.deviceId;
                    sendDeviceCommand(deviceId, 'record_video', 60);
                });
            });
            
        } catch (error) {
            console.error('Devices dashboard error:', error);
        }
    }
    
    // Смена пароля
    if (changePasswordForm) {
        changePasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const currentPassword = safeElement('currentPassword')?.value;
            const newPassword = safeElement('newPassword')?.value;
            const confirmPassword = safeElement('confirmPassword')?.value;

            if (!rpiId || rpiId === 'unknown') {
                alert('Требуется авторизация');
                return;
            }
            
            if (!currentPassword || !newPassword || !confirmPassword) {
                alert('Заполните все поля');
                return;
            }
            
            if (newPassword !== confirmPassword) {
                alert('Пароли не совпадают');
                return;
            }
            
            try {                       
                const response = await fetch(`/api/change_password`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`
                    },
                    body: JSON.stringify({ 
                        rpi_id: rpiId,
                        old_password: currentPassword,
                        new_password: newPassword 
                    })
                });

                const data = await response.json();
                if (response.ok) {
                    alert('Пароль изменен');
                    changePasswordForm.reset();
                } else {
                    alert(data.error || 'Ошибка');
                }
            } catch (error) {
                console.error('Password change error:', error);
                alert('Ошибка сети');
            }
        });
    }

    // История данных
    if (historySensor && historyRange) {
        historySensor.addEventListener('change', loadHistory);
        historyRange.addEventListener('change', loadHistory);
    }

    // Уведомления FCM
    updateFCMButton();
    if (enableFCM) {
        enableFCM.addEventListener('click', async () => {
            try {
                const permission = await Notification.requestPermission();
                if (permission === 'granted') {
                    alert('Уведомления разрешены!');
                }
                updateFCMButton();
            } catch (e) {
                console.error('Notification error:', e);
            }
        });
    }

    // Добавление устройства
    if (addDeviceBtn && deviceIdInput && deviceRole) {
        addDeviceBtn.addEventListener('click', async () => {
            const deviceId = deviceIdInput.value.trim();
            const role = deviceRole.value;
            
            if (!deviceId) {
                alert('Введите ID устройства');
                return;
            }
            
            try {
                const response = await fetch(`/api/devices`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`
                    },
                    body: JSON.stringify({
                        id: deviceId,
                        role: role,
                        rpi_id: rpiId
                    })
                });
                
                const data = await response.json();
                if (response.ok) {
                    alert(`Устройство добавлено: ${data.device_id}`);
                    loadDevicesList();
                    deviceIdInput.value = '';
                } else {
                    alert(data.error || 'Ошибка при добавлении устройства');
                }
            } catch (error) {
                console.error('Add device error:', error);
                alert('Ошибка сети');
            }
        });
    }

    // Обработчик сценария "Уход"
    if (awayScenarioSwitch) {
        awayScenarioSwitch.addEventListener('change', (e) => {
            const devices = JSON.parse(localStorage.getItem('devices') || '[]');
            devices.forEach(device => {
                sendDeviceCommand(device.id, "update_state", JSON.stringify({
                    away_mode: e.target.checked,
                    camera_active: e.target.checked
                }));
            });
        });
    }

    // Инициализация уведомлений
    setupNotificationHandlers();

    // Данные пользователя для логов
    const userData = {
        device_type: /Mobile|Android|iPhone/i.test(navigator.userAgent) ? "Mobile" : "Desktop",
        browser: navigator.userAgent.match(/(Chrome|Firefox|Safari|Edge)\//i)?.[0]?.split('/')[0] || 'Unknown',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        referrer: document.referrer || 'direct',
        rpi_id: rpiId || 'unknown'
    };

    // Управление вкладками устройств
    if (deviceTabs.length > 0) {
        deviceTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                deviceTabs.forEach(t => t.classList.remove('active'));
                document.querySelectorAll('#devices .tab-content').forEach(tc => tc.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tabName).classList.add('active');
                
                if (tabName === 'devices-dashboard') {
                    updateDevicesDashboard();
                } else if (tabName === 'devices-list') {
                    loadDevicesList();
                }
            });
        });
    }

    // Очистка при закрытии
    window.addEventListener('beforeunload', () => {
        Object.values(cameraUpdateIntervals).forEach(clearInterval);
        if (socket && socket.connected) {
            socket.disconnect();
        }
    });

    // Инициализация начальных данных
    setTimeout(() => {
        loadLatestSensorData();
        updateDeviceCards();
    }, 500);
});