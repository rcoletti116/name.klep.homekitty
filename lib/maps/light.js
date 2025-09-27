module.exports = (Mapper, Service, Characteristic) => ({
  class:    ['light', 'dimmable_light', 'lightbulb'],
  group:    true,
  service:  Service.Lightbulb,
  adaptiveLighting: true, // 👈 NEW
  required: {
    onoff: Mapper.Characteristics.OnOff,
    dim:   Mapper.Characteristics.Light.Dim, // ✅ must be required
  },
  optional: {
    light_hue:         Mapper.Characteristics.Light.Hue,
    light_saturation:  Mapper.Characteristics.Light.Saturation,
    light_temperature: Mapper.Characteristics.Light.Temperature,
  }
});
