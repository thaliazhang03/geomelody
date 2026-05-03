import board
import busio
from adafruit_lsm6ds.lsm6ds3 import LSM6DS3
from adafruit_lis3mdl import LIS3MDL
import time
from max30102 import MAX30102
import analogio
import math
import wifi
import socketpool
import ssl
import adafruit_requests
from secrets import secrets
import microcontroller


# --- WiFi setup ---
print("Connecting to WiFi...")
wifi.radio.connect(secrets["ssid"], secrets["password"])
print("Connected! IP:", wifi.radio.ipv4_address)
pool = socketpool.SocketPool(wifi.radio)
requests = adafruit_requests.Session(pool, ssl.create_default_context())
BACKEND_URL = secrets["backend_url"]

# --- Sensor setup ---
i2c = busio.I2C(board.SCL1, board.SDA1)
mic = analogio.AnalogIn(board.A0)
sensor = MAX30102(i2c=i2c)
imu = LSM6DS3(i2c)

print("Sensors initialized...")
time.sleep(2)

# --- Sensor states ---
rolling = []
smoother = []
window_ac = []
beat_times = []
bpm = 0
last_was_low = False

imu_samples = []
last_db = 30.0
last_imu = "ACT_STILL"
REPORT_EVERY = 5  # seconds
last_report = time.monotonic()

def get_imu_state(samples):
    if len(samples) < 10:
        return "ACT_STILL"
    max_jerk = 0
    for i in range(1, len(samples)):
        for axis in range(3):
            jerk = abs(samples[i][axis] - samples[i-1][axis])
            if jerk > max_jerk:
                max_jerk = jerk
    max_var = 0
    for axis in range(3):
        vals = [s[axis] for s in samples]
        mean = sum(vals) / len(vals)
        variance = sum((v - mean) ** 2 for v in vals) / len(vals)
        if variance > max_var:
            max_var = variance
    if max_jerk > 1.64:
        return "ACT_WALKING"
    elif max_var > 0.2:
        return "ACT_WORKING"
    else:
        return "ACT_STILL"


def get_noise_db(num_samples=256):
    # read samples and calculate RMS
    mean = 0
    for _ in range(num_samples):
        mean += mic.value
    mean //= num_samples

    rms = 0
    for _ in range(num_samples):
        diff = mic.value - mean
        rms += diff * diff
    rms = math.sqrt(rms / num_samples)

    if rms < 1:
        return 30.0  # floor to avoid log(0)

    db = 20 * (math.log(rms) / math.log(10))
    # clamp to expected range
    return max(30.0, min(100.0, db))


while True:
    # --- heart rate (runs every iteration, never blocks) ---
    num_samples = sensor.get_data_present()
    while num_samples > 0:
        red, ir = sensor.read_fifo()
        num_samples -= 1

        rolling.append(ir)
        if len(rolling) > 20:
            rolling.pop(0)
        mean = sum(rolling) // len(rolling)
        ac = ir - mean

        smoother.append(ac)
        if len(smoother) > 5:
            smoother.pop(0)
        ac = sum(smoother) // len(smoother)

        window_ac.append(ac)
        if len(window_ac) > 50:
            window_ac.pop(0)

        ac_min = min(window_ac)
        ac_max = max(window_ac)
        ac_range = ac_max - ac_min

        if ac_range > 10:
            threshold = ac_min + ac_range * 0.55
            if ac < threshold and not last_was_low:
                last_was_low = True
                now = time.monotonic()
                # print(f"BEAT detected, interval since last: {now - beat_times[-2]:.2f}s" if len(beat_times) >= 2 else "BEAT detected (first)")
                beat_times.append(now)

                if len(beat_times) > 4:
                    beat_times.pop(0)

                if len(beat_times) >= 2:
                    intervals = [beat_times[i] - beat_times[i-1] for i in range(1, len(beat_times))]
                    avg_interval = sum(intervals) / len(intervals)
                    new_bpm = 60.0 / avg_interval
                    if 40 <= new_bpm <= 200:
                        # if new reading is roughly half of current, we missed a beat
                        if bpm > 0 and abs(new_bpm * 2 - bpm) < 15:
                            new_bpm = new_bpm * 2
                        
                        # outlier check: if we have 3+ readings, check if new one is consistent
                        if len(beat_times) >= 3:
                            prev_intervals = intervals[:-1]
                            prev_bpm = 60.0 / (sum(prev_intervals) / len(prev_intervals))
                            if abs(new_bpm - prev_bpm) > 10:
                                pass  # outlier, skip
                            else:
                                bpm = new_bpm
                                # print(f"BEAT, BPM: {bpm:.1f}")
                        else:
                            bpm = new_bpm
                            # print(f"BEAT, BPM: {bpm:.1f}")
            elif ac > ac_min + ac_range * 0.5:
                last_was_low = False

        # print((ac,))

    # --- IMU sample collection (one sample per loop, no blocking) ---
    x, y, z = imu.acceleration
    imu_samples.append((x, y, z))
    if len(imu_samples) > 100:
        imu_samples.pop(0)

    # --- compute and report all sensors every REPORT_EVERY seconds ---
    now = time.monotonic()
    if now - last_report >= REPORT_EVERY:
        last_report = now

        last_db = get_noise_db()
        last_imu = get_imu_state(imu_samples)

        print(f"BPM: {bpm:.1f}, Noise: {last_db:.1f} dB, Motion: {last_imu}")

        payload = {
            "heart_rate": bpm,
            "noise_level": last_db,
            "imu_state": last_imu
        }
        try:
            response = requests.post(BACKEND_URL, json=payload)
            print("Posted:", response.status_code)
            response.close()
        except Exception as e:
            print("Post failed:", e)