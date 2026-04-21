import React, { useState, useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  View,
  Text,
  StyleSheet,
  ImageBackground,
  Pressable,
  Animated,
  Easing,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  Screen,
  Section,
  Card,
  Eyebrow,
  AutoFitText,
  useTheme,
} from '../theme';

const CATEGORIES = [
  { label: 'Food & Drink',          img: require('../assets/foodback.jpg'), route: 'FoodRewards',          icon: 'restaurant-outline' },
  { label: 'Shopping',              img: require('../assets/shopback.jpg'), route: 'ShoppingRewards',      icon: 'bag-handle-outline' },
  { label: 'Games & Entertainment', img: require('../assets/gameback.jpg'), route: 'GamesRewards',         icon: 'game-controller-outline' },
  { label: 'Subscriptions',         img: require('../assets/subback.jpg'), route: 'SubscriptionsRewards', icon: 'repeat-outline' },
];

export default function RewardsScreen({ navigation }) {
  const [totalPoints, setTotalPoints] = useState(0);
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const t = useTheme();

  useFocusEffect(
    useCallback(() => {
      contentOpacity.setValue(0);
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.poly(3)),
        useNativeDriver: true,
      }).start();

      let isActive = true;
      (async () => {
        try {
          const stored = await AsyncStorage.getItem('totalPoints');
          if (isActive) setTotalPoints(stored ? parseFloat(stored) : 0);
        } catch (e) {
          console.error(e);
        }
      })();
      return () => { isActive = false; };
    }, [])
  );

  return (
    <Screen>
      <Animated.View style={{ flex: 1, opacity: contentOpacity }}>
        <View style={{ marginTop: 24, marginBottom: 24 }}>
          <Eyebrow>Rewards</Eyebrow>
          <Text style={[t.typography.title, { color: t.colors.text, marginTop: 8 }]}>
            Redeem points for prizes
          </Text>
        </View>

        <Card style={styles.balanceCard} padded={false}>
          <View
            style={{
              padding: 20,
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <View>
              <Text style={[t.typography.micro, { color: t.colors.textMuted }]}>
                Available balance
              </Text>
              <AutoFitText
                style={[
                  t.typography.numeric,
                  { color: t.colors.text, marginTop: 6, fontSize: 44, lineHeight: 48 },
                ]}
              >
                {totalPoints.toFixed(0)}
              </AutoFitText>
              <Text
                style={[
                  t.typography.caption,
                  { color: t.colors.accent, marginTop: 2 },
                ]}
              >
                points
              </Text>
            </View>
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                backgroundColor: t.colors.accentFaint,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="gift-outline" size={28} color={t.colors.accent} />
            </View>
          </View>
          <View
            style={{
              height: 1,
              backgroundColor: t.colors.divider,
            }}
          />
          <View
            style={{
              paddingHorizontal: 20,
              paddingVertical: 12,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Ionicons name="information-circle-outline" size={16} color={t.colors.textMuted} />
            <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>
              Drive safely to earn more points.
            </Text>
          </View>
        </Card>

        <Section label="Categories" style={{ marginTop: 28 }}>
          <View style={{ gap: 12 }}>
            {CATEGORIES.map((item) => (
              <CategoryCard
                key={item.route}
                item={item}
                onPress={() => navigation.navigate(item.route)}
              />
            ))}
          </View>
        </Section>
      </Animated.View>
    </Screen>
  );
}

function CategoryCard({ item, onPress }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: t.colors.accentFaint }}
      style={({ pressed }) => [
        {
          borderRadius: t.radius.lg,
          overflow: 'hidden',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
          ...t.elevation.card,
        },
        pressed && { transform: [{ scale: 0.99 }] },
      ]}
    >
      <ImageBackground
        source={item.img}
        style={{ height: 96, justifyContent: 'center' }}
        imageStyle={{ borderRadius: t.radius.lg }}
      >
        <View
          style={{
            ...StyleSheet.absoluteFillObject,
            backgroundColor: t.isDark ? 'rgba(6,10,12,0.55)' : 'rgba(0,0,0,0.25)',
          }}
        />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 20,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: 'rgba(255,255,255,0.15)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name={item.icon} size={18} color="#fff" />
            </View>
            <Text
              style={{
                color: '#fff',
                fontSize: 17,
                fontWeight: '700',
                letterSpacing: -0.2,
                textShadowColor: 'rgba(0,0,0,0.6)',
                textShadowRadius: 4,
              }}
            >
              {item.label}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#fff" />
        </View>
      </ImageBackground>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  balanceCard: {
    overflow: 'hidden',
  },
});
