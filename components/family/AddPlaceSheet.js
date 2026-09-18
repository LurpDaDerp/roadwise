// AddPlaceSheet — add or edit one of the group's saved places. Addresses come
// from HERE autocomplete (debounced) or from the address already cached for the
// user's current position.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  Keyboard,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Dimensions,
} from 'react-native';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import debounce from 'lodash.debounce';
import { useTheme, Button, Field, useInputStyle } from '../../theme';
import { fetchHereAutocomplete } from '../../utils/here';
import { getCachedAddressNear } from '../../utils/geo';

const { height: WINDOW_HEIGHT } = Dimensions.get('window');

const placeKey = (p) => (p ? `${p.name}|${p.address}` : null);

export function AddPlaceSheet({ open, editing, places = [], myLocation, onClose, onSave, onDelete }) {
  const t = useTheme();
  const input = useInputStyle();
  const sheetRef = useRef(null);
  const nameRef = useRef(null);
  const addressRef = useRef(null);
  const snapPoints = useMemo(() => ['90%'], []);

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const editKey = placeKey(editing);

  useEffect(() => {
    if (open) {
      setName(editing?.name || '');
      setAddress(editing?.address || '');
      setSuggestions([]);
      setError(null);
      setBusy(false);
      sheetRef.current?.expand();
    } else {
      sheetRef.current?.close();
    }
    // `editKey` identifies the place being edited without depending on the
    // object identity, which changes on every group snapshot.
  }, [open, editKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const runFetch = useCallback(async (q) => {
    if (!q || !q.trim()) {
      setSuggestions([]);
      return;
    }
    setFetching(true);
    try {
      const items = await fetchHereAutocomplete(q);
      setSuggestions(Array.isArray(items) ? items : []);
    } finally {
      setFetching(false);
    }
  }, []);

  const debouncedFetch = useMemo(() => debounce(runFetch, 500), [runFetch]);
  useEffect(() => () => debouncedFetch.cancel(), [debouncedFetch]);

  const dismissInputs = useCallback(() => {
    nameRef.current?.blur();
    addressRef.current?.blur();
    Keyboard.dismiss();
  }, []);

  const useCurrentLocation = useCallback(async () => {
    if (!myLocation?.latitude || !myLocation?.longitude) {
      setError('Your location is not available yet.');
      return;
    }
    const cached = await getCachedAddressNear(myLocation.latitude, myLocation.longitude);
    if (cached) {
      setAddress(cached);
      setSuggestions([]);
      setError(null);
    } else {
      setError('No address for your current position yet. Try typing it instead.');
    }
  }, [myLocation?.latitude, myLocation?.longitude]);

  const handleSave = useCallback(async () => {
    dismissInputs();
    const n = name.trim();
    const a = address.trim();
    if (!n) {
      setError('Give this place a name.');
      return;
    }
    if (!a) {
      setError('Add an address.');
      return;
    }
    const others = places.filter((p) => placeKey(p) !== editKey);
    if (others.some((p) => (p.name || '').trim().toLowerCase() === n.toLowerCase())) {
      setError('A place with that name already exists.');
      return;
    }
    if (others.some((p) => (p.address || '').trim().toLowerCase() === a.toLowerCase())) {
      setError('That address is already saved.');
      return;
    }
    setError(null);
    setBusy(true);
    const result = await onSave({ name: n, address: a }, editing || null);
    setBusy(false);
    if (result && result.ok === false) setError(result.error || 'Could not save this place.');
    else onClose();
  }, [address, dismissInputs, editKey, editing, name, onClose, onSave, places]);

  const handleDelete = useCallback(() => {
    if (!editing) return;
    Alert.alert('Delete place', `Remove "${editing.name}" from the group?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          const result = await onDelete(editing);
          setBusy(false);
          if (result && result.ok === false) setError(result.error || 'Could not delete this place.');
          else onClose();
        },
      },
    ]);
  }, [editing, onDelete, onClose]);

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={snapPoints}
      backgroundStyle={{ backgroundColor: t.colors.surface }}
      handleComponent={null}
      enablePanDownToClose={false}
      enableContentPanningGesture={false}
      enableHandlePanningGesture={false}
    >
      <BottomSheetView style={{ flex: 1, paddingHorizontal: 22, paddingTop: 20, paddingBottom: 24 }}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingBottom: 14,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: t.colors.divider,
          }}
        >
          <Pressable
            onPress={() => {
              dismissInputs();
              onClose();
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={[t.typography.body, { color: t.colors.textMuted, fontWeight: '600' }]}>Cancel</Text>
          </Pressable>
          <Text style={[t.typography.bodyStrong, { color: t.colors.text }]}>
            {editing ? 'Edit place' : 'Add a place'}
          </Text>
          <View style={{ width: 52 }} />
        </View>

        <View style={{ marginTop: 20 }}>
          <Field label="Name">
            <TextInput
              ref={nameRef}
              style={input}
              placeholder="e.g. Home, School"
              placeholderTextColor={t.colors.textSubtle}
              value={name}
              onChangeText={(v) => {
                setName(v);
                if (error) setError(null);
              }}
              accessibilityLabel="Place name"
            />
          </Field>

          <Field label="Address">
            <TextInput
              ref={addressRef}
              style={input}
              placeholder="Start typing an address"
              placeholderTextColor={t.colors.textSubtle}
              value={address}
              onChangeText={(v) => {
                setAddress(v);
                if (error) setError(null);
                debouncedFetch(v);
              }}
              accessibilityLabel="Address"
            />
          </Field>

          <Pressable
            onPress={useCurrentLocation}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Use my current location"
            style={({ pressed }) => [
              { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Ionicons name="locate-outline" size={14} color={t.colors.accent} />
            <Text style={[t.typography.caption, { color: t.colors.accent, fontWeight: '700' }]}>
              Use my current location
            </Text>
          </Pressable>

          {fetching && <ActivityIndicator size="small" color={t.colors.accent} style={{ marginTop: 12 }} />}

          {suggestions.length > 0 && (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              style={{
                maxHeight: WINDOW_HEIGHT / 3,
                marginTop: 12,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: t.colors.border,
                borderRadius: t.radius.md,
                backgroundColor: t.colors.surfaceAlt,
              }}
            >
              {suggestions.map((s, idx) => {
                const label = s?.address?.label || s?.title || '';
                return (
                  <Pressable
                    key={`${label}-${idx}`}
                    onPress={() => {
                      setAddress(label);
                      setSuggestions([]);
                    }}
                    style={({ pressed }) => [
                      {
                        padding: 12,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        borderBottomWidth: idx === suggestions.length - 1 ? 0 : StyleSheet.hairlineWidth,
                        borderBottomColor: t.colors.divider,
                      },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Ionicons name="location-outline" size={14} color={t.colors.textMuted} />
                    <Text style={[t.typography.body, { color: t.colors.text, flex: 1 }]} numberOfLines={2}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          {!!error && (
            <Text style={[t.typography.caption, { color: t.colors.danger, marginTop: 12 }]}>{error}</Text>
          )}

          <Button
            title={editing ? 'Save changes' : 'Save place'}
            onPress={handleSave}
            loading={busy}
            style={{ marginTop: 20 }}
          />

          {!!editing && (
            <Button
              title="Delete place"
              variant="danger"
              onPress={handleDelete}
              disabled={busy}
              style={{ marginTop: 10 }}
            />
          )}
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}

export default AddPlaceSheet;
