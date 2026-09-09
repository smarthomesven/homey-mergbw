'use strict';

/**
 * MeRGBW BLE protocol helpers.
 * Reverse-engineered from com.mergbw.core.ble.CommandUtils / ColorUtils / CommandList.
 *
 * Frame format (outgoing, to CHARACTERISTIC_WRITEABLE 0000fff3-...):
 *   [0]      0x55           header
 *   [1]      cmdCode
 *   [2]      0xFF           sequence (fixed, non-DIY commands)
 *   [3]      length         total frame length (5 + payload.length)
 *   [4..n-2] payload
 *   [n-1]    checksum       (~sum(bytes[0..n-2])) & 0xFF
 *
 * Notify frames (from CHARACTERISTIC_NOTIFY 0000fff4-...) start with 0x56
 * and mirror cmdCode at index 1 (see RGBDeviceManager#setNotify ->
 * onNotifyData(device, data[1], data)).
 */

const CMD = {
  SYNC_STATUS: 0x00,
  POWER: 0x01,
  FIRMWARE_INFO: 0x02,
  SET_COLOR: 0x03,          // 4-byte HSV payload, see encodeColor()
  SET_PART_COLOR: 0x04,
  SET_BRIGHTNESS: 0x05,     // 2-byte big-endian, value = (percent0to100 *10)+50, see encodeBrightness()
  SET_MODE: 0x06,           // scene index, 2-byte big-endian
  SET_MUSIC_MODE: 0x07,
  SET_MUSIC_SENS: 0x08,
  SET_DIY_MODE: 0x09,
  SET_TIMER: 0x0a,
  SET_LED_NUM: 0x0b,
  SYNC_TIME: 0x0c,
  CONFIG_MODE: 0x0d,
  CHECK_BIND_STATE: 0x0e,
  SET_MODE_SPEED: 0x0f,     // 1 byte, 0-255
  SET_WHITE_LIGHT: 0x10,
  SET_WHITE_BRIGHTNESS: 0x11,
  SET_COLD_AND_WARM: 0x12,
};

const HEADER = 0x55;
const NOTIFY_HEADER = 0x56;
const SEQ_FIXED = 0xff;

function checksum(bytes, len) {
  let sum = 0;
  for (let i = 0; i < len; i++) sum += bytes[i] & 0xff;
  while (sum > 255) sum &= 255;
  return (~sum) & 0xff;
}

/**
 * Build a standard command frame, matching CommandUtils.getCommand().
 * @param {number} cmdCode
 * @param {Buffer|number[]|null} value
 * @returns {Buffer}
 */
function getCommand(cmdCode, value) {
  const payload = value ? Buffer.from(value) : Buffer.alloc(0);
  const length = 5 + payload.length;
  const buf = Buffer.alloc(length);
  buf[0] = HEADER;
  buf[1] = cmdCode & 0xff;
  buf[2] = SEQ_FIXED;
  buf[3] = length & 0xff;
  payload.copy(buf, 4);
  buf[length - 1] = checksum(buf, length - 1);
  return buf;
}

/** 2-byte big-endian, matching CommandUtils.getByteArray(). */
function getByteArray(value) {
  return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

/**
 * Encode power state. Confirmed working: value=[1] on, value=[0] off.
 */
function encodePower(on) {
  return getCommand(CMD.POWER, [on ? 1 : 0]);
}

/**
 * Encode brightness. Matches setBrightness(i):
 *   getCommand(5, getByteArray((i + 5) * 10))
 * where i is the UI slider, observed domain 0-95 -> device value 50-1000.
 * We expose this as a plain 0-100 percent, matching Homey's `dim` capability
 * (0.0-1.0), and rescale onto the confirmed-working device range.
 * @param {number} percent 0-100
 */
function encodeBrightness(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  // Reproduce the app's i -> (i+5)*10 curve. The app's slider tops out at 95
  // (giving 1000), so we rescale our 0-100 input onto that same 0-95 range
  // to stay inside the confirmed-working envelope.
  const i = Math.round((clamped / 100) * 95);
  const value = (i + 5) * 10;
  return getCommand(CMD.SET_BRIGHTNESS, getByteArray(value));
}

/**
 * Encode color. Matches ColorUtils.getHSVColorData(color):
 *   hue (0-360) as 2-byte BE int, saturation*1000 (0-1000) as 2-byte BE int.
 * No brightness/value component is sent here -- brightness is a separate
 * command (encodeBrightness). Confirmed working on real device.
 * @param {number} hue 0-360
 * @param {number} saturation 0-1 (fraction)
 */
function encodeColor(hue, saturation) {
  const h = Math.round(Math.max(0, Math.min(360, hue)));
  const s = Math.round(Math.max(0, Math.min(1, saturation)) * 1000);
  const hBytes = getByteArray(h);
  const sBytes = getByteArray(s);
  return getCommand(CMD.SET_COLOR, Buffer.concat([hBytes, sBytes]));
}

/** Request a full status sync frame (sent on connect by the stock app). */
function encodeSyncRequest() {
  return getCommand(CMD.SYNC_STATUS, null);
}

/**
 * Verify a frame's checksum, matching CommandUtils.checkValid().
 * Confirmed reliable for outgoing (0x55) frames only. Captured 0x56 notify
 * frames did NOT consistently satisfy this check (the "power on" sync
 * frame failed it while "power off" passed), so do not gate notify
 * parsing on this -- treat notify frames positionally instead
 * (see parseSyncStatus / getNotifyCmdCode).
 */
function checkValid(data) {
  let sum = 0;
  for (let i = 0; i < data.length - 1; i++) sum += data[i] & 0xff;
  while (sum > 255) sum &= 255;
  return ((~(sum + data[data.length - 1])) & 0xff) === 0;
}

/**
 * Parse a notify frame's cmdCode (mirrors RGBDeviceManager: data[1]).
 * Returns null if the frame is too short to contain a cmdCode byte.
 */
function getNotifyCmdCode(data) {
  if (!data || data.length < 2) return null;
  return data[1];
}

/**
 * Parse a CMD_SYNC_STATUS_REQ (0x00) notify frame's power state.
 * Only the power on/off bit has been confirmed by testing so far:
 *   last byte 0x32 -> on, 0x33 -> off.
 * All other fields in this frame (brightness/color/mode) are UNCONFIRMED --
 * extend this function once you've captured+correlated more notify frames
 * for those states. Returns null if the frame doesn't look like a sync
 * status frame or is too short.
 */
function parseSyncStatus(data) {
  if (!data || data.length < 1 || getNotifyCmdCode(data) !== CMD.SYNC_STATUS) return null;
  const last = data[data.length - 1];
  let on = null;
  if (last === 0x32) on = true;
  else if (last === 0x33) on = false;
  return { on, raw: data };
}

module.exports = {
  CMD,
  HEADER,
  NOTIFY_HEADER,
  getCommand,
  getByteArray,
  encodePower,
  encodeBrightness,
  encodeColor,
  encodeSyncRequest,
  checkValid,
  getNotifyCmdCode,
};