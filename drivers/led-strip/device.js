'use strict';

const Homey = require('homey');
const protocol = require('../../lib/protocol');

const SERVICE_UUID = 'fff0';
const CHARACTERISTIC_WRITEABLE = 'fff3';
const CHARACTERISTIC_NOTIFY = 'fff4';

const RECONNECT_DELAY_MS = 5000;

class MeRGBWDevice extends Homey.Device {

  async onInit() {
    this.peripheral = null;
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
    this._destroyed = false;

    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
    this.registerMultipleCapabilityListener(['light_hue', 'light_saturation'], this.onCapabilityColor.bind(this));
    //this.registerCapabilityListener('light_hue', this.onCapabilityColor.bind(this));
    //this.registerCapabilityListener('light_saturation', this.onCapabilityColor.bind(this));
    this.registerCapabilityListener('light_mode', () => Promise.resolve()); // no-op, just to avoid "no listener" warnings

    await this._connect();
  }

  async onUninit() {
    this._destroyed = true;
    await this._disconnect();
  }

  async _connect() {
    if (this._destroyed) return;
    try {
      const { peripheralUuid } = this.getStore();
      const advertisement = await this.homey.ble.find(peripheralUuid);
      const peripheral = await advertisement.connect();

      peripheral.once('disconnect', () => this._onDisconnected());

      // Give the peripheral a brief moment to settle after connecting.
      // Homey's own dev tools work reliably here because a human clicking
      // through each step naturally introduces this delay; our code was
      // firing discoverServices() -> discoverCharacteristics() back to
      // back, which appears to return characteristics as an empty array
      // (not an error) on this device when done too quickly.
      await this._sleep(300);

      const services = await peripheral.discoverServices();
      this.log('Discovered services:', services.map((s) => s.uuid).join(', ') || '(none)');
      const service = services.find((s) => this._normalizeUuid(s.uuid) === SERVICE_UUID);
      if (!service) throw new Error('MeRGBW GATT service (0xFFF0) not found');

      await this._sleep(300);

      const characteristics = await service.discoverCharacteristics();
      this.log('Discovered characteristics:', characteristics.map((c) => `${c.uuid} [${(c.properties || []).join(',')}]`).join(', ') || '(none)');
      this.writeCharacteristic = characteristics.find(
        (c) => this._normalizeUuid(c.uuid) === CHARACTERISTIC_WRITEABLE,
      );
      this.notifyCharacteristic = characteristics.find(
        (c) => this._normalizeUuid(c.uuid) === CHARACTERISTIC_NOTIFY,
      );
      if (!this.writeCharacteristic || !this.notifyCharacteristic) {
        throw new Error('MeRGBW characteristics (0xFFF3/0xFFF4) not found');
      }

      await this._sleep(300);

      // Notifications don't work correctly with Homey, skipping.

      this.peripheral = peripheral;
      await this.setAvailable();

      // Mirrors BaseDeviceDetailViewModel#initData(), which requests a
      // sync/status frame right after connecting.
      await this._write(protocol.encodeSyncRequest());

      this.log('MeRGBW device connected and ready');
    } catch (err) {
      this.error('Connect failed:', err.message);
      await this.setUnavailable("Could not connect to the light. Is it connected to power?").catch(() => {});
      this._scheduleReconnect();
    }
  }

  _normalizeUuid(uuid) {
    // Homey's BLE layer has been observed to report the service UUID in
    // full 128-bit form (e.g. "0000fff0-0000-1000-8000-00805f9b34fb") but
    // characteristic UUIDs in short 16-bit form (e.g. "fff3") for the same
    // device -- so normalize both down to the bare short form for
    // comparison rather than assuming either shape.
    const stripped = uuid.toLowerCase().replace(/-/g, '');
    if (stripped.length === 32 && stripped.startsWith('0000') && stripped.endsWith('00001000800000805f9b34fb')) {
      return stripped.slice(4, 8);
    }
    return stripped;
  }

  _sleep(ms) {
    return new Promise((resolve) => this.homey.setTimeout(resolve, ms));
  }

  _withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = this.homey.setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.then(
        (value) => { this.homey.clearTimeout(timer); resolve(value); },
        (err) => { this.homey.clearTimeout(timer); reject(err); },
      );
    });
  }

  async _disconnect() {
    if (this.reconnectTimeout) {
      this.homey.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.peripheral) {
      try {
        await this.peripheral.disconnect();
      } catch (err) {
        this.error('Disconnect error (ignored):', err.message);
      }
      this.peripheral = null;
      this.writeCharacteristic = null;
      this.notifyCharacteristic = null;
    }
  }

  _onDisconnected() {
    this.log('MeRGBW device disconnected');
    this.peripheral = null;
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
    this.setUnavailable('Disconnected').catch(() => {});
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._destroyed || this.reconnectTimeout) return;
    this.reconnectTimeout = this.homey.setTimeout(() => {
      this.reconnectTimeout = null;
      this._connect();
    }, RECONNECT_DELAY_MS);
  }

  /**
   * Parse incoming notify frames. Only CMD_SYNC_STATUS_REQ (power on/off)
   * has been confirmed against the real device so far -- see
   * lib/protocol.js#parseSyncStatus for what's known and what's still
   * unconfirmed (brightness/color/mode fields in this same frame).
   */
  _onNotify(data) {
    this.log('Notify:', data.toString('hex'));
    const status = protocol.parseSyncStatus(data);
    if (status && status.on !== null) {
      this.setCapabilityValue('onoff', status.on).catch(this.error);
    }
  }

  async _write(buffer) {
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

  async onCapabilityOnoff(value) {
    await this._write(protocol.encodePower(value));
  }

  async onCapabilityDim(value) {
    await this._write(protocol.encodeBrightness(value * 100));
  }

  async onCapabilityColor() {
    // light_hue and light_saturation are separate capabilities in Homey but
    // a single combined command in this protocol, so read both current
    // values whenever either one changes and send them together.
    const hue = this.getCapabilityValue('light_hue') || 0; // Homey: 0-1
    const saturation = this.getCapabilityValue('light_saturation') || 0; // Homey: 0-1
    await this._write(protocol.encodeColor(hue * 360, saturation));
  }

}

module.exports = MeRGBWDevice;