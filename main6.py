import time
import Adafruit_ADS1x15
import adafruit_dht
import board
import requests
import json
import sys
from gpiozero import MotionSensor
import math


# тест фтп4


# Конфигурация
RPI_ID = "RP001"
SERVER_URL = "https://ecodom.asia/api/sensor_data"
SLEEP_INTERVAL = 5

# Инициализация датчиков
dht_sensor = adafruit_dht.DHT22(board.D17)
pir_sensor = MotionSensor(27)
adc = Adafruit_ADS1x15.ADS1115(address=0x48, busnum=1)
GAIN = 1  # Усиление для АЦП (±4.096V)

# Последние значения для обработки ошибок
last_temp = 0.0
last_humidity = 0.0
last_co_ppm = 0.0

def read_dht22():
    """Чтение данных с датчика DHT22 (температура и влажность)"""
    global last_temp, last_humidity
    try:
        temperature = dht_sensor.temperature
        humidity = dht_sensor.humidity
        
        if temperature is not None and humidity is not None:
            last_temp = temperature
            last_humidity = humidity
            return temperature, humidity
    except RuntimeError:
        pass
    return last_temp, last_humidity

# КОНСТАНТЫ ДЛЯ MQ-135 (ВАЖНО ПРАВИЛЬНЫЕ ЗНАЧЕНИЯ)
VCC = 5.0          # Напряжение питания датчика (5V)
RL = 10.0           # Сопротивление нагрузки (10 кОм)
RO_CLEAN_AIR = 10.0 # Базовое сопротивление в чистом воздухе
# Коэффициенты для CO (из даташита MQ-135)
CO_A = 110.47       # Коэффициент A
CO_B = -2.862       # Коэффициент B

last_co_ppm = 0
R0 = 10.0           # Калибровочное значение

def calibrate_mq135():
    """Калибровка датчика в чистом воздухе"""
    print("Калибровка MQ-135...")
    samples = []
    for _ in range(10):
        raw_value = adc.read_adc(0, gain=GAIN)
        voltage = raw_value * 4.096 / 32767
        
        # ВАЖНО: Правильное вычисление сопротивления датчика
        rs = (VCC - voltage) / voltage * RL
        
        samples.append(rs)
        time.sleep(0.5)
    
    # Рассчитываем среднее сопротивление в чистом воздухе
    avg_rs = sum(samples) / len(samples)
    
    # Вычисляем R0 с учетом температуры (компенсация)
    temp, humidity = read_dht22()
    compensation_factor = 1.0
    
    # Температурная компенсация (пример)
    if temp > 25:
        compensation_factor = 1 + (temp - 25) * 0.02
    
    return avg_rs / RO_CLEAN_AIR * compensation_factor

# Выполнить калибровку при старте
try:
    R0 = calibrate_mq135()
    print(f"Калибровочное значение R0 = {R0:.2f} Ом")
except Exception as e:
    print(f"Ошибка калибровки: {e}")
    R0 = RO_CLEAN_AIR  # значение по умолчанию

def read_mq135():
    """Чтение данных с датчика MQ-135 (концентрация CO)"""
    global last_co_ppm, R0
    
    try:
        # Чтение сырого значения
        raw_value = adc.read_adc(0, gain=GAIN)
        voltage = max(0.001, raw_value * 4.096 / 32767)  # Защита от 0
        
        # Вычисление сопротивления датчика (ПРАВИЛЬНАЯ ФОРМУЛА)
        rs = (VCC - voltage) / voltage * RL
        
        # Вычисление отношения Rs/R0
        ratio = rs / R0
        
        # Получение текущей температуры для компенсации
        temp, humidity = read_dht22()
        
        # Температурная компенсация
        temp_compensation = 1.0
        if temp > 25:
            temp_compensation = 1 + (temp - 25) * 0.02
        elif temp < 15:
            temp_compensation = 1 - (15 - temp) * 0.03
            
        # Расчет PPM для CO (ПРАВИЛЬНАЯ ФОРМУЛА)
        ppm = CO_A * math.pow(ratio, CO_B) * temp_compensation
        
        # Фильтрация значений
        if 0 < ppm < 10000:
            last_co_ppm = ppm
            return ppm
        
    except Exception as e:
        print(f"Ошибка чтения MQ-135: {str(e)}")
    
    return last_co_ppm

# Остальной код без изменений...
def read_power_sensors():
    """Чтение данных с датчиков напряжения"""
    try:
        # Чтение солнечной панели (канал A1)
        solar_raw = adc.read_adc(1, gain=GAIN)
        solar_voltage = solar_raw * 4.096 / 32767
        
        # Чтение ветрогенератора (канал A2)
        wind_raw = adc.read_adc(2, gain=GAIN)
        wind_voltage = wind_raw * 4.096 / 32767
        
        # Чтение батареи (канал A3)
        battery_raw = adc.read_adc(3, gain=GAIN)
        battery_voltage = battery_raw * 4.096 / 32767
        
        return solar_voltage, wind_voltage, battery_voltage
    except Exception:
        return 0.0, 0.0, 0.0

# 
def send_to_server(data):
    """Отправка данных на сервер с детальной диагностикой"""
    try:
        rounded_data = {
            'rpi_id': data['rpi_id'],
            'temp': round(data['temp'], 2),
            'humidity': round(data['humidity'], 2),
            'co_ppm': round(data['co_ppm'], 2),
            'solar_voltage': round(data['solar_voltage'], 2),
            'wind_voltage': round(data['wind_voltage'], 2),
            'battery_level': round(data['battery_level'], 2),
            'motion': data['motion']
        }
        
        print(f"Отправка данных: {rounded_data}")
        response = requests.post(
            SERVER_URL,
            json=rounded_data,
            headers={'Content-Type': 'application/json'},
            timeout=10
        )
        
        print(f"Статус ответа: {response.status_code}")
        print(f"Текст ответа: {response.text}")
        
        if response.status_code == 200:
            print("✓ Данные успешно отправлены на сервер")
            return True
        else:
            print(f"✗ Ошибка сервера: {response.status_code}")
            return False
            
    except requests.exceptions.ConnectionError as e:
        print(f"✗ Ошибка соединения: {str(e)}")
        return False
    except requests.exceptions.Timeout as e:
        print(f"✗ Таймаут соединения: {str(e)}")
        return False
    except requests.exceptions.RequestException as e:
        print(f"✗ Ошибка запроса: {str(e)}")
        return False
    except Exception as e:
        print(f"✗ Неожиданная ошибка: {str(e)}")
        return False


def main():
    print("Запуск мониторинга датчиков...")
    
    try:
        while True:
            # Чтение данных с датчиков
            temp, humidity = read_dht22()
            co_ppm = read_mq135()
            motion = pir_sensor.motion_detected
            solar_voltage, wind_voltage, battery_voltage = read_power_sensors()
            
            # Формирование данных для отправки
            sensor_data = {
                'rpi_id': RPI_ID,
                'temp': temp,
                'humidity': humidity,
                'co_ppm': co_ppm,
                'solar_voltage': solar_voltage,
                'wind_voltage': wind_voltage,
                'battery_level': battery_voltage,
                'motion': motion
            }
            
            print(f"{temp:.1f}°C, {humidity:.1f}%, {co_ppm:.2f} ppm, {solar_voltage:.3f}V, {wind_voltage:.3f}V, {battery_voltage:.3f}V, {'Да' if motion else 'Нет'}")
                       
            # Отправка данных на сервер
            send_to_server(sensor_data)
            
            time.sleep(SLEEP_INTERVAL)
            
    except KeyboardInterrupt:
        print("\nОстановка мониторинга")
        sys.exit(0)

if __name__ == '__main__':

    main()


"""
sudo chmod 644 /etc/systemd/system/ecodom_sensor.service
sudo systemctl daemon-reload
sudo systemctl enable ecodom_sensor.service
sudo systemctl start ecodom_sensor.service
"""