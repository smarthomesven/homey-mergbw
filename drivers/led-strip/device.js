'use strict';

const Homey = require('homey');
const protocol = require('../../lib/protocol');

const SERVICE_UUID = 'fff0';
const CHARACTERISTIC_WRITEABLE = 'fff3';
const CHARACTERISTIC_NOTIFY = 'fff4';

const IDLE_DISCONNECT_MS = 10000;

const CONNECT_RETRY_ATTEMPTS = 2;
const CONNECT_RETRY_DELAY_MS = 300;
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

    // Don't connect on init anymore -- only connect when a command needs
    // sending (see _ensureConnected), so the device sits disconnected and
    // leaves the mobile app free until Homey actually has something to say.
    await this.setAvailable();
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

  /**
   * (Re)arm the idle-disconnect timer after a successful command. A quick
   * burst of changes (e.g. dragging the color wheel, which fires hue and
   * saturation together) reuses one connection; once nothing happens for
   * IDLE_DISCONNECT_MS, we disconnect so the phone app can connect again.
   */
  _armIdleTimer() {
    this._clearIdleTimer();
    this.idleDisconnectTimer = this.homey.setTimeout(() => {
      this.idleDisconnectTimer = null;
      this._disconnect().catch((err) => this.error('Idle disconnect failed:', err.message));
    }, IDLE_DISCONNECT_MS);
  }

  /**
   * Ensure a connection is in place before sending a command, connecting
   * fresh if needed. Concurrent callers share a single in-flight connect
   * attempt instead of racing to connect twice.
   */
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
        // Whatever partial connection state this attempt left behind is
        // not trustworthy -- drop it entirely before retrying from scratch
        // (a fresh advertisement.connect(), not a reuse of the stale
        // peripheral/service handles that caused the failure).
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
    const writeCharacteristic = characteristics.find(
      (c) => this._normalizeUuid(c.uuid) === CHARACTERISTIC_WRITEABLE,
    );
    const notifyCharacteristic = characteristics.find(
      (c) => this._normalizeUuid(c.uuid) === CHARACTERISTIC_NOTIFY,
    );
    if (!writeCharacteristic || !notifyCharacteristic) {
      throw new Error('MeRGBW characteristics (0xFFF3/0xFFF4) not found');
    }

    // Notifications don't work correctly with Homey, skipping.

    this.peripheral = peripheral;
    this.writeCharacteristic = writeCharacteristic;
    this.notifyCharacteristic = notifyCharacteristic;
    await this.setAvailable();

    // Mirrors BaseDeviceDetailViewModel#initData(), which requests a
    // sync/status frame right after connecting.
    await this._writeRaw(protocol.encodeSyncRequest());

    this.log('MeRGBW device connected and ready');
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
    // Fires both for our own idle-disconnect and for an unexpected drop
    // (device power loss, phone app taking over the single connection
    // slot, etc). Either way, just clear state -- the next capability
    // write reconnects on demand, so there is no background reconnect
    // loop or "unavailable" tile for a disconnect that was intentional.
    this.log('MeRGBW device disconnected');
    this._clearIdleTimer();
    this.peripheral = null;
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
  }

  /**
   * Parse incoming notify frames. Unused for now -- notify subscription is
   * skipped entirely (known-broken on Homey against this class of device).
   * Left in place in case that's ever fixed on Homey's side.
   */
  _onNotify(data) {
    this.log('Notify:', data.toString('hex'));
    const status = protocol.parseSyncStatus(data);
    if (status && status.on !== null) {
      this.setCapabilityValue('onoff', status.on).catch(this.error);
    }
  }

  /** Raw write, no connect-ensuring or idle-timer side effects -- used internally by _connect's own sync request. */
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

  /**
   * Public write path for capability listeners: ensures connection, writes,
   * then arms the idle-disconnect timer. Retries once (reconnecting first)
   * if the strip drops the connection mid-write -- confirmed to happen
   * unpredictably on this device even outside Homey (same behavior seen in
   * nRF Connect), so this isn't a one-off to just log and move past.
   */
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
        // The connection this write was using is no longer trustworthy
        // (whether it dropped mid-write or was never really established) --
        // discard it so the next attempt's _ensureConnected() reconnects
        // from scratch rather than retrying against a dead peripheral.
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
    // registerMultipleCapabilityListener passes an object containing
    // whichever of the registered capabilities changed; fall back to the
    // currently stored value for whichever one didn't.
    const hue = (values.light_hue !== undefined ? values.light_hue : this.getCapabilityValue('light_hue')) || 0;
    const saturation = (values.light_saturation !== undefined ? values.light_saturation : this.getCapabilityValue('light_saturation')) || 0;
    await this._write(protocol.encodeColor(hue * 360, saturation));
  }

}

module.exports = MeRGBWDevice;