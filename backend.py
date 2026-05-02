from fastapi import FastAPI
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

latest_sensor_data = {}

class SensorData(BaseModel):
    heart_rate: float
    noise_level: float

@app.post("/sensor-data")
def receive_sensor_data(data: SensorData):
    global latest_sensor_data
    latest_sensor_data = {
        "heart_rate": data.heart_rate,
        "noise_level": data.noise_level,
        "timestamp": datetime.now().isoformat()
    }
    print("Received:", latest_sensor_data)
    return {"status": "ok", "received": latest_sensor_data}

@app.get("/latest-sensor-data")
def get_latest_sensor_data():
    return latest_sensor_data