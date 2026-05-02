Feather setup 
- On the Feather, create a secrets.py:
secrets = {
    "ssid": "WIFI_NAME",
    "password": "WIFI_PASSWORD",
    "backend_url": "http://laptop-ip:8000/sensor-data"
}
- On Mac, run command ipconfig getifaddr en0 to get laptop IP
- For example, if the IP is 192.168.1.23, then the backend url is http://192.168.1.23:8000/sensor-data
- Make sure laptop and Feather are connected to the same WiFi network 

Backend setup (need to modify the backend script later)
- Run command pip install fastapi uvicorn
- Run command uvicorn main:app --host 0.0.0.0 --port 8000