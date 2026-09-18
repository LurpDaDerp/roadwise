// Metro configuration: the driver-monitoring model bundle (MediaPipe .task, ONNX .onnx) ships as
// app assets under assets/models/ and must be treated as binary assets by the bundler.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

for (const ext of ['task', 'onnx', 'ort', 'tflite', 'npy']) {
  if (!config.resolver.assetExts.includes(ext)) config.resolver.assetExts.push(ext);
}

module.exports = config;
