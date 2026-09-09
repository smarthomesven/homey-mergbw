'use strict';

const Homey = require('homey');

const SERVICE_UUID = '0000fff000001000800000805f9b34fb';
const MODEL_TAG = 'TG201A';

class MeRGBWDriver extends Homey.Driver {

  async onInit() {
    this.log('MeRGBW ledstrip driver initialized');
  }

  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover();

    return advertisements
      .filter((advertisement) => this._looksLikeMeRGBW(advertisement))
      .map((advertisement) => ({
        name: advertisement.localName || `MeRGBW ${advertisement.address}`,
        data: {
          id: advertisement.uuid,
        },
        store: {
          peripheralUuid: advertisement.uuid,
          address: advertisement.address,
        },
      }));
  }

  _looksLikeMeRGBW(advertisement) {
    const manufacturerData = advertisement.manufacturerData;
    if (manufacturerData) {
      const buf = Buffer.isBuffer(manufacturerData) ? manufacturerData : Buffer.from(manufacturerData);
      if (buf.includes(Buffer.from(MODEL_TAG, 'ascii'))) return true;
    }

    const nameMatches = advertisement.localName === 'LED Lights';
    const serviceMatches = (advertisement.serviceUuids || [])
      .some((uuid) => uuid.toLowerCase().replace(/-/g, '') === SERVICE_UUID
        || uuid.toLowerCase().replace(/-/g, '') === '3519');
    return nameMatches && serviceMatches;
  }

}

module.exports = MeRGBWDriver;