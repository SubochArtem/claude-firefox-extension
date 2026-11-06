import * as z from 'zod/v4';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
}

const coordinateSchema = z.array(z.number()).length(2);

export const computerInputSchema = z.strictObject({
  action: z
    .enum([
      'screenshot',
      'zoom',
      'left_click',
      'right_click',
      'double_click',
      'triple_click',
      'hover',
      'left_click_drag',
      'scroll',
      'scroll_to',
      'type',
      'key',
      'wait',
    ])
    .describe(
      'Action to perform; "screenshot" captures the visible part of the tab, "zoom" captures a region of the last screenshot at higher resolution, the click actions and "hover" move the mouse to a coordinate or an element, "left_click_drag" drags from start_coordinate to coordinate, "scroll" turns the mouse wheel at a coordinate and returns a new screenshot, "scroll_to" scrolls an element into view, "type" types text into the focused element, "key" presses keys or shortcuts, "wait" pauses',
    ),
  tabId: z.number().int().positive().optional().describe('Id of the tab, from tabs_context; defaults to the active tab'),
  region: z
    .array(z.number())
    .length(4)
    .optional()
    .describe(
      'Zoom only, required there: rectangle [x0, y0, x1, y1] to zoom into, in coordinates of the tab\'s last screenshot frame (top-left corner x0, y0 and bottom-right corner x1, y1; x1 > x0, y1 > y0). Take a screenshot first.',
    ),
  scale: z
    .number()
    .min(0.1)
    .max(1)
    .optional()
    .describe(
      'Screenshot and zoom: shrink the returned image by this factor (0.1 to 1, default 1) to save tokens. Coordinates always refer to the full-resolution screenshot frame, never to the scaled image.',
    ),
  coordinate: coordinateSchema
    .optional()
    .describe(
      '[x, y] in the tab\'s last screenshot frame. Clicks and hover: the target, or pass ref instead (not both). left_click_drag: where the drag ends. scroll: where the wheel turns, required. Take a screenshot first; a point outside it is refused.',
    ),
  start_coordinate: coordinateSchema
    .optional()
    .describe('left_click_drag only, required there: [x, y] in the last screenshot frame where the drag starts'),
  ref: z
    .string()
    .regex(/^ref_\d+$/)
    .optional()
    .describe(
      'Clicks, hover and scroll_to: element reference ref_N from read_page or find; the element is scrolled into view and its center is used. Clicks and hover take ref or coordinate, not both; scroll_to requires ref.',
    ),
  modifiers: z
    .string()
    .optional()
    .describe('Clicks only: modifier keys held during the click, joined with "+", e.g. "ctrl", "shift", "ctrl+shift", "alt", "meta"'),
  scroll_direction: z
    .enum(['up', 'down', 'left', 'right'])
    .optional()
    .describe('scroll only, required there: direction to scroll'),
  scroll_amount: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('scroll only: number of wheel ticks (1 to 10, default 3)'),
  duration: z
    .number()
    .positive()
    .max(10)
    .optional()
    .describe('wait only, required there: seconds to wait (more than 0, at most 10)'),
  text: z
    .string()
    .optional()
    .describe(
      'type and key only, required there. type: the text to type into the focused element (newlines press Enter). key: space-separated keys or chords, e.g. "Enter", "ctrl+a Delete", "shift+Tab", "cmd+c"; names include Enter, Tab, Escape, Backspace, Delete, arrows (Up, Down, Left, Right), Home, End, PageUp, PageDown, F1 to F12 and single characters',
    ),
  repeat: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('key only: how many times to press the whole key sequence (1 to 100, default 1)'),
});

export const readPageInputSchema = z.strictObject({
  tabId: z.number().int().positive().optional().describe('Id of the tab, from tabs_context; defaults to the active tab'),
  filter: z
    .enum(['all', 'interactive'])
    .optional()
    .describe(
      '"all" (default): interactive elements, landmarks, headings, lists and named elements; "interactive": only links, buttons, form fields and other controls',
    ),
  depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum number of printed tree levels (default 15); counts indentation levels of the output, not DOM nesting, since wrappers that are not printed do not add a level. A note marks a cut.',
    ),
  ref_id: z
    .string()
    .regex(/^ref_\d+$/)
    .optional()
    .describe('Read only the subtree of this element, a ref_N from an earlier read_page of the same page'),
  max_chars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum length of the output in characters (default 50000); longer output is cut with a note'),
});

export const pageTextInputSchema = z.strictObject({
  tabId: z.number().int().positive().optional().describe('Id of the tab, from tabs_context; defaults to the active tab'),
  max_chars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum length of the text in characters (default 50000); longer text is cut at a line break with a note'),
});

export const findInputSchema = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe('What to look for, in plain words: a name, label, placeholder or text, optionally with a role, e.g. "login button" or "search box"'),
  tabId: z.number().int().positive().optional().describe('Id of the tab, from tabs_context; defaults to the active tab'),
});

export const formInputInputSchema = z.strictObject({
  ref: z
    .string()
    .regex(/^ref_\d+$/)
    .describe('The form element to set, a ref_N from read_page or find on the same page'),
  value: z
    .union([z.string(), z.boolean(), z.number()])
    .describe(
      'The value: text for text-like inputs, textareas and editable elements; true or false for a checkbox; a number for number and range inputs; the value or visible text of an option for a select',
    ),
  tabId: z.number().int().positive().optional().describe('Id of the tab, from tabs_context; defaults to the active tab'),
});

export const resizeWindowInputSchema = z.strictObject({
  width: z.number().min(1).lt(7681).describe('Outer window width in pixels, including the browser frame and toolbars (fractions are floored)'),
  height: z.number().min(1).lt(4321).describe('Outer window height in pixels, including the browser frame and toolbars (fractions are floored)'),
  tabId: z.number().int().positive().optional().describe('Id of a tab in the window, from tabs_context; defaults to the active tab'),
});

// The extension refuses longer code; MAX_CODE_LENGTH in extension/tools/javascript-input.ts.
export const MAX_JAVASCRIPT_CODE_LENGTH = 100_000;

export const javascriptInputSchema = z.strictObject({
  action: z.literal('javascript_exec').describe('Must be "javascript_exec"'),
  text: z
    .string()
    .min(1)
    .max(MAX_JAVASCRIPT_CODE_LENGTH)
    .describe(
      'JavaScript code to run in the page. The value of the last expression statement is returned, e.g. "document.title" or "[...document.links].map((a) => a.href)"; a returned promise is awaited. Top-level await and return are allowed; such code runs as the body of an async function, so give its result with return.',
    ),
  tabId: z.number().int().positive().optional().describe('Id of the tab, from tabs_context; defaults to the active tab'),
});

// The extension enforces the same limits; extension/tools/console-input.ts.
export const MAX_CONSOLE_MESSAGES_LIMIT = 1000;
export const MAX_CONSOLE_PATTERN_LENGTH = 500;

export const consoleInputSchema = z.strictObject({
  tabId: z.number().int().positive().optional().describe('Id of the tab, from tabs_context; defaults to the active tab'),
  onlyErrors: z
    .boolean()
    .optional()
    .describe('Only console.error calls, uncaught errors and unhandled promise rejections (default false)'),
  pattern: z
    .string()
    .min(1)
    .max(MAX_CONSOLE_PATTERN_LENGTH)
    .optional()
    .describe('Keep only messages matching this case-insensitive regular expression; an invalid expression is matched as plain text'),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_CONSOLE_MESSAGES_LIMIT)
    .optional()
    .describe('Maximum number of messages to return, the most recent matching ones, oldest first (default 100)'),
  clear: z.boolean().optional().describe('Empty the captured messages after reading, so the next call shows only new ones (default false)'),
});

// The extension enforces the same limits; extension/tools/network-input.ts.
export const MAX_NETWORK_REQUESTS_LIMIT = 1000;
export const MAX_NETWORK_URL_PATTERN_LENGTH = 500;

export const networkInputSchema = z.strictObject({
  tabId: z.number().int().positive().optional().describe('Id of the tab, from tabs_context; defaults to the active tab'),
  urlPattern: z
    .string()
    .min(1)
    .max(MAX_NETWORK_URL_PATTERN_LENGTH)
    .optional()
    .describe('Keep only requests whose URL contains this text, case-insensitive (plain text, matched against the redacted URL)'),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_NETWORK_REQUESTS_LIMIT)
    .optional()
    .describe('Maximum number of requests to return, the most recent matching ones, oldest first (default 100)'),
  clear: z.boolean().optional().describe('Empty the captured requests after reading, so the next call shows only new ones (default false)'),
});

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'tabs_context',
    description:
      'List the tabs currently open in Firefox together with their tab ids. Call this first to get a tab id that the other browser tools can target.',
    inputSchema: z.object({}),
  },
  {
    name: 'navigate',
    description:
      'Navigate a tab to a URL, or go back or forward in its history. A URL without a scheme gets https://; only http and https URLs are allowed. Pass "back" or "forward" as the url to move through the tab\'s history. Waits until the page has loaded (up to 20 s) and returns the final URL, the page title and the current tabs. Get the tab id from tabs_context.',
    inputSchema: z.object({
      tabId: z.number().int().positive().describe('Id of the tab to navigate, from tabs_context'),
      url: z.string().describe('URL to open, or "back" / "forward" to move through the tab history'),
    }),
  },
  {
    name: 'tabs_create',
    description:
      'Open a new background tab in the last focused Firefox window, empty or loading the given http(s) URL (a URL without a scheme gets https://). With a URL it waits for the page like navigate (up to 20 s); if the load fails the tab stays open. Returns the new tab id and the current tabs.',
    inputSchema: z.object({
      url: z.string().optional().describe('URL to open in the new tab; omit for an empty tab'),
    }),
  },
  {
    name: 'tabs_close',
    description:
      'Close a tab by its id from tabs_context. Refuses to close the last tab of the last browser window. Returns the remaining tabs.',
    inputSchema: z.object({
      tabId: z.number().int().positive().describe('Id of the tab to close, from tabs_context'),
    }),
  },
  {
    name: 'computer',
    description:
      'Interact with a browser tab. "screenshot" captures the visible part of the tab as a JPEG image without switching to it or bringing it to the front. Defaults to the active tab; get other tab ids from tabs_context. The image is downscaled to stay within the image token budget; later actions take coordinates in the returned screenshot frame. "zoom" captures the region [x0, y0, x1, y1] of the last screenshot frame at up to device resolution to read small details; it does not change the frame, so coordinates keep referring to the last screenshot. "left_click", "right_click", "double_click" and "triple_click" click at coordinate or on an element ref (optionally holding modifiers), "hover" moves the mouse there, "left_click_drag" drags with the left button from start_coordinate to coordinate. Input is sent as real mouse and keyboard events through WebDriver BiDi, so Firefox must be started with --remote-debugging-port; background tabs receive it without being activated. "scroll" turns the mouse wheel at coordinate by scroll_amount ticks in scroll_direction and returns a new screenshot, which becomes the new coordinate frame. "scroll_to" scrolls the element ref into view. "type" types text and "key" presses space-separated keys or chords (repeat times) to the tab\'s focused element (click the field first). Reload shortcuts such as F5 or ctrl+r reload the tab; page zoom shortcuts are refused, use "zoom" instead. "wait" pauses for duration seconds.',
    inputSchema: computerInputSchema,
  },
  {
    name: 'read_page',
    description:
      'Read the structure of a page as an accessibility tree built from its DOM: one line per element with its role, name, a reference like [ref_12] and state (href, value, checked, expanded...). Hidden elements are left out and password-like fields are redacted. Defaults to the active tab; get other tab ids from tabs_context. References stay valid for the same element until the page is reloaded or navigates; pass ref_id to read just that element\'s subtree. Output longer than max_chars is truncated with a note: narrow it with ref_id, a smaller depth or filter "interactive". Ends with the viewport size in CSS pixels.',
    inputSchema: readPageInputSchema,
  },
  {
    name: 'get_page_text',
    description:
      'Extract the main readable text of a page as plain text, prioritising article content: the longest article, else main, else common content containers, else the whole body. Whitespace is collapsed and blank lines are kept to one. Defaults to the active tab; get other tab ids from tabs_context. Returns the page title, URL and the element the text came from, then the text; text longer than max_chars is truncated with a note. Use read_page instead to find elements to interact with.',
    inputSchema: pageTextInputSchema,
  },
  {
    name: 'find',
    description:
      'Find elements on a page by a natural-language-ish description, using local text matching over the page\'s accessibility tree (the elements read_page shows); no model is involved. Matches the words of the query against each element\'s name, role (words like button, link, checkbox, heading, search box), placeholder, id, title, alt, href, type, name attribute and text, case-insensitively. Returns up to 20 best matches, best first, as lines "- ref_N: role "name" (type) - reason"; the refs are the same as read_page\'s, usable with read_page ref_id and other tools until the page is reloaded or navigates. Hidden elements are left out and field values are never searched or shown. Defaults to the active tab; get other tab ids from tabs_context.',
    inputSchema: findInputSchema,
  },
  {
    name: 'form_input',
    description:
      'Set the value of a form element directly in the page, by a ref_N from read_page or find: text-like inputs (text, email, search, url, tel, password, date, time, datetime-local, month, week, color), textareas and contenteditable elements take text; a checkbox takes true or false; a radio button is selected; number and range inputs take a number; a select picks the first option whose value or visible text equals the value. The element is scrolled into view and focused, then input and change events are sent so page scripts notice the change. File, hidden and button inputs are not supported. Returns the new and the previous value, with password-like fields redacted. Defaults to the active tab; get other tab ids from tabs_context.',
    inputSchema: formInputInputSchema,
  },
  {
    name: 'resize_window',
    description:
      'Resize the outer Firefox window containing a tab to width x height pixels. The size includes the browser frame, tab strip and toolbars, so the page viewport ends up smaller; read_page reports the viewport size. A maximized, minimized or fullscreen window is set back to normal first. Only normal browser windows can be resized. The tab is not activated and focus is not requested, though restoring a minimized window may raise it. Returns the requested and the actual size, which the window manager or the screen may limit. Defaults to the active tab; get other tab ids from tabs_context.',
    inputSchema: resizeWindowInputSchema,
  },
  {
    name: 'javascript_tool',
    description:
      'Run JavaScript in a page\'s main world, the same realm as the page\'s own scripts, so it sees and can change page globals, the DOM and the page\'s state. Returns the value of the last expression as readable text (objects, arrays, maps and sets up to 4 levels deep, DOM nodes as short descriptions, at most 50000 characters); an uncaught exception is returned as an error with its stack. Values under keys like password, token, secret, auth, cookie or session and JWT-like strings are redacted on a best-effort basis; secrets inside other text are not. The script has 30 s; a script that runs longer cannot be stopped and may keep running in the page. Runs through WebDriver BiDi, so the page\'s Content Security Policy does not apply; Firefox must be started with --remote-debugging-port, otherwise it falls back to eval in the page, which the page\'s Content Security Policy may block, and the result says so. Needs the user\'s permission for the site. Defaults to the active tab; get other tab ids from tabs_context.',
    inputSchema: javascriptInputSchema,
  },
  {
    name: 'read_console_messages',
    description:
      'Read console messages of a page: console.log, info, warn, error and debug calls, uncaught errors and unhandled promise rejections, one line per message with its level and local time, oldest first. Capture starts in a tab on the first call to this tool, so the first call usually returns nothing: reload the page or repeat the action, then call again. Capture restarts with every page load in the tab, so messages from before the last navigation or reload are gone, and messages logged very early in a page load may be missed. Keeps the last 10000 messages per page, each cut at 2000 characters. URL query strings, JWT-like tokens and values after keys like password, token or session are redacted on a best-effort basis. Needs the user\'s permission for the site. Defaults to the active tab; get other tab ids from tabs_context.',
    inputSchema: consoleInputSchema,
  },
  {
    name: 'read_network_requests',
    description:
      'Read the network requests of a tab: one line per request with method, status code (or ERROR with Firefox\'s error text, PENDING, or REDIRECT), resource type, URL and duration, oldest first. Capture starts in a tab on the first call to this tool, so the first call usually returns nothing: reload the page or repeat the action, then call again. Requests are kept across navigations on the same site; the list starts over when the tab moves to another site. Keeps the last 1000 requests per tab. No headers or bodies. URL credentials, query strings and fragments are removed, and JWT-like tokens and values after keys like token or session in the path are redacted on a best-effort basis. Requests made by service workers are not attributed to the tab and are not shown. Needs the user\'s permission for the site. Defaults to the active tab; get other tab ids from tabs_context.',
    inputSchema: networkInputSchema,
  },
];
