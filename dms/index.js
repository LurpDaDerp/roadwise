'use strict';
/**
 * Driver monitoring rule engine (plain JS port of the Python `dms` package).
 *
 *   const { DriverMonitor, createConfig } = require('./dms');
 *   const monitor = new DriverMonitor(createConfig());
 *   const inputs = monitor.prepareInputs({t, landmarks, width, height, face_present: true});
 *   const prediction = await runtime.run(inputs.cloud, inputs.context, inputs.validity);
 *   const out = monitor.finishFrame(frame, inputs, prediction);
 */

const util = require('./util');
const config = require('./config');
const appConfig = require('./app_config');
const alerts = require('./alerts');
const gazeInputs = require('./gaze_inputs');
const features = require('./features');
const calibration = require('./calibration');
const attention = require('./attention');
const drowsiness = require('./drowsiness');
const monitor = require('./monitor');

module.exports = Object.assign({}, util, config, appConfig, alerts, gazeInputs, features, calibration, attention, drowsiness, monitor, {
  util,
  config,
  appConfig,
  alerts,
  gazeInputs,
  features,
  calibration,
  attention,
  drowsiness,
  monitor,
});
