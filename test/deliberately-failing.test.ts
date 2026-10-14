import { expect, it } from 'vitest';

// Throwaway: proves branch protection blocks a red PR (#6). Never merge.
it('fails on purpose', () => {
  expect(1).toBe(2);
});
