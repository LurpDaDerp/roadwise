import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Dimensions,
  Animated,
} from 'react-native';
import LottieView from 'lottie-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAuth } from 'firebase/auth';
import { Ionicons } from '@expo/vector-icons';

import { getAIFeedback } from '../utils/gptApi';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  SafeGradient as LinearGradient,
  useTheme,
} from '../theme';

const { width } = Dimensions.get('window');

function interpolateColor(percent) {
  const p = Math.min(Math.max(percent, 0), 100) / 100;
  const start = { r: 230, g: 80, b: 80 };
  const mid = { r: 240, g: 180, b: 60 };
  const end = { r: 0, g: 179, b: 134 };
  let r, g, b;
  if (p < 0.5) {
    const k = p / 0.5;
    r = Math.round(start.r + (mid.r - start.r) * k);
    g = Math.round(start.g + (mid.g - start.g) * k);
    b = Math.round(start.b + (mid.b - start.b) * k);
  } else {
    const k = (p - 0.5) / 0.5;
    r = Math.round(mid.r + (end.r - mid.r) * k);
    g = Math.round(mid.g + (end.g - mid.g) * k);
    b = Math.round(mid.b + (end.b - mid.b) * k);
  }
  return `rgb(${r},${g},${b})`;
}

function normalizeInput(stats) {
  const { generatedAt, ...rest } = stats;
  return rest;
}

export default function AIFeedbackScreen({ route }) {
  const t = useTheme();
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState('Analyzing data...');
  const fadeAnim = useState(new Animated.Value(0))[0];

  useEffect(() => {
    if (feedback !== null) return;
    const controller = new AbortController();
    const messages = ['Processing data…', 'Analyzing driving behavior…', 'Generating response…'];
    let index = 0;
    setLoadingMessage(messages[index]);
    let timeoutId;

    const showNextMessage = () => {
      index++;
      if (index < messages.length) {
        const randomDelay = Math.floor(Math.random() * 1800) + 750;
        timeoutId = setTimeout(() => {
          setLoadingMessage(messages[index]);
          showNextMessage();
        }, randomDelay);
      }
    };
    showNextMessage();

    const fetchFeedback = async () => {
      try {
        const user = getAuth().currentUser;
        if (!user) {
          if (!controller.signal.aborted) {
            setFeedback({ summary: 'No user logged in.', score: 0, tips: [] });
            setLoading(false);
          }
          return;
        }

        const { statsJSON } = route.params;
        const normalizedInput = normalizeInput(statsJSON);

        let cache = [];
        try {
          const storedCache = await AsyncStorage.getItem('feedbackCache');
          if (storedCache) cache = JSON.parse(storedCache);
        } catch (err) {
          console.error('Error loading cache:', err);
        }

        const match = cache.find(
          (entry) => JSON.stringify(entry.input) === JSON.stringify(normalizedInput)
        );
        if (match) {
          setFeedback(match.response);
          setLoading(false);
          return;
        }

        const aiResponse = await getAIFeedback(statsJSON, controller.signal);
        if (!controller.signal.aborted) {
          if (!aiResponse) {
            setFeedback({ summary: 'No feedback received.', score: 0, tips: [] });
          } else {
            setFeedback(aiResponse);
            try {
              await AsyncStorage.setItem('safetyScore', aiResponse.score.toString());
            } catch (err) {
              console.error('Error saving safety score:', err);
            }
            try {
              const newEntry = { input: normalizedInput, response: aiResponse };
              const updatedCache = [newEntry, ...cache].slice(0, 10);
              await AsyncStorage.setItem('feedbackCache', JSON.stringify(updatedCache));
            } catch (err) {
              console.error('Error updating cache:', err);
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error(err);
          setFeedback({ summary: 'Error getting AI feedback.', score: 0, tips: [] });
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          clearTimeout(timeoutId);
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }).start();
        }
      }
    };

    fetchFeedback();
    return () => {
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, []);

  const renderHeatBar = (score) => {
    const markerSize = 26;
    const barWidth = width - 80;
    const margin = 14;
    const usableWidth = barWidth - 2 * margin;
    const markerLeft = margin + (usableWidth * score) / 100 - markerSize / 2;
    const barColor = interpolateColor(score);

    return (
      <View style={{ paddingTop: 6, paddingBottom: 10 }}>
        <View style={{ height: 54, justifyContent: 'center' }}>
          <View
            style={{
              height: 10,
              borderRadius: 5,
              backgroundColor: t.colors.divider,
              overflow: 'hidden',
            }}
          >
            <LinearGradient
              colors={['#e65050', '#f0b43c', '#00b386']}
              locations={[0, 0.5, 1]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={{ height: 10, width: '100%' }}
            />
          </View>
          <View
            style={{
              position: 'absolute',
              left: markerLeft,
              width: markerSize,
              height: markerSize,
              borderRadius: markerSize / 2,
              backgroundColor: t.colors.surface,
              borderWidth: 3,
              borderColor: barColor,
              top: (54 - markerSize) / 2,
            }}
          />
          <Text
            style={{
              position: 'absolute',
              left: markerLeft + markerSize / 2 - 25,
              top: -4,
              width: 50,
              textAlign: 'center',
              color: barColor,
              fontWeight: '800',
              fontSize: 11,
              letterSpacing: 1.1,
            }}
          >
            {score}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <Screen>
      {loading ? (
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <LottieView
            source={require('../assets/loader.json')}
            autoPlay
            loop
            style={{ width: width * 0.9, height: width * 0.9 }}
          />
          <Text
            style={[
              t.typography.bodyStrong,
              {
                color: t.colors.text,
                position: 'absolute',
                marginTop: 40,
              },
            ]}
          >
            {loadingMessage}
          </Text>
        </View>
      ) : (
        <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <ScreenHeader
              eyebrow="Insights · Feedback"
              title="Your feedback"
              subtitle="A personalized read on your recent drives."
            />

            {feedback && (
              <>
                <Section label="Safety rating">
                  <Card>
                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 6,
                      }}
                    >
                      <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>
                        Overall score
                      </Text>
                      <AutoFitText
                        style={[
                          t.typography.numeric,
                          { color: interpolateColor(feedback.score), fontSize: 28 },
                        ]}
                      >
                        {feedback.score}
                      </AutoFitText>
                    </View>
                    {renderHeatBar(feedback.score)}
                  </Card>
                </Section>

                <Section label="Summary">
                  <Card>
                    <Text
                      style={[
                        t.typography.body,
                        { color: t.colors.text, lineHeight: 23 },
                      ]}
                    >
                      {feedback.summary}
                    </Text>
                  </Card>
                </Section>

                {feedback.tips && feedback.tips.length > 0 && (
                  <Section label="Tips & suggestions">
                    <Card padded={false}>
                      {feedback.tips.map((tip, idx) => (
                        <View
                          key={idx}
                          style={{
                            flexDirection: 'row',
                            paddingVertical: 14,
                            paddingHorizontal: 18,
                            borderTopWidth: idx === 0 ? 0 : StyleSheet.hairlineWidth,
                            borderTopColor: t.colors.divider,
                          }}
                        >
                          <View
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 14,
                              backgroundColor: t.colors.accentFaint,
                              alignItems: 'center',
                              justifyContent: 'center',
                              marginRight: 12,
                            }}
                          >
                            <Ionicons
                              name="bulb-outline"
                              size={15}
                              color={t.colors.accent}
                            />
                          </View>
                          <Text
                            style={[
                              t.typography.body,
                              { color: t.colors.text, flex: 1, lineHeight: 22 },
                            ]}
                          >
                            {tip}
                          </Text>
                        </View>
                      ))}
                    </Card>
                  </Section>
                )}

                <View style={{ height: 32 }} />
              </>
            )}
          </ScrollView>
        </Animated.View>
      )}
    </Screen>
  );
}
