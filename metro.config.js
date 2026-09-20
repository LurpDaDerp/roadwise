const { getDefaultConfig } = require('expo/metro-config');

// No resolver override here: the old RoadCash app is a sibling directory, and Metro's hierarchical
// lookup only walks ancestors, so it can never resolve packages out of that tree.
module.exports = getDefaultConfig(__dirname);
