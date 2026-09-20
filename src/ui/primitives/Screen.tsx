import type { ReactNode } from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '../theme';

/** The desk the licence card sits on. Every screen starts here. */
export function Screen({
  children,
  scroll = false,
  padded = true,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
}) {
  const t = useTheme();
  const content: ViewStyle = {
    flexGrow: 1,
    paddingHorizontal: padded ? t.space.lg : 0,
    paddingVertical: padded ? t.space.lg : 0,
    gap: t.space.lg,
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.colors.bg }}
      edges={['top', 'left', 'right']}
    >
      {scroll ? (
        <ScrollView
          contentContainerStyle={content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={content}>{children}</View>
      )}
    </SafeAreaView>
  );
}
