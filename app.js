const { join : pathJoin }           = require('node:path');
const { mkdir, access, rm : rmdir } = require('node:fs/promises');
const { chdir }                     = require('node:process');
const debounce                      = require('debounce');
const Homey                         = require('homey');
const Constants                     = require('./constants');
const DeviceMapper                  = require('./lib/device-mapper');
const { HomeyAPI }                  = require('./modules/homey-api');
const {
  Bridge, Service, Characteristic, Categories,Accessory,AdaptiveLightingController, AccessoryEventTypes, uuid } = require('hap-nodejs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function defer() {
  const deferred = {};
  const promise  = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject  = reject;
  });
  deferred.promise = promise;
  return deferred;
}

module.exports = class HomeKitty extends Homey.App {
  #api           = null;
  #bridge        = null;
  #persistDir    = null;
  #watching      = false;
  #devicesMapped = defer();
  #bridgeReady   = defer();
  #bridgeStarted = defer();
  #exposed       = null;

  async onInit() {
    this.log('');
    this.log(`🐈🏠 ✧･ﾟ: *✧･ﾟWᴇʟᴄᴏᴍᴇ ᴛᴏ HᴏᴍᴇKɪᴛᴛʏ v${ this.manifest.version } ﾟ･✧*:･ﾟ✧ 🏠🐈`);
    this.log('');

    // initialize API handlers
    await this.initializeApiHandlers();

    // create persistence directory
    await this.initializePersistence();

// *** HAP ***
const hapStoragePath = pathJoin(this.#persistDir, 'hap-storage');
require('hap-nodejs').HAPStorage.setCustomStoragePath(hapStoragePath);
this.log(`HAP storage path set to ${ hapStoragePath }`);
// *** End block ***


    // perform a reset
    if (Homey.env.HOMEKITTY_RESET === 'true') {
      await this.reset();
    }

    // initialize expose map
    this.initializeExposeMap();

    // initialize Homey Web API
    await this.initializeWebApi();

    // configure the bridge
    await this.configureBridge();

    // start second stage, since `onInit` isn't allowed to take longer than 30
    // seconds and we might need to wait for devices to settle first after
    // a reboot; we also need to wait for our own drivers/devices to be
    // initialized before we continue.
    this.onInit2();
  }

  async onInit2() {
    // wait for devices to settle
    await this.settleDevices();

    // map all supported devices
    await this.mapDevices();

    // watch for device updates
    await this.watchDevices();

    // wait for all drivers and devices to become ready
    const drivers = this.homey.drivers.getDrivers();
    for (const driver of Object.values(drivers)) {
      await driver.ready();
      for (const device of driver.getDevices()) {
        await device.ready();
      }
    }
    this.log('all our drivers and devices ready');

    // start the bridge
    this.startBridge();
  }

  onUninit() {
    this.log('[onUninit] saving expose map');
    this.#exposed.save();
  }

  async initializeApiHandlers() {
    for (const [ name, fn ] of Object.entries(this.api)) {
      this.api[name] = fn.bind(this);
    }
  }

  async initializePersistence() {
    const persistDir = this.#persistDir = pathJoin(Constants.PERSISTENCE_DIRECTORY_PREFIX, Constants.BRIDGE_FIRMWARE_REVISION);

    try {
      await access(persistDir);
      this.log(`persistence directory '${ persistDir }' exists`);
    } catch(e) {
      this.log(`creating persistence directory '${ persistDir }:`);
      try {
        await mkdir(persistDir, { recursive : true });
        this.log(`- success 🥳`);
      } catch(e) {
        this.error(`- failed 😭`);
        this.error(e);
        // cannot continue
        throw Error(`Internal Error (mkdir: ${ e.message })`);
      }
    }
    this.log(`changing to persistence directory:`);
    try {
      chdir(persistDir);
      this.log(`- success 🥳`);
    } catch(e) {
      this.error(`- failed 😭`);
      this.error(e);
      // cannot continue
      throw Error(`Internal Error (chdir: ${ e.message })`);
    }
  }

  async initializeExposeMap() {
    this.#exposed = new StorageBackedMap(
      this.homey.settings.get(Constants.SETTINGS_EXPOSE_MAP),
      data => this.homey.settings.set(Constants.SETTINGS_EXPOSE_MAP, data)
    );
    this.homey.on('unload', () => {
      this.log('[onUnload] saving expose map');
      this.#exposed.save();
    });
    // watch for (un)expose all setting change (from the app settings page)
    this.homey.settings.on('set', key => {
      if (key != 'Settings.SetExposureState') return;

      // get the new exposure state for all devices
      const state = this.homey.settings.get('Settings.SetExposureState');
      if (state !== true && state !== false) return;

      // remove the setting
      this.homey.settings.unset('Settings.SetExposureState');

      // set it
      this.log('setting exposure state for all devices to', state);
      this.#exposed.setAll(state);

      // restart app
      this.exit();
    });
  }

  async initializeWebApi() {
    this.#api = await HomeyAPI.createAppAPI({ homey: this.homey });

    // have to do this really early to work around a bug in the Web API (if
    // `getDevices()` is called before `connect()`, a call to `getDevices()`
    // _after_ `connect()` will not yield any results).
    await this.#api.devices.connect();
  }

  async settleDevices() {
    // If Homey has booted in the last 10 minutes, we'll wait a while for all
    // devices to get created properly before we start.
    try {
      const uptime = (await this.#api.system.getInfo()).uptime;
      if (uptime > 600) {
        this.log('no need to wait for devices to settle');
        return;
      }
    } catch(e) {
      // ignored, as most likely the `getInfo()` call timed out
    }
    this.log('Homey was rebooted recently');

    // Check if the user has configured a delayed start
    const delayAppStart = Number(this.homey.settings.get(Constants.SETTINGS_APP_DELAY_AFTER_REBOOT) || 0);
    if (delayAppStart >= 0) {
      this.log(`Delaying app start for ${ delayAppStart } seconds...`);
      await delay(delayAppStart * 1000);
    }

    this.log('Waiting for devices to settle...');

    // Check every minute if the number of devices has changed. Once it hasn't,
    // we'll assume all devices have been created and we can continue.
    let previousCount = 0;
    while (true) {
      const newCount = Object.keys(await this.getDevices()).length;
      if (newCount && newCount === previousCount) {
        this.log(`devices have settled (counted ${ newCount } in total)`);
        break;
      }
      previousCount = newCount;
      this.log(`devices have not yet settled, waiting for 60 seconds...`);
      await delay(60000);
    }
  }

  async configureBridge() {
    const identifier = this.homey.settings.get(Constants.SETTINGS_BRIDGE_IDENTIFIER) || Constants.DEFAULT_BRIDGE_IDENTIFIER;

    this.log('setting up HomeKit bridge:');
    this.log(`- using "${ identifier }" as bridge identifier`);

    this.#bridge = new Bridge(identifier, uuid.generate(identifier));
    this.#bridge.getService(Service.AccessoryInformation)
                .setCharacteristic(Characteristic.Manufacturer,     'Athom')
                .setCharacteristic(Characteristic.Model,            'Homey')
                .setCharacteristic(Characteristic.SerialNumber,     uuid.generate(identifier))
                .setCharacteristic(Characteristic.FirmwareRevision, Constants.BRIDGE_FIRMWARE_REVISION);

    // Allow for virtual devices to add themselves to the bridge now.
    this.#bridgeReady.resolve();

    // Listen for bridge identification events
    this.#bridge.on(AccessoryEventTypes.IDENTIFY, (paired, callback) => {
      this.log('`identify` called on bridge');
      callback();
    });

    // Store current identifier.
    this.homey.settings.set(Constants.SETTINGS_BRIDGE_IDENTIFIER, identifier);

    // watch for changes of the identifier (from the app settings page)
    this.homey.settings.on('set', key => {
      if (key !== Constants.SETTINGS_BRIDGE_IDENTIFIER) return;
      const identifier = this.homey.settings.get(Constants.SETTINGS_BRIDGE_IDENTIFIER);
      this.log(`bridge identifier has changed to '${ identifier }', will stop bridge and app!`);
      this.exit();
    });
  }

  async startBridge() {
    const { username, port, pincode, setupID } = this.getBridgeCredentials();

    this.log(`- using bridge credentials: username=${ username} port=${ port } setupID=${ setupID } pincode=${ pincode }`);

    try {
      this.log(`- starting bridge:`);
      await this.#bridge.publish({
        username,
        port,
        setupID,
        pincode,
        category: Categories.BRIDGE
      });
      this.log('  - started successfully! 🥳');
      // store current credentials
      this.homey.settings.set(Constants.SETTINGS_BRIDGE_USERNAME,   username);
      this.homey.settings.set(Constants.SETTINGS_BRIDGE_PORT,       port);
      this.homey.settings.set(Constants.SETTINGS_BRIDGE_SETUP_ID,   setupID);
      this.homey.settings.set(Constants.SETTINGS_BRIDGE_PINCODE,    pincode);
      this.#bridgeStarted.resolve();
    } catch(e) {
      this.error('  - unable to start! 😭');
      this.error(e);
      // cannot continue
      throw Error(`Internal Error (publish: ${ e.message })`);
    }
  }

  async getBridge(wait = true) {
    if (wait) {
      await this.#bridgeReady;
    }
    return this.#bridge;
  }

  getBridgeCredentials() {
    return {
      username : this.homey.settings.get(Constants.SETTINGS_BRIDGE_USERNAME) || this.generateBridgeUsername(),
      port     : this.homey.settings.get(Constants.SETTINGS_BRIDGE_PORT)     || this.generateBridgePort(),
      setupID  : this.homey.settings.get(Constants.SETTINGS_BRIDGE_SETUP_ID) || Constants.DEFAULT_SETUP_ID,
      pincode  : this.homey.settings.get(Constants.SETTINGS_BRIDGE_PINCODE)  || Constants.DEFAULT_PIN_CODE,
    };
  }

  generateBridgeUsername() {
    return 'XX:XX:XX:XX:XX:XX'.replace(/X/g, () => '0123456789ABCDEF'.charAt(Math.floor(Math.random() * 16)));
  }

  generateBridgePort() {
    // combination of IANA and Linux ranges: 49152 to 60999
    return 49152 + (0 | Math.random() * 11847);
  }

  async mapDevices() {
    // use the app logger for the device mapper
    DeviceMapper.setLogger(this.log.bind(this));

    // get all devices and try to map them
    for (const [ id, device ] of Object.entries(await this.getDevices())) {
      await this.addDeviceToHomeKit(device);
    }

    // save exposure map
    this.#exposed.save();

    // done mapping devices
    this.#devicesMapped.resolve();
  }

  // XXX: make sure a device isn't already mapped
  async addDeviceToHomeKit(device) {
    // don't add our own devices like this
    if (this.isVirtualDevice(device)) return;

    // XXX: make sure we have an actual useable device
    const prefix = `[${ device?.name || "NO NAME" }:${ device?.id || "NO_ID" }]`;
    if (! device || ! device.ready || ! device.capabilitiesObj) {
      this.error(`${ prefix } device not ready or doesn't have capabilitiesObj`);
      return false;
    }

    // if we don't know the exposure state of the device (i.e. it's new to us),
    // use the user-defined default.
    if (! this.#exposed.has(device.id)) {
      const exposureState = this.homey.settings.get('Settings.NewDevicePublish') ?? true;
      this.log(`${ prefix } device not in exposed map, setting exposure state to "${ exposureState }"`);
      this.#exposed.set(device.id, exposureState);
    }

    this.log(`${ prefix } trying mapper`);
    const mappedDevice = DeviceMapper.mapDevice(device);
    if (mappedDevice) {
      this.log(`${ prefix } was able to map 🥳`);

      // expose it to HK unless the user doesn't want to
      if (this.#exposed.get(device.id) !== false) {
        this.log(`${ prefix } - device should be exposed`);
        try {
          this.#bridge.addBridgedAccessory(mappedDevice.accessorize());
        } catch(e) {
          this.log(`${ prefix } - unable to expose device: ${ e.message }`);
          this.error(e);
          return false;
        }
      } else {
        this.log(`${ prefix } - device not exposed`);
      }
      return true;
    }
    this.#exposed.set(device.id, false);
    this.log(`${ prefix } unable to map 🥺 (class=${ device.class } virtualClass=${ device.virtualClass } capabilities=${ device.capabilities })`);
    return false;
  }

  async deleteDevice(device) {
    // delete device from HomeKit
    await this.deleteDeviceFromHomeKit(device);
    // delete device from the exposure list
    this.#exposed.delete(device.id);
    this.#exposed.save();
  }

  getAccessoryById(id) {
    const UUID = uuid.generate(id);
    return this.#bridge.bridgedAccessories.find(r => r.UUID === UUID);
  }

  async deleteDeviceFromHomeKit(device) {
    let accessory = this.getAccessoryById(device.id);
    if (! accessory) return false;
    this.log(`[${ device.id }] removing device from HomeKit:`);
    try {
      this.#bridge.removeBridgedAccessory(accessory);
      await accessory.destroy();
      DeviceMapper.forgetDevice(device);
      this.log(`- success 🥳`);
      return true;
    } catch(e) {
      this.log(`- failed 🥺`);
      this.error(e);
      return false;
    }
  }

  async getDevices() {
    // HomeyAPIV3 doesn't set zoneName property (unlike V2)
    // so we'll set it ourselves.
    const [ zones, devices ] = await Promise.all([
      this.#api.zones.getZones(),
      this.#api.devices.getDevices()
    ]);

    for (const device of Object.values(devices)) {
      device._zoneName = zones[device.zone].name;
    }

    return devices;
  }

  async getDeviceById(id) {
    return await this.#api.devices.getDevice({ id });
  }

  isVirtualDevice(device) {
    return !!device?.driverId?.startsWith('homey:app:name.klep.homekitty:');
  }

  isHomeyDevice(device) {
    return !!device?.driverId === 'homey:manager:vdevice:homey';
  }

  async reset(delayedExit = false) {
    this.log('resetting credentials');
    // reset credentials and persistence (start over)
    this.homey.settings.unset(Constants.SETTINGS_BRIDGE_IDENTIFIER);
    this.homey.settings.unset(Constants.SETTINGS_BRIDGE_USERNAME);
    this.homey.settings.unset(Constants.SETTINGS_BRIDGE_PORT);
    this.homey.settings.unset(Constants.SETTINGS_BRIDGE_SETUP_ID);
    this.homey.settings.unset(Constants.SETTINGS_BRIDGE_PINCODE);
    this.homey.settings.unset(Constants.SETTINGS_EXPOSE_MAP);
    try {
      this.log('removing persistence directory:');
      await rmdir(this.#persistDir, { recursive : true });
      this.log('- success 🥳');
    } catch(e) {
      this.error('- failed 😭 ');
      this.error(e);
    }
    // API calls may want to set this, otherwise the app exits
    // before the API call gets a response and the frontend balks.
    if (delayedExit) {
      return setTimeout(() => this.exit(), 1000);
    }
    this.exit();
  }

  async exit() {
    await this.#bridge.unpublish();
    await this.notify(this.homey.i18n.__('app.stopping'));
    process.exit(0);
  }

  async notify(excerpt) {
    await this.homey.notifications.createNotification({ excerpt });
  }

  async watchDevices() {
    if (this.#watching) return;
    this.#watching = true;

    this.#api.devices.on('device.create', device => {
      if (this.isVirtualDevice(device)) return;
      this.log(`[EV] device created — name=${ device.name} id=${ device.id } driver=${ device.driverId }`);
    });

    this.#api.devices.on('device.delete', async (device) => { // really just `{ id }`
      if (this.isVirtualDevice(device)) return;
      this.log(`[EV] device deleted — id=${ device.id }`);
      await this.deleteDevice(device);
    });

    // debounce update events because they may get emitted
    // multiple times during device creation
    this.#api.devices.on('device.update', debounce(async (device) => {
      if (this.isVirtualDevice(device)) return;
      this.log(`[EV] device updated — name=${ device.name} id=${ device.id } driver=${ device.driverId }`);
      if (! device.ready || ! device.capabilitiesObj) {
        this.log(`- device incomplete, skipping further handling for now`);
        return;
      }

      // newly created devices are not passed as instance anymore
      if (! device.makeCapabilityInstance) {
        device = await this.#api.devices.getDevice({ id : device.id });
      }

      // check if device is already exposed through HomeKit
      let accessory = this.getAccessoryById(device.id);
      let addDevice = true;
      if (accessory) {
        this.log(`- already exposed via HomeKit (reachable: ${ !!device.available })`);

        // retrieve mapped device instance
        const mappedDevice = DeviceMapper.getDeviceById(device.id);

        // check if capabilities have changed
        const capsBefore = [...mappedDevice.getCapabilities()].sort().join(',');
        const capsAfter  = [...device.capabilities].sort().join(',');
        if (capsBefore !== capsAfter) {
          this.log(`- capabilities have changed (before=${ capsBefore } after=${ capsAfter })`)
          this.log(`- will have to add device again as new`);
          await this.deleteDeviceFromHomeKit(device);
        }
        // check if device class has changed
        else if (mappedDevice.getClass() !== device.class) {
          this.log(`- device class has changed (before=${ mappedDevice.getClass() } after=${ device.class })`)
          this.log(`- will have to add device again as new`);
          await this.deleteDeviceFromHomeKit(device);
        }
        // device hasn't changed
        else {
          addDevice = false;
        }
      } else {
        this.log('- not yet exposed via HomeKit, will add it as new');
      }
      if (addDevice) {
        if (await this.addDeviceToHomeKit(device)) {
          await this.#exposed.save();
        }
      }
    }, 500));
  }

  api = {
    async getDevices() {
      // wait for devices to be mapped
      await this.#devicesMapped;

      // return the list of devices
      return Object.values(await this.getDevices())
        .filter(device => ! this.isVirtualDevice(device) && ! this.isHomeyDevice(device))
        .map(device => {
          // pass the device state (supported/exposed) to the API
          device.homekitty = {
            supported: DeviceMapper.canMapDevice(device),
            exposed:   this.#exposed.get(device.id) !== false,
          }
          return device;
        });
    },

    async exposeDevice(id) {
      const device = await this.getDeviceById(id);
      if (! device) {
        throw Error('API_ADD_DEVICE_FAILED');
      }

      // check if device is available; if not, we'll only update its exposure
      // status and let the user know we can't add it at the moment.
      if (! device.available) {
        this.#exposed.set(id, true);
        this.#exposed.save();
        throw Error('API_DEVICE_UNAVAILABLE');
      }

      // update exposure state (before we try to add it)
      const oldExposureState = this.#exposed.get(id);
      this.#exposed.set(id, true);
      this.#exposed.save();

      if (! await this.addDeviceToHomeKit(device)) {
        // restore old exposure state
        this.#exposed.set(id, oldExposureState);
        this.#exposed.save();
        // throw the appropriate exception
        if (this.#bridge.bridgedAccessories.length >= 149) {
          throw Error('API_DEVICE_LIMIT_REACHED');
        }
        throw Error('API_ADD_DEVICE_FAILED');
      }

      // done
      return 'ok';
    },

    async unexposeDevice(id) {
      // check if device was actually added (it may not have because the
      // HomeKit limit was reached); if not, we'll just set its exposure
      // state to false for the future.
      let accessory = this.getAccessoryById(id);

      if (accessory && ! await this.deleteDeviceFromHomeKit({ id })) {
        throw Error('API_DELETE_DEVICE_FAILED');
      }

      // update exposure state
      this.#exposed.set(id, false);
      this.#exposed.save();

      // done
      return 'ok';
    },

    async reset() {
      await this.reset(true);
      return 'ok';
    }
  }
}

class StorageBackedMap extends Map {
  #dirty  = false;
  #onSave = null;

  constructor(data, onSave) {
    super();
    for (const [ key, value ] of Object.entries(data || {})) {
      this.set(key, value);
    }
    this.#dirty  = false; // treat as not dirty after loading
    this.#onSave = onSave;
  }

  set(key, value) {
    this.#dirty = this.#dirty || this.get(key) !== value;
    return super.set(key, value);
  }

  setAll(value) {
    for (const key of this.keys()) {
      this.set(key, value);
    }
    this.save();
  }

  delete(key) {
    this.#dirty = this.#dirty || this.has(key);
    return super.delete(key);
  }

  save() {
    if (! this.#dirty) return;
    this.#onSave(Object.fromEntries(this));
    this.#dirty = false;
  }

  isDirty() {
    return this.#dirty;
  }
}
