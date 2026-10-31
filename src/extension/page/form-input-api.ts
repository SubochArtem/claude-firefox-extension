// Installed by page/read-page.js next to the read_page entry point, so it resolves the same refs.
export const FORM_INPUT_ENTRY = '__claudeFirefoxFormInput';

export type FormValue = string | boolean | number;

export interface FormInputOptions {
  ref: string;
  value: FormValue;
}

export type FormInputResult = { ok: true; text: string } | { ok: false; error: string };

export type FormInputEntry = (options: FormInputOptions) => FormInputResult;
