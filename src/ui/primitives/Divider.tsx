import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

export type DividerProps = {
  /** Left inset in pt, e.g. to start under a ListRow's title rather than its leading icon. */
  inset?: number;
  vertical?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** A hairline. Groups rows inside one card instead of a card per row. */
export function Divider({ inset = 0, vertical = false, style }: DividerProps) {
  const t = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[
        vertical
          ? { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' }
          : { height: StyleSheet.hairlineWidth, marginLeft: inset },
        { backgroundColor: t.colors.divider },
        style,
      ]}
    />
  );
}
