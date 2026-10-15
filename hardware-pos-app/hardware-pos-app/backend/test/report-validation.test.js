import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReportRange } from '../src/report-validation.js';

test('report date range accepts valid inclusive date ranges', () => {
  assert.deepEqual(validateReportRange('2026-10-01', '2026-10-13'), { from: '2026-10-01', to: '2026-10-13' });
});
test('report date range rejects invalid calendar dates and reversed dates', () => {
  assert.ok(validateReportRange('2026-02-30', '2026-03-01').error);
  assert.ok(validateReportRange('2026-10-14', '2026-10-13').error);
});
test('report date range rejects ranges longer than 367 days', () => {
  assert.ok(validateReportRange('2024-01-01', '2025-01-03').error);
});
