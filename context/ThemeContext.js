import React, { createContext, useState, useEffect } from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const ThemeContext = createContext();

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState('system'); 
  const [colorScheme, setColorScheme] = useState(Appearance.getColorScheme());

  useEffect(() => {
    const loadTheme = async () => {
      const savedTheme = await AsyncStorage.getItem('@appTheme');
      if (savedTheme) setTheme(savedTheme);
    };

    loadTheme();
  }, []);

  useEffect(() => {
    const resolveScheme = () => {
      if (theme === 'light' || theme === 'dark') {
        setColorScheme(theme);
      } else {
        setColorScheme(Appearance.getColorScheme());
      }
    };

    resolveScheme(); 

    const subscription = Appearance.addChangeListener(() => {
      if (theme === 'system') {
        resolveScheme(); 
      }
    });

    return () => subscription.remove();
  }, [theme]);

  const updateTheme = async (newTheme) => {
    setTheme(newTheme);
    await AsyncStorage.setItem('@appTheme', newTheme);
  };


  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme: colorScheme, updateTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};
