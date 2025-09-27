const { Accessory, Service, Characteristic, AdaptiveLightingController, AccessoryEventTypes, uuid } = require('hap-nodejs');
const debounce = require('debounce');

module.exports.MappedDevice = class MappedDevice {
  #mapper;
  #device;
  #class;
  #capabilities;
  #category;
  #logger;
  #maps      = [];
  #accessory = null;
  #listeners = [];

  constructor(mapper, device, map, logger = console.log) {
    this.#mapper       = mapper;
    this.#device       = device;
    this.#class        = device.class;
    this.#capabilities = [...device.capabilities];
    this.#device.name  = this.#device.name || `${ this.#mapper.Utils.upperFirst(device.class) } Device`;
    this.#logger       = logger;
    this.#category     = map.category
    this.#maps.push(map);
  }

  getDevice() {
    return this.#device;
  }

  getCapabilities() {
    return this.#capabilities;
  }

  getClass() {
    return this.#class;
  }

  cleanup() {
    this.#listeners.forEach(listener => listener.destroy());
  }

  addMap(map) {
    if (this.#category === Accessory.Categories.OTHER) {
      this.#category = map.category ?? Accessory.Categories.OTHER;
    }
    this.#maps.push(map);
  }

  createAccessory() {
    // XXX: if UUID generation changes, update `App#getAccessoryById()` as well!
    const accessory = new Accessory(this.#device.name, uuid.generate(this.#device.id), this.#category);

    accessory.on(AccessoryEventTypes.IDENTIFY, (paired, callback) => {
      this.log('identify');
      // NOOP
      callback();
    });

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, String(this.#device.driverId).replace(/^homey:app:/, ''))
      .setCharacteristic(Characteristic.Model,        `${ this.#device.name } (${ this.#device._zoneName || 'onbekende zone' })`)
      .setCharacteristic(Characteristic.SerialNumber, this.#device.id);

    return accessory;
  }

  updateCapability(capability, value) {
    if (! this.#device.capabilitiesObj) {
      this.#device.capabilitiesObj = {};
    }
    if (! this.#device.capabilitiesObj[capability]) {
      this.#device.capabilitiesObj[capability] = {};
    }
    this.#device.capabilitiesObj[capability].value = value;
  }

  groupCapabilities() {
    // only extract visible capabilities
    const capabilities = this.#device.ui?.components?.map(c => c.capabilities).flat() || [];
    return capabilities.reduce((acc, cap) => {
      const [ capability, group = '' ] = cap.split('.');
      if (! acc[group]) acc[group] = [];
      acc[group].push(capability);
      return acc;
    }, {})
  }

  flattenGroups(groups) {
    // sort group names on length, sortest first
    const groupNames = Object.keys(groups).sort((a, b) => a.length - b.length);

    // process each group and leave only the capabilities that don't already belong in a 'shorter' group
    return groupNames.reduce((acc, group) => {
      acc.groups[group] = groups[group].filter(cap => ! (cap in acc.seen)).map(cap => {
        acc.seen[cap] = true;
        return cap;
      });
      return acc;
    }, { groups : {}, seen : {} }).groups;
  }

accessorize() {
  const [ cachedAccessory, device ] = [ this.#accessory, this.#device ];

  // shortcut if already created
  if (cachedAccessory) return cachedAccessory;

  // create HomeKit accessory
  const accessory = this.#accessory = this.createAccessory();

  // group capabilities
  let groups = this.groupCapabilities();

  for (const map of this.#maps) {
    this.log(`map '${ map.name }':`);

    for (const [ group, capabilities ] of Object.entries(map.group ? groups : this.flattenGroups(groups))) {
      let service;

      this.log(2, `- group '${ group || 'DEFAULT' }' [${ capabilities }]`);

      for (const prefix of capabilities) {
        const capability = `${ prefix }${ group ? '.' + group : '' }`;
        const characteristicMaps = map.required?.[prefix] || map.optional?.[prefix] || map.triggers?.[prefix];
        if (! characteristicMaps) continue;

        const isTrigger = !!map.triggers?.[prefix];

        // create or retrieve service
        if (! service) {
          service = accessory.getService(map.service);
          if (! service || map.group === true) {
            this.log(4, `- new service ${ map.service.name }`);
            service = accessory.addService(map.service, device.name, group || 'default');
          } else {
            this.log(4, `- existing service ${ map.service.name }`);
          }

          if (typeof map.onService === 'function') {
            map.onService(service, { device });
          }
        }

        for (const characteristicMap of [ characteristicMaps ].flat()) {
          const debounceTimeout   = characteristicMap.debounce || 0;
          const debounceImmediate = characteristicMap.debounce ? false : true;
          const getters = [ characteristicMap.get ].flat();
          const setters = [ characteristicMap.set ].flat();
          const getter  = getters[ device.capabilities.includes(capability) ? 0 : 1 ];
          const setter  = setters[ device.capabilities.includes(capability) ? 0 : 1 ];

          const characteristics = [ characteristicMap.characteristics ].flat().map(klass => {
            const characteristic = service.getCharacteristic(klass);
            this.log(6, `- [${ capability }] ${ isTrigger ? 'triggers' : '→' } [${ klass.name }] (debounce ${ debounceTimeout }ms)`);

            if (map.onUpdate) {
              characteristic.on('change', async ({ oldValue, newValue }) => {
                map.onUpdate({ characteristic : characteristic.constructor.name, oldValue, newValue, service, device, capability });
              });
            }

            if (! isTrigger) {
              if (getter) {
                characteristic.onGet(async () => {
                  const rawValue = device.capabilitiesObj?.[capability]?.value;
                  if (rawValue === undefined) throw Error(`missing capability value for '${ capability }'`);
                  return characteristic.validateUserInput(await getter(rawValue, { device, service, characteristic: characteristic.constructor.name }));
                });
              }
              if (setter) {
                characteristic.onSet(debounce(async rawValue => {
                  const value = await setter(rawValue, { device, service, characteristic: characteristic.constructor.name });
                  await this.#device.setCapabilityValue(capability, value).catch(() => {});
                  this.updateCapability(capability, value);
                }, debounceTimeout, debounceImmediate));
              }
            }

            return characteristic;
          });

          // subscribe to capability updates
          this.#listeners.push(
            device.makeCapabilityInstance(capability, debounce(async rawValue => {
              this.log(`capability update - capability=${ capability } raw=${ rawValue }`);
              for (const characteristic of characteristics) {
                const name  = characteristic.constructor.name;
                const value = await getter(rawValue, { device, service, capability, characteristic: name });
                if (value === this.#mapper.Constants.NO_VALUE) continue;
                characteristic.updateValue(characteristic.validateUserInput(value));
              }
              this.updateCapability(capability, rawValue);
            }, debounceTimeout, debounceImmediate))
          );
        }
      }

      // --- Adaptive Lighting ---
      if (map.adaptiveLighting && service) {
        try {
          const brightnessChar = service.getCharacteristic(Characteristic.Brightness);
          const colorTempChar = service.getCharacteristic(Characteristic.ColorTemperature);

          if (brightnessChar && colorTempChar) {
            const alc = new AdaptiveLightingController(service, {
              controllerName: `${device.name} Adaptive Lighting`,
              manufacturer: 'Athom',
              model: device.class,
              serialNumber: device.id
            });
            accessory.configureController(alc);
            this.log(4, '- Adaptive Lighting enabled');
          } else {
            this.log(4, '- Adaptive Lighting skipped: missing Brightness or ColorTemperature');
          }
        } catch (err) {
          this.log('Error enabling Adaptive Lighting:', err);
        }
      }
    }
  }

  return accessory;
}


  log(...messages) {
    let indent = '';
    if (typeof messages[0] === 'number') {
      indent = ''.padStart(messages.shift());
    }
    this.#logger(`[${ this.toString() }]${ indent }`, ...messages);
  }

  toString() {
    return `${ this.#device.name }`;
  }
}
