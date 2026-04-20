import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';

// ErrorBoundary — catches render errors anywhere below it so a single bad
// screen can't take down the whole app. Shows the error message and
// component stack so bugs are diagnosable in dev.
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    if (typeof console !== 'undefined' && console.error) {
      console.error('[ErrorBoundary]', error?.message || error, '\n', info?.componentStack || '', '\n', error?.stack || '');
    }
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    if (!this.state.error) return this.props.children;

    const message = this.state.error?.message || 'Something went wrong.';
    const stack = this.state.error?.stack || '';
    const componentStack = this.state.info?.componentStack || '';
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: '#06080a',
          padding: 24,
          paddingTop: 64,
        }}
      >
        <Text style={{ color: '#ff6b6b', fontSize: 18, fontWeight: '700', marginBottom: 8 }}>
          Something went wrong
        </Text>
        <Text style={{ color: '#f4f6fa', fontSize: 14, marginBottom: 12 }}>
          {message}
        </Text>
        <ScrollView style={{ flex: 1, marginBottom: 16 }}>
          <Text style={{ color: '#a6adbb', fontSize: 11, fontFamily: 'Courier' }}>
            {componentStack}
          </Text>
          <Text style={{ color: '#6b7280', fontSize: 10, fontFamily: 'Courier', marginTop: 12 }}>
            {stack}
          </Text>
        </ScrollView>
        <Pressable
          onPress={this.reset}
          style={{
            backgroundColor: '#00b386',
            paddingHorizontal: 20,
            paddingVertical: 12,
            borderRadius: 12,
            alignSelf: 'center',
          }}
        >
          <Text style={{ color: '#06100d', fontWeight: '700' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

export default ErrorBoundary;
