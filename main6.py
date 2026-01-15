import os
import io
import time
import socket
import subprocess
import csv
import ftplib
import requests
from datetime import datetime, timedelta, timezone

import board
import adafruit_dht
from gpiozero import MotionSensor
import Adafruit_ADS1x15
from adafruit_ina219 import INA219

from luma.core.interface.serial import spi
from luma.lcd.device import st7735
from PIL import Image, ImageDraw
import qrcode

RPI_ID = "RP001"
LOCAL_DIR = "/home/dias/Desktop/appjs"

LOCAL_NODE_URL = f"http://localhost:8767/api/sensor_data?rpi_id={RPI_ID}"
SERVER_URL = f"https://ecodom.asia/api/sensor_data?rpi_id={RPI_ID}"

FTP_HOST = "185.98.5.149"
FTP_USER = "ecodom_asia"
FTP_PASS = "Dioptriy0"
DISPLAY_TIMEOUT = 900 # 15 минут
ftp_conn = None

serial = spi(port=0, device=0, gpio_DC=25, gpio_RST=24, bus_speed_hz=8000000)
display = st7735(serial, width=160, height=128, rotate=1, h_offset=0, v_offset=0, bgr=True)

dht = adafruit_dht.DHT22(board.D17)
pir = MotionSensor(27)
adc = Adafruit_ADS1x15.ADS1115(address=0x48, busnum=1)
try:
    ina = INA219(board.I2C())
except:
    ina = None

script_start_time = time.time()
last_payload = None
node_process = None


def has_internet():
    try:
        socket.create_connection(("8.8.8.8", 53), timeout=2)
        return True
    except: return False

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except: return "0.0.0.0"

def cleanup_old_data(filename):
    path = os.path.join(LOCAL_DIR, filename)
    if not os.path.exists(path): return
    
    now = datetime.now(timezone.utc)
    rows_to_keep = []
    header = []
    
    try:
        with open(path, "r", encoding='utf-8') as f:
            reader = csv.DictReader(f)
            header = reader.fieldnames
            for row in reader:
                try:
                    row_time = datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00'))
                    if (now - row_time).days < 30:
                        rows_to_keep.append(row)
                except: continue # Если строка битая - пропускаем
        
        # Используем нашу атомарную функцию
        if header:
            safe_save_csv(path, rows_to_keep, header)
            
    except Exception as e:
        print(f"Cleanup error: {e}")

def is_port_in_use(port):
    """Проверяет, занят ли порт на локальном хосте"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) == 0

def start_node():
    global node_process
    
    # 1. Сначала проверяем, не запущен ли процесс уже самим этим скриптом
    if node_process is not None:
        if node_process.poll() is None: # poll() == None значит процесс еще живой
            return
        else:
            print("Node.js process died, restarting...")
            node_process = None

    # 2. Если скрипт перезапустился, но старая Нода осталась в системе (порты заняты)
    if is_port_in_use(8767):
        print("Node.js is already running (port 8767 in use). Skipping start.")
        return

    # 3. Если порт свободен, запускаем
    try:
        print("Starting Node.js server...")
        node_process = subprocess.Popen(
            ["node", "app.js"],
            cwd=LOCAL_DIR
            # stdout=subprocess.DEVNULL, # Чтобы логи ноды не забивали консоль питона
            # stderr=subprocess.STDOUT
        )
    except Exception as e:
        print(f"Failed to start Node.js: {e}")

def show_qr(ip):
    if time.time() - script_start_time > DISPLAY_TIMEOUT:
        display.display(Image.new("RGB", (display.width, display.height), "black"))
        return

    url = f"http://{ip}:8767/ecodom.apk"
    qr = qrcode.QRCode(box_size=3, border=1)
    qr.add_data(url)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    qr_img = qr_img.resize((100, 100), Image.NEAREST)

    bg = Image.new("RGB", (display.width, display.height), "white")
    bg.paste(qr_img, (30, 2))
    draw = ImageDraw.Draw(bg)
    draw.text((10, 105), f"ID:{RPI_ID} ", fill="black")
    draw.text((10, 115), f"IP:{ip}/ecodom.apk", fill="blue")
    display.display(bg)

img = Image.new("RGB", (display.width, display.height), "black")
ImageDraw.Draw(img).text((40, 55), "STARTING...", fill="white")
display.display(img)
time.sleep(5)

# node_process = subprocess.Popen(["node", "app.js"], cwd=LOCAL_DIR)
start_node() 


import tempfile

def safe_save_csv(target_path, rows, fieldnames):
    """Атомарное сохранение CSV: temp файл -> fsync -> replace"""
    # Создаем временный файл в той же папке (важно для атомарности)
    folder = os.path.dirname(target_path)
    fd, temp_path = tempfile.mkstemp(dir=folder, suffix=".tmp")
    
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
            
            # Принудительно выталкиваем данные из кэша ОС на физический диск
            f.flush()
            os.fsync(f.fileno())
            
        # Атомарная замена: старый файл мгновенно заменяется новым
        os.replace(temp_path, target_path)
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise e

def get_ftp():
    """Поддерживает одно активное соединение с FTP"""
    global ftp_conn
    try:
        if ftp_conn:
            ftp_conn.voidcmd("NOOP") # Проверка: живо ли соединение
        else:
            raise Exception("Reconnect needed")
    except:
        try:
            print("FTP: Connecting...")
            ftp_conn = ftplib.FTP(FTP_HOST, FTP_USER, FTP_PASS, timeout=10)
            ftp_conn.cwd("/public/")
        except Exception as e:
            print(f"FTP: Connection failed: {e}")
            ftp_conn = None
    return ftp_conn


def get_remote_mtime(ftp, filename):
    """Получает дату изменения файла на FTP сервере в формате timestamp"""
    try:
        # Команда MDTM возвращает строку типа '213 20231027123045'
        response = ftp.sendcmd(f"MDTM {filename}")
        time_str = response[4:].strip()
        return datetime.strptime(time_str, "%Y%m%d%H%M%S").timestamp()
    except:
        return 0

def sync_ftp_logic():
    """Основная логика синхронизации файлов"""
    global RPI_ID, LOCAL_DIR
    
    ftp = get_ftp() # Используем существующее или создаем новое соединение
    if not ftp: 
        return

    # В этих файлах мы только обновляем строку с нашим RPI_ID
    for filename in ["users.csv", "rpi.csv"]:
        local_path = os.path.join(LOCAL_DIR, filename)
        
        remote_mtime = get_remote_mtime(ftp, filename)
        local_mtime = os.path.getmtime(local_path) if os.path.exists(local_path) else 0

        # Если файл на сервере новее — вытаскиваем нашу строку
        if remote_mtime > local_mtime + 2: # 2 сек погрешность
            try:
                # Скачиваем весь файл с сервера в оперативную память
                r_buffer = io.BytesIO()
                ftp.retrbinary(f"RETR {filename}", r_buffer.write)
                r_buffer.seek(0)
                
                # Читаем содержимое сервера
                remote_data = io.TextIOWrapper(r_buffer, encoding='utf-8')
                remote_rows = list(csv.DictReader(remote_data))
                
                # Ищем строку нашего устройства
                remote_row = next((r for r in remote_rows if r.get('rpi_id') == RPI_ID), None)

                if remote_row:
                    # Читаем наш текущий локальный файл
                    local_rows = []
                    fieldnames = remote_row.keys() # Берем заголовки с сервера
                    
                    if os.path.exists(local_path):
                        with open(local_path, "r", encoding='utf-8') as f:
                            local_rows = list(csv.DictReader(f))
                    
                    # Обновляем нашу строку в локальном списке
                    found = False
                    for i, row in enumerate(local_rows):
                        if row.get('rpi_id') == RPI_ID:
                            local_rows[i] = remote_row
                            found = True
                            break
                    if not found:
                        local_rows.append(remote_row)

                    # АТОМАРНОЕ СОХРАНЕНИЕ
                    temp_path = local_path + ".tmp"
                    with open(temp_path, "w", encoding='utf-8', newline='') as f:
                        writer = csv.DictWriter(f, fieldnames=fieldnames)
                        writer.writeheader()
                        writer.writerows(local_rows)
                        f.flush()
                        os.fsync(f.fileno()) # Сброс кэша на диск
                    
                    os.replace(temp_path, local_path) # Мгновенная замена
                    os.utime(local_path, (remote_mtime, remote_mtime)) # Синхронизируем дату
                    print(f"FTP: Synced row {RPI_ID} in {filename}")

            except Exception as e:
                print(f"FTP error in {filename}: {e}")

    cam_file = "ip_cameras.csv"
    cam_local_path = os.path.join(LOCAL_DIR, cam_file)
    
    remote_mtime = get_remote_mtime(ftp, cam_file)
    local_mtime = os.path.getmtime(cam_local_path) if os.path.exists(cam_local_path) else 0

    # Вариант А: На сервере файл моложе -> Скачиваем целиком (АТОМАРНО)
    if remote_mtime > local_mtime + 2:
        try:
            temp_cam = cam_local_path + ".tmp"
            with open(temp_cam, "wb") as f:
                ftp.retrbinary(f"RETR {cam_file}", f.write)
            
            os.replace(temp_cam, cam_local_path)
            os.utime(cam_local_path, (remote_mtime, remote_mtime))
            print("FTP: ip_cameras.csv updated FROM server (atomically)")
        except Exception as e:
            print(f"FTP Download error (ip_cameras): {e}")

    # Вариант Б: У нас файл моложе (мы добавили камеру) -> Загружаем на сервер
    elif local_mtime > remote_mtime + 2:
        try:
            with open(cam_local_path, "rb") as f:
                ftp.storbinary(f"STOR {cam_file}", f)
            print("FTP: ip_cameras.csv uploaded TO server")
        except Exception as e:
            print(f"FTP Upload error (ip_cameras): {e}")

def get_stable_current():
    total = 0
    for _ in range(5):
        total += ina.current
        time.sleep(0.1)
        avg = max(0, (total / 5))
    return round(avg, 2)


last_sync_time = 0

def update_wifi():
    csv_path = "/home/dias/Desktop/appjs/rpi.csv"
    if not os.path.exists(csv_path): return

    try:
        with open(csv_path, mode='r', encoding='utf-8') as f:
            config = next(csv.DictReader(f), None)
            if not config: return
            target_ssid = config.get('wifi_ssid')
            target_pass = config.get('wifi_password')

        # 1. Проверяем наличие внешней антенны (wlan1)
        res_dev = subprocess.run(["nmcli", "-t", "-f", "DEVICE,STATE", "dev"], capture_output=True, text=True)
        has_wlan1 = "wlan1" in res_dev.stdout
        
        # 2. Узнаем, какой интерфейс сейчас активен и на каком SSID
        # Результат будет в виде: yes:SSID:wlan1
        res_status = subprocess.run(
            ["sudo", "nmcli", "-t", "-f", "active,ssid,device", "dev", "wifi"], 
            capture_output=True, text=True
        )
        
        active_ssid = ""
        active_dev = ""
        for line in res_status.stdout.split('\n'):
            if line.startswith("yes:"):
                parts = line.split(':')
                active_ssid = parts[1]
                active_dev = parts[2]
                break

        # 3. ЛОГИКА ПЕРЕКЛЮЧЕНИЯ
        
        # ЕСЛИ внешняя антенна (wlan1) уже работает на нужной сети
        if has_wlan1 and active_dev == "wlan1" and active_ssid == target_ssid:
            print(f"WiFi: Внешняя антенна (wlan1) уже работает на '{target_ssid}'")
            # Проверяем, не включена ли встроенная wlan0 параллельно
            if "wlan0:connected" in res_dev.stdout.replace(" ", ""):
                print("WiFi: Отключаю лишнюю встроенную антенну wlan0 для экономии...")
                subprocess.run(["sudo", "nmcli", "device", "disconnect", "wlan0"])
            return

        # ЕСЛИ нужно подключиться или сменить сеть
        print(f"WiFi: Настройка приоритетного подключения к '{target_ssid}'...")
        
        success = False
        # Сначала пробуем внешнюю (ifname wlan1)
        if has_wlan1:
            print("WiFi: Попытка через внешнюю антенну (wlan1)...")
            res = subprocess.run(
                ["sudo", "nmcli", "dev", "wifi", "connect", target_ssid, "password", target_pass, "ifname", "wlan1"],
                capture_output=True, text=True, timeout=20
            )
            if res.returncode == 0:
                print("WiFi: Успешно через wlan1!")
                subprocess.run(["sudo", "nmcli", "device", "disconnect", "wlan0"]) # Гасим встроенную
                success = True

        # Если внешней нет или она подвела — пробуем встроенную
        if not success:
            if active_ssid == target_ssid and active_dev == "wlan0":
                print(f"WiFi: Внешняя недоступна, встроенная уже на '{target_ssid}'")
            else:
                print("WiFi: Попытка через встроенную антенну (wlan0)...")
                res = subprocess.run(
                    ["sudo", "nmcli", "dev", "wifi", "connect", target_ssid, "password", target_pass, "ifname", "wlan0"],
                    capture_output=True, text=True, timeout=20
                )
                if res.returncode == 0:
                    print("WiFi: Успешно через встроенную wlan0")
                else:
                    print(f"WiFi: Ошибка подключения: {res.stderr}")

    except Exception as e:
        print(f"WiFi: Ошибка в функции update_wifi: {e}")

update_wifi()


start_battery = 100
total_minutes = 99
total_seconds = total_minutes * 60
start_time = time.time()





while True:
    ip = get_local_ip()
    show_qr(ip)

    # Чтение датчиков
    try:
        t, h = dht.temperature, dht.humidity
    except: t, h = None, None

    if int(time.time()) % 60 < 5:
        start_node()


    elapsed = time.time() - start_time
        
    # Вычисляем текущий процент (линейно)
    # Формула: Начало - (Прошло / Всего * (Сколько всего нужно отнять))
    current_pct = start_battery - (elapsed / total_seconds * 99)
    
    if current_pct < 1:
        print("\rBattery level: 1.00% (Time is up!)", end="")
        break
        
    # \r позволяет перезаписывать одну и ту же строку в терминале
    # .2f — это 2 знака после запятой для плавности
    # sys.stdout.write(f"\rBattery level: {current_pct:.2f}% | Time: {int(elapsed//60)}m {int(elapsed%60)}s")
    # sys.stdout.flush()

    # import board; 
    # from adafruit_ina219 
    # import INA219; 
    # i2c=board.I2C(); 
    # s=INA219(i2c); 
    # s.set_calibration_16V_400mA(); 
    # print(f'V: {s.bus_voltage:.2f}V | I: {s.current:.1f}mA | P: {s.power:.3f}W')
    
    co_val = round(adc.read_adc(0, gain=1) * (4.096 / 32767), 2)   # A0 -> co_ppm (напряжение)
    bat_val = round(adc.read_adc(1, gain=1) * (4.096 / 32767), 2)  # A1 -> battery_level
    wind_val = round(adc.read_adc(2, gain=1) * (4.096 / 32767), 2) # A2 -> wind_voltage
    # INA219
    solar_v = get_stable_current() if not None else 0  # solar_voltage (ток в мА)


    payload = {
        "temp": t if t is not None else 0,
        "humidity": h if h is not None else 0,
        "co_ppm": co_val if co_val is not None else 0,
        "solar_voltage": solar_v if solar_v is not None else 0,
        "wind_voltage": wind_val if wind_val is not None else 0,
        # "battery_level": bat_val if bat_val is not None else 0,
        "battery_level": round(current_pct, 2) if current_pct is not None else 1,
        "motion": bool(pir.motion_detected)
    }

    # 1. Всегда отправляем на локальный Node.js

    # 2. Если данные изменились - работаем с облаком
    current_state = {k: v for k, v in payload.items() if k not in ["timestamp"]}
    last_state = {k: v for k, v in last_payload.items() if k not in ["timestamp"]} if last_payload else None

    if current_state != last_state:
        try:
            requests.post(LOCAL_NODE_URL, json=payload, timeout=5)
        except: pass

        if has_internet():
            # Отправка на внешний сервер
            try: requests.post(SERVER_URL, json=payload, timeout=3)
            except: pass
            # Синхронизация файлов
            if time.time() - last_sync_time > 30:
                sync_ftp_logic()
                last_sync_time = time.time()

        
        last_payload = payload
        print("Change detected. Local & Cloud updated.")

    # Раз в час чистим старье
    if int(time.time()) % 21600 < 10:
        cleanup_old_data("sensor_data.csv")

    time.sleep(5)


