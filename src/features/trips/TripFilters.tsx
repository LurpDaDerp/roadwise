import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import type { EventCategory, ScoreBand } from '@scoring';

import { categoryCaps } from '@/content/scoring-explainer';
import { TRIP_ROLES, type TripRole, type TripsFilter } from '@/data/queries';
import { Text, useTheme } from '@/ui';
import { bandLabel, BAND_FLOORS } from '@/ui/charts';

import { tripCopy as copy } from './copy';
import { ICON, TOUCH } from './layout';

/** The filters D4 offers (§7.D D4). Vehicle and date range wait for M3's vehicles and a picker. */
export interface HistoryFilters {
  role?: TripRole;
  band?: ScoreBand;
  category?: EventCategory;
}

export const NO_FILTERS: HistoryFilters = {};

export const hasFilters = (filters: HistoryFilters): boolean =>
  filters.role !== undefined || filters.band !== undefined || filters.category !== undefined;

/**
 * The filters as `useTrips` reads them. No page size: the page is a slice of this read, not a
 * different read (see `TripHistoryScreen`).
 */
export function toTripsFilter(filters: HistoryFilters): TripsFilter {
  return {
    ...(filters.role === undefined ? {} : { role: filters.role }),
    ...(filters.band === undefined ? {} : { band: filters.band }),
    ...(filters.category === undefined ? {} : { category: filters.category }),
  };
}

function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={th.space.xs}
      style={({ pressed }) => ({
        minHeight: TOUCH,
        justifyContent: 'center',
        paddingHorizontal: th.space.md,
        borderRadius: th.radius.pill,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? th.colors.accent : th.colors.borderStrong,
        backgroundColor: selected
          ? th.colors.accentFaint
          : pressed
            ? th.colors.surfaceRaised
            : th.colors.surface,
      })}
    >
      <Text variant="subhead" tone={selected ? 'accent' : 'default'}>
        {label}
      </Text>
    </Pressable>
  );
}

function Group<T extends string>({
  label,
  options,
  value,
  onChange,
  testID,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T | undefined;
  onChange: (value: T | undefined) => void;
  testID: string;
}) {
  const th = useTheme();
  return (
    <View style={{ gap: th.space.sm }}>
      <Text variant="caption" tone="subtle" style={{ textTransform: 'uppercase' }}>
        {label}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.sm }}
      >
        <Chip
          label={copy.history.filters.all}
          selected={value === undefined}
          onPress={() => onChange(undefined)}
          testID={`${testID}-all`}
        />
        {options.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            selected={value === option.value}
            onPress={() => onChange(value === option.value ? undefined : option.value)}
            testID={`${testID}-${option.value}`}
          />
        ))}
      </View>
    </View>
  );
}

const ROLE_OPTIONS = TRIP_ROLES.map((role) => ({ value: role, label: copy.history.roles[role] }));
const BAND_OPTIONS = BAND_FLOORS.map((entry) => ({
  value: entry.band,
  label: bandLabel(entry.band),
}));
const CATEGORY_OPTIONS = categoryCaps.map((entry) => ({
  value: entry.category,
  label: entry.label,
}));

/**
 * The D4 filters: who was driving, which score band, and which behaviour actually cost points.
 *
 * Collapsed by default, because the list is the screen and a wall of chips above it is not. The
 * control says how many filters are on, so a driver who left one set yesterday and finds five
 * drives today can see why without opening anything.
 *
 * Each group is a radio group with "All" as its own option rather than a cleared state, so there
 * is always something checked and the rotor never lands on a group with no answer.
 */
export function TripFilterBar({
  filters,
  onChange,
  testID,
}: {
  filters: HistoryFilters;
  onChange: (filters: HistoryFilters) => void;
  testID?: string;
}) {
  const th = useTheme();
  const [open, setOpen] = useState(false);
  const count = [filters.role, filters.band, filters.category].filter(
    (value) => value !== undefined
  ).length;

  return (
    <View style={{ gap: th.space.md }} testID={testID}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            count === 0
              ? copy.history.filters.label
              : `${copy.history.filters.label}, ${String(count)}`
          }
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((v) => !v)}
          hitSlop={th.space.xs}
          testID="filters-toggle"
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: th.space.xs,
            minHeight: TOUCH,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Ionicons name="options-outline" size={ICON.md} color={th.colors.accent} />
          <Text variant="subhead" tone="accent">
            {count === 0
              ? copy.history.filters.label
              : `${copy.history.filters.label} (${String(count)})`}
          </Text>
        </Pressable>
        {count > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.history.clear}
            onPress={() => onChange(NO_FILTERS)}
            hitSlop={th.space.xs}
            testID="filters-clear"
            style={{ minHeight: TOUCH, justifyContent: 'center' }}
          >
            <Text variant="subhead" tone="accent">
              {copy.history.clear}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {open ? (
        <View style={{ gap: th.space.lg }} testID="filters-panel">
          <Group
            label={copy.history.filters.role}
            options={ROLE_OPTIONS}
            value={filters.role}
            onChange={(role) => onChange({ ...filters, role })}
            testID="filter-role"
          />
          <Group
            label={copy.history.filters.band}
            options={BAND_OPTIONS}
            value={filters.band}
            onChange={(band) => onChange({ ...filters, band })}
            testID="filter-band"
          />
          <Group
            label={copy.history.filters.category}
            options={CATEGORY_OPTIONS}
            value={filters.category}
            onChange={(category) => onChange({ ...filters, category })}
            testID="filter-category"
          />
        </View>
      ) : null}
    </View>
  );
}
