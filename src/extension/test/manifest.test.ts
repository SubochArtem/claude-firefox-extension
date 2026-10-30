import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';

describe('manifest', () => {
  it('declares the webNavigation permission that navigate needs', () => {
    expect(manifest.permissions).toContain('webNavigation');
  });

  it('declares the tabs permission that the tab tools need for titles and urls', () => {
    expect(manifest.permissions).toContain('tabs');
  });
});
