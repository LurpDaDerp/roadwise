import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';

import { ThemeProvider } from '@/ui/theme';

import { StepCancelProvider, StepFrame, StepPositionProvider } from '../StepFrame';

function renderFrame(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('StepFrame', () => {
  it('prints the position, the title as a header, the body and one primary action', async () => {
    const onPrimary = jest.fn();
    await renderFrame(
      <StepFrame
        position={{ index: 2, total: 7 }}
        title="Location"
        body="We use location to measure speed."
        primary={{ label: 'Continue', onPress: onPrimary }}
      />
    );

    expect(screen.getByText('Step 2 of 7')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Location' })).toBeOnTheScreen();
    expect(screen.getByText('We use location to measure speed.')).toBeOnTheScreen();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it('reads the position from the stepper when none is passed', async () => {
    await renderFrame(
      <StepPositionProvider value={{ index: 4, total: 5 }}>
        <StepFrame title="Notifications" primary={{ label: 'Continue', onPress: () => {} }} />
      </StepPositionProvider>
    );
    expect(screen.getByText('Step 4 of 5')).toBeOnTheScreen();
  });

  it('prints no position outside the stepper', async () => {
    await renderFrame(
      <StepFrame title="Ready" primary={{ label: 'Go to Home', onPress: () => {} }} />
    );
    expect(screen.queryByText(/^Step \d+ of \d+$/)).toBeNull();
  });

  it('keeps the progress rule out of the accessibility tree: the words carry the position', async () => {
    await renderFrame(
      <StepFrame
        position={{ index: 1, total: 3 }}
        title="Motion"
        primary={{ label: 'Continue', onPress: () => {} }}
      />
    );
    const rule = screen.getByTestId('onboarding-progress-rule', {
      includeHiddenElements: true,
    });
    expect(rule.props.accessibilityElementsHidden).toBe(true);
    expect(rule.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('offers Back only when the step has somewhere to go back to', async () => {
    const onBack = jest.fn();
    const { rerender } = await renderFrame(
      <StepFrame
        title="Motion"
        onBack={onBack}
        primary={{ label: 'Continue', onPress: () => {} }}
      />
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);

    await rerender(
      <ThemeProvider>
        <StepFrame title="Motion" primary={{ label: 'Continue', onPress: () => {} }} />
      </ThemeProvider>
    );
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('gives Back a target of at least 44 points', async () => {
    await renderFrame(
      <StepFrame
        title="Motion"
        onBack={() => {}}
        primary={{ label: 'Continue', onPress: () => {} }}
      />
    );
    const back = screen.getByRole('button', { name: 'Back' });
    const style = [back.props.style]
      .flat(Infinity)
      .reduce((a: object, s: object) => ({ ...a, ...s }), {});
    // A round button: its drawn size is its touch target.
    expect(style.minHeight ?? style.height).toBeGreaterThanOrEqual(44);
    expect(style.minWidth ?? style.width).toBeGreaterThanOrEqual(44);
  });

  it('adds an optional secondary action under the primary', async () => {
    const onSkip = jest.fn();
    await renderFrame(
      <StepFrame
        title="Auto-record"
        primary={{ label: 'Turn on', onPress: () => {} }}
        secondary={{ label: 'Skip', onPress: onSkip }}
      />
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Skip' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('passes the disabled and busy states through to the primary action', async () => {
    const onPress = jest.fn();
    await renderFrame(
      <StepFrame title="Terms" primary={{ label: 'Continue', onPress, disabled: true }} />
    );
    const primary = screen.getByRole('button', { name: 'Continue' });
    expect(primary).toBeDisabled();
    await fireEvent.press(primary);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('shows no Cancel outside the stepper', async () => {
    await renderFrame(<StepFrame title="Ready" primary={{ label: 'Go to Home', onPress: () => {} }} />);
    expect(screen.queryByRole('button', { name: 'Cancel setup' })).toBeNull();
  });

  it('offers Cancel inside the stepper, on a target of at least 44 points', async () => {
    const onCancel = jest.fn();
    await renderFrame(
      <StepCancelProvider value={{ onCancel, busy: false }}>
        <StepFrame
          position={{ index: 1, total: 6 }}
          title="Pick a username"
          primary={{ label: 'Claim username', onPress: () => {} }}
        />
      </StepCancelProvider>
    );
    const cancel = screen.getByRole('button', { name: 'Cancel setup' });
    expect(cancel).toHaveTextContent('Cancel');
    const style = [cancel.props.style]
      .flat(Infinity)
      .reduce((a: object, s: object) => ({ ...a, ...s }), {});
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    await fireEvent.press(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    // The position is still printed beside it.
    expect(screen.getByText('Step 1 of 6')).toBeOnTheScreen();
  });

  it('makes every button wait while Cancel signs the driver out', async () => {
    const onCancel = jest.fn();
    const onPrimary = jest.fn();
    const onSkip = jest.fn();
    const onBack = jest.fn();
    await renderFrame(
      <StepCancelProvider value={{ onCancel, busy: true }}>
        <StepFrame
          title="Motion"
          onBack={onBack}
          primary={{ label: 'Continue', onPress: onPrimary }}
          secondary={{ label: 'Not now', onPress: onSkip }}
        />
      </StepCancelProvider>
    );
    for (const name of ['Cancel setup', 'Continue', 'Not now', 'Back']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      await fireEvent.press(button);
    }
    expect(onCancel).not.toHaveBeenCalled();
    expect(onPrimary).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('renders the step content between the body and the actions', async () => {
    await renderFrame(
      <StepFrame title="Profile" primary={{ label: 'Continue', onPress: () => {} }}>
        <View testID="content" />
      </StepFrame>
    );
    expect(screen.getByTestId('content')).toBeOnTheScreen();
  });
});
