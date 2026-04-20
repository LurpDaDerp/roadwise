import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Animated,
  Easing,
} from 'react-native';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getCountFromServer,
  query,
  orderBy,
  limit,
  where,
} from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';

import { auth, db } from '../utils/firebase';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  AutoFitText,
  useTheme,
} from '../theme';

const USERS_SHOWN = 50;

export default function LeaderboardScreen() {
  const t = useTheme();

  const [leaderboard, setLeaderboard] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [currentUserPlacement, setCurrentUserPlacement] = useState(null);
  const [loading, setLoading] = useState(true);

  const contentOpacity = useRef(new Animated.Value(0)).current;

  useFocusEffect(
    useCallback(() => {
      contentOpacity.setValue(0);
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: 350,
        easing: Easing.out(Easing.poly(3)),
        useNativeDriver: true,
      }).start();
    }, [contentOpacity])
  );

  useEffect(() => {
    const fetchLeaderboard = async () => {
      try {
        const currentUser = auth.currentUser;
        const currentUid = currentUser?.uid || null;
        setCurrentUserId(currentUid);

        const leaderboardRef = collection(db, 'users');
        const leaderboardQuery = query(
          leaderboardRef,
          orderBy('points', 'desc'),
          limit(USERS_SHOWN)
        );
        const querySnapshot = await getDocs(leaderboardQuery);

        const topResults = [];
        let isCurrentUserInTop = false;

        querySnapshot.forEach((docSnap) => {
          const data = docSnap.data();
          const id = docSnap.id;
          if (id === currentUid) isCurrentUserInTop = true;
          topResults.push({
            id,
            name: data.username || 'N/A',
            points: data.points || 0,
          });
        });

        setLeaderboard(topResults);

        if (!isCurrentUserInTop && currentUid) {
          const userSnap = await getDoc(doc(db, 'users', currentUid));
          if (userSnap.exists()) {
            const data = userSnap.data();
            const myPoints = data.points || 0;
            const higherCount = await getCountFromServer(
              query(leaderboardRef, where('points', '>', myPoints))
            );
            setCurrentUserPlacement({
              id: currentUid,
              name: data.username || 'You',
              points: myPoints,
              rank: higherCount.data().count + 1,
            });
          }
        }
      } catch (error) {
        console.error('Error fetching leaderboard:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchLeaderboard();
  }, []);

  const medalColors = [
    { bg: '#f5c56a22', fg: '#f2b23a', label: 'Gold' },
    { bg: '#bcc5cf22', fg: '#aab4bf', label: 'Silver' },
    { bg: '#c9773a22', fg: '#c78653', label: 'Bronze' },
  ];

  return (
    <Screen>
      <Animated.View style={{ flex: 1, opacity: contentOpacity }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          <ScreenHeader
            eyebrow="Community"
            title="Leaderboard"
            subtitle="Top focused drivers, ranked by points."
          />

          <Section label={`Top ${USERS_SHOWN}`}>
            <Card padded={false}>
              {loading ? (
                <View style={{ paddingVertical: 48, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={t.colors.accent} />
                </View>
              ) : leaderboard.length === 0 ? (
                <View style={{ paddingVertical: 36, alignItems: 'center' }}>
                  <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>
                    No entries yet.
                  </Text>
                </View>
              ) : (
                leaderboard.map((user, index) => {
                  const isCurrentUser = user.id === currentUserId;
                  const medal = medalColors[index];
                  return (
                    <Row
                      key={user.id}
                      t={t}
                      rank={index + 1}
                      name={user.name}
                      points={user.points}
                      isCurrentUser={isCurrentUser}
                      medal={medal}
                      first={index === 0}
                    />
                  );
                })
              )}
            </Card>
          </Section>

          {currentUserPlacement && (
            <Section label="Your rank">
              <Card padded={false}>
                <Row
                  t={t}
                  rank={currentUserPlacement.rank}
                  name={`${currentUserPlacement.name} (You)`}
                  points={currentUserPlacement.points}
                  isCurrentUser
                  first
                />
              </Card>
            </Section>
          )}

          <View style={{ height: 32 }} />
        </ScrollView>
      </Animated.View>
    </Screen>
  );
}

function Row({ t, rank, name, points, isCurrentUser, medal, first }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 18,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: t.colors.divider,
        backgroundColor: isCurrentUser ? t.colors.accentFaint : 'transparent',
        borderTopLeftRadius: first ? t.radius.lg : 0,
        borderTopRightRadius: first ? t.radius.lg : 0,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: 36,
          alignItems: 'center',
          marginRight: 12,
        }}
      >
        {medal ? (
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: 15,
              backgroundColor: medal.bg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="trophy" size={16} color={medal.fg} />
          </View>
        ) : (
          <Text
            style={[
              t.typography.numeric,
              { color: t.colors.textMuted, fontSize: 16 },
            ]}
          >
            {rank}
          </Text>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text
          style={[
            t.typography.bodyStrong,
            { color: isCurrentUser ? t.colors.accent : t.colors.text },
          ]}
          numberOfLines={1}
        >
          {name}
        </Text>
      </View>
      <AutoFitText
        style={[
          t.typography.numeric,
          { color: isCurrentUser ? t.colors.accent : t.colors.text, fontSize: 16 },
        ]}
      >
        {points.toLocaleString()}
      </AutoFitText>
    </View>
  );
}
