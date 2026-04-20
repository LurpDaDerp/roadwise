// Design tokens for RoadCash.
// Dark-first automotive-dashboard aesthetic with a teal safety accent.
// Colors chosen for high legibility under glance-read driving conditions.

const palette = {
  teal: {
    50:  '#e6fffa',
    100: '#b3f5e6',
    200: '#7fe8d1',
    300: '#4bd9b9',
    400: '#22c79e',
    500: '#00b386', // primary accent
    600: '#009971',
    700: '#007a5a',
    800: '#005a43',
    900: '#003a2c',
  },
  slate: {
    0:   '#ffffff',
    50:  '#f6f7f9',
    100: '#eceef2',
    200: '#d7dbe3',
    300: '#b6bcc8',
    400: '#858d9d',
    500: '#5d6573',
    600: '#434954',
    700: '#2d3139',
    750: '#22262c',
    800: '#191c21',
    850: '#121418',
    900: '#0b0d10',
    950: '#06080a',
  },
  amber: '#ffb020',
  red:   '#ff3b30',
  green: '#22c79e',
};

export const tokens = {
  dark: {
    bg:            palette.slate[950],
    bgElevated:    palette.slate[900],
    surface:       palette.slate[850],
    surfaceRaised: palette.slate[800],
    surfaceAlt:    palette.slate[750],
    border:        '#1f232a',
    borderStrong:  '#2d3139',
    divider:       'rgba(255,255,255,0.06)',

    text:          '#f4f6fa',
    textMuted:     '#a6adbb',
    textSubtle:    '#6b7280',
    textInverse:   palette.slate[900],

    accent:        palette.teal[500],
    accentMuted:   palette.teal[700],
    accentFaint:   'rgba(0,179,134,0.14)',
    accentText:    '#06100d',

    danger:        palette.red,
    warning:       palette.amber,
    success:       palette.teal[400],

    scrimTop:      'rgba(0,179,134,0.10)',
    scrimBottom:   'rgba(11,13,16,0.0)',
    shadow:        'rgba(0,0,0,0.55)',

    // Screen gradient stops (subtle, teal-tinged charcoal)
    gradientTop:    '#0d1114',
    gradientBottom: '#070a0c',
  },
  light: {
    bg:            '#f3f5f7',
    bgElevated:    '#ffffff',
    surface:       '#ffffff',
    surfaceRaised: '#ffffff',
    surfaceAlt:    palette.slate[50],
    border:        '#e3e6ec',
    borderStrong:  '#cfd4dd',
    divider:       'rgba(15,23,42,0.08)',

    text:          '#0c1116',
    textMuted:     '#4a5261',
    textSubtle:    '#7a8290',
    textInverse:   '#ffffff',

    accent:        palette.teal[600],
    accentMuted:   palette.teal[200],
    accentFaint:   'rgba(0,153,113,0.12)',
    accentText:    '#ffffff',

    danger:        '#e02e24',
    warning:       '#c77a00',
    success:       palette.teal[600],

    scrimTop:      'rgba(0,153,113,0.08)',
    scrimBottom:   'rgba(243,245,247,0.0)',
    shadow:        'rgba(20,32,45,0.10)',

    gradientTop:    '#f7f9fb',
    gradientBottom: '#e6ebf1',
  },
  palette,
};

export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
};

export const spacing = {
  px: 1,
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  7: 32,
  8: 40,
  9: 48,
  10: 64,
};

// Type scale — relies on weight + tracking to carry character with system fonts.
export const typography = {
  display: {
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -0.8,
    lineHeight: 40,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.4,
    lineHeight: 32,
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.2,
    lineHeight: 26,
  },
  subheading: {
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0,
    lineHeight: 22,
  },
  body: {
    fontSize: 15,
    fontWeight: '400',
    letterSpacing: 0,
    lineHeight: 22,
  },
  bodyStrong: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0,
    lineHeight: 22,
  },
  caption: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.1,
    lineHeight: 18,
  },
  micro: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    lineHeight: 14,
    textTransform: 'uppercase',
  },
  numeric: {
    fontSize: 52,
    fontWeight: '800',
    letterSpacing: -2,
    lineHeight: 56,
  },
};

export const elevation = {
  dark: {
    card: {
      shadowColor: '#000',
      shadowOpacity: 0.35,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 6 },
      elevation: 4,
    },
    raised: {
      shadowColor: '#000',
      shadowOpacity: 0.5,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 12 },
      elevation: 8,
    },
  },
  light: {
    card: {
      shadowColor: '#0f172a',
      shadowOpacity: 0.08,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    },
    raised: {
      shadowColor: '#0f172a',
      shadowOpacity: 0.12,
      shadowRadius: 28,
      shadowOffset: { width: 0, height: 10 },
      elevation: 6,
    },
  },
};
