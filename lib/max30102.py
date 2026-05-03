# -*-coding:utf-8-*-
# Adapted for CircuitPython: replaces smbus with busio.I2C
 
import time
import busio
import board

# register addresses
REG_INTR_STATUS_1 = 0x00
REG_INTR_STATUS_2 = 0x01

REG_INTR_ENABLE_1 = 0x02
REG_INTR_ENABLE_2 = 0x03

REG_FIFO_WR_PTR = 0x04
REG_OVF_COUNTER = 0x05
REG_FIFO_RD_PTR = 0x06
REG_FIFO_DATA = 0x07
REG_FIFO_CONFIG = 0x08

REG_MODE_CONFIG = 0x09
REG_SPO2_CONFIG = 0x0A
REG_LED1_PA = 0x0C

REG_LED2_PA = 0x0D
REG_PILOT_PA = 0x10
REG_MULTI_LED_CTRL1 = 0x11
REG_MULTI_LED_CTRL2 = 0x12

REG_TEMP_INTR = 0x1F
REG_TEMP_FRAC = 0x20
REG_TEMP_CONFIG = 0x21
REG_PROX_INT_THRESH = 0x30
REG_REV_ID = 0xFE
REG_PART_ID = 0xFF


class MAX30102:
    def __init__(self, i2c=None, address=0x57):
        self.address = address
        if i2c is None:
            self.i2c = busio.I2C(board.SCL1, board.SDA1)  # QT Py ESP32-S3 STEMMA QT port
        else:
            self.i2c = i2c
 
        self.reset()
        time.sleep(1)
 
        # read & clear interrupt register
        self._read_register(REG_INTR_STATUS_1, 1)
        self.setup()
    def _write_register(self, reg, data):
        """Write one or more bytes to a register."""
        if isinstance(data, int):
            data = [data]
        buf = bytes([reg] + data)
        while not self.i2c.try_lock():
            pass
        try:
            self.i2c.writeto(self.address, buf)
        finally:
            self.i2c.unlock()
 
    def _read_register(self, reg, length):
        """Read `length` bytes from a register, return as bytearray."""
        buf = bytearray(length)
        while not self.i2c.try_lock():
            pass
        try:
            self.i2c.writeto(self.address, bytes([reg]))
            self.i2c.readfrom_into(self.address, buf)
        finally:
            self.i2c.unlock()
        return buf
 
    def _read_byte(self, reg):
        return self._read_register(reg, 1)[0]
 
    # ------------------------------------------------------------------ #
    # public API (same interface as original)                              #
    # ------------------------------------------------------------------ #
 
    def shutdown(self):
        self._write_register(REG_MODE_CONFIG, [0x80])
 
    def reset(self):
        self._write_register(REG_MODE_CONFIG, [0x40])
 
    def setup(self, led_mode=0x03):
        self._write_register(REG_INTR_ENABLE_1, [0xc0])
        self._write_register(REG_INTR_ENABLE_2, [0x00])
 
        self._write_register(REG_FIFO_WR_PTR, [0x00])
        self._write_register(REG_OVF_COUNTER, [0x00])
        self._write_register(REG_FIFO_RD_PTR, [0x00])
 
        # sample avg = 4, fifo rollover = TRUE (0x5f), fifo almost full = 17
        # rollover enabled so FIFO keeps writing when full instead of stopping
        self._write_register(REG_FIFO_CONFIG, [0x5f])

        self._write_register(REG_MODE_CONFIG, [led_mode])
        # SPO2_ADC range = 4096nA, sample rate = 100Hz, pulse-width = 411uS
        self._write_register(REG_SPO2_CONFIG, [0x27])

        self._write_register(REG_LED1_PA, [0x1f])   # ~25mA (was 0x24 ~7mA, too low)
        self._write_register(REG_LED2_PA, [0x1f])   # ~25mA
        self._write_register(REG_PILOT_PA, [0x7f])  # ~25mA
 
    def set_config(self, reg, value):
        self._write_register(reg, value)
 
    def get_data_present(self):
        read_ptr  = self._read_byte(REG_FIFO_RD_PTR)
        write_ptr = self._read_byte(REG_FIFO_WR_PTR)
        if read_ptr == write_ptr:
            return 0
        num_samples = write_ptr - read_ptr
        if num_samples < 0:
            num_samples += 32
        return num_samples
 
    def read_fifo(self):
        # read 6 bytes directly - no interrupt clearing here, that was
        # adding 2 extra I2C transactions per sample and causing FIFO overflow
        d = self._read_register(REG_FIFO_DATA, 6)
        red_led = (d[0] << 16 | d[1] << 8 | d[2]) & 0x03FFFF
        ir_led  = (d[3] << 16 | d[4] << 8 | d[5]) & 0x03FFFF
        return red_led, ir_led
 
    def read_sequential(self, amount=100):
        red_buf = []
        ir_buf  = []
        count   = amount
        while count > 0:
            num_bytes = self.get_data_present()
            while num_bytes > 0:
                red, ir = self.read_fifo()
                red_buf.append(red)
                ir_buf.append(ir)
                num_bytes -= 1
                count -= 1
        return red_buf, ir_buf