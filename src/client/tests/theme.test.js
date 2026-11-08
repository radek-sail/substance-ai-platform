import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  getInitialTheme,
  getNextTheme,
  applyThemeToDocument,
} from '../src/utils/theme.ts';

describe('Light & Dark Theme Support', () => {
  it('should default to light mode when no saved theme exists', () => {
    assert.strictEqual(DEFAULT_THEME, 'light');
    assert.strictEqual(getInitialTheme(null), 'light');
    assert.strictEqual(getInitialTheme({ getItem: () => null }), 'light');
    assert.strictEqual(getInitialTheme({ getItem: () => 'invalid-value' }), 'light');
  });

  it('should read saved dark or light preference from storage', () => {
    assert.strictEqual(
      getInitialTheme({
        getItem: (key) => (key === THEME_STORAGE_KEY ? 'dark' : null),
      }),
      'dark'
    );
    assert.strictEqual(
      getInitialTheme({
        getItem: (key) => (key === THEME_STORAGE_KEY ? 'light' : null),
      }),
      'light'
    );
  });

  it('should toggle between light and dark mode', () => {
    assert.strictEqual(getNextTheme('light'), 'dark');
    assert.strictEqual(getNextTheme('dark'), 'light');
  });

  it('should apply theme attributes, classes, and persist to storage', () => {
    const saved = {};
    const mockStorage = {
      setItem: (k, v) => {
        saved[k] = v;
      },
    };

    const createMockElement = () => {
      const classes = new Set();
      const attrs = {};
      return {
        style: {},
        setAttribute: (k, v) => {
          attrs[k] = v;
        },
        getAttribute: (k) => attrs[k],
        classList: {
          toggle: (cls, force) => {
            if (force) classes.add(cls);
            else classes.delete(cls);
          },
          contains: (cls) => classes.has(cls),
        },
      };
    };

    const mockDoc = {
      documentElement: createMockElement(),
      body: createMockElement(),
    };

    applyThemeToDocument('light', mockDoc, mockStorage);
    assert.strictEqual(saved[THEME_STORAGE_KEY], 'light');
    assert.strictEqual(mockDoc.documentElement.getAttribute('data-theme'), 'light');
    assert.strictEqual(mockDoc.documentElement.classList.contains('light'), true);
    assert.strictEqual(mockDoc.documentElement.classList.contains('dark'), false);
    assert.strictEqual(mockDoc.documentElement.style.colorScheme, 'light');

    applyThemeToDocument('dark', mockDoc, mockStorage);
    assert.strictEqual(saved[THEME_STORAGE_KEY], 'dark');
    assert.strictEqual(mockDoc.documentElement.getAttribute('data-theme'), 'dark');
    assert.strictEqual(mockDoc.documentElement.classList.contains('dark'), true);
    assert.strictEqual(mockDoc.documentElement.classList.contains('light'), false);
    assert.strictEqual(mockDoc.documentElement.style.colorScheme, 'dark');
  });
});
