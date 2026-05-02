import time
import wifi
import socketpool
import ssl
import adafruit_requests
from secrets import secrets

# connect to WiFi
print("Connecting to WiFi...")
wifi.radio.connect(secrets["ssid"], secrets["password"])
print("Connected!")
print("IP address:", wifi.radio.ipv4_address)

pool = socketpool.SocketPool(wifi.radio)
requests = adafruit_requests.Session(pool, ssl.create_default_context())

BACKEND_URL = secrets["backend_url"]

while True:
   
    payload = {
        "heart_rate": heart_rate,
        "noise_level": noise_level
    }

    try:
        print("Sending:", payload)
        response = requests.post(BACKEND_URL, json=payload)
        print("Response:", response.status_code, response.text)
        response.close()

    except Exception as e:
        print("Error sending data:", e)

    time.sleep(5)