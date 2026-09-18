// MemberMarker — a map pin for one family member: the marker asset with the
// member's avatar on it, plus a pulsing ring while they are in an emergency.
import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, Image } from 'react-native';
import { Marker } from 'react-native-maps';

const PIN = require('../../assets/marker.png');

function PulseRing() {
  const scale = useRef(new Animated.Value(0.2)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, { toValue: 2.5, duration: 1000, useNativeDriver: true }),
          Animated.timing(scale, { toValue: 0.2, duration: 0, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0, duration: 1000, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1, duration: 0, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [scale, opacity]);

  return (
    <Animated.View
      style={{
        position: 'absolute',
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: 'rgba(255, 58, 48, 0.77)',
        transform: [{ scale }],
        opacity,
      }}
    />
  );
}

const AVATAR = {
  width: 30,
  height: 30,
  borderRadius: 15,
  position: 'absolute',
  top: 3,
};

// `animatedCoordinate` (an AnimatedRegion) renders the animated marker used for
// the signed-in user; everyone else uses a plain coordinate.
export function MemberMarker({ coordinate, animatedCoordinate, title, name, photoURL, emergency }) {
  const Pin = animatedCoordinate ? Marker.Animated : Marker;
  const initial = (name || 'M').trim().charAt(0).toUpperCase();

  return (
    <Pin
      coordinate={animatedCoordinate || coordinate}
      title={title || name}
      tracksViewChanges={false}
    >
      <View style={{ width: 50, height: 50, alignItems: 'center', marginBottom: 50 }}>
        {!!emergency && <PulseRing />}
        <Image source={PIN} style={{ width: 50, height: 50 }} resizeMode="contain" />
        {photoURL ? (
          <Image source={{ uri: photoURL }} style={AVATAR} />
        ) : (
          <View style={[AVATAR, { backgroundColor: '#666', justifyContent: 'center', alignItems: 'center' }]}>
            <Text style={{ color: '#ffffff', fontWeight: '700' }}>{initial}</Text>
          </View>
        )}
      </View>
    </Pin>
  );
}

export default MemberMarker;
