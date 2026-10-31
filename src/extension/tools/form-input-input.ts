import type { FormValue } from '../page/form-input-api';
import { describe, isRecord, type ParseResult, parseTabId } from './navigation-input';
import { echo } from './read-page-input';

export interface FormInputArgs {
  tabId?: number;
  ref: string;
  value: FormValue;
}

const PARAMETERS = ['ref', 'value', 'tabId'];
const REF_PATTERN = /^ref_\d+$/;

function parseRef(value: unknown): ParseResult<string> {
  if (value === undefined) {
    return { ok: false, error: 'ref is required: an element reference like ref_12 from read_page or find' };
  }
  if (typeof value !== 'string') return { ok: false, error: `ref must be a string, received ${describe(value)}` };
  if (!REF_PATTERN.test(value)) {
    return { ok: false, error: `ref must look like ref_12 (from read_page or find), received ${echo(value)}` };
  }
  return { ok: true, value };
}

function parseValue(value: unknown): ParseResult<FormValue> {
  if (value === undefined) return { ok: false, error: 'value is required: a string, boolean or number' };
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return { ok: true, value };
  }
  return { ok: false, error: `value must be a string, boolean or finite number, received ${describe(value)}` };
}

export function parseFormInputArgs(args: unknown): ParseResult<FormInputArgs> {
  if (args === undefined) args = {};
  if (!isRecord(args)) return { ok: false, error: `Expected an object of parameters, received ${describe(args)}` };
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || PARAMETERS.includes(key)) continue;
    return { ok: false, error: `Unknown parameter ${echo(key)}; allowed: ${PARAMETERS.join(', ')}` };
  }
  const ref = parseRef(args.ref);
  if (!ref.ok) return ref;
  const value = parseValue(args.value);
  if (!value.ok) return value;
  const tabId = args.tabId === undefined ? undefined : parseTabId(args.tabId);
  if (tabId && !tabId.ok) return tabId;

  const parsed: FormInputArgs = { ref: ref.value, value: value.value };
  if (tabId) parsed.tabId = tabId.value;
  return { ok: true, value: parsed };
}
