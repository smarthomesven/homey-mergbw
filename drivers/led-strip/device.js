'use strict';

const Homey = require('homey');
const protocol = require('../../lib/protocol');

const SERVICE_UUID = 'fff0';
const CHARACTERISTIC_WRITEABLE = 'fff3';
const CHARACTERISTIC_NOTIFY = 'fff4';

const IDLE_DISCONNECT_MS = 4000;
const CONNECT_RETRY_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 500;
const WRITE_RETRY_ATTEMPTS = 2;

class MeRGBWDevice extends Homey.Device {

  async onInit() {
    this.peripheral = null;
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
    this._destroyed = false;
    this.idleDisconnectTimer = null;
    this._connectingPromise = null;

    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
    this.registerMultipleCapabilityListener(['light_hue', 'light_saturation'], this.onCapabilityColor.bind(this));
    this.registerCapabilityListener('light_mode', () => Promise.resolve()); // no-op, just to avoid "no listener" warnings
  }

  async onUninit() {
    this._destroyed = true;
    this._clearIdleTimer();
    await this._disconnect();
  }

  _clearIdleTimer() {
    if (this.idleDisconnectTimer) {
      this.homey.clearTimeout(this.idleDisconnectTimer);
      this.idleDisconnectTimer = null;
    }
  }

  _armIdleTimer() {
    this._clearIdleTimer();
    this.idleDisconnectTimer = this.homey.setTimeout(() => {
      this.idleDisconnectTimer = null;
      this._disconnect().catch((err) => this.error('Idle disconnect failed:', err.message));
    }, IDLE_DISCONNECT_MS);
  }

  async _ensureConnected() {
    if (this.peripheral && this.writeCharacteristic) {
      this._clearIdleTimer();
      return;
    }
    if (this._connectingPromise) {
      await this._connectingPromise;
      return;
    }
    this._connectingPromise = this._connect();
    try {
      await this._connectingPromise;
    } finally {
      this._connectingPromise = null;
    }
  }

  async _connect() {
    if (this._destroyed) return;
    let lastErr;
    for (let attempt = 1; attempt <= CONNECT_RETRY_ATTEMPTS; attempt++) {
      try {
        await this._connectOnce();
        return;
      } catch (err) {
        lastErr = err;
        const retryable = err.message === 'could_not_find_service'
          || err.message === 'could_not_find_characteristic'
          || err.message === 'MeRGBW GATT service (0xFFF0) not found'
          || err.message === 'MeRGBW characteristics (0xFFF3/0xFFF4) not found';
        this.error(`Connect attempt ${attempt}/${CONNECT_RETRY_ATTEMPTS} failed:`, err.message);
        await this._disconnect();
        if (!retryable || attempt === CONNECT_RETRY_ATTEMPTS) break;
        await this._sleep(CONNECT_RETRY_DELAY_MS);
      }
    }
    throw lastErr;
  }

  async _connectOnce() {
    const { peripheralUuid } = this.getStore();
    const advertisement = await this.homey.ble.find(peripheralUuid);
    const peripheral = await advertisement.connect();

    peripheral.once('disconnect', () => this._onDisconnected());
    await this._sleep(300);

    const services = await peripheral.discoverServices();
    this.log('Discovered services:', services.map((s) => s.uuid).join(', ') || '(none)');
    const service = services.find((s) => this._normalizeUuid(s.uuid) === SERVICE_UUID);
    if (!service) throw new Error('MeRGBW GATT service (0xFFF0) not found');

    await this._sleep(300);

    const characteristics = await service.discoverCharacteristics();
    this.log('Discovered characteristics:', characteristics.map((c) => `${c.uuid} [${(c.properties || []).join(',')}]`).join(', ') || '(none)');
    const writeCharacteristic = characteristics.find(
      (c) => this._normalizeUuid(c.uuid) === CHARACTERISTIC_WRITEABLE,
    );
    const notifyCharacteristic = characteristics.find(
      (c) => this._normalizeUuid(c.uuid) === CHARACTERISTIC_NOTIFY,
    );
    if (!writeCharacteristic || !notifyCharacteristic) {
      throw new Error('MeRGBW characteristics (0xFFF3/0xFFF4) not found');
    }

    this.peripheral = peripheral;
    this.writeCharacteristic = writeCharacteristic;
    this.notifyCharacteristic = notifyCharacteristic;
    await this._writeRaw(protocol.encodeSyncRequest());

    try {
      await this._writeRaw(protocol.encodeTimeSync(this._getLocalDate()));
    } catch (err) {
      this.error('Time sync failed (non-fatal):', err.message);
    }

    this.log('MeRGBW device connected and ready');
  }

  _getLocalDate() {
    const timezone = this.homey.clock.getTimezone();
    const now = new Date();
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(now);
      const get = (type) => parts.find((p) => p.type === type).value;
      const hour = Number(get('hour')) % 24;
      return new Date(
        Number(get('year')),
        Number(get('month')) - 1,
        Number(get('day')),
        hour,
        Number(get('minute')),
        Number(get('second')),
      );
    } catch (err) {
      this.error('Could not resolve timezone, falling back to system time:', err.message);
      return now;
    }
  }

  _normalizeUuid(uuid) {
    const stripped = uuid.toLowerCase().replace(/-/g, '');
    if (stripped.length === 32 && stripped.startsWith('0000') && stripped.endsWith('00001000800000805f9b34fb')) {
      return stripped.slice(4, 8);
    }
    return stripped;
  }

  _sleep(ms) {
    return new Promise((resolve) => this.homey.setTimeout(resolve, ms));
  }

  async _disconnect() {
    this._clearIdleTimer();
    if (this.peripheral) {
      const peripheral = this.peripheral;
      this.peripheral = null;
      this.writeCharacteristic = null;
      this.notifyCharacteristic = null;
      try {
        await peripheral.disconnect();
      } catch (err) {
        this.error('Disconnect error (ignored):', err.message);
      }
    }
  }

  _onDisconnected() {
    this.log('MeRGBW device disconnected');
    this._clearIdleTimer();
    this.peripheral = null;
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
  }

  _onNotify(data) {
    this.log('Notify:', data.toString('hex'));
    const status = protocol.parseSyncStatus(data);
    if (status && status.on !== null) {
      this.setCapabilityValue('onoff', status.on).catch(this.error);
    }
  }

  async _writeRaw(buffer) {
    if (!this.peripheral || !this.writeCharacteristic) {
      throw new Error('Not connected');
    }
    this.log('Writing:', buffer.toString('hex'));
    try {
      const result = await this.writeCharacteristic.write(buffer);
      this.log('Write resolved, result:', result ? result.toString('hex') : '(empty)');
    } catch (err) {
      this.error('Write threw:', err.message);
      throw err;
    }
  }

  async _write(buffer) {
    let lastErr;
    for (let attempt = 1; attempt <= WRITE_RETRY_ATTEMPTS; attempt++) {
      try {
        await this._ensureConnected();
        await this._writeRaw(buffer);
        this._armIdleTimer();
        return;
      } catch (err) {
        lastErr = err;
        this.error(`Write attempt ${attempt}/${WRITE_RETRY_ATTEMPTS} failed:`, err.message);
        await this._disconnect();
        if (attempt === WRITE_RETRY_ATTEMPTS) break;
      }
    }
    throw lastErr;
  }

  async onCapabilityOnoff(value) {
    await this._write(protocol.encodePower(value));
  }

  async onCapabilityDim(value) {
    await this._write(protocol.encodeBrightness(value * 100));
  }

  async onCapabilityColor(values) {
    const hue = (values.light_hue !== undefined ? values.light_hue : this.getCapabilityValue('light_hue')) || 0;
    const saturation = (values.light_saturation !== undefined ? values.light_saturation : this.getCapabilityValue('light_saturation')) || 0;
    await this._write(protocol.encodeColor(hue * 360, saturation));
  }

}

module.exports = MeRGBWDevice;