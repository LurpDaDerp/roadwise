const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.disableHierarchicalLookup = true; // never resolve from the parent RoadCash node_modules
module.exports = config;
