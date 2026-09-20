import { useWindowDimensions } from 'react-native';

/**
 * The Dynamic Type factor `Text` applies (capped at 2.0), for the parts of a chart that are sized
 * by hand rather than by a line of text: a numeral cut to fit a ring, a gutter that has to hold a
 * tick label. `max` tightens the cap where geometry, not legibility, sets the limit.
 */
export function useFontScale(max = 2): number {
  const { fontScale } = useWindowDimensions();
  return Math.min(fontScale, max);
}
