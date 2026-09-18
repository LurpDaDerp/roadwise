// SavedPlaceRow — one saved place in the bottom sheet. Tapping it opens the
// add/edit sheet for that place.
import React from 'react';
import { Card, ListRow } from '../../theme';

export function SavedPlaceRow({ place, onPress }) {
  if (!place) return null;
  return (
    <Card padded={false} style={{ marginBottom: 10 }}>
      <ListRow
        first
        icon="bookmark-outline"
        title={place.name}
        subtitle={place.address}
        chevron
        onPress={onPress}
      />
    </Card>
  );
}

export default SavedPlaceRow;
